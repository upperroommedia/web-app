import { createHash } from 'node:crypto';

export const MOSES_RECOVERY_RECEIPTS_PATH = 'processAudioQueues/youtube/mosesRecoveries';
export interface MosesRecoverySelection {
  sermonId: string;
  videoId: string;
  requestVersion: string;
  custodySha256?: string;
}

export function getMosesRecoverySelection(env: NodeJS.ProcessEnv): MosesRecoverySelection | null {
  const sermonId = env.PROCESS_AUDIO_MOSES_RECOVERY_SERMON_ID;
  const videoId = env.PROCESS_AUDIO_MOSES_RECOVERY_VIDEO_ID;
  const requestVersion = env.PROCESS_AUDIO_MOSES_RECOVERY_REQUEST_VERSION;
  const custodySha256 = env.PROCESS_AUDIO_MOSES_RECOVERY_CUSTODY_SHA256;
  if (!sermonId || !/^[A-Za-z0-9_-]{1,128}$/u.test(sermonId) ||
      !videoId || !/^[A-Za-z0-9_-]{11}$/u.test(videoId) ||
      !requestVersion || !/^[0-9a-f]{16}$/u.test(requestVersion) ||
      (custodySha256 !== undefined && !/^[0-9a-f]{64}$/u.test(custodySha256))) return null;
  return { sermonId, videoId, requestVersion, ...(custodySha256 && { custodySha256 }) };
}

export function mosesRecoveryDigest(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === undefined || (typeof entry === 'number' && !Number.isFinite(entry))) {
      throw new Error('Invalid recovery evidence.');
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return createHash('sha256').update(serialized).digest('hex');
}

export interface MosesRecoveryEvidence {
  sermonId: string;
  videoId: string;
  requestVersion: string;
  requestSha256: string;
  deferredSha256: string;
  documentCreateTime: string;
  documentUpdateTime: string;
}

export function computeMosesRecoveryCustody(evidence: MosesRecoveryEvidence): string {
  const { sermonId, videoId, requestVersion, requestSha256, deferredSha256, documentCreateTime, documentUpdateTime } = evidence;
  return mosesRecoveryDigest({ schema: 1, kind: 'deferred_cookie', project: 'urm-app', sermonId,
    videoId, requestVersion, requestSha256, deferredSha256, documentCreateTime, documentUpdateTime });
}

export function computeMosesRecoveryTaskId(sermonId: string, requestVersion: string, custodySha256: string): string {
  return 'mr-' + createHash('sha256').update(['deferred_cookie', sermonId, requestVersion, custodySha256].join('\n')).digest('hex').slice(0, 48);
}

export interface MosesDeferredRecoveryReservation {
  taskId: string;
  nonce: string;
  requestVersion: string;
  custodySha256: string;
}

export interface MosesDeferredRecoveryReceipt extends MosesRecoveryEvidence, MosesDeferredRecoveryReservation {
  schema: 1;
  kind: 'deferred_cookie';
  queuedAt: string;
  phase: 'prepared' | 'sending' | 'acknowledged' | 'rejected' | 'consumed';
}
