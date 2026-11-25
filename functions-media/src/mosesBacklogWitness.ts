import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalMosesRecoveryJson, type MosesBacklogReceipt } from '@upperroom/contracts/mosesDeferredRecovery';

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
function verifyReleaseSignature(statement: unknown, armor: unknown, fingerprint: string) {
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
      namespace !== 'urm-moses-backlog-drain-v1' || reserved.length !== 0 || hash !== 'sha512' ||
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
