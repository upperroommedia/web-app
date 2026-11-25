import { mediaRecoveryTaskIdentity, isMediaRecoveryTaskIdentity } from './temporal-media-recovery-job.mjs';
import { nativeSnapshotProof, proofDigest as hash } from './temporal-release-runtime.mjs';

const fail = () => {
  throw new Error('MEDIA_RECOVERY_JOB_ORIGINAL_STARTUP_UNCONFIRMED');
};

/** A startup witness only authorizes the original START gate together with
 * the caller's fresh native Job, pool, and paused release observations. */
export async function readMediaRecoveryJobStartup(db, tx, plan, run, validateCapacity, taskAttestation, executionExpiresAt) {
  if (!Number.isSafeInteger(executionExpiresAt)) fail();
  const [kernelRef, startupRef] = ['Kernel', 'Startup'].map((kind) =>
    db.doc(`_control/temporalMediaRecovery${kind}-${plan.operationId}`)
  );
  const [kernel, startup] = await Promise.all([tx.get(kernelRef), tx.get(startupRef)]);
  if (!kernel.exists) {
    if (startup.exists) fail();
    return false;
  }
  const k = kernel.data();
  const context = k.context;
  if (
    k.schemaVersion !== 1 ||
    !['armed', 'born', 'running'].includes(k.stage) ||
    context?.operationId !== plan.operationId ||
    !/^[a-f0-9]{64}$/.test(context.intentSHA256 ?? '') ||
    context.parent?.buildId !== plan.buildId
  )
    fail();

  function matchesRun(witness) {
    const task = witness?.cloudRunJob;
    return (
      witness?.buildId === plan.buildId &&
      !witness.cloudRun &&
      task?.projectId === 'urm-app-staging' &&
      task.region === 'us-central1' &&
      task.job === plan.job.name &&
      task.execution === run.execution &&
      task.executionUid === run.executionUid &&
      task.serviceAccount === plan.runner &&
      task.imageDigest === plan.image.split('@')[1] &&
      task.task?.startsWith(run.execution + '/tasks/') &&
      typeof task.taskCreateTime === 'string' &&
      isMediaRecoveryTaskIdentity(mediaRecoveryTaskIdentity(task)) &&
      typeof task.instanceId === 'string' &&
      /^[a-zA-Z0-9_-]{1,256}$/.test(task.instanceId)
    );
  }
  if (!matchesRun(context.parent)) fail();
  if (!startup.exists) return false;
  const s = startup.data();
  const proof = nativeSnapshotProof(startup);
  const birth = { context, intent: k.intent, birth: k.birth, worker: k.worker };
  const time = Date.parse(s.observedAt),
    spawned = Date.parse(k.birth?.spawnedAt);
  if (
    k.stage !== 'running' ||
    !matchesRun(k.worker) ||
    hash(context.parent.cloudRunJob) !== hash(k.worker.cloudRunJob) ||
    Object.keys(s).sort().join(',') !==
      'bundle,capacity,intentSHA256,kernel,kind,observedAt,operationId,schemaVersion,' +
        (taskAttestation ? 'taskAttestation,' : '') +
        'worker' ||
    (taskAttestation && hash(taskAttestation) !== hash(s.taskAttestation ?? null)) ||
    s.schemaVersion !== 1 ||
    s.kind !== 'private-diagnostic-startup-only-no-recovery-proof' ||
    s.operationId !== plan.operationId ||
    s.intentSHA256 !== context.intentSHA256 ||
    s.kernel?.operationId !== plan.operationId ||
    s.kernel.birthDigest !== hash(birth) ||
    hash(s.worker) !== hash(k.worker) ||
    s.bundle?.buildId !== plan.buildId ||
    !/^[a-f0-9]{64}$/.test(s.bundle.bundleSHA256 ?? '') ||
    hash(proof.createTime) !== hash(proof.updateTime) ||
    !Number.isFinite(time) ||
    !Number.isFinite(spawned) ||
    time < spawned ||
    spawned < Date.parse(plan.createdAt) ||
    (plan.executionWindowVersion !== undefined && (!taskAttestation ||
      !Number.isSafeInteger(taskAttestation.seconds) || !Number.isInteger(taskAttestation.nanoseconds) ||
      BigInt(spawned) * 1_000_000n <
        BigInt(taskAttestation.seconds) * 1_000_000_000n + BigInt(taskAttestation.nanoseconds))) ||
    time > Date.now() + 1000 ||
    time >= executionExpiresAt
  )
    fail();
  if (typeof validateCapacity !== 'function') fail();
  validateCapacity(s.capacity, k.birth.spawnedAt, s.observedAt);
  return { proof, taskIdentity: mediaRecoveryTaskIdentity(k.worker.cloudRunJob) };
}
