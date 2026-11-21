import { createPublicKey, verify } from 'node:crypto';
import { isMediaRecoveryTaskCreateTime } from '@upperroom/orchestration/media-recovery-task-identity';

export const mediaRecoveryTaskAttestationMode = 'operator-ed25519-v1';
const modeName = 'TEMPORAL_MEDIA_RECOVERY_ATTESTATION_MODE';
const keyName = 'TEMPORAL_MEDIA_RECOVERY_ATTESTATION_KEY';
const domain = 'urm.staging.media-recovery.task-attestation.v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const generation = /^[1-9][0-9]{0,19}$/;
const location = 'projects/urm-app-staging/locations/us-central1';
const lro = /^projects\/urm-app-staging\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/;
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
] as const;

export type MediaRecoveryTaskAttestation = {
  [K in Exclude<(typeof fields)[number], 'expiresAt' | 'taskUid'>]: string;
} & { expiresAt: number; taskUid: string | null };

function deny(): never {
  throw new Error('MEDIA_RECOVERY_TASK_ATTESTATION_UNCONFIRMED');
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === names.length && names.every((k) => Object.hasOwn(value, k));
}
function base64(value: unknown, length: number) {
  if (typeof value !== 'string' || value.length !== Math.ceil(length / 3) * 4) return deny();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== length || bytes.toString('base64') !== value) return deny();
  return bytes;
}
function publicKey(value: unknown) {
  const der = base64(value, 44);
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519' || !key.export({ type: 'spki', format: 'der' }).equals(der)) return deny();
  return key;
}
export function mediaRecoveryTaskAttestationKey(env: NodeJS.ProcessEnv) {
  const mode = env[modeName],
    key = env[keyName];
  if (mode === undefined && key === undefined) return undefined;
  if (mode !== mediaRecoveryTaskAttestationMode || !key) return deny();
  publicKey(key);
  return key;
}
export function matchesMediaRecoveryTaskAttestationEnv(entries: unknown, key: string) {
  if (!Array.isArray(entries)) return false;
  return [
    [modeName, mediaRecoveryTaskAttestationMode],
    [keyName, key],
  ].every(([name, value]) => {
    const found = entries.filter((entry) => entry?.name === name);
    return found.length === 1 && exact(found[0], ['name', 'value']) && found[0].value === value;
  });
}
function payload(value: unknown): MediaRecoveryTaskAttestation {
  if (!exact(value, fields) || fields.some((k) => k !== 'expiresAt' && k !== 'taskUid' && typeof value[k] !== 'string'))
    return deny();
  const p = value as MediaRecoveryTaskAttestation;
  const job = 'urm-media-recovery-' + p.operationId.replaceAll('-', '');
  const execution = p.execution.split('/').at(-1) ?? '';
  const time = Date.parse(p.issuedAt);
  if (
    !uuid.test(p.operationId) ||
    !uuid.test(p.releaseId) ||
    !/^[a-f0-9]{40}$/.test(p.buildId) ||
    ![p.bindingDigest, p.planSHA256, p.jobPlanSHA256, p.armingSHA256, p.authoritySHA256, p.runIntentSHA256].every((v) =>
      digest.test(v)
    ) ||
    !/^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(p.image) ||
    p.runner !== 'tw-m-' + p.buildId.slice(0, 20) + '@urm-app-staging.iam.gserviceaccount.com' ||
    p.job !== location + '/jobs/' + job ||
    !uuid.test(p.jobUid) ||
    !lro.test(p.createOperation) ||
    !lro.test(p.runOperation) ||
    p.createOperation === p.runOperation ||
    p.execution !== p.job + '/executions/' + execution ||
    !execution.startsWith(job + '-') ||
    !/^[a-z0-9-]{1,63}$/.test(execution) ||
    !uuid.test(p.executionUid) ||
    p.task !== p.execution + '/tasks/' + execution + '-task0' ||
    !isMediaRecoveryTaskCreateTime(p.taskCreateTime) ||
    !generation.test(p.executionGeneration) ||
    !generation.test(p.taskGeneration) ||
    (p.taskUid !== null && (typeof p.taskUid !== 'string' || !uuid.test(p.taskUid))) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== p.issuedAt ||
    !Number.isSafeInteger(p.expiresAt) ||
    time >= p.expiresAt ||
    time < p.expiresAt - 300000 ||
    Date.parse(p.taskCreateTime) > time
  )
    return deny();
  return p;
}
export function mediaRecoveryTaskAttestationBytes(input: unknown): Buffer {
  const p = payload(input);
  return Buffer.from(JSON.stringify([domain, ...fields.map((k) => p[k])]), 'utf8');
}
/** The verification key comes from the immutable Job template through the process environment. */
export function verifyMediaRecoveryTaskAttestation(input: unknown, trustedKey: string): MediaRecoveryTaskAttestation {
  if (!exact(input, ['payload', 'signature'])) return deny();
  const p = payload(input.payload);
  if (!verify(null, mediaRecoveryTaskAttestationBytes(p), publicKey(trustedKey), base64(input.signature, 64)))
    return deny();
  return p;
}
