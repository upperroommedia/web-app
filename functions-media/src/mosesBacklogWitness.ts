import { createHash, createPublicKey, verify } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalMosesRecoveryJson, mosesRecoveryDigest, type MosesBacklogHeldPredecessor, type MosesBacklogReceipt } from '@upperroom/contracts/mosesDeferredRecovery';

export const MOSES_BACKLOG_SURFACES = {
  'hetzner-youtube': 'https://yt-worker.upperroommedia.org/process-audio',
  'cloudrun-storage': 'https://process-audio-yshbijirxq-uc.a.run.app/process-audio',
  'media-callable': 'https://us-central1-urm-app.cloudfunctions.net/addintrooutrotaskgenerator',
  'media-sermon-create': 'https://us-central1-urm-app.cloudfunctions.net/sermonaudiocreatetrigger',
  'media-cookie-update': 'https://us-central1-urm-app.cloudfunctions.net/setyoutubecookies',
  'core-sermon-delete': 'https://us-central1-urm-app.cloudfunctions.net/sermonOnDelete',
  'media-recovery': 'https://us-central1-urm-app.cloudfunctions.net/recoverdeferredmosesaudio',
} as const;

const fail = (): never => { throw new Error('Invalid forward exclusion witness.'); };
const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : fail();
function canonicalTime(value: unknown) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return fail();
  return Date.parse(value);
}
function reader(buffer: Buffer) {
  let pos = 0;
  return {
    field() {
      if (pos + 4 > buffer.length) return fail();
      const length = buffer.readUInt32BE(pos); pos += 4;
      if (length > buffer.length - pos) return fail();
      const field = buffer.subarray(pos, pos + length); pos += length;
      return field;
    },
    done() { if (pos !== buffer.length) fail(); },
  };
}
function field(value: Buffer | string) {
  const data = Buffer.from(value);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

// ssh-keygen -Y sign, version 1. Pin the SSH public blob independently of the supplied envelope.
function verifyReleaseSignature(statement: unknown, armor: unknown, fingerprint: string, expectedNamespace = 'urm-moses-backlog-drain-v1') {
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/u.test(fingerprint) || typeof armor !== 'string' || armor.length > 4096) fail();
  const match = /^-----BEGIN SSH SIGNATURE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END SSH SIGNATURE-----\r?\n?$/u.exec(armor as string);
  if (!match) return fail();
  const b64 = match[1].replace(/[\r\n]/gu, '');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.toString('base64') !== b64 || bytes.length < 10 || bytes.subarray(0, 6).toString() !== 'SSHSIG' || bytes.readUInt32BE(6) !== 1) fail();
  const sig = reader(bytes.subarray(10));
  const keyBlob = sig.field();
  const key = reader(keyBlob);
  const keyType = key.field().toString();
  const rawKey = key.field(); key.done();
  const namespace = sig.field().toString();
  const reserved = sig.field();
  const hash = sig.field().toString();
  const signature = reader(sig.field()); sig.done();
  const signatureType = signature.field().toString();
  const rawSig = signature.field(); signature.done();
  if (keyType !== 'ssh-ed25519' || signatureType !== keyType || rawKey.length !== 32 || rawSig.length !== 64 ||
      namespace !== expectedNamespace || reserved.length !== 0 || hash !== 'sha512' ||
      'SHA256:' + createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/u, '') !== fingerprint) fail();
  const digest = createHash('sha512').update(canonicalMosesRecoveryJson(statement)).digest();
  const data = Buffer.concat([Buffer.from('SSHSIG'), field(namespace), field(reserved), field(hash), field(digest)]);
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), format: 'der', type: 'spki' });
  if (!verify(null, data, publicKey, rawSig)) fail();
}

export function verifyMosesBacklogWitness(bytes: Buffer, receipt: MosesBacklogReceipt, fingerprint: string, now = Date.now()): string {
  if (bytes.length > 65536) return fail();
  const envelope = record(JSON.parse(bytes.toString('utf8')));
  const statement = record(envelope.statement);
  verifyReleaseSignature(statement, envelope.signature, fingerprint);
  if (statement.schema !== 1 || statement.kind !== 'moses_backlog_forward_exclusion' || statement.project !== 'urm-app' ||
      statement.sermonId !== receipt.sermonId || statement.requestVersion !== receipt.requestVersion ||
      statement.custodySha256 !== receipt.custodySha256 || statement.nonce !== receipt.nonce ||
      statement.fencedAt !== receipt.fencedAt || statement.releaseSha !== receipt.releaseSha) return fail();
  const observed = canonicalTime(statement.observedAt);
  const installed = canonicalTime(receipt.fencedAt);
  if (observed < installed || observed > now || observed < now - 300_000) return fail();
  const surfaces = record(statement.surfaces);
  if (Object.keys(surfaces).length !== Object.keys(MOSES_BACKLOG_SURFACES).length) return fail();
  for (const [id, target] of Object.entries(MOSES_BACKLOG_SURFACES)) {
    const surface = record(surfaces[id]);
    const readAt = canonicalTime(surface.readAt);
    if (surface.target !== target || surface.releaseSha !== receipt.releaseSha || readAt < installed || readAt > observed ||
        readAt < now - 300_000 || !Array.isArray(surface.nativeIds) || !surface.nativeIds.length ||
        surface.nativeIds.some(value => typeof value !== 'string' || !value.trim() || value.length > 512) ||
        new Set(surface.nativeIds).size !== surface.nativeIds.length || !Array.isArray(surface.unguardedOwners) ||
        surface.unguardedOwners.length || typeof surface.evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(surface.evidenceSha256)) return fail();
  }
  return statement.observedAt as string;
}

export interface VerifiedBacklogClosure {
  documentCreateTime: string;
  documentUpdateTime: string;
  sourceAudioStatus: 'PROCESSING' | 'ERROR';
  observedAt: string;
  beforeSha256: string;
  afterSha256: string;
  unchangedFieldsSha256: string;
  changedMessage: boolean;
}

export function verifyMosesBacklogClosure(bytes: Buffer, prior: MosesBacklogHeldPredecessor, releaseSha: string,
  fingerprint: string, now = Date.now()): VerifiedBacklogClosure {
  if (!bytes.length || bytes.length > 65536) return fail();
  const envelope = record(JSON.parse(bytes.toString('utf8')));
  const s = record(envelope.statement);
  verifyReleaseSignature(s, envelope.signature, fingerprint, 'urm-moses-backlog-closure-v1');
  if (s.schema !== 1 || s.kind !== 'moses_backlog_predecessor_closure' || s.project !== 'urm-app' ||
      s.sermonId !== prior.sermonId || s.requestVersion !== prior.requestVersion || s.predecessorTaskId !== prior.taskId ||
      s.predecessorCustodySha256 !== prior.custodySha256 || s.predecessorReceiptSha256 !== mosesRecoveryDigest(prior) ||
      s.releaseSha !== releaseSha || releaseSha === prior.releaseSha || s.documentCreateTime !== prior.documentCreateTime ||
      typeof s.documentUpdateTime !== 'string' || !/^\d+\.\d{9}$/u.test(s.documentUpdateTime) ||
      (s.sourceAudioStatus !== 'PROCESSING' && s.sourceAudioStatus !== 'ERROR')) return fail();
  const observed = canonicalTime(s.observedAt);
  const source = record(s.source), transport = record(s.transport), queue = record(s.queue);
  const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
  const empty = (v: unknown) => Array.isArray(v) && v.length === 0;
  const changedMessage = isDeepStrictEqual(source.changedFields, ['status.audioStatus', 'status.message']);
  const changedAudioOnly = isDeepStrictEqual(source.changedFields, ['status.audioStatus']);
  if (observed > now || [source, transport, queue].some(part => {
    const at = canonicalTime(part.readAt);
    return at < now - 300_000 || at < canonicalTime(prior.queuedAt) || at > observed;
  }) || !digest(source.beforeSha256) || !digest(source.afterSha256) ||
      !digest(source.unchangedFieldsSha256) || (s.sourceAudioStatus === 'PROCESSING'
        ? (!changedAudioOnly && !changedMessage) || source.beforeSha256 === source.afterSha256
        : !empty(source.changedFields) || source.beforeSha256 !== source.afterSha256) ||
      !digest(transport.evidenceSha256) || transport.taskRetired !== true || transport.ownerExited !== true || !empty(transport.activeOwners) ||
      !digest(queue.evidenceSha256) || queue.youtubeTaskAbsent !== true || queue.storageTaskAbsent !== true ||
      !empty(queue.activeClaims) || queue.outputsAbsent !== true) return fail();
  return { documentCreateTime: prior.documentCreateTime, documentUpdateTime: s.documentUpdateTime,
    sourceAudioStatus: s.sourceAudioStatus, observedAt: s.observedAt as string,
    beforeSha256: source.beforeSha256, afterSha256: source.afterSha256, unchangedFieldsSha256: source.unchangedFieldsSha256,
    changedMessage };
}
