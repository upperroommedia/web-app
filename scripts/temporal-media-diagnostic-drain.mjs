import { scanPrivateMediaInventory } from './temporal-media-private-inventory.mjs';
import { proofDigest as hash, assertNativeSnapshot } from './temporal-release-runtime.mjs';
import { observeNamespaceComputeIsolation } from './temporal-compute-isolation.mjs';
import { readCloudRunRevisionInstanceCount } from './temporal-cloud-run-worker-count.mjs';
import { readCloudRunWorkerStart, readCloudRunWorkerSystemEvents } from './temporal-cloud-run-worker-start.mjs';
const fail = () => {
  throw new Error('MEDIA_DIAGNOSTIC_DRAIN_UNCONFIRMED');
};
const namespace = 'urm-app-staging.qwejt',
  deploymentName = 'urm-worker-media-recovery-staging',
  queue = 'urm-media-kernel-recovery';
const uuid = (x) => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const stamp = (s) => {
  if (!s.exists || !s.createTime || !s.updateTime) fail();
  return hash({ data: s.data(), created: s.createTime, updated: s.updateTime });
};
function originalStopScope(cycle, kernel, startup) {
  const worker = kernel.get('worker'),
    record = startup.data(),
    { context, intent, birth } = kernel.data(),
    bornAt = Date.parse(record?.observedAt),
    startAttempt = Date.parse(cycle.start.attemptedAt),
    stopAttempt = Date.parse(cycle.stop.attemptedAt);
  if (
    !record ||
    !startup.createTime?.isEqual(startup.updateTime) ||
    record.schemaVersion !== 1 ||
    record.kind !== 'private-diagnostic-startup-only-no-recovery-proof' ||
    record.operationId !== cycle.plan.operationId ||
    record.intentSHA256 !== context.intentSHA256 ||
    hash(record.worker) !== hash(worker) ||
    hash(record.kernel) !==
      hash({
        operationId: context.operationId,
        birthDigest: hash({ context, intent, birth, worker }),
      }) ||
    !/^projects\/(?:urm-app-staging|251680231116)\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(
      cycle.stop.nativeOperation ?? ''
    ) ||
    ![bornAt, startAttempt, stopAttempt].every(Number.isSafeInteger) ||
    bornAt < startAttempt ||
    stopAttempt <= bornAt ||
    stopAttempt >= Date.now()
  )
    fail();
  return {
    pool: worker.cloudRun.pool,
    revision: worker.cloudRun.revision,
    revisionUid: worker.cloudRun.revisionUid,
    workerIdentity: `media-recovery-${worker.instanceId}`,
    startupSHA256: hash(record),
    bornAt,
    startAttempt,
    stopAttempt,
  };
}

/** Separate diagnostic policy. No normal role queue/action validator is widened.
 * Legacy DescribeTaskQueue aggregates all loaded versions of ONE partition;
 * enumerate and repeat the complete partition set for BOTH queue types.
 * Native v1.32 matching sources linked in SERVERLESS_BOOTSTRAP_HANDOFF.md. */
async function observe(o, mode = 'drained') {
  const { client, firestore: db, plan, pool } = o;
  const captureStopEvents = mode === 'stopped-origin';
  if (
    db.projectId !== 'urm-app-staging' ||
    db.databaseId !== '(default)' ||
    client.options.namespace !== namespace ||
    !uuid(o.operationId) ||
    plan.operationId !== o.operationId ||
    plan.role !== 'media' ||
    plan.contract?.deploymentName !== deploymentName ||
    plan.contract.queue !== queue ||
    !/^[a-f0-9]{40}$/.test(plan.buildId) ||
    pool.desiredManualInstanceCount !== (mode === 'drained' ? 1 : 0)
  )
    fail();
  const end = Date.now() + 30000;
  let live = true;
  const read = async (fn) => {
    if (!live || o.signal?.aborted || Date.now() >= end) fail();
    let timer, aborted;
    try {
      const result = await Promise.race([
        new Promise((_, reject) => {
          aborted = () => reject(new Error('MEDIA_DIAGNOSTIC_DRAIN_UNCONFIRMED'));
          o.signal?.addEventListener('abort', aborted, { once: true });
        }),
        Promise.resolve().then(() => {
          if (!live) fail();
          return fn();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('MEDIA_DIAGNOSTIC_DRAIN_UNCONFIRMED')),
            Math.max(1, Math.min(5000, end - Date.now()))
          );
        }),
      ]);
      if (!live || o.signal?.aborted || Date.now() >= end) fail();
      return result;
    } catch {
      live = false;
      return fail();
    } finally {
      clearTimeout(timer);
      if (aborted) o.signal?.removeEventListener('abort', aborted);
    }
  };
  const rpc = (fn) => read(() => client.connection.withDeadline(Math.min(end, Date.now() + 5000), fn));
  const authority = () =>
    read(() =>
      db.runTransaction(
        async (tx) => {
          if (!live || o.signal?.aborted || Date.now() >= end) fail();
          const [parent, c, s, old, newborn, intent, ready, drain, start, originalStartup, ...otherExecutionFacts] =
            await Promise.all(
              [
                o.lockRef,
                o.controlRef,
                o.stateRef,
                ...['Kernel', 'ReplacementKernel', 'ReplacementIntent', 'OriginalReady'].map((k) =>
                  db.doc(`_control/temporalMediaRecovery${k}-${o.operationId}`)
                ),
                db.doc(`_control/temporalMediaRecoveryDrain-${o.operationId}`),
                ...[
                  'Start',
                  'Startup',
                  'OriginalSignal',
                  'OriginalDeath',
                  'Work',
                  'ReplacementStartup',
                  'ReplacementAdoption',
                  'ReplacementCompleted',
                  'ReplacementStop',
                ].map((k) => db.doc(`_control/temporalMediaRecovery${k}-${o.operationId}`)),
              ].map((r) => tx.get(r))
            );
          assertNativeSnapshot(o.ownedOperation, parent);
          assertNativeSnapshot(o.expectedAuthority.control, c);
          assertNativeSnapshot(o.expectedAuthority.state, s);
          const cycle = parent.get('cloudMediaRecovery');
          if (
            parent.get('action') !== 'diagnose-cloud-run-media-recovery' ||
            parent.get('operationId') !== o.operationId ||
            parent.get('bindingDigest') !== o.bindingDigest ||
            parent.get('releaseId') !== plan.releaseId ||
            hash(cycle?.plan) !== hash(plan) ||
            cycle.restore ||
            c.get('admission') !== 'paused' ||
            s.get('phase') !== 'provider-usage-ready' ||
            c.get('releaseId') !== plan.releaseId ||
            s.get('releaseId') !== plan.releaseId ||
            ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
              (k) => c.get(`domains.${k}.admission`) !== 'paused'
            )
          )
            fail();
          if (mode === 'never-started') {
            const rejection = cycle.start;
            if (
              !['prepared', 'never-started'].includes(cycle.stage) ||
              cycle.diagnostic?.stage !== 'completed' ||
              hash(cycle.diagnostic.pool) !== hash(pool) ||
              cycle.recovery ||
              cycle.recoveryFailed ||
              cycle.drained ||
              cycle.stop ||
              cycle.stopped ||
              parent.get('mediaRecoveryWorkflowStart') !== undefined ||
              (rejection &&
                (rejection.stage !== 'rejected' ||
                  !Number.isInteger(rejection.status) ||
                  rejection.status < 400 ||
                  rejection.status >= 500 ||
                  [408, 429].includes(rejection.status))) ||
              [old, newborn, intent, ready, drain, start, originalStartup, ...otherExecutionFacts].some((x) => x.exists)
            )
              fail();
            return {
              closureSHA256: hash({ kind: 'no-execution-facts', operationId: o.operationId }),
              authoritySHA256: hash([stamp(parent), stamp(c), stamp(s)]),
            };
          }
          if (cycle.start?.stage !== 'completed' || Boolean(cycle.recovery) === Boolean(cycle.recoveryFailed)) fail();
          const startedPool = cycle.start.pool;
          if (mode === 'stopped' || captureStopEvents) {
            if (
              !['drained', 'stopped'].includes(cycle.stage) ||
              cycle.stop?.stage !== 'completed' ||
              hash(cycle.stop.pool) !== hash(pool) ||
              !cycle.drained ||
              !drain.exists
            )
              fail();
            assertStoredMediaDiagnosticDrain(cycle.drained.observation, plan, startedPool);
            if (
              cycle.drained.proofSHA256 !== hash(cycle.drained.observation) ||
              hash(drain.data()) !==
                hash({
                  schemaVersion: 1,
                  operationId: o.operationId,
                  releaseId: plan.releaseId,
                  bindingDigest: o.bindingDigest,
                  planSHA256: hash(plan),
                  proof: cycle.drained,
                })
            )
              fail();
            const { desiredManualInstanceCount: oldCount, generation: oldGeneration, ...oldIdentity } = startedPool;
            const { desiredManualInstanceCount: newCount, generation: newGeneration, ...newIdentity } = pool;
            // A scaling stop changes generation and etag, not the native revision.
            delete oldIdentity.etag;
            delete newIdentity.etag;
            if (
              oldCount !== 1 ||
              newCount !== 0 ||
              hash(oldIdentity) !== hash(newIdentity) ||
              !/^\d+$/.test(oldGeneration ?? '') ||
              !/^\d+$/.test(newGeneration ?? '') ||
              BigInt(newGeneration) !== BigInt(oldGeneration) + 1n
            )
              fail();
          } else if (
            !['recovered', 'recovery-failed', 'drained'].includes(cycle.stage) ||
            hash(startedPool) !== hash(pool) ||
            cycle.stop
          )
            fail();
          for (const kernel of [old, ...(newborn.exists ? [newborn] : [])]) {
            const worker = kernel.get('worker'),
              cloud = worker?.cloudRun,
              parentWorker = kernel.get('context.parent');
            if (
              !kernel.exists ||
              kernel.get('schemaVersion') !== 1 ||
              kernel.get('context.operationId') !== o.operationId ||
              !/^[a-f0-9]{64}$/.test(kernel.get('context.intentSHA256') ?? '') ||
              !uuid(worker?.instanceId) ||
              worker.buildId !== plan.buildId ||
              !cloud ||
              cloud.projectId !== 'urm-app-staging' ||
              cloud.region !== 'us-central1' ||
              cloud.pool !== plan.name?.split('/').at(-1) ||
              cloud.revision !== startedPool.revision?.split('/').at(-1) ||
              cloud.revisionUid !== startedPool.revisionUid ||
              cloud.imageDigest !== plan.image?.split('@')[1] ||
              cloud.serviceAccount !== plan.runner ||
              !cloud.instanceId ||
              parentWorker?.buildId !== plan.buildId ||
              hash(parentWorker.cloudRun) !== hash(cloud) ||
              parentWorker.instanceId === worker.instanceId
            )
              fail();
          }
          if (
            newborn.exists &&
            (newborn.get('worker.instanceId') === old.get('worker.instanceId') ||
              hash(newborn.get('context.parent')) !== hash(old.get('context.parent')) ||
              hash(newborn.get('worker.cloudRun')) !== hash(old.get('worker.cloudRun')))
          )
            fail();
          if (!old.exists || old.get('stage') !== 'closed' || old.get('close.descendantsAbsent') !== true) fail();
          if (
            intent.exists !== newborn.exists ||
            (newborn.exists && (newborn.get('stage') !== 'closed' || newborn.get('close.descendantsAbsent') !== true))
          )
            fail();
          if (
            cycle.recovery &&
            (!newborn.exists ||
              old.get('close.observerFailed') === true ||
              newborn.get('close.observerFailed') === true ||
              newborn.get('close.code') !== 0 ||
              newborn.get('close.signal') !== null)
          )
            fail();
          return {
            closureSHA256: hash([
              stamp(old),
              newborn.exists ? stamp(newborn) : null,
              intent.exists ? stamp(intent) : null,
            ]),
            ready: ready.data(),
            worker: newborn.get('worker'),
            ...(captureStopEvents ? { stopScope: originalStopScope(cycle, old, originalStartup) } : {}),
            authoritySHA256: hash([stamp(parent), stamp(c), stamp(s)]),
          };
        },
        { readOnly: true }
      )
    );
  const scan = async () => {
    const auth = await authority();
    const inventory = await scanPrivateMediaInventory({
      client,
      db,
      plan,
      operationId: o.operationId,
      read,
      rpc,
      auth,
      allowAbsent: mode === 'never-started',
    });

    return {
      closureSHA256: auth.closureSHA256,
      authoritySHA256: auth.authoritySHA256,
      ...(captureStopEvents ? { stopScope: auth.stopScope } : {}),
      versions: inventory.versions,
      partitions: inventory.partitions,
      workflows: inventory.workflows,
      rows: inventory.rows,
    };
  };
  const beganMonotonic = performance.now();
  const began = Date.now(),
    first = await scan(),
    second = await scan(),
    compute = await read(() => observeNamespaceComputeIsolation(client, namespace));
  if (hash(first) !== hash(second)) fail();
  let stopObservation;
  if (captureStopEvents) {
    const scope = second.stopScope;
    const api = (...args) => read(() => o.api(...args));
    const startup = await readCloudRunWorkerStart({
      ...scope,
      api,
      buildId: plan.buildId,
      taskQueue: queue,
      recovery: { operationId: o.operationId, child: 'original', startupSHA256: scope.startupSHA256 },
      from: Math.max(scope.startAttempt, scope.bornAt - 5000),
      to: Math.min(scope.stopAttempt - 1, scope.bornAt + 90000),
    });
    if (!startup) fail();
    const end = Date.now();
    const [events, instanceCounts] = await Promise.all([
      readCloudRunWorkerSystemEvents({
        ...scope,
        api,
        instanceId: startup.instanceId,
        from: scope.stopAttempt,
        to: end,
      }),
      readCloudRunRevisionInstanceCount({
        ...scope,
        api,
        from: scope.startAttempt,
        to: end,
      }),
    ]);
    stopObservation = { startup, events, instanceCounts, stopAttempt: scope.stopAttempt };
  }
  const final = await authority();
  if (
    (captureStopEvents && hash(final.stopScope) !== hash(second.stopScope)) ||
    final.closureSHA256 !== first.closureSHA256 ||
    final.authoritySHA256 !== first.authoritySHA256 ||
    Date.now() - began > 5000 ||
    performance.now() - beganMonotonic > 5000 ||
    Math.abs(Date.now() - Date.parse(compute.observedAt)) > 5000
  )
    fail();
  return {
    schemaVersion: 1,
    operationId: o.operationId,
    planSHA256: hash(plan),
    poolSHA256: hash(pool),
    namespace,
    observedAt: new Date(began).toISOString(),
    closureSHA256: first.closureSHA256,
    protectionSHA256: hash(second),
    computeInventorySHA256: compute.inventorySHA256,
    versionCount: first.versions.length,
    partitionCount: first.partitions.length,
    ...(stopObservation ? { stopObservation } : {}),
  };
}
export async function observeMediaDiagnosticDrain(o) {
  try {
    return await observe(o);
  } catch (error) {
    if (error?.message === 'MEDIA_DIAGNOSTIC_POLLERS_PRESENT') throw error;
    return fail();
  }
}

function assertDiagnosticObservation(value, plan, pool, minVersions) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      'closureSHA256,computeInventorySHA256,namespace,observedAt,operationId,partitionCount,planSHA256,poolSHA256,protectionSHA256,schemaVersion,versionCount' ||
    value.schemaVersion !== 1 ||
    value.operationId !== plan.operationId ||
    value.planSHA256 !== hash(plan) ||
    value.poolSHA256 !== hash(pool) ||
    value.namespace !== namespace ||
    !['closureSHA256', 'computeInventorySHA256', 'protectionSHA256'].every((k) =>
      /^[a-f0-9]{64}$/.test(value[k] ?? '')
    ) ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    Date.parse(value.observedAt) > Date.now() + 5000 ||
    !Number.isInteger(value.versionCount) ||
    value.versionCount < minVersions ||
    value.versionCount > 100 ||
    !Number.isInteger(value.partitionCount) ||
    value.partitionCount < 2 ||
    value.partitionCount > 256
  )
    fail();
  return value;
}
/** Immutable checkpoint validator; timestamps are never refreshed on resume. */
export function assertStoredMediaDiagnosticDrain(value, plan, pool) {
  return assertDiagnosticObservation(value, plan, pool, 1);
}

export function assertMediaDiagnosticNeverStartedObservation(value, plan, pool) {
  assertDiagnosticObservation(value, plan, pool, 0);
  if (value.closureSHA256 !== hash({ kind: 'no-execution-facts', operationId: plan.operationId })) fail();
}

export function assertFreshMediaDiagnosticDrain(value, plan, pool) {
  assertStoredMediaDiagnosticDrain(value, plan, pool);
  if (Math.abs(Date.now() - Date.parse(value.observedAt)) > 5000) fail();
  return value;
}

/** Only native pollers-present is pending. No work, signal, scale or authorization
 * renewal occurs while waiting; ambiguity and authority drift stop immediately. */
export async function waitForMediaDiagnosticDrain(o) {
  // Temporal Matching's default poller history window is five minutes.
  const waitMs = 330000;
  const controller = new AbortController(),
    end = Date.now() + waitMs;
  const timer = setTimeout(() => controller.abort(), waitMs);
  try {
    while (!controller.signal.aborted && Date.now() < end) {
      try {
        const observation = await observeMediaDiagnosticDrain({ ...o, signal: controller.signal });
        if (controller.signal.aborted || Date.now() >= end) fail();
        return observation;
      } catch (error) {
        if (error?.message !== 'MEDIA_DIAGNOSTIC_POLLERS_PRESENT') throw error;
      }
      await new Promise((r) => setTimeout(r, Math.min(2000, Math.max(0, end - Date.now()))));
    }
    return fail();
  } finally {
    clearTimeout(timer);
  }
}

/** Separate stopped/never-started native confirmations. These inspect work and
 * receipt absence/lineage; desired0 is not a live process-count assertion. The
 * caller must independently bind exact native pool/revision before and after. */
export async function observeMediaDiagnosticStopped(o) {
  try {
    return await observe(o, 'stopped');
  } catch {
    throw new Error('MEDIA_DIAGNOSTIC_STOP_UNCONFIRMED');
  }
}
/** Read the original provider instance while the owned stop still fences
 * restoration. System log text never authorizes the next transition. */
export async function observeMediaDiagnosticStopEvents(o) {
  return observe(o, 'stopped-origin');
}

export async function observeMediaDiagnosticNeverStarted(o) {
  try {
    return await observe(o, 'never-started');
  } catch {
    throw new Error('MEDIA_DIAGNOSTIC_NEVER_STARTED_UNCONFIRMED');
  }
}
