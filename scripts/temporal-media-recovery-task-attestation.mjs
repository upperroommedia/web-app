import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { attestationPublicKey, observeMediaRecoveryAttestationTask } from './temporal-media-recovery-job.mjs';
import { proofDigest as hash } from './temporal-release-runtime.mjs';
import { checkpointMediaRecoveryTaskAttestation } from './temporal-media-recovery-checkpoint.mjs';
import { mediaRecoveryAttestedWorkExpiry, mediaRecoveryExecutionWindowVersion, mediaRecoveryLaunchWindow,
  mediaRecoveryWorkMillis } from './temporal-media-recovery-execution-window.mjs';

const domain = 'urm.staging.media-recovery.task-attestation.v1';
const v2Domain = 'urm.staging.media-recovery.task-attestation.v2';
const fields = [
  'operationId',
  'releaseId',
  'bindingDigest',
  'buildId',
  'image',
  'runner',
  'planSHA256',
  'jobPlanSHA256',
  'armingSHA256',
  'authoritySHA256',
  'job',
  'jobUid',
  'createOperation',
  'runOperation',
  'runIntentSHA256',
  'execution',
  'executionUid',
  'executionGeneration',
  'task',
  'taskCreateTime',
  'taskGeneration',
  'taskUid',
  'issuedAt',
  'expiresAt',
];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const deny = () => {
  throw new Error('MEDIA_RECOVERY_TASK_ATTESTATION_UNCONFIRMED');
};

export function mediaRecoveryTaskAttestationBytes(payload) {
  const v2 = payload?.executionWindowVersion === mediaRecoveryExecutionWindowVersion;
  if (!payload || Object.keys(payload).length !== fields.length + (v2 ? 1 : 0) ||
      fields.some((key) => !Object.hasOwn(payload, key))) deny();
  const lineage = fields.map(key => payload[key]);
  return Buffer.from(JSON.stringify(v2 ? [v2Domain, payload.executionWindowVersion, ...lineage] : [domain, ...lineage]), 'utf8');
}

export function verifyMediaRecoveryTaskAttestation(record, publicKey) {
  if (
    !record ||
    Object.keys(record).sort().join(',') !== 'payload,signature' ||
    typeof record.signature !== 'string' ||
    record.signature.length !== 88
  )
    deny();
  const signature = Buffer.from(record.signature, 'base64');
  if (
    signature.length !== 64 ||
    signature.toString('base64') !== record.signature ||
    !verify(null, mediaRecoveryTaskAttestationBytes(record.payload), attestationPublicKey(publicKey), signature)
  )
    deny();
  return record.payload;
}

function pathFor(directory, operationId, suffix) {
  if (!directory || !isAbsolute(directory) || !uuid.test(operationId) || realpathSync(directory) !== directory) deny();
  const owner = lstatSync(directory);
  if (!owner.isDirectory() || owner.uid !== process.getuid() || (owner.mode & 0o777) !== 0o700) deny();
  return join(directory, operationId + suffix);
}

function readPrivate(path, encoding) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > 16384
    )
      deny();
    return readFileSync(fd, encoding);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Link a synced inode without replacing an existing key or certificate. A
// competing writer must read the winner; nobody issues two signed payloads.
function createPrivate(directory, path, content) {
  const temporary = join(directory, '.' + randomUUID());
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
  const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

function custodyKey(directory, operationId, saved) {
  const path = pathFor(directory, operationId, '.key');
  let bytes = readPrivate(path);
  if (!bytes && !saved) {
    createPrivate(directory, path, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }));
    bytes = readPrivate(path);
  }
  if (!bytes) deny();
  const key = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') deny();
  return key;
}

function publicKey(key) {
  return createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
}

export function prepareMediaRecoveryTaskAttestation(directory, operationId, savedPlan) {
  // Historical plans remain verifiable with their original bytes.
  if (savedPlan && !Object.hasOwn(savedPlan, 'taskAttestationPublicKey')) return undefined;
  const key = publicKey(custodyKey(directory, operationId, !!savedPlan));
  if (savedPlan && savedPlan.taskAttestationPublicKey !== key) deny();
  return key;
}

export async function attestMediaRecoveryTask({ directory, o, plan, provider, setOwnedOperation }) {
  if (!plan.taskAttestationPublicKey) return;
  const window = mediaRecoveryLaunchWindow(plan);
  if (!window) deny();
  const run = provider?.runIdentity;
  if (
    !run ||
    provider.create?.stage !== 'acknowledged' ||
    provider.run?.stage !== 'acknowledged' ||
    provider.run.operation !== run.operation ||
    provider.run.intentSHA256 !== run.intentSHA256 ||
    provider.jobPlanSHA256 !== hash(plan.job)
  )
    deny();
  const payloadPath = pathFor(directory, plan.operationId, '.payload');
  const certificatePath = pathFor(directory, plan.operationId, '.certificate');
  const key = custodyKey(directory, plan.operationId, true);
  if (publicKey(key) !== plan.taskAttestationPublicKey) deny();
  const get = () => {
    const local = readPrivate(certificatePath, 'utf8');
    return local ? JSON.parse(local) : undefined;
  };
  const base = {
    operationId: plan.operationId,
    releaseId: plan.releaseId,
    bindingDigest: plan.bindingDigest,
    buildId: plan.buildId,
    image: plan.image,
    runner: plan.runner,
    planSHA256: hash(plan),
    jobPlanSHA256: provider.jobPlanSHA256,
    authoritySHA256: hash(o.expectedAuthority),
    job: plan.job.name,
    jobUid: run.jobUid,
    createOperation: provider.create.operation,
    runOperation: run.operation,
    runIntentSHA256: run.intentSHA256,
    execution: run.execution,
    executionUid: run.executionUid,
    ...(window.version === undefined ? {expiresAt:plan.expiresAt} : {executionWindowVersion:window.version}),
  };
  let record = get();
  let sampledAt;
  // Atomically rejoin the immutable journal and current authority before
  // requesting a witness. No worker status or caller-provided digest is used.
  const { armingSHA256, published } = await checkpointMediaRecoveryTaskAttestation({ ...o, plan, provider });
  base.armingSHA256 = armingSHA256;
  if (published && !record) deny();
  if (!record) {
    for (;;) {
      if (Date.now() >= window.attestationExpiresAt) deny();
      sampledAt = performance.now();
      const native = await observeMediaRecoveryAttestationTask({ api: o.api, plan, run });
      if (!native) {
        await delay(1000);
        continue;
      }
      const issuedAt = new Date().toISOString();
      if (Date.parse(issuedAt) >= window.attestationExpiresAt || performance.now() - sampledAt > 5000) deny();
      const expiry = window.version === undefined ? window.launchExpiresAt : Date.parse(issuedAt) + mediaRecoveryWorkMillis;
      createPrivate(directory, payloadPath, JSON.stringify({ ...base, ...native, issuedAt, expiresAt:expiry }));
      const payload = JSON.parse(readPrivate(payloadPath, 'utf8') ?? 'null');
      if (!payload || Object.entries({ ...base, ...native }).some(([name, value]) => payload[name] !== value)) deny();
      createPrivate(
        directory,
        certificatePath,
        JSON.stringify({
          payload,
          signature: sign(null, mediaRecoveryTaskAttestationBytes(payload), key).toString('base64'),
        })
      );
      record = get();
      break;
    }
  }
  const signed = verifyMediaRecoveryTaskAttestation(record, plan.taskAttestationPublicKey);
  if (Object.entries(base).some(([name, value]) => signed[name] !== value) ||
      mediaRecoveryAttestedWorkExpiry(plan, signed) === undefined) deny();
  if (published) {
    if (published !== hash(record)) deny();
    return;
  }
  // On a resume after local sealing, prove that the same exact task is live
  // again before the first Firestore publication. The signed bytes stay fixed.
  if (sampledAt === undefined) {
    sampledAt = performance.now();
    const native = await observeMediaRecoveryAttestationTask({ api: o.api, plan, run });
    if (!native || Object.entries(native).some(([name, value]) => record.payload[name] !== value)) deny();
  }
  const { ownedOperation } = await checkpointMediaRecoveryTaskAttestation({ ...o, plan, provider, record, sampledAt });
  setOwnedOperation(ownedOperation);
}
