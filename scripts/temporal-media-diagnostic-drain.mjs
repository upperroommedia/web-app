import { proofDigest as hash, assertNativeSnapshot } from './temporal-release-runtime.mjs';
import { observeNamespaceComputeIsolation } from './temporal-compute-isolation.mjs';
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
const array = (v) => {
  if (!Array.isArray(v)) fail();
  return v;
};
const token = (v, seen) => {
  if (v != null && !(v instanceof Uint8Array) && !(Array.isArray(v) && !v.length)) fail();
  if (!v?.length) return undefined;
  const k = Buffer.from(v).toString('base64');
  if (seen.has(k) || seen.size >= 10) fail();
  seen.add(k);
  return v;
};
const emptyCompute = (v) => {
  if (
    v != null &&
    (typeof v !== 'object' ||
      Array.isArray(v) ||
      Object.keys(v).some((k) => k !== 'scalingGroups') ||
      (v.scalingGroups != null && Object.keys(v.scalingGroups).length))
  )
    fail();
};
/** Separate diagnostic policy. No normal role queue/action validator is widened.
 * Legacy DescribeTaskQueue aggregates all loaded versions of ONE partition;
 * enumerate and repeat the complete partition set for BOTH queue types.
 * Native v1.32 matching sources linked in SERVERLESS_BOOTSTRAP_HANDOFF.md. */
async function observe(o, mode = 'drained') {
  const { client, firestore: db, plan, pool } = o;
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
  const service = client.connection.workflowService;
  const rpc = (fn) => read(() => client.connection.withDeadline(Math.min(end, Date.now() + 5000), fn));
  const authority = () =>
    read(() =>
      db.runTransaction(
        async (tx) => {
          if (!live || o.signal?.aborted || Date.now() >= end) fail();
          const [parent, c, s, old, newborn, intent, ready, drain, ...executionFacts] = await Promise.all(
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
              [old, newborn, intent, ready, drain, ...executionFacts].some((x) => x.exists)
            )
              fail();
            return {
              closureSHA256: hash({ kind: 'no-execution-facts', operationId: o.operationId }),
              authoritySHA256: hash([stamp(parent), stamp(c), stamp(s)]),
            };
          }
          if (cycle.start?.stage !== 'completed' || Boolean(cycle.recovery) === Boolean(cycle.recoveryFailed)) fail();
          const startedPool = cycle.start.pool;
          if (mode === 'stopped') {
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
            authoritySHA256: hash([stamp(parent), stamp(c), stamp(s)]),
          };
        },
        { readOnly: true }
      )
    );
  const scan = async () => {
    const auth = await authority();
    const versions = [];
    let report;
    report = await rpc(async () => {
      try {
        return await service.describeWorkerDeployment({ namespace, deploymentName });
      } catch (error) {
        if (mode !== 'never-started' || error?.code !== 5) throw error;
        return { workerDeploymentInfo: { name: deploymentName, routingConfig: {}, versionSummaries: [] } };
      }
    });
    const d = report.workerDeploymentInfo,
      r = d?.routingConfig;
    if (
      d?.name !== deploymentName ||
      r?.currentDeploymentVersion?.buildId ||
      r?.rampingDeploymentVersion?.buildId ||
      Number(r?.rampingVersionPercentage ?? 0) !== 0
    )
      fail();
    const summaries = array(d.versionSummaries);
    if ((!summaries.length && mode !== 'never-started') || summaries.length > 100) fail();
    for (const entry of summaries) {
      const v = entry.deploymentVersion;
      if (
        v?.deploymentName !== deploymentName ||
        typeof v.buildId !== 'string' ||
        !v.buildId ||
        v.buildId.length > 200 ||
        versions.some((x) => x.buildId === v.buildId)
      )
        fail();
      const detail = await rpc(() =>
        service.describeWorkerDeploymentVersion({ namespace, deploymentVersion: v, reportTaskQueueStats: true })
      );
      const info = detail.workerDeploymentVersionInfo;
      if (
        hash(info?.deploymentVersion) !== hash(v) ||
        info.currentSinceTime ||
        info.rampingSinceTime ||
        Number(info.rampPercentage ?? 0) !== 0
      )
        fail();
      emptyCompute(info.computeConfig);
      const infos = array(info.taskQueueInfos),
        seen = new Set();
      for (const q of infos) {
        if (q.name !== queue || ![1, 2].includes(q.type) || seen.has(q.type)) fail();
        seen.add(q.type);
      }
      if (seen.size !== 2) fail();
      const stats = array(detail.versionTaskQueues);
      if (stats.length !== 2) fail();
      const seenStats = new Set();
      for (const q of stats) {
        if (
          q.name !== queue ||
          ![1, 2].includes(q.type) ||
          seenStats.has(q.type) ||
          !q.stats ||
          String(q.stats.approximateBacklogCount) !== '0'
        )
          fail();
        seenStats.add(q.type);
      }
      versions.push({
        buildId: v.buildId,
        queues: [1, 2],
        statsSHA256: hash(
          stats
            .map((q) => ({ name: q.name, type: q.type, backlog: String(q.stats.approximateBacklogCount) }))
            .sort((a, b) => a.type - b.type)
        ),
      });
    }
    if (mode !== 'never-started' && !versions.some((v) => v.buildId === plan.buildId)) fail();
    const partitions = await rpc(() =>
      service.listTaskQueuePartitions({ namespace, taskQueue: { name: queue, kind: 1 } })
    );
    const partitionRows = [];
    for (const [type, rows] of [
      [1, partitions.workflowTaskQueuePartitions],
      [2, partitions.activityTaskQueuePartitions],
    ]) {
      const seen = new Set();
      for (const part of array(rows)) {
        if (
          typeof part.key !== 'string' ||
          (part.key !== queue && !/^\/_sys\/urm-media-kernel-recovery\/[1-9][0-9]*$/.test(part.key)) ||
          seen.has(part.key)
        )
          fail();
        seen.add(part.key);
        const p = await rpc(() =>
          service.describeTaskQueue({ namespace, taskQueue: { name: part.key, kind: 1 }, taskQueueType: type })
        );
        if (array(p.pollers).length) throw new Error('MEDIA_DIAGNOSTIC_POLLERS_PRESENT');
        const route = p.versioningInfo;
        if (
          route?.currentDeploymentVersion?.buildId ||
          route?.rampingDeploymentVersion?.buildId ||
          Number(route?.rampingVersionPercentage ?? 0) !== 0
        )
          fail();
        partitionRows.push({ type, key: part.key, owner: part.ownerHostName ?? '' });
      }
      if (!seen.has(queue) || seen.size > 128) fail();
    }
    const workflows = [],
      tokens = new Set();
    let cursor;
    do {
      const page = await rpc(() =>
        service.listWorkflowExecutions({
          namespace,
          pageSize: 100,
          query: 'ExecutionStatus = "Running"',
          ...(cursor ? { nextPageToken: cursor } : {}),
        })
      );
      for (const e of array(page.executions)) {
        const x = e.execution;
        if (
          !uuid(x?.runId) ||
          typeof x.workflowId !== 'string' ||
          workflows.some((w) => w.runId === x.runId) ||
          workflows.length >= 500
        )
          fail();
        const native = await rpc(() => service.describeWorkflowExecution({ namespace, execution: x })),
          info = native.workflowExecutionInfo,
          v = info?.versioningInfo,
          version = v?.versioningOverride?.pinned?.version ?? v?.deploymentVersion;
        if (
          info?.status !== 1 ||
          hash(info.execution) !== hash(x) ||
          info.taskQueue === queue ||
          version?.deploymentName === deploymentName ||
          version?.buildId === plan.buildId ||
          !version?.deploymentName ||
          !version?.buildId ||
          (v?.versioningOverride && !v.versioningOverride.pinned) ||
          native.pendingActivities?.length ||
          native.pendingNexusOperations?.length ||
          native.pendingChildren?.length
        )
          fail();
        workflows.push({ runId: x.runId, executionSHA256: hash(x), nativeSHA256: hash(native) });
      }
      cursor = token(page.nextPageToken, tokens);
    } while (cursor);
    const rows = [];
    for (const collection of [
      'durableJobOutbox',
      'durableJobCommands',
      'durableJobCriticalSections',
      'durableActivityExecutions',
      'temporalProviderMutationSessions',
      'temporalProviderMutationLocks',
    ]) {
      let after;
      do {
        let q = db.collection(collection).orderBy('__name__').limit(100);
        if (after) q = q.startAfter(after);
        const page = await read(() => q.get());
        for (const doc of page.docs) {
          if (
            rows.length >= 3000 ||
            collection === 'durableJobCriticalSections' ||
            collection === 'temporalProviderMutationLocks' ||
            (collection === 'temporalProviderMutationSessions' &&
              !['committed', 'aborted'].includes(doc.get('state'))) ||
            (['durableJobOutbox', 'durableJobCommands'].includes(collection) &&
              (!['dispatched', 'failed'].includes(doc.get('state')) ||
                doc.get('leaseOwner') ||
                doc.get('leaseExpiresAt') > 0))
          )
            fail();
          if (doc.get('worker.buildId') === plan.buildId || doc.get('execution.worker.buildId') === plan.buildId) {
            const a = auth.ready,
              w = auth.worker;
            if (
              collection !== 'durableActivityExecutions' ||
              !a ||
              !w ||
              doc.get('projectId') !== 'urm-app-staging' ||
              doc.get('jobId') !== `media-recovery-${o.operationId}` ||
              doc.get('workflowId') !== a.workflowId ||
              doc.get('runId') !== a.runId ||
              doc.get('activityId') !== a.activityId ||
              doc.get('activityType') !== 'acquireMedia' ||
              doc.get('attempt') !== 2 ||
              hash(doc.get('worker')) !== hash(w)
            )
              fail();
          }
          rows.push({ pathSHA256: hash(doc.ref.path), stamp: stamp(doc) });
        }
        after = page.size === 100 ? page.docs.at(-1) : undefined;
      } while (after);
    }
    return {
      closureSHA256: auth.closureSHA256,
      authoritySHA256: auth.authoritySHA256,
      versions: versions.sort((a, b) => a.buildId.localeCompare(b.buildId)),
      partitions: partitionRows.sort((a, b) => a.type - b.type || a.key.localeCompare(b.key)),
      workflows: workflows.sort((a, b) => a.runId.localeCompare(b.runId)),
      rows: rows.sort((a, b) => a.pathSHA256.localeCompare(b.pathSHA256)),
    };
  };
  const beganMonotonic = performance.now();
  const began = Date.now(),
    first = await scan(),
    second = await scan(),
    compute = await read(() => observeNamespaceComputeIsolation(client, namespace));
  const final = await authority();
  if (
    hash(first) !== hash(second) ||
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

/** Immutable checkpoint validator; timestamps are never refreshed on resume. */
export function assertStoredMediaDiagnosticDrain(value, plan, pool) {
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
    value.versionCount < 1 ||
    value.versionCount > 100 ||
    !Number.isInteger(value.partitionCount) ||
    value.partitionCount < 2 ||
    value.partitionCount > 256
  )
    fail();
  return value;
}
export function assertFreshMediaDiagnosticDrain(value, plan, pool) {
  assertStoredMediaDiagnosticDrain(value, plan, pool);
  if (Math.abs(Date.now() - Date.parse(value.observedAt)) > 5000) fail();
  return value;
}

/** Only native pollers-present is pending. No work, signal, scale or authorization
 * renewal occurs while waiting; ambiguity and authority drift stop immediately. */
export async function waitForMediaDiagnosticDrain(o) {
  const controller = new AbortController(),
    end = Date.now() + 45000;
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    while (!controller.signal.aborted && Date.now() < end) {
      try {
        return await observeMediaDiagnosticDrain({ ...o, signal: controller.signal });
      } catch (error) {
        if (error?.message !== 'MEDIA_DIAGNOSTIC_POLLERS_PRESENT') throw error;
      }
      await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, end - Date.now()))));
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
export async function observeMediaDiagnosticNeverStarted(o) {
  try {
    return await observe(o, 'never-started');
  } catch {
    throw new Error('MEDIA_DIAGNOSTIC_NEVER_STARTED_UNCONFIRMED');
  }
}
