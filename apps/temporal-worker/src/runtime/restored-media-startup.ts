import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import type { WorkerWitness } from './worker-witness';
import { workerReadinessDigest as hash } from './readiness-probe';
import { releaseProvenanceDigest } from './media-recovery-history';
import {
  runMediaFilesystemCanary,
  validateMediaStartupCapacityEvidence,
  mediaStartupBudget,
} from './media-startup-capacity';
import { readRestoredMediaKernelBirth, validateMediaKernelBirthRecord } from './media-kernel-supervisor';
const fail = (): never => {
  throw new Error('RESTORED_MEDIA_STARTUP_UNCONFIRMED');
};
const object = (x: unknown): Record<string, any> =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, any>) : fail();
const uuid = (x: unknown): x is string =>
  typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const sha = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const domains = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'];
async function boundedRead<T>(fn: () => Promise<T>): Promise<T> {
  const at = Date.now(),
    mono = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fresh = () => {
    if (Date.now() < at || Date.now() - at >= 5000 || performance.now() - mono >= 5000) fail();
  };
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => {
        fresh();
        return fn();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('RESTORED_MEDIA_STARTUP_UNCONFIRMED')), 5000);
      }),
    ]);
    fresh();
    return value;
  } finally {
    clearTimeout(timer);
  }
}

const stamp = (s: any) =>
  s.exists && s.createTime && s.updateTime
    ? {
        createTime: { seconds: s.createTime.seconds, nanoseconds: s.createTime.nanoseconds },
        updateTime: { seconds: s.updateTime.seconds, nanoseconds: s.updateTime.nanoseconds },
      }
    : fail();
const version = (s: any) => hash(stamp(s));
export const RESTORED_MEDIA_STARTUP_COLLECTION = 'temporalRestoredMediaStartupCapacity';
/** Fixed new-action preimage. Neither an old bootstrap state nor a diagnostic
 * birth can be converted into this intent. ACK/LRO convergence never retimes it. */
export function restoredMediaStartupIntent(raw: unknown) {
  return parseRestoredMediaStartupIntent(raw, 'live');
}
/** Fixed read-only historical phase preimage. It conveys no birth, polling,
 * work, or renewed live capability and never changes the current parent. */
export function restoredMediaHistoricalStartupIntent(raw: unknown) {
  return parseRestoredMediaStartupIntent(raw, 'historical');
}
function parseRestoredMediaStartupIntent(raw: unknown, scope: 'live' | 'historical') {
  const op = object(raw),
    s = object(op.cloudRestoredMediaActivation),
    p = object(s.plan),
    x = object(s.start),
    origin = object(p.origin),
    before = object(x.before);
  if (
    op.action !== 'activate-restored-cloud-run-media' ||
    !uuid(op.operationId) ||
    !uuid(op.releaseId) ||
    !sha(op.bindingDigest) ||
    p.operationId !== op.operationId ||
    p.releaseId !== op.releaseId ||
    p.bindingDigest !== op.bindingDigest ||
    p.schemaVersion !== 1 ||
    p.role !== 'media' ||
    !uuid(p.recoveryOperationId) ||
    p.recoveryOperationId === p.operationId ||
    !sha(p.evidenceDigest) ||
    !sha(p.receiptsSHA256) ||
    !/^[a-f0-9]{40}$/.test(p.buildId ?? '') ||
    !/^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(p.image ?? '') ||
    !(
      scope === 'live' ? ['starting', 'started', 'completed'] : ['starting', 'started', 'cleaning', 'completed']
    ).includes(s.stage) ||
    (scope === 'live' && (s.stop || s.cleanup || (s.stage === 'completed' && s.disposition !== 'retained'))) ||
    (scope === 'historical' &&
      s.cleanup &&
      (x.stage !== 'completed' ||
        s.cleanup.kind !== 'unused-cleanup' ||
        s.cleanup.operationId !== p.operationId ||
        s.cleanup.planSHA256 !== hash(p) ||
        !Number.isFinite(Date.parse(s.cleanup.decisionAt)))) ||
    (scope === 'historical' && s.stop && (!s.cleanup || x.stage !== 'completed' || s.registration)) ||
    !['attempted', 'acknowledged', 'completed'].includes(x.stage) ||
    !Number.isFinite(Date.parse(x.attemptedAt)) ||
    Date.parse(x.attemptedAt) < Date.parse(p.createdAt) ||
    !Number.isFinite(Date.parse(p.createdAt)) ||
    origin.kind !== 'restored-media-activation-origin-v1' ||
    origin.operationId !== p.operationId ||
    origin.recoveryOperationId !== p.recoveryOperationId ||
    origin.bindingDigest !== p.bindingDigest ||
    origin.releaseId !== p.releaseId ||
    origin.buildId !== p.buildId ||
    origin.image !== p.image ||
    !sha(origin.capsuleSHA256) ||
    !sha(origin.proofSHA256) ||
    hash(before) !== hash(origin.pool) ||
    before.desiredManualInstanceCount !== 0 ||
    !before.uid ||
    !before.revisionUid ||
    !before.etag ||
    before.name !==
      `projects/urm-app-staging/locations/us-central1/workerPools/urm-worker-media-${p.buildId.slice(0, 20)}` ||
    typeof before.revision !== 'string' ||
    !before.revision.startsWith(`${before.name}/revisions/`) ||
    hash(p.startup) !==
      hash({
        protocol: 'restored-normal-media-kernel-v1',
        capacity: 'filesystem-allocation-native-audio-and-kernel-v4',
        ...mediaStartupBudget,
      }) ||
    !sha(x.phaseSHA256) ||
    !sha(x.computeSHA256) ||
    !x.quota ||
    hash(x.request) !==
      hash({
        url: `https://run.googleapis.com/v2/${before.name}?updateMask=scaling`,
        method: 'PATCH',
        body: { name: before.name, etag: before.etag, scaling: { manualInstanceCount: 1 } },
      }) ||
    Object.keys(object(p.receiptIds)).sort().join(',') !==
      'bootstrapCycle,firestore,pool,poolAccess,projectAccess,projectRole,recovery,runner,runnerScaler,scaler,scalerTrust,storageAccess,storageRole' ||
    p.receiptIds.recovery !== p.recoveryOperationId ||
    new Set(Object.values(p.receiptIds)).size !== 13 ||
    Object.values(p.receiptIds).some((id) => !uuid(id) || id === p.operationId)
  )
    fail();
  if (
    x.stage === 'completed' &&
    (x.pool?.uid !== before.uid ||
      x.pool.revision !== before.revision ||
      x.pool.revisionUid !== before.revisionUid ||
      x.pool.desiredManualInstanceCount !== 1 ||
      !/^[1-9][0-9]*$/.test(String(before.generation)) ||
      BigInt(x.pool.generation) !== BigInt(before.generation) + 1n)
  )
    fail();
  const intent = {
    kind: 'restored-normal-media-startup-v1',
    operationId: p.operationId,
    recoveryOperationId: p.recoveryOperationId,
    releaseId: p.releaseId,
    bindingDigest: p.bindingDigest,
    plan: p,
    start: {
      before,
      request: x.request,
      attemptedAt: x.attemptedAt,
      phaseSHA256: x.phaseSHA256,
      computeSHA256: x.computeSHA256,
      quota: x.quota,
    },
  };
  return { intent, intentSHA256: hash(intent), plan: p, start: x };
}
/** One original application child only. The distinct path/context gives no
 * diagnostic fault/replacement or original receipt authority. */
async function kernelContext(db: Firestore, auth: () => Auth, witness: WorkerWitness) {
  if (!('projectId' in db) || db.projectId !== 'urm-app-staging' || db.databaseId !== '(default)') fail();
  const root = db.doc('_control/temporalReleaseOperation');
  if ((await boundedRead(() => root.get())).get('action') !== 'activate-restored-cloud-run-media') return undefined;
  let original: any;
  const refs = [root, db.doc('_control/temporalRelease'), db.doc('_control/temporalReleaseState')];
  const read = async (tx: Transaction) => {
    const [op, c, s] = await Promise.all(refs.map((r) => tx.get(r))),
      owned = restoredMediaStartupIntent(op.data()),
      p = owned.plan;
    const [cap, done] = await Promise.all(
      [
        `_control/temporalMediaRecoveryCapsule-${p.recoveryOperationId}`,
        `_control/temporalCloudMediaRecovery-${p.recoveryOperationId}`,
      ].map((path) => tx.get(db.doc(path)))
    );
    const value = cap.data() ?? fail(),
      { capsuleSHA256, ...preimage } = value,
      cloud = witness.cloudRun;
    const jobMode = Boolean(done.get('identityState.plan.job'));
    if (
      !done.exists ||
      value.schemaVersion !== (jobMode ? 2 : 1) ||
      value.kind !==
        (jobMode ? 'completed-media-recovery-job-provenance-v2' : 'completed-media-recovery-provenance-only-v1') ||
      capsuleSHA256 !== p.origin.capsuleSHA256 ||
      releaseProvenanceDigest(preimage) !== capsuleSHA256 ||
      value.operationId !== p.recoveryOperationId ||
      value.releaseId !== p.releaseId ||
      value.source?.buildId !== p.buildId ||
      value.source.image !== p.image ||
      value.source.evidenceDigest !== p.evidenceDigest ||
      value.completionSHA256 !== releaseProvenanceDigest(done.data()) ||
      hash(value.restoredPool) !== hash(p.origin.pool) ||
      hash(stamp(cap).createTime) !== hash(stamp(cap).updateTime) ||
      hash(stamp(done).createTime) !== hash(stamp(done).updateTime) ||
      hash(stamp(cap).createTime) !== hash(stamp(done).createTime) ||
      op.get('operatorPrincipal.adcAndGcloudAccountMatch') !== true ||
      c.get('releaseId') !== p.releaseId ||
      s.get('releaseId') !== p.releaseId ||
      c.get('admission') !== 'paused' ||
      s.get('phase') !== 'provider-usage-ready' ||
      domains.some((d) => c.get(`domains.${d}.admission`) !== 'paused') ||
      !cloud ||
      !uuid(witness.instanceId) ||
      witness.buildId !== p.buildId ||
      cloud.projectId !== 'urm-app-staging' ||
      cloud.region !== 'us-central1' ||
      cloud.pool !== owned.start.before.name.split('/').at(-1) ||
      cloud.revision !== owned.start.before.revision.split('/').at(-1) ||
      cloud.revisionUid !== owned.start.before.revisionUid ||
      cloud.imageDigest !== p.image.split('@')[1] ||
      cloud.serviceAccount !== `tw-m-${p.buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com` ||
      !cloud.instanceId
    )
      fail();
    const actor = await auth().getUserByEmail(op.get('operatorPrincipal.email'));
    if (actor.disabled || actor.email !== op.get('operatorPrincipal.email') || actor.customClaims?.role !== 'admin')
      fail();
    const current = {
      intentSHA256: owned.intentSHA256,
      plan: p,
      controlVersion: version(c),
      stateVersion: version(s),
      rootCreation: stamp(op).createTime,
      capsuleStamp: stamp(cap),
      completionStamp: stamp(done),
      actorUid: actor.uid,
      attemptedAt: owned.start.attemptedAt,
    };
    if (original && hash(current) !== hash(original)) fail();
    original = current;
    if (
      Date.now() >= Date.parse(owned.start.attemptedAt) + 120000 ||
      Date.parse(owned.start.attemptedAt) > Date.now() + 5000
    )
      fail();
  };
  const authorize = async (tx: Transaction) => {
    const began = Date.now(),
      mono = performance.now();
    await boundedRead(() => read(tx));
    if (Date.now() < began || Date.now() - began >= 5000 || performance.now() - mono >= 5000) fail();
  };
  await boundedRead(() => db.runTransaction(authorize, { readOnly: true }));
  const deadline = Date.parse(original.attemptedAt) + 120000,
    monotonicDeadline = performance.now() + Math.max(0, deadline - Date.now());
  const fresh = () => {
    if (
      Date.now() >= deadline ||
      performance.now() >= monotonicDeadline ||
      Date.parse(original.attemptedAt) > Date.now() + 5000
    )
      fail();
  };
  fresh();

  return {
    context: {
      operationId: original.plan.operationId,
      intentSHA256: original.intentSHA256,
      controlVersion: original.controlVersion,
      stateVersion: original.stateVersion,
      parent: witness,
      protocol: 'restored-normal-media-kernel-v1',
      actorUid: original.actorUid,
      recoveryOperationId: original.plan.recoveryOperationId,
      capsuleSHA256: original.plan.origin.capsuleSHA256,
    },
    authorize,
    checkFresh: fresh,
    plan: original.plan,
    attemptedAt: original.attemptedAt,
  };
}

export async function restoredMediaKernelContext(db: Firestore, auth: () => Auth, witness: WorkerWitness) {
  try {
    return await kernelContext(db, auth, witness);
  } catch {
    return fail();
  }
}

/** Distinct startup receipt before Worker.create. Source-fixed real canary is
 * default; tests may supply controlled capacity reports, which are not native
 * allocation/image acceptance. No ordinary readiness receipt shape changes. */
export async function recordRestoredMediaStartupCapacity(options: {
  firestore: Firestore;
  auth: () => Auth;
  buildId: string;
  witness: WorkerWitness;
  kernel?: { operationId: string; birthDigest: string };
  isDraining?: () => boolean;
  canary?: typeof runMediaFilesystemCanary;
}) {
  try {
    const { firestore: db, witness } = options;
    const cap = await restoredMediaKernelContext(db, options.auth, witness);
    if (!cap) return false;
    if (options.buildId !== cap.plan.buildId || !options.kernel) fail();
    const kernel = await boundedRead(() =>
      readRestoredMediaKernelBirth(db, cap.context.operationId, cap.context.intentSHA256, options.kernel, witness)
    );
    if (
      kernel.value.stage !== 'running' ||
      kernel.value.birth.pid !== process.pid ||
      kernel.value.context.protocol !== 'restored-normal-media-kernel-v1' ||
      kernel.value.context.recoveryOperationId !== cap.plan.recoveryOperationId ||
      kernel.value.context.capsuleSHA256 !== cap.plan.origin.capsuleSHA256
    )
      fail();
    const authorize = async (tx: Transaction) => {
      await cap.authorize(tx);
      cap.checkFresh();
      if (options.isDraining?.()) fail();
    };
    const capacity = await (options.canary ?? runMediaFilesystemCanary)(options.isDraining, undefined, undefined, () =>
      boundedRead(() => db.runTransaction(authorize, { readOnly: true }))
    );
    validateMediaStartupCapacityEvidence(capacity, cap.attemptedAt);
    cap.checkFresh();
    const evidence = {
      schemaVersion: 1,
      kind: 'restored-normal-media-startup-capacity-v1',
      operationId: cap.context.operationId,
      recoveryOperationId: cap.plan.recoveryOperationId,
      intentSHA256: cap.context.intentSHA256,
      capsuleSHA256: cap.plan.origin.capsuleSHA256,
      kernel: options.kernel,
      worker: witness,
      capacity,
      observedAt: new Date().toISOString(),
    };
    const record = { ...evidence, digest: hash(evidence) },
      ref = db.collection(RESTORED_MEDIA_STARTUP_COLLECTION).doc(cap.context.operationId);
    try {
      await boundedRead(() =>
        db.runTransaction(
          async (tx) => {
            await authorize(tx);
            tx.create(ref, record);
          },
          { maxAttempts: 1 }
        )
      );
    } catch (e) {
      if ([3, 5, 6, 7, 9, 11, 12, 16].includes(Number((e as { code?: unknown })?.code))) fail();
    }
    const kernelRef = db.doc(`_control/temporalRestoredMediaKernel-${cap.context.operationId}`);
    const readPollingAuthority = async () => {
      const facts = await boundedRead(() =>
        db.runTransaction(
          async (tx) => {
            await authorize(tx);
            const [receipt, current] = await Promise.all([tx.get(ref), tx.get(kernelRef)]);
            const nativeBirth = validateMediaKernelBirthRecord(
              current.data(),
              cap.context.operationId,
              cap.context.intentSHA256,
              options.kernel,
              witness
            );
            const receiptVersion = stamp(receipt);
            if (
              hash(receiptVersion.createTime) !== hash(receiptVersion.updateTime) ||
              hash(receipt.data()) !== hash(record) ||
              nativeBirth.value.stage !== 'running' ||
              hash(nativeBirth.value) !== hash(kernel.value)
            )
              fail();
            return { receiptVersion, kernelVersion: stamp(current) };
          },
          { readOnly: true }
        )
      );
      cap.checkFresh();
      if (options.isDraining?.()) fail();
      return facts;
    };
    const issued = await readPollingAuthority();
    return {
      authorizePolling: async () => {
        if (hash(await readPollingAuthority()) !== hash(issued)) fail();
      },
    };
  } catch {
    return fail();
  }
}
