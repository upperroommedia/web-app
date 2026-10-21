import { runNativeMediaProcessingCanary, MEDIA_STARTUP_CANARY_KIND } from './media-processing-canary';
import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, mkdtemp, rm, stat, statfs, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Firestore } from 'firebase-admin/firestore';
import type { WorkerWitness } from './worker-witness';
import { workerReadinessDigest } from './readiness-probe';
import {
  mediaResources,
  reserveMediaWorkspace,
  checkMediaWorkspace,
} from '../../../process-audio/src/temporal/resources';

const GiB = 1024 ** 3;
const failure = (): never => {
  throw new Error('MEDIA_STARTUP_CAPACITY_UNCONFIRMED');
};
const object = (x: unknown): Record<string, any> =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, any>) : failure();
const uuid = (x: unknown) =>
  typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const hash = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export const MEDIA_STARTUP_CAPACITY_COLLECTION = 'temporalMediaStartupCapacity';
export const mediaStartupBudget = Object.freeze({
  sourceBytes: 20 * GiB,
  outputBytes: 20 * GiB,
  workspaceBytes: 64 * GiB,
  headroomBytes: 16 * GiB,
});

/** Source-owned attempted scale checkpoint is the startup intent. No new signal,
 * Workflow, Activity queue or polling loop is introduced. */
export function mediaStartupIntent(raw: unknown) {
  const operation = object(raw),
    field =
      operation.action === 'bootstrap-stop-cloud-run-media'
        ? 'cloudMediaBootstrapCycle'
        : operation.action === 'activate-cloud-run-media-pool'
        ? 'cloudMediaActivation'
        : failure();
  const state = object(operation[field]),
    plan = object(state.plan),
    start = object(state.start),
    p = object(plan.mediaStartup);
  if (
    !uuid(operation.operationId) ||
    !uuid(operation.releaseId) ||
    !hash(operation.bindingDigest) ||
    plan.operationId !== operation.operationId ||
    plan.releaseId !== operation.releaseId ||
    plan.role !== 'media' ||
    !hash(plan.evidenceDigest) ||
    !/^[a-f0-9]{40}$/.test(plan.buildId ?? '') ||
    !['starting', 'started', 'stopping', 'completed'].includes(state.stage) ||
    state.stop !== undefined ||
    (state.stage === 'completed' && state.disposition !== 'retained') ||
    !['attempted', 'acknowledged', 'completed'].includes(start.stage) ||
    start.plan?.operationId !== operation.operationId ||
    start.plan?.mode !== 'start' ||
    start.plan?.target !== 1 ||
    !Number.isFinite(Date.parse(start.attemptedAt ?? '')) ||
    Date.parse(start.attemptedAt) > Date.now() + 5000 ||
    typeof start.before?.uid !== 'string' ||
    !start.before.uid ||
    typeof start.before?.revision !== 'string' ||
    !start.before.revision ||
    start.plan.origin?.uid !== start.before.uid ||
    start.plan.origin?.revision !== start.before.revision ||
    start.before.desiredManualInstanceCount !== 0 ||
    start.request?.method !== 'PATCH' ||
    start.request.body?.name !== plan.name ||
    start.request.body?.scaling?.manualInstanceCount !== 1 ||
    start.request.url !== `https://run.googleapis.com/v2/${plan.name}?updateMask=scaling` ||
    plan.name !==
      `projects/urm-app-staging/locations/us-central1/workerPools/urm-worker-media-${plan.buildId.slice(0, 20)}` ||
    Object.keys(p).sort().join(',') !== 'budgets,canary,image,runner' ||
    p.canary !== MEDIA_STARTUP_CANARY_KIND ||
    workerReadinessDigest(p.budgets) !== workerReadinessDigest(mediaStartupBudget) ||
    !/^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(p.image ?? '') ||
    p.runner !== `tw-m-${plan.buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com`
  )
    failure();
  const intent = {
    schemaVersion: 1,
    operationId: operation.operationId,
    releaseId: operation.releaseId,
    bindingDigest: operation.bindingDigest,
    action: operation.action,
    plan,
    start: {
      plan: start.plan,
      attemptedAt: start.attemptedAt,
      before: start.before,
      request: start.request,
      access: start.access,
      protection: start.protection,
    },
  };
  return { intent, intentSHA256: workerReadinessDigest(intent), plan, start };
}
function paused(operation: any, control: any, state: any) {
  if (
    control?.releaseId !== operation.releaseId ||
    state?.releaseId !== operation.releaseId ||
    control?.admission !== 'paused' ||
    state?.phase !== 'provider-usage-ready'
  )
    failure();
  const domains = object(control.domains);
  if (!Object.keys(domains).length || Object.values(domains).some((v) => object(v).admission !== 'paused')) failure();
}
function sameTime(a: any, b: any) {
  return Boolean(a && b && a.isEqual(b));
}

/** One MiB real write/read/fsync, actual application reservation and exact budgets.
 * Await native filesystem settlement and cleanup; a deadline is not proof that an
 * outstanding syscall stopped. No sparse/full-budget allocation claim is made. */
export async function runMediaFilesystemCanary(
  isDraining: () => boolean = () => false,
  processing = runNativeMediaProcessingCanary
) {
  const end = Date.now() + 10000,
    signal = AbortSignal.timeout(10000),
    check = () => {
      signal.throwIfAborted();
      if (isDraining() || Date.now() > end) failure();
    };
  if (
    workerReadinessDigest(mediaResources) !== workerReadinessDigest(mediaStartupBudget) ||
    (await realpath('/tmp')) !== '/tmp'
  )
    failure();
  const [root, scratch, disk] = await Promise.all([stat('/'), stat('/tmp'), statfs('/tmp')]);
  check();
  const totalBytes = Number(disk.blocks) * Number(disk.bsize),
    availableBytes = Number(disk.bavail) * Number(disk.bsize);
  // A source-mounted scratch filesystem, not a writable container root fallback.
  if (
    root.dev === scratch.dev ||
    ![totalBytes, availableBytes].every(Number.isSafeInteger) ||
    availableBytes > totalBytes ||
    availableBytes < 80 * GiB
  )
    failure();
  const directory = await mkdtemp('/tmp/temporal-media-capacity-');
  let release: (() => void) | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let confirmed = false;
  let audio: Awaited<ReturnType<typeof runNativeMediaProcessingCanary>> | undefined;
  try {
    check();
    release = await reserveMediaWorkspace(directory);
    check();
    const bytes = randomBytes(1024 * 1024),
      digest = createHash('sha256').update(bytes).digest('hex');
    file = await open(join(directory, 'source.bin'), 'wx', 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = undefined;
    check();
    const stored = await readFile(join(directory, 'source.bin'));
    check();
    if (stored.length !== bytes.length || createHash('sha256').update(stored).digest('hex') !== digest) failure();
    audio = await processing({ directory, signal });
    check();
    await checkMediaWorkspace(directory);
    check();
    confirmed = true;
  } finally {
    try {
      await file?.close();
    } finally {
      try {
        await rm(directory, { recursive: true, force: false });
      } finally {
        release?.();
      }
    }
  }
  check();
  if (!confirmed || !audio) failure();
  // A second application reservation verifies that the first was released.
  const again = await reserveMediaWorkspace('/tmp');
  again();
  check();
  return {
    schemaVersion: 2,
    processing: audio,
    budgets: { ...mediaStartupBudget },
    totalBytes,
    availableBytes,
    canaryBytes: 1024 * 1024,
    writeReadFsync: true,
    cleanupConfirmed: true,
    reservationReleased: true,
    observedAt: new Date().toISOString(),
  };
}

/** Runs only for a currently owned media startup operation. Normal later cold
 * starts have no such diagnostic authority and create no diagnostic receipt. */
async function recordStartup(options: {
  firestore: Firestore;
  buildId: string;
  witness: WorkerWitness;
  isDraining?: () => boolean;
  canary?: typeof runMediaFilesystemCanary;
}) {
  const { firestore: db, witness, buildId } = options;
  if (!('projectId' in db) || db.projectId !== 'urm-app-staging' || db.databaseId !== '(default)') failure();
  const op = db.doc('_control/temporalReleaseOperation'),
    control = db.doc('_control/temporalRelease'),
    state = db.doc('_control/temporalReleaseState');
  const original = await db.runTransaction(
    async (tx) => {
      const [o, c, s] = await Promise.all([tx.get(op), tx.get(control), tx.get(state)]);
      return { o, c, s };
    },
    { readOnly: true }
  );
  if (!['bootstrap-stop-cloud-run-media', 'activate-cloud-run-media-pool'].includes(original.o.get('action'))) return;
  const owned = mediaStartupIntent(original.o.data());
  paused(original.o.data(), original.c.data(), original.s.data());
  const cloud = witness.cloudRun;
  if (
    !cloud ||
    witness.buildId !== buildId ||
    owned.plan.buildId !== buildId ||
    cloud.projectId !== 'urm-app-staging' ||
    cloud.region !== 'us-central1' ||
    cloud.pool !== owned.plan.name.split('/').at(-1) ||
    cloud.revision !== owned.start.before.revision.split('/').at(-1) ||
    cloud.serviceAccount !== owned.plan.mediaStartup.runner ||
    cloud.imageDigest !== owned.plan.mediaStartup.image.split('@')[1] ||
    !cloud.revisionUid ||
    !cloud.instanceId ||
    !uuid(witness.instanceId)
  )
    failure();
  const capacity = await (options.canary ?? runMediaFilesystemCanary)(options.isDraining);
  validateCapacity(capacity, owned.start.attemptedAt);
  const evidence = {
    schemaVersion: 1,
    intentSHA256: owned.intentSHA256,
    operationId: owned.intent.operationId,
    worker: witness,
    capacity,
    observedAt: new Date().toISOString(),
  };
  const digest = workerReadinessDigest(evidence),
    receipt = db.collection(MEDIA_STARTUP_CAPACITY_COLLECTION).doc(owned.intent.operationId);
  const verify = async (tx: any) => {
    const [o, c, s] = await Promise.all([tx.get(op), tx.get(control), tx.get(state)]);
    paused(o.data(), c.data(), s.data());
    if (
      mediaStartupIntent(o.data()).intentSHA256 !== owned.intentSHA256 ||
      !sameTime(o.createTime, original.o.createTime) ||
      !sameTime(c.updateTime, original.c.updateTime) ||
      !sameTime(s.updateTime, original.s.updateTime)
    )
      failure();
  };
  try {
    await db.runTransaction(
      async (tx) => {
        await verify(tx);
        tx.create(receipt, { ...evidence, digest });
      },
      { maxAttempts: 1 }
    );
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : NaN;
    if ([3, 5, 6, 7, 9, 11, 12, 16].includes(code)) failure();
    // Unknown acknowledgement: exact readback only, never another create.
    await db.runTransaction(
      async (tx) => {
        await verify(tx);
        const current = await tx.get(receipt);
        if (!current.exists || workerReadinessDigest(current.data()) !== workerReadinessDigest({ ...evidence, digest }))
          failure();
      },
      { readOnly: true }
    );
  }
}

function validateCapacity(raw: unknown, attemptedAt: string) {
  const c = object(raw),
    at = Date.parse(c.observedAt ?? '');
  if (
    Object.keys(c).sort().join(',') !==
      'availableBytes,budgets,canaryBytes,cleanupConfirmed,observedAt,processing,reservationReleased,schemaVersion,totalBytes,writeReadFsync' ||
    c.schemaVersion !== 2 ||
    workerReadinessDigest(c.budgets) !== workerReadinessDigest(mediaStartupBudget) ||
    !Number.isSafeInteger(c.totalBytes) ||
    !Number.isSafeInteger(c.availableBytes) ||
    c.totalBytes < c.availableBytes ||
    c.availableBytes < 80 * GiB ||
    c.canaryBytes !== 1024 * 1024 ||
    c.writeReadFsync !== true ||
    c.cleanupConfirmed !== true ||
    c.reservationReleased !== true ||
    !Number.isFinite(at) ||
    at < Date.parse(attemptedAt) ||
    at > Date.now() + 5000 ||
    Date.now() - at > 120000
  )
    failure();
  const p = object(c.processing);
  if (
    Object.keys(p).sort().join(',') !==
      'cancelledChildDrained,channels,durationSeconds,ffmpegSHA256,ffprobeSHA256,outputBytes,pcmSamplesVerified,progressBeforeCancellation,retryCompleted,sampleRate,schemaVersion,sourceBytes' ||
    p.schemaVersion !== 1 ||
    !hash(p.ffmpegSHA256) ||
    !hash(p.ffprobeSHA256) ||
    p.sourceBytes !== 32044 ||
    !Number.isSafeInteger(p.outputBytes) ||
    p.outputBytes < 32044 ||
    p.outputBytes > 65536 ||
    p.sampleRate !== 16000 ||
    p.channels !== 1 ||
    !Number.isFinite(p.durationSeconds) ||
    Math.abs(p.durationSeconds - 1) > 0.005 ||
    p.pcmSamplesVerified !== 16000 ||
    p.progressBeforeCancellation !== true ||
    p.cancelledChildDrained !== true ||
    p.retryCompleted !== true
  )
    failure();
  return c;
}

/** Called only by the frozen-runtime canonical bootstrap adapter. Joins actual
 * private startup evidence to fresh native pool/revision and original intent.
 * This is not Activity execution, processing, restart or available-capacity lease. */
async function collectStartup(options: {
  firestore: Firestore;
  binding: any;
  operationId: string;
  readResource: (name: string) => Promise<unknown>;
  verifyPool: (binding: any, pool: unknown, revision: unknown) => unknown;
}) {
  const { firestore: db, binding, operationId } = options;
  if (
    !('projectId' in db) ||
    db.projectId !== 'urm-app-staging' ||
    db.databaseId !== '(default)' ||
    binding.role !== 'media' ||
    !uuid(operationId)
  )
    failure();
  const op = db.doc('_control/temporalReleaseOperation'),
    control = db.doc('_control/temporalRelease'),
    state = db.doc('_control/temporalReleaseState');
  const read = (requireReceipt = true) =>
    db.runTransaction(
      async (tx) => {
        const [o, c, s, r] = await Promise.all([
          tx.get(op),
          tx.get(control),
          tx.get(state),
          tx.get(db.collection(MEDIA_STARTUP_CAPACITY_COLLECTION).doc(operationId)),
        ]);
        const owned = mediaStartupIntent(o.data());
        paused(o.data(), c.data(), s.data());
        if (owned.intent.operationId !== operationId || (requireReceipt && !r.exists)) failure();
        return { o, c, s, owned, evidence: r.exists ? object(r.data()) : undefined };
      },
      { readOnly: true }
    );
  const waiting = await read(false),
    end = Date.now() + 30000;
  let original = waiting;
  while (!original.evidence) {
    if (Date.now() >= end) failure();
    await new Promise((resolve) => setTimeout(resolve, 100));
    original = await read(false);
    if (
      original.owned.intentSHA256 !== waiting.owned.intentSHA256 ||
      !sameTime(original.o.createTime, waiting.o.createTime) ||
      !sameTime(original.c.updateTime, waiting.c.updateTime) ||
      !sameTime(original.s.updateTime, waiting.s.updateTime) ||
      Date.now() > end
    )
      failure();
  }
  const { owned } = original,
    evidence = object(original.evidence);
  const { digest, ...value } = evidence;
  if (
    !hash(digest) ||
    workerReadinessDigest(value) !== digest ||
    Object.keys(value).sort().join(',') !== 'capacity,intentSHA256,observedAt,operationId,schemaVersion,worker' ||
    value.schemaVersion !== 1 ||
    value.operationId !== operationId ||
    value.intentSHA256 !== owned.intentSHA256 ||
    owned.plan.buildId !== binding.buildId ||
    owned.plan.mediaStartup.image !== binding.image ||
    owned.plan.mediaStartup.runner !== binding.runnerServiceAccount
  )
    failure();
  const capacity = validateCapacity(value.capacity, owned.start.attemptedAt),
    worker = object(value.worker),
    cloud = object(worker.cloudRun);
  if (
    worker.buildId !== binding.buildId ||
    !uuid(worker.instanceId) ||
    cloud.projectId !== binding.projectId ||
    cloud.region !== binding.region ||
    cloud.pool !== binding.poolName ||
    cloud.serviceAccount !== binding.runnerServiceAccount ||
    cloud.imageDigest !== binding.image.split('@')[1] ||
    !cloud.instanceId ||
    cloud.revision !== owned.start.before.revision.split('/').at(-1) ||
    !cloud.revisionUid ||
    !Number.isFinite(Date.parse(value.observedAt ?? '')) ||
    Date.parse(value.observedAt) < Date.parse(capacity.observedAt) ||
    Date.parse(value.observedAt) > Date.now() + 5000 ||
    Date.now() - Date.parse(value.observedAt) > 120000
  )
    failure();
  const parent = `projects/urm-app-staging/locations/us-central1/workerPools/${binding.poolName}`;
  if (parent !== owned.plan.name) failure();
  const pool = object(await options.readResource(parent));
  const revisionName = `${parent}/revisions/${cloud.revision}`;
  const revision = object(await options.readResource(revisionName));
  options.verifyPool(binding, pool, revision);
  const normalize = (s: unknown) =>
    typeof s === 'string' ? s.replace('projects/251680231116/', 'projects/urm-app-staging/') : failure();
  if (
    pool.uid !== owned.start.before.uid ||
    pool.scaling?.manualInstanceCount !== 1 ||
    normalize(pool.latestReadyRevision) !== revisionName ||
    revision.uid !== cloud.revisionUid
  )
    failure();
  const fresh = await read();
  if (
    fresh.owned.intentSHA256 !== owned.intentSHA256 ||
    workerReadinessDigest(fresh.evidence) !== workerReadinessDigest(evidence) ||
    !sameTime(fresh.o.createTime, original.o.createTime) ||
    !sameTime(fresh.c.updateTime, original.c.updateTime) ||
    !sameTime(fresh.s.updateTime, original.s.updateTime)
  )
    failure();
  validateCapacity(capacity, owned.start.attemptedAt);
  return {
    receiptSHA256: workerReadinessDigest(evidence),
    intentSHA256: owned.intentSHA256,
    capacityObservedAt: capacity.observedAt,
    scope:
      'owned startup filesystem and synthetic audio/child cancellation-retry only; not Activity, worker restart, provider processing or readiness',
  };
}

export async function recordMediaStartupCapacity(options: Parameters<typeof recordStartup>[0]) {
  try {
    return await recordStartup(options);
  } catch {
    failure();
  }
}
export async function collectMediaStartupCapacity(options: Parameters<typeof collectStartup>[0]) {
  try {
    return await collectStartup(options);
  } catch {
    failure();
  }
}
