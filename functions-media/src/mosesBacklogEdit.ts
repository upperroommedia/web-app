import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Bucket } from '@google-cloud/storage';
import type { Database } from 'firebase-admin/database';
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import {
  MOSES_BACKLOG_DOCUMENT_FENCES, MOSES_BACKLOG_EDITS_PATH, MOSES_BACKLOG_RELEASES,
  computeMosesBacklogCustody, computeMosesBacklogTaskId, mosesBacklogDocumentFence, mosesRecoveryDigest,
  type MosesBacklogReceipt, type MosesBacklogRelease, type MosesBacklogEditGrant,
} from '@upperroom/contracts/mosesDeferredRecovery';
import {
  computeProcessAudioRequestVersion, computeProcessAudioTaskId, getProcessAudioSourceType, sanitizeProcessAudioPayload,
  type StoredProcessAudioRequestState,
} from '@upperroom/contracts/processAudioQueue';
import { pinBacklogBumper } from './mosesBacklogNative';

type Output = { path: string; generation: string; bytes: string };
type Terminal = MosesBacklogReceipt & {
  outcome: 'completed';
  owner: string;
  originalRequest?: StoredProcessAudioRequestState;
  completedRequestSha256: string;
  proof: { documentWriteTime: string; completedAt: string; outputs: { processed: Output; final: Output } };
};
type EditHead = {
  taskId: string; requestVersion: string; previousRequestSha256: string; payloadSha256: string;
  phase: 'prepared' | 'sending' | 'acknowledged';
};
type Editor = { uid: string; role: unknown };
const deny = (): never => { throw new Error('Recovered audio edit ownership could not be confirmed.'); };
const stamp = (v?: Timestamp) => v && v.seconds + '.' + String(v.nanoseconds).padStart(9, '0');
const source = (p: AddIntroOutroInputType) => 'youtubeUrl' in p ? p.youtubeUrl : p.storageFilePath;
const iso = (s: unknown) => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;

export function isCompletedBacklogForEdit(f: MosesBacklogReceipt): f is Terminal {
  const t = f as Terminal;
  return t.schema === 2 && t.phase === 'consumed' && t.outcome === 'completed' &&
    typeof t.owner === 'string' && !!t.owner && !!t.witness && t.witness.releaseSha === t.releaseSha &&
    mosesRecoveryDigest(t.originalRequest ?? null) === t.requestSha256 &&
    /^[a-f0-9]{64}$/u.test(t.completedRequestSha256) && !!t.proof?.outputs?.processed && !!t.proof?.outputs?.final &&
    iso(t.proof.completedAt) && /^\d+\.\d{9}$/u.test(t.proof.documentWriteTime) && computeMosesBacklogCustody(t) === t.custodySha256 &&
    computeMosesBacklogTaskId(t.kind, t.sermonId, t.requestVersion, t.custodySha256) === t.taskId;
}

async function verifyOriginalOutputs(bucket: Bucket, terminal: Terminal) {
  await Promise.all(([['processed', 'processed-sermons'], ['final', 'intro-outro-sermons']] as const).map(async ([key, folder]) => {
    const proof = terminal.proof.outputs[key];
    const path = folder + '/' + terminal.sermonId;
    const [metadata] = await bucket.file(path).getMetadata();
    if (proof.path !== path || !/^[1-9][0-9]*$/u.test(proof.generation) || !/^[1-9][0-9]*$/u.test(proof.bytes) ||
        metadata.bucket !== 'urm-app.appspot.com' || metadata.name !== path || String(metadata.generation) !== proof.generation ||
        String(metadata.size) !== proof.bytes || metadata.contentType !== 'audio/mpeg' || metadata.metadata?.urmBacklogTask !== terminal.taskId) deny();
  }));
}

interface GrantArgs {
  terminal: Terminal; payload: AddIntroOutroInputType; editor: Editor; taskId: string; previous: StoredProcessAudioRequestState; first: boolean;
}

// Both documents are create-only. A crash after this transaction resumes the same prepared task and private grant.
export async function grantNativeMosesBacklogEdit(db: Firestore, bucket: Bucket, args: GrantArgs): Promise<MosesBacklogEditGrant> {
  const { terminal: t, payload, editor, taskId, previous, first } = args;
  if (!editor.uid || !['admin', 'publisher', 'uploader'].includes(String(editor.role)) || bucket.name !== 'urm-app.appspot.com') return deny();
  const doc = db.collection('sermons').doc(t.sermonId);
  const prior = await doc.get();
  const [seconds, nanos] = t.proof.documentWriteTime.split('.').map(Number);
  if (!prior.exists || stamp(prior.createTime) !== t.documentCreateTime || !prior.updateTime ||
      prior.updateTime.seconds < seconds || (prior.updateTime.seconds === seconds && prior.updateTime.nanoseconds <= nanos)) return deny();
  const requestVersion = computeProcessAudioRequestVersion(payload);
  if (first) await verifyOriginalOutputs(bucket, t);
  for (const kind of ['intro', 'outro'] as const) {
    const savedUrl = payload[kind === 'intro' ? 'introUrl' : 'outroUrl'];
    if (!savedUrl) return deny();
    const [selected, supplied] = await Promise.all([pinBacklogBumper(bucket, kind, prior.get('subtitle')),
      pinBacklogBumper(bucket, kind, prior.get('subtitle'), savedUrl)]);
    if (!isDeepStrictEqual(selected.pin, supplied.pin)) return deny();
  }
  const releaseRef = db.collection(MOSES_BACKLOG_RELEASES).doc(t.sermonId);
  const grantRef = releaseRef.collection('tasks').doc(taskId);
  const nonce = randomUUID();
  const authorizedAt = new Date().toISOString();
  return db.runTransaction(async tx => {
    const [live, mirror, releaseDoc, grantDoc] = await tx.getAll(doc, db.collection(MOSES_BACKLOG_DOCUMENT_FENCES).doc(t.sermonId), releaseRef, grantRef);
    const publishedList = await tx.get(doc.collection('sermonLists').where('uploadStatus.status', '==', 'UPLOADED').limit(1));
    const release = releaseDoc.data() as MosesBacklogRelease | undefined;
    const grant = grantDoc.data() as MosesBacklogEditGrant | undefined;
    const previousPayload = previous.currentPayload;
    if (!live.exists || !live.updateTime?.isEqual(prior.updateTime!) || !previousPayload || !publishedList.empty ||
        !isDeepStrictEqual(mirror.data(), mosesBacklogDocumentFence(t)) ||
        (editor.role !== 'admin' && live.get('uploaderId') !== editor.uid) || live.get('seriesPublishedToSubsplash') === true ||
        live.get('status.soundCloud') !== 'NOT_UPLOADED' || live.get('status.subsplash') !== 'NOT_UPLOADED' ||
        ['subsplashId', 'subsplashAudioUrl', 'soundCloudTrackId', 'soundCloudTrackUrl'].some(k => !!live.get(k)) ||
        live.get('status.audioStatus') !== (grant ? 'PENDING' : 'PROCESSED') ||
        live.get('sourceStartTime') !== payload.startTime || live.get('trimDurationSeconds') !== payload.duration ||
        ('youtubeUrl' in payload ? live.get('youtubeUrl') !== payload.youtubeUrl :
          !!live.get('youtubeUrl') || payload.storageFilePath !== 'sermons/' + t.sermonId) ||
        (source(previousPayload) === source(payload) && previousPayload.startTime === payload.startTime && previousPayload.duration === payload.duration))
      return deny();
    const binding = { schema: 1 as const, sermonId: t.sermonId, custodySha256: t.custodySha256 };
    if (release) {
      if (release.schema !== 1 || release.sermonId !== t.sermonId || release.custodySha256 !== t.custodySha256 ||
          release.terminalRequestVersion !== t.requestVersion || release.terminalTaskId !== t.taskId ||
          release.completedRequestSha256 !== t.completedRequestSha256 || (first && (release.firstEditRequestVersion !== requestVersion || !grant))) return deny();
    } else {
      if (!first || grant) return deny();
      tx.create(releaseRef, { ...binding, terminalRequestVersion: t.requestVersion, terminalTaskId: t.taskId,
        completedRequestSha256: t.completedRequestSha256, firstEditRequestVersion: requestVersion, authorizedUid: editor.uid, authorizedAt } satisfies MosesBacklogRelease);
    }
    const expected = { ...binding, taskId, requestVersion, payloadSha256: mosesRecoveryDigest(payload), authorizedUid: editor.uid };
    if (grant) {
      if (!release || !isDeepStrictEqual(grant, { ...expected, authorizedAt: grant.authorizedAt, nonce: grant.nonce }) ||
          !iso(grant.authorizedAt) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(grant.nonce)) return deny();
      return grant;
    }
    const newGrant = { ...expected, authorizedAt, nonce };
    tx.create(grantRef, newGrant);
    tx.update(doc, { 'status.audioStatus': 'PENDING' });
    return newGrant;
  });
}

export interface BacklogEditDependencies {
  database: Database;
  editor: Editor;
  authorize: (args: GrantArgs) => Promise<MosesBacklogEditGrant>;
  enqueue: (payload: AddIntroOutroInputType, id: string, nonce: string) => Promise<void>;
}

// Called only inside the same queue claim as initial-create, task replacement and worker completion.
export async function queueCompletedBacklogEdit(fence: MosesBacklogReceipt, input: AddIntroOutroInputType, claimOwner: string, deps: BacklogEditDependencies) {
  if (!isCompletedBacklogForEdit(fence) || input.id !== fence.sermonId || !deps.editor.uid) return deny();
  const { database } = deps;
  const payload = sanitizeProcessAudioPayload(input);
  const sourceType = getProcessAudioSourceType(payload);
  const requestVersion = computeProcessAudioRequestVersion(payload);
  if (requestVersion === fence.requestVersion || !Number.isFinite(payload.startTime) || payload.startTime < 0 ||
      !Number.isFinite(payload.duration) || payload.duration <= 0 || payload.deleteOriginal || payload.skipTranscode ||
      ('youtubeUrl' in payload && !/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/u.test(payload.youtubeUrl))) return deny();
  const reqPath = 'processAudioRequests/' + payload.id;
  const headPath = MOSES_BACKLOG_EDITS_PATH + '/' + payload.id;
  const headRef = database.ref(headPath);
  const [request, prior, lock, progress, deferred, probe] = await Promise.all([
    database.ref(reqPath).get(), headRef.get(), database.ref('processAudioLocks/' + payload.id).get(),
    database.ref('addIntroOutro/' + payload.id).get(), database.ref('processAudioQueues/youtube/deferred/' + payload.id).get(),
    database.ref('processAudioQueues/youtube/state/probeTaskSermonId').get(),
  ]);
  const row = request.val() as StoredProcessAudioRequestState | null;
  const previousHead = prior.val() as EditHead | null;
  if (!row || row.sermonId !== payload.id || !row.currentPayload || row.currentRequestVersion !== computeProcessAudioRequestVersion(row.currentPayload) ||
      !row.lastCompletedRequestVersion || row.currentRequestVersion !== row.lastCompletedRequestVersion || !iso(row.lastCompletedAt) ||
      row.runningRequestId || row.runningTaskId || row.runningRequestVersion || row.runningAt || row.queuedAt || row.queuedTaskId ||
      row.nextRequestVersion || row.nextPayload || row.nextUpdatedAt ||
      row.deferredAt || lock.exists() || progress.exists() || deferred.exists() || probe.val() === payload.id) return deny();
  const previousRequestSha256 = mosesRecoveryDigest(row);
  const first = previousRequestSha256 === fence.completedRequestSha256;
  if (first ? row.lastCompletedRequestVersion !== fence.requestVersion || row.lastCompletedAt !== fence.proof.completedAt :
      !previousHead || (previousHead.phase === 'acknowledged' && (previousHead.requestVersion !== row.lastCompletedRequestVersion ||
        previousHead.payloadSha256 !== mosesRecoveryDigest(row.currentPayload) ||
        computeProcessAudioTaskId(payload.id, previousHead.requestVersion, fence.custodySha256 + previousHead.previousRequestSha256 + previousHead.payloadSha256) !== previousHead.taskId))) return deny();
  const payloadSha256 = mosesRecoveryDigest(payload);
  const taskId = computeProcessAudioTaskId(payload.id, requestVersion, fence.custodySha256 + previousRequestSha256 + payloadSha256);
  const prepared: EditHead = { taskId, requestVersion, previousRequestSha256, payloadSha256, phase: 'prepared' };
  if (previousHead && (previousHead.phase !== 'acknowledged' || first) && !isDeepStrictEqual(previousHead, prepared)) return deny();
  const owns = async () => {
    const claim = (await database.ref('processAudioQueueClaims/' + payload.id).get()).val();
    if (claim?.requestId !== claimOwner || !Number.isFinite(claim.acquiredAt) || Date.now() - claim.acquiredAt >= 40_000) deny();
  };
  const move = async (from: EditHead | null, to: EditHead) => {
    await owns();
    const result = await headRef.transaction(value => value === null && from ? null : isDeepStrictEqual(value, from) ? to : undefined, undefined, false);
    if (!result.committed || !isDeepStrictEqual(result.snapshot.val(), to)) deny();
  };
  // Prepare native authority first. No dispatch is possible until 'sending' wins.
  await owns();
  const grant = await deps.authorize({ terminal: fence, payload, previous: row, editor: deps.editor, taskId, first });
  if (!isDeepStrictEqual(previousHead, prepared)) await move(previousHead, prepared);
  await move(prepared, { ...prepared, phase: 'sending' });
  try { await deps.enqueue(payload, taskId, grant.nonce); } catch { throw new Error('Edited audio task outcome unknown. Inspect the original named task.'); }
  await owns();
  if (mosesRecoveryDigest((await database.ref(reqPath).get()).val()) !== previousRequestSha256) return deny();
  const queuedAt = new Date().toISOString();
  await database.ref().update({
    [reqPath]: { ...row, currentPayload: payload, currentRequestVersion: requestVersion, sourceType, queuedTaskId: taskId, queuedAt, updatedAt: queuedAt },
    [headPath]: { ...prepared, phase: 'acknowledged' },
  });
  return { action: 'queued' as const, requestVersion, taskId, sourceType };
}
