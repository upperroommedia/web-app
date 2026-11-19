import { proofDigest as hash, assertNativeSnapshot } from './temporal-release-runtime.mjs';
import { mediaRecoveryPhaseExpectation } from './temporal-media-recovery-phase-pool.mjs';
import { assertStoredMediaDiagnosticDrain } from './temporal-media-diagnostic-drain.mjs';
import { scanPrivateMediaInventory } from './temporal-media-private-inventory.mjs';
import { observeNamespaceComputeIsolation } from './temporal-compute-isolation.mjs';
const fail = () => {
  throw new Error('MEDIA_RECOVERY_PHASE_PROTECTION_UNCONFIRMED');
};
const namespace = 'urm-app-staging.qwejt';
const kinds = [
  'Kernel',
  'Startup',
  'Start',
  'OriginalReady',
  'OriginalSignal',
  'OriginalDeath',
  'Work',
  'ReplacementIntent',
  'ReplacementKernel',
  'ReplacementStartup',
  'ReplacementAdoption',
  'ReplacementCompleted',
  'ReplacementStop',
];
const stamp = (s) => {
  if (!s.exists || !s.createTime || !s.updateTime) fail();
  return hash({ data: s.data(), created: s.createTime, updated: s.updateTime });
};
// Normalize native timestamps BEFORE either digest canonicalizer runs. The
// release digester's Timestamp branch preserves insertion order, whereas a
// plain map is sorted; both source boundaries must hash the same plain map.
const factTime = (v) =>
  v && typeof v.toDate === 'function' ? { seconds: v.seconds, nanoseconds: v.nanoseconds } : v ?? null;
const phaseFresh = (v) => {
  const at = Date.parse(v?.observedAt);
  if (!Number.isFinite(at) || Math.abs(Date.now() - at) >= 5000) fail();
};
function monotonicIdle(a, b) {
  const rank = { absent: 0, armed: 1, born: 2, running: 3 };
  if (!(a.stage in rank) || !(b.stage in rank) || rank[b.stage] < rank[a.stage]) fail();
  for (const k of ['originSHA256', 'birthSHA256', 'workerSHA256']) if (a[k] && a[k] !== b[k]) fail();
  if (
    a.allowedPollerIdentity &&
    (a.allowedPollerIdentity !== b.allowedPollerIdentity || a.ownFactsSHA256 !== b.ownFactsSHA256)
  )
    fail();
}
/** Diagnostic phase policy only. No normal role validator gains an exception.
 * Fixed canonical callers supply readIdle from verified source; CLI/descriptors
 * cannot inject an identity, collector, callback or positive policy result. */
export async function observeMediaRecoveryProtection(o) {
  const { client, firestore: db, plan, phase, pool } = o,
    at = Date.now(),
    mono = performance.now();
  let live = true;
  const fresh = () => {
    if (
      !live ||
      Date.now() - at < 0 ||
      Date.now() - at >= 5000 ||
      performance.now() - mono < 0 ||
      performance.now() - mono >= 5000
    )
      fail();
  };
  const read = async (fn) => {
    let timer;
    try {
      fresh();
      const v = await Promise.race([
        Promise.resolve().then(() => {
          fresh();
          return fn();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('MEDIA_RECOVERY_PHASE_PROTECTION_UNCONFIRMED')),
            Math.max(1, 5000 - (Date.now() - at))
          );
        }),
      ]);
      fresh();
      return v;
    } catch {
      live = false;
      return fail();
    } finally {
      clearTimeout(timer);
    }
  };
  const rpc = (fn) => read(() => client.connection.withDeadline(at + 5000, fn));
  try {
    if (
      db.projectId !== 'urm-app-staging' ||
      db.databaseId !== '(default)' ||
      client.options.namespace !== namespace ||
      plan.operationId !== o.operationId ||
      o.phasePool?.kind !== 'private-media-phase-pool-v1' ||
      o.phasePool.operationId !== o.operationId ||
      o.phasePool.phase !== phase ||
      o.phasePool.planSHA256 !== hash(plan)
    )
      fail();
    phaseFresh(o.phasePool);
    const idle = phase === 'start' ? await read(() => o.readIdle()) : null;
    const authority = () =>
      read(() =>
        db.runTransaction(
          async (tx) => {
            fresh();
            const [root, c, s, journal, drain, ...facts] = await Promise.all(
              [
                o.lockRef,
                o.controlRef,
                o.stateRef,
                db.doc(`_control/temporalMediaRecoveryJournal-${o.operationId}`),
                db.doc(`_control/temporalMediaRecoveryDrain-${o.operationId}`),
                ...kinds.map((k) => db.doc(`_control/temporalMediaRecovery${k}-${o.operationId}`)),
              ].map((r) => tx.get(r))
            );
            assertNativeSnapshot(o.ownedOperation, root);
            assertNativeSnapshot(o.expectedAuthority.control, c);
            assertNativeSnapshot(o.expectedAuthority.state, s);
            const cycle = root.get('cloudMediaRecovery'),
              expected = mediaRecoveryPhaseExpectation(plan, phase, pool, cycle),
              j = journal.data(),
              f = Object.fromEntries(kinds.map((k, i) => [k, facts[i]]));
            if (
              root.get('action') !== 'diagnose-cloud-run-media-recovery' ||
              root.get('operationId') !== o.operationId ||
              root.get('bindingDigest') !== o.bindingDigest ||
              root.get('releaseId') !== plan.releaseId ||
              c.get('admission') !== 'paused' ||
              c.get('releaseId') !== plan.releaseId ||
              s.get('phase') !== 'provider-usage-ready' ||
              s.get('releaseId') !== plan.releaseId ||
              ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
                (k) => c.get(`domains.${k}.admission`) !== 'paused'
              ) ||
              !journal.exists ||
              j.operationId !== o.operationId ||
              j.planSHA256 !== hash(plan) ||
              j.buildId !== plan.buildId ||
              j.image !== plan.image ||
              cycle.prepared?.proofSHA256 !== hash(j) ||
              root.get('mediaRecoveryJournalAttempt.stage') !== 'completed' ||
              root.get('mediaRecoveryJournalAttempt.recordSHA256') !== hash(j)
            )
              fail();
            if (
              ['diagnostic', 'start'].includes(phase) &&
              ['before-attempt', 'attempted'].includes(expected.stage) &&
              Date.now() >= plan.expiresAt
            )
              fail();
            const position = expected.exact
              ? 'exact'
              : expected.stage === 'acknowledged'
              ? o.phasePool.position
              : 'before';
            if (position !== o.phasePool.position || !['before', 'successor', 'exact'].includes(position)) fail();
            let ready, worker;
            const never = phase === 'never-started' || Boolean(cycle.neverStarted);
            if (phase === 'start') {
              if (
                !idle ||
                idle.kind !== 'owned-idle-media-startup-v1' ||
                idle.operationId !== o.operationId ||
                idle.planSHA256 !== hash(plan) ||
                idle.buildId !== plan.buildId ||
                idle.scope !== 'identity-only-no-work-or-poll-authority'
              )
                fail();
              phaseFresh(idle);
              const digest = hash(
                facts.map((x) => ({
                  exists: x.exists,
                  data: x.data() ?? null,
                  createTime: factTime(x.createTime),
                  updateTime: factTime(x.updateTime),
                }))
              );
              const k = f.Kernel.data(),
                startup = f.Startup.data();
              const actualStage = k?.stage ?? 'absent';
              const actualIdentity =
                k?.stage === 'running' && startup ? `media-recovery-${k.worker?.instanceId}` : null;
              if (
                idle.stage !== actualStage ||
                idle.allowedPollerIdentity !== actualIdentity ||
                idle.originSHA256 !== (k ? hash({ context: k.context, intent: k.intent }) : null) ||
                idle.birthSHA256 !== (k?.birth ? hash(k.birth) : null) ||
                idle.workerSHA256 !== (k?.worker ? hash(k.worker) : null) ||
                (actualIdentity &&
                  !/^media-recovery-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(actualIdentity))
              )
                fail();
              if (
                digest !== idle.ownFactsSHA256 ||
                root.get('mediaRecoveryWorkflowStart') !== undefined ||
                facts.slice(2).some((x) => x.exists) ||
                drain.exists
              )
                fail();
            } else if (phase === 'diagnostic' || never) {
              if (root.get('mediaRecoveryWorkflowStart') !== undefined || facts.some((x) => x.exists) || drain.exists)
                fail();
            } else {
              if (!cycle.drained || !drain.exists || cycle.start?.stage !== 'completed') fail();
              assertStoredMediaDiagnosticDrain(cycle.drained.observation, plan, cycle.start.pool);
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
              const closure = hash([
                stamp(f.Kernel),
                f.ReplacementKernel.exists ? stamp(f.ReplacementKernel) : null,
                f.ReplacementIntent.exists ? stamp(f.ReplacementIntent) : null,
              ]);
              if (
                closure !== cycle.drained.observation.closureSHA256 ||
                f.Kernel.get('stage') !== 'closed' ||
                f.Kernel.get('close.descendantsAbsent') !== true ||
                (f.ReplacementKernel.exists &&
                  (f.ReplacementKernel.get('stage') !== 'closed' ||
                    f.ReplacementKernel.get('close.descendantsAbsent') !== true))
              )
                fail();
              ready = f.OriginalReady.data();
              worker = f.ReplacementKernel.get('worker');
            }
            return {
              ready,
              worker,
              allowAbsent: phase === 'diagnostic' || phase === 'start' || never,
              authoritySHA256: hash([stamp(root), stamp(c), stamp(s)]),
              ownFactsSHA256: idle?.ownFactsSHA256 ?? null,
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
        allowAbsent: auth.allowAbsent,
        allowedPollerIdentity: idle?.allowedPollerIdentity ?? null,
      });
      const { ownedPollers, ...protectedInventory } = inventory;
      return { auth, protectedInventory, ownedPollers };
    };
    const first = await scan(),
      second = await scan(),
      compute = await read(() => observeNamespaceComputeIsolation(client, namespace, { deadline: at + 5000 }));
    const lastIdle = phase === 'start' ? await read(() => o.readIdle()) : null;
    if (idle) monotonicIdle(idle, lastIdle);
    const final = await authority();
    if (
      hash(first.protectedInventory) !== hash(second.protectedInventory) ||
      first.auth.authoritySHA256 !== second.auth.authoritySHA256 ||
      final.authoritySHA256 !== first.auth.authoritySHA256
    )
      fail();
    phaseFresh(o.phasePool);
    phaseFresh(compute);
    fresh();
    return {
      operationId: o.operationId,
      phase,
      role: 'media',
      buildId: plan.buildId,
      namespace,
      contractSHA256: hash(plan.contract),
      protectionSHA256: hash(first.protectedInventory),
      computeInventorySHA256: compute.inventorySHA256,
      ownStartupSHA256: lastIdle?.ownFactsSHA256 ?? null,
      ownedPollersSHA256: hash(second.ownedPollers),
      observedAt: new Date(at).toISOString(),
    };
  } catch {
    return fail();
  }
}
