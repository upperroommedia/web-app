/** GET-only original startup authentication before SDK START. No polling, work,
 * signal, replacement or mutation authority is returned by this collector. */
import type { Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import { mediaRecoveryKernelContext } from './media-recovery-capability';
import { validateMediaKernelBirthRecord } from './media-kernel-supervisor';
import { validateHistoricalMediaRecoveryCapacity } from './media-startup-capacity';
import { workerReadinessDigest as hash } from './readiness-probe';
const fail = (): never => {
  throw new Error('MEDIA_RECOVERY_IDLE_STARTUP_UNCONFIRMED');
};
const exact = (v: any, keys: string) => {
  if (!v || Object.keys(v).sort().join(',') !== keys) fail();
};
const time = (v: any) => {
  const n = Date.parse(v);
  if (!Number.isFinite(n) || n > Date.now() + 5000) fail();
  return n;
};
const uuid = (v: any) =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
type Options = {
  db: Firestore;
  auth: Auth;
  operationId: string;
  plan: any;
  phasePool: any;
  expectedRootSHA256: string;
  expectedControlSHA256: string;
  expectedStateSHA256: string;
  image?: { bundleSHA256: string; tools: { pythonSHA256: string; ffmpegSHA256: string; ffprobeSHA256: string } };
};
export async function collectMediaRecoveryIdleStartup(o: Options) {
  const deadline = Date.now() + 5000,
    monotonic = performance.now();
  let live = true;
  const fresh = () => {
    if (!live || Date.now() >= deadline || performance.now() - monotonic >= 5000) fail();
  };
  const read = async <T>(fn: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      fresh();
      const v = await Promise.race([
        Promise.resolve().then(() => {
          fresh();
          return fn();
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('MEDIA_RECOVERY_IDLE_STARTUP_UNCONFIRMED')),
            Math.max(1, deadline - Date.now())
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
  try {
    if (
      !('projectId' in o.db) ||
      o.db.projectId !== 'urm-app-staging' ||
      o.db.databaseId !== '(default)' ||
      o.plan.operationId !== o.operationId ||
      o.phasePool?.kind !== 'private-media-phase-pool-v1' ||
      o.phasePool.phase !== 'start' ||
      o.phasePool.operationId !== o.operationId ||
      o.phasePool.planSHA256 !== hash(o.plan) ||
      Date.now() - time(o.phasePool.observedAt) >= 5000
    )
      fail();
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
    const snapshot = () =>
      read(() =>
        o.db.runTransaction(
          async (tx) => {
            fresh();
            const [root, c, s, ...facts] = await Promise.all(
              [
                '_control/temporalReleaseOperation',
                '_control/temporalRelease',
                '_control/temporalReleaseState',
                ...kinds.map((k) => `_control/temporalMediaRecovery${k}-${o.operationId}`),
              ].map((p) => tx.get(o.db.doc(p)))
            );
            if (
              hash(root.data()) !== o.expectedRootSHA256 ||
              hash(c.data()) !== o.expectedControlSHA256 ||
              hash(s.data()) !== o.expectedStateSHA256 ||
              root.get('action') !== 'diagnose-cloud-run-media-recovery' ||
              root.get('operationId') !== o.operationId ||
              hash(root.get('cloudMediaRecovery.plan')) !== hash(o.plan) ||
              root.get('cloudMediaRecovery.stage') !== 'prepared' ||
              root.get('mediaRecoveryWorkflowStart') !== undefined ||
              root.get('cloudMediaRecovery.stop') ||
              facts.slice(2).some((f) => f.exists)
            )
              fail();
            return {
              kernel: facts[0].data(),
              startup: facts[1].data(),
              factsSHA256: hash(
                facts.map((f) => ({
                  exists: f.exists,
                  data: f.data() ?? null,
                  createTime: f.createTime
                    ? { seconds: f.createTime.seconds, nanoseconds: f.createTime.nanoseconds }
                    : null,
                  updateTime: f.updateTime
                    ? { seconds: f.updateTime.seconds, nanoseconds: f.updateTime.nanoseconds }
                    : null,
                }))
              ),
              root: root.data()!,
            };
          },
          { readOnly: true }
        )
      );
    const before = await snapshot(),
      k = before.kernel,
      start = before.root.cloudMediaRecovery.start;
    if (!['acknowledged', 'completed'].includes(start?.stage)) {
      if (k || before.startup) fail();
    } else if (k) {
      if (!['successor', 'exact'].includes(o.phasePool.position)) fail();
      const cap = await read(() => mediaRecoveryKernelContext(o.db, o.auth, k.context?.parent, o.operationId));
      if (hash(k.context) !== hash(cap.context) || hash(cap.plan) !== hash(o.plan)) fail();
      exact(k.intent, 'createdAt,launchId,parentPid');
      if (
        k.schemaVersion !== 1 ||
        !['armed', 'born', 'running'].includes(k.stage) ||
        !uuid(k.intent.launchId) ||
        !Number.isSafeInteger(k.intent.parentPid) ||
        k.intent.parentPid <= 0 ||
        time(k.intent.createdAt) < time(o.plan.createdAt) ||
        time(k.intent.createdAt) >= o.plan.expiresAt
      )
        fail();
      exact(
        k,
        [
          'context',
          'intent',
          'schemaVersion',
          'stage',
          ...(['born', 'running'].includes(k.stage) ? ['birth'] : []),
          ...(k.stage === 'running' ? ['worker'] : []),
        ]
          .sort()
          .join(',')
      );
      if (k.stage !== 'armed') {
        exact(k.birth, 'nonce,pid,spawnedAt');
        if (
          !uuid(k.birth.nonce) ||
          !Number.isSafeInteger(k.birth.pid) ||
          k.birth.pid <= 0 ||
          k.birth.pid === k.intent.parentPid ||
          time(k.birth.spawnedAt) < time(k.intent.createdAt) ||
          time(k.birth.spawnedAt) >= o.plan.expiresAt
        )
          fail();
      }
      if (k.stage === 'running') {
        const birthDigest = hash({ context: k.context, intent: k.intent, birth: k.birth, worker: k.worker });
        validateMediaKernelBirthRecord(
          k,
          o.operationId,
          cap.context.intentSHA256,
          { operationId: o.operationId, birthDigest },
          k.worker
        );
        if (before.startup) {
          const s = before.startup,
            image = o.image ?? fail();
          exact(s, 'bundle,capacity,intentSHA256,kernel,kind,observedAt,operationId,schemaVersion,worker');
          exact(s.bundle, 'buildId,bundleBytes,bundleSHA256,schemaVersion');
          exact(s.kernel, 'birthDigest,operationId');
          if (
            s.schemaVersion !== 1 ||
            s.kind !== 'private-diagnostic-startup-only-no-recovery-proof' ||
            s.operationId !== o.operationId ||
            s.intentSHA256 !== cap.context.intentSHA256 ||
            hash(s.worker) !== hash(k.worker) ||
            s.kernel.operationId !== o.operationId ||
            s.kernel.birthDigest !== birthDigest ||
            s.bundle.schemaVersion !== 1 ||
            s.bundle.buildId !== o.plan.buildId ||
            s.bundle.bundleSHA256 !== image.bundleSHA256 ||
            !/^[a-f0-9]{64}$/.test(image.bundleSHA256) ||
            !Number.isSafeInteger(s.bundle.bundleBytes) ||
            s.bundle.bundleBytes < 1 ||
            s.bundle.bundleBytes > 64 * 1024 * 1024 ||
            time(s.observedAt) < time(k.birth.spawnedAt) ||
            time(s.observedAt) >= o.plan.expiresAt
          )
            fail();
          const capacity = validateHistoricalMediaRecoveryCapacity(s.capacity, k.birth.spawnedAt, s.observedAt);
          if (
            capacity.allocation.pythonSHA256 !== image.tools.pythonSHA256 ||
            capacity.processing.ffmpegSHA256 !== image.tools.ffmpegSHA256 ||
            capacity.processing.ffprobeSHA256 !== image.tools.ffprobeSHA256 ||
            Object.values(image.tools).some((v) => !/^[a-f0-9]{64}$/.test(v))
          )
            fail();
        }
      } else if (before.startup) fail();
      await read(() => o.db.runTransaction(cap.authorize, { readOnly: true }));
      cap.checkFresh();
    } else if (before.startup) fail();
    const after = await snapshot();
    if (after.factsSHA256 !== before.factsSHA256) fail();
    fresh();
    const allowedPollerIdentity =
      k?.stage === 'running' && before.startup ? `media-recovery-${k.worker.instanceId}` : null;
    return {
      schemaVersion: 1,
      kind: 'owned-idle-media-startup-v1',
      operationId: o.operationId,
      planSHA256: hash(o.plan),
      ownFactsSHA256: after.factsSHA256,
      originSHA256: k ? hash({ context: k.context, intent: k.intent }) : null,
      birthSHA256: k?.birth ? hash(k.birth) : null,
      workerSHA256: k?.worker ? hash(k.worker) : null,
      stage: k?.stage ?? 'absent',
      allowedPollerIdentity,
      buildId: o.plan.buildId,
      observedAt: new Date(deadline - 5000).toISOString(),
      scope: 'identity-only-no-work-or-poll-authority',
    };
  } catch {
    return fail();
  }
}
