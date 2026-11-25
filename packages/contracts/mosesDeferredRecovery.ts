import { createHash } from 'node:crypto';
import type { AddIntroOutroInputType } from './addIntroOutro/types';

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

export function canonicalMosesRecoveryJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === undefined || (typeof entry === 'number' && !Number.isFinite(entry))) {
      throw new Error('Invalid recovery evidence.');
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

export function mosesRecoveryDigest(value: unknown): string {
  return createHash('sha256').update(canonicalMosesRecoveryJson(value)).digest('hex');
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

export const MOSES_BACKLOG_FENCES_PATH = 'processAudioQueues/youtube/mosesBacklogFences';
export type MosesBacklogKind = 'failed_request' | 'missing_admission';
export type MosesBumperPin = { path: string; generation: string };
export interface MosesBacklogEvidence {
  schema: 2;
  kind: MosesBacklogKind;
  sermonId: string;
  videoId: string;
  requestVersion: string;
  requestSha256: string;
  priorTaskId?: string;
  documentCreateTime: string;
  documentUpdateTime: string;
  payload: AddIntroOutroInputType;
  bumperGenerations: { intro: MosesBumperPin; outro: MosesBumperPin };
  releaseSha: string;
}
export interface MosesBacklogWitness {
  generation: string;
  sha256: string;
  observedAt: string;
  releaseSha: string;
}
export interface MosesBacklogReceipt extends MosesBacklogEvidence {
  custodySha256: string;
  taskId: string;
  nonce: string;
  fencedAt: string;
  phase: 'fenced' | 'prepared' | 'sending' | 'acknowledged' | 'rejected' | 'consumed';
  queuedAt?: string;
  witness?: MosesBacklogWitness;
}
export function computeMosesBacklogCustody(evidence: MosesBacklogEvidence): string {
  const { schema, kind, sermonId, videoId, requestVersion, requestSha256, priorTaskId,
    documentCreateTime, documentUpdateTime, payload, bumperGenerations, releaseSha } = evidence;
  return mosesRecoveryDigest({ project: 'urm-app', schema, kind, sermonId, videoId, requestVersion, requestSha256,
    ...(priorTaskId && { priorTaskId }), documentCreateTime, documentUpdateTime, payload, bumperGenerations, releaseSha });
}
export function computeMosesBacklogTaskId(kind: MosesBacklogKind, sermonId: string, version: string, custodySha256: string): string {
  return 'mr-' + createHash('sha256').update([kind, sermonId, version, custodySha256].join('\n')).digest('hex').slice(0, 48);
}

export const MOSES_BACKLOG_DOCUMENT_FENCES = '_processAudioBacklogFences';
export function mosesBacklogDocumentFence(receipt: MosesBacklogReceipt) {
  const { schema, kind, sermonId, requestVersion, custodySha256, nonce, fencedAt, releaseSha, documentCreateTime, documentUpdateTime } = receipt;
  return { schema, kind, sermonId, requestVersion, custodySha256, nonce, fencedAt, releaseSha, documentCreateTime, documentUpdateTime };
}

export const MOSES_BACKLOG_RELEASES = '_processAudioBacklogReleases';
export const MOSES_BACKLOG_EDITS_PATH = 'processAudioQueues/youtube/mosesBacklogEdits';

export interface MosesBacklogRelease {
  schema: 1;
  sermonId: string;
  custodySha256: string;
  terminalTaskId: string;
  terminalRequestVersion: string;
  completedRequestSha256: string;
  firstEditRequestVersion: string;
  authorizedAt: string;
  authorizedUid: string;
}

export interface MosesBacklogEditGrant {
  schema: 1;
  sermonId: string;
  custodySha256: string;
  taskId: string;
  requestVersion: string;
  payloadSha256: string;
  nonce: string;
  authorizedAt: string;
  authorizedUid: string;
}

export interface MosesRecoveryCohortMember {
  ref: string;
  kind: 'deferred_cookie' | MosesBacklogKind;
  sermonId: string;
  videoId: string;
  requestVersion?: string;
}

// Deployment configuration only. Require compact JSON and canonical unpadded base64url
// so duplicate JSON keys, ambiguous encodings or additional authority fields fail closed.
export function getMosesRecoveryCohort(env: NodeJS.ProcessEnv): MosesRecoveryCohortMember[] | null {
  const encoded = env.PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL;
  if (!encoded || encoded.length > 16_384 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return null;
    const json = bytes.toString('utf8');
    const config = JSON.parse(json);
    if (JSON.stringify(config) !== json || !config || config.schema !== 1 ||
        Object.keys(config).sort().join() !== 'rows,schema' || !Array.isArray(config.rows) ||
        config.rows.length < 1 || config.rows.length > 14) return null;
    const refs = new Set<string>(), sermons = new Set<string>();
    for (const entry of config.rows) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          Object.keys(entry).some(k => !['ref', 'kind', 'sermonId', 'videoId', 'requestVersion'].includes(k)) ||
          typeof entry.ref !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/u.test(entry.ref) ||
          typeof entry.sermonId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(entry.sermonId) ||
          entry.sermonId === '__youtube_auth_recovery__' || typeof entry.videoId !== 'string' ||
          !/^[A-Za-z0-9_-]{11}$/u.test(entry.videoId) || !['deferred_cookie','failed_request','missing_admission'].includes(entry.kind) ||
          (entry.requestVersion === undefined ? entry.kind !== 'missing_admission' :
            typeof entry.requestVersion !== 'string' || !/^[a-f0-9]{16}$/u.test(entry.requestVersion)) ||
          refs.has(entry.ref) || sermons.has(entry.sermonId)) return null;
      refs.add(entry.ref);
      sermons.add(entry.sermonId);
    }
    return config.rows;
  } catch {
    return null;
  }
}

export function getMosesRecoveryCohortMember(env: NodeJS.ProcessEnv, sermonId: string): MosesRecoveryCohortMember | null {
  return getMosesRecoveryCohort(env)?.find(row => row.sermonId === sermonId) ?? null;
}
