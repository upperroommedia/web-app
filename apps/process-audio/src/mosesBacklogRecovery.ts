import type { Bucket } from '@google-cloud/storage';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import { computeProcessAudioTaskId, getProcessAudioTaskQueueNameForSource } from '@upperroom/contracts/processAudioQueue';
import type { Database } from 'firebase-admin/database';
import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Timestamp,
  UpdateData,
} from 'firebase-admin/firestore';
import { isDeepStrictEqual } from 'node:util';
import {
  computeMosesBacklogCustody,
  computeMosesBacklogTaskId,
  MOSES_BACKLOG_FENCES_PATH,
  MOSES_BACKLOG_RELEASES,
  MOSES_BACKLOG_EDITS_PATH,
  type MosesBacklogEditGrant,
  type MosesBacklogRelease,
  mosesRecoveryDigest,
  MOSES_BACKLOG_DOCUMENT_FENCES,
  mosesBacklogDocumentFence,
  type MosesBacklogReceipt,
} from '@upperroom/contracts/mosesDeferredRecovery';
import type {
  StoredProcessAudioRequestState,
  YouTubeSuccessfulAcquisitionAuthority,
} from '@upperroom/contracts/processAudioQueue';
import type { VerifiedMosesRecoveryDelivery } from './mosesGuestTaskIdentity';
import {
  ReservedBacklogDelivery,
  computeProcessAudioRequestVersion,
  withProcessAudioQueueClaim,
} from './processAudioQueueStore';
import { MosesBacklogStorage, type BacklogOutputs } from './mosesBacklogStorage';
import { rememberConsumedMosesPilotNonce } from './sentryMosesPrivacy';

type Completion = {
  authority: YouTubeSuccessfulAcquisitionAuthority;
  mosesVerified: boolean;
  outputs: BacklogOutputs;
  documentWriteTime: string;
  completedAt: string;
};
type Receipt = MosesBacklogReceipt & {
  owner?: string;
  originalRequest?: StoredProcessAudioRequestState;
  outcome?: 'processing' | 'review_required' | 'media_completed' | 'completed';
  proof?: Completion;
  completedRequestSha256?: string;
};
const fail = (): never => {
  throw new Error('Unconfirmed backlog recovery custody');
};
const stamp = (time?: Timestamp) => time && time.seconds + '.' + String(time.nanoseconds).padStart(9, '0');
const fence = (db: Database, job: VerifiedMosesRecoveryDelivery) =>
  db.ref(MOSES_BACKLOG_FENCES_PATH + '/' + job.sermonId);
const request = (db: Database, job: VerifiedMosesRecoveryDelivery) => db.ref('processAudioRequests/' + job.sermonId);
function iso(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function checkIntent(receipt: Receipt | null, job: VerifiedMosesRecoveryDelivery): asserts receipt is Receipt {
  const witness = receipt?.witness;
  if (
    !receipt ||
    !job.backlog ||
    receipt.schema !== 2 ||
    receipt.kind !== job.backlog.kind ||
    receipt.releaseSha !== job.backlog.releaseSha ||
    receipt.sermonId !== job.sermonId ||
    receipt.requestVersion !== job.requestVersion ||
    receipt.videoId !== job.videoId ||
    receipt.taskId !== job.taskId ||
    receipt.nonce !== job.nonce ||
    receipt.custodySha256 !== job.custodySha256 ||
    computeMosesBacklogCustody(receipt) !== job.custodySha256 ||
    computeMosesBacklogTaskId(receipt.kind, job.sermonId, job.requestVersion, job.custodySha256) !== job.taskId ||
    computeProcessAudioRequestVersion(job.payload) !== job.requestVersion ||
    !isDeepStrictEqual(receipt.payload, job.payload) ||
    !witness ||
    witness.releaseSha !== receipt.releaseSha ||
    !/^[1-9][0-9]*$/u.test(witness.generation) ||
    !/^[a-f0-9]{64}$/u.test(witness.sha256) ||
    !iso(witness.observedAt) ||
    !iso(receipt.fencedAt) ||
    !iso(receipt.queuedAt) ||
    Date.parse(witness.observedAt) < Date.parse(receipt.fencedAt) ||
    Date.parse(witness.observedAt) > Date.now()
  )
    fail();
}

function checkOriginal(value: StoredProcessAudioRequestState | null, receipt: Receipt) {
  if (mosesRecoveryDigest(value) !== receipt.requestSha256) fail();
  if (receipt.kind === 'missing_admission') {
    if (value !== null || receipt.priorTaskId !== undefined) fail();
  } else if (
    !value ||
    !receipt.priorTaskId ||
    value.queuedTaskId !== receipt.priorTaskId ||
    !isDeepStrictEqual(value.currentPayload, receipt.payload) ||
    value.currentRequestVersion !== receipt.requestVersion ||
    value.sermonId !== receipt.sermonId ||
    value.sourceType !== 'youtube' ||
    value.runningRequestId != null ||
    value.runningTaskId != null ||
    value.nextPayload != null
  )
    fail();
}

// An ordinary status write and the initial create-only Firestore fence serialize on the same document.
export function updateUnreservedAudioDocument(ref: DocumentReference, patch: UpdateData<DocumentData>) {
  return ref.firestore.runTransaction(async (tx) => {
    const mirror = await tx.get(ref.firestore.collection(MOSES_BACKLOG_DOCUMENT_FENCES).doc(ref.id));
    if (mirror.exists) throw new ReservedBacklogDelivery();
    tx.update(ref, patch);
  });
}

export async function readBacklogDocument(
  ref: DocumentReference,
  expected: ReturnType<typeof mosesBacklogDocumentFence>
) {
  const mirrorRef = ref.firestore.collection(MOSES_BACKLOG_DOCUMENT_FENCES).doc(ref.id);
  return ref.firestore.runTransaction(
    async (tx) => {
      const [document, mirror] = await tx.getAll(ref, mirrorRef);
      if (!mirror.exists || !isDeepStrictEqual(mirror.data(), expected)) return fail();
      return document;
    },
    { readOnly: true }
  );
}

function checkDocument(doc: DocumentSnapshot, receipt: Receipt, terminal = false) {
  const status = terminal ? 'PROCESSED' : receipt.kind === 'failed_request' ? 'ERROR' : 'PENDING';
  const payload = receipt.payload;
  if (
    !doc.exists ||
    doc.ref.path !== 'sermons/' + receipt.sermonId ||
    stamp(doc.createTime) !== receipt.documentCreateTime ||
    stamp(doc.updateTime) !== (terminal ? receipt.proof?.documentWriteTime : receipt.documentUpdateTime) ||
    !('youtubeUrl' in payload) ||
    doc.get('youtubeUrl') !== payload.youtubeUrl ||
    doc.get('sourceStartTime') !== payload.startTime ||
    doc.get('trimDurationSeconds') !== payload.duration ||
    doc.get('status.audioStatus') !== status ||
    doc.get('status.soundCloud') !== 'NOT_UPLOADED' ||
    doc.get('status.subsplash') !== 'NOT_UPLOADED' ||
    doc.get('audioSource') === 'subsplash' ||
    [
      'subsplashId',
      'subsplashAudioUrl',
      'soundCloudTrackId',
      'soundCloudTrackUrl',
      'audioUrl',
      'processedAudioUrl',
      'finalAudioUrl',
      'canonicalAudioUrl',
    ].some((key) => doc.get(key) != null && doc.get(key) !== '')
  )
    fail();
}

async function readAcknowledged(
  db: Database,
  job: VerifiedMosesRecoveryDelivery,
  receipt: Receipt,
  document: DocumentSnapshot,
  bucket: Bucket,
  owner?: string
) {
  if (receipt.phase !== 'acknowledged' || receipt.owner || receipt.outcome || receipt.proof) return fail();
  const [current, deferred, probe, lock] = await Promise.all([
    request(db, job).get(),
    db.ref('processAudioQueues/youtube/deferred/' + job.sermonId).get(),
    db.ref('processAudioQueues/youtube/state/probeTaskSermonId').get(),
    db.ref('processAudioLocks/' + job.sermonId).get(),
  ]);
  if (deferred.exists() || probe.val() === job.sermonId || (owner ? lock.val()?.requestId !== owner : lock.exists()))
    fail();
  checkOriginal(current.val(), receipt);
  checkDocument(document, receipt);
  checkDocument(await readBacklogDocument(document.ref, mosesBacklogDocumentFence(receipt)), receipt);
  const storage = new MosesBacklogStorage(bucket, receipt, job.taskId);
  await Promise.all([storage.checkBeforeAcquisition(), storage.verifyWitness(job.nonce, receipt.witness!)]);
  return { original: current.val() as StoredProcessAudioRequestState | null, storage };
}

export async function beginBacklogRecovery(
  db: Database,
  job: VerifiedMosesRecoveryDelivery,
  owner: string,
  document: DocumentSnapshot,
  bucket: Bucket
) {
  return withProcessAudioQueueClaim(db, job.sermonId, 'backlog-start:' + owner, async () => {
    const ref = fence(db, job);
    const receipt: Receipt = (await ref.get()).val();
    checkIntent(receipt, job);
    const { storage, original } = await readAcknowledged(db, job, receipt, document, bucket, owner);
    const next = {
      ...receipt,
      phase: 'consumed',
      outcome: 'processing',
      owner,
      ...(original && { originalRequest: original }),
    };
    const result = await ref.transaction(
      (current) => (current === null ? null : isDeepStrictEqual(current, receipt) ? next : undefined),
      undefined,
      false
    );
    if (!result.committed || !isDeepStrictEqual(result.snapshot.val(), next)) return fail();
    rememberConsumedMosesPilotNonce(job.nonce);
    return storage;
  });
}

export async function advanceBacklogMedia(
  db: Database,
  job: VerifiedMosesRecoveryDelivery,
  owner: string,
  proof?: Completion
) {
  const nextOutcome = proof ? 'media_completed' : 'review_required';
  const result = await fence(db, job).transaction(
    (receipt: Receipt | null) => {
      if (!receipt) return null;
      checkIntent(receipt, job);
      if (receipt.phase !== 'consumed' || receipt.owner !== owner || receipt.outcome !== 'processing') return undefined;
      return { ...receipt, outcome: nextOutcome, ...(proof && { proof }) };
    },
    undefined,
    false
  );
  if (proof && (!result.committed || result.snapshot.child('outcome').val() !== nextOutcome)) fail();
}

function completedRequest(receipt: Receipt) {
  const { payload, sermonId, requestVersion, proof } = receipt;
  if (!proof) return fail();
  const result: Partial<StoredProcessAudioRequestState> = {
    ...receipt.originalRequest,
    sourceType: 'youtube',
    currentPayload: payload,
    sermonId,
    currentRequestVersion: requestVersion,
    lastCompletedRequestVersion: requestVersion,
    lastCompletedAt: proof.completedAt,
    updatedAt: proof.completedAt,
    authenticatedDeferralAttemptCount: 0,
    transientRetryCount: 0,
    lastSuccessfulYouTubeAcquisitionRequestVersion: requestVersion,
    lastSuccessfulYouTubeAcquisitionAuthority: proof.authority,
  };
  for (const key of [
    'queuedTaskId',
    'queuedAt',
    'runningRequestId',
    'runningAt',
    'runningRequestVersion',
    'runningTaskId',
    'deferredAt',
    'transientRetryReason',
    'transientRetryNextRunAt',
    'transientRetryLastFailureMessage',
  ] as const)
    delete result[key];
  return result;
}

export async function reconcileBacklogRecovery(
  db: Database,
  job: VerifiedMosesRecoveryDelivery,
  owner: string,
  readDocument: () => Promise<DocumentSnapshot>,
  bucket: Bucket
): Promise<'ready' | 'completed'> {
  return withProcessAudioQueueClaim(db, job.sermonId, 'backlog-finish:' + owner, async () => {
    const ref = fence(db, job);
    const receipt: Receipt = (await ref.get()).val();
    checkIntent(receipt, job);
    if (receipt.phase === 'acknowledged') {
      await readAcknowledged(db, job, receipt, await readDocument(), bucket);
      return 'ready';
    }
    if (receipt.phase !== 'consumed' || !receipt.owner) return fail();
    const original = receipt.originalRequest ?? null;
    checkOriginal(original, receipt);
    if (receipt.outcome === 'completed') return 'completed';
    if (receipt.outcome !== 'media_completed' || !receipt.proof) return fail();
    const doc = await readDocument();
    checkDocument(await readBacklogDocument(doc.ref, mosesBacklogDocumentFence(receipt)), receipt, true);
    await new MosesBacklogStorage(bucket, receipt, job.taskId).verifyCurrent(receipt.proof.outputs);
    const next = completedRequest(receipt);
    const changed = await request(db, job).transaction(
      (current) =>
        isDeepStrictEqual(current, original) || isDeepStrictEqual(current, next)
          ? next
          : current === null
          ? null
          : undefined,
      undefined,
      false
    );
    if (!changed.committed || !isDeepStrictEqual(changed.snapshot.val(), next)) return fail();
    const terminal = { ...receipt, outcome: 'completed', completedRequestSha256: mosesRecoveryDigest(next) };
    const sealed = await ref.transaction(
      (current) => (current === null ? null : isDeepStrictEqual(current, receipt) ? terminal : undefined),
      undefined,
      false
    );
    if (!sealed.committed || !isDeepStrictEqual(sealed.snapshot.val(), terminal)) return fail();
    return 'completed';
  });
}


// The nonce is a private capability for one direct callable-created task. Do not
// propagate it to a retry task, store it in the request row, or include it in logs.
export interface BacklogEditDelivery {
  payload: AddIntroOutroInputType;
  taskId: string;
  requestVersion: string;
  payloadSha256: string;
  documentFence: ReturnType<typeof mosesBacklogDocumentFence>;
  pendingWriteTime: Timestamp;
}

export async function readBacklogEditDelivery(
  database: Database,
  doc: DocumentReference,
  body: { data: AddIntroOutroInputType },
  headers: Readonly<Record<string, readonly string[] | undefined>>,
  env = process.env
): Promise<BacklogEditDelivery | 'settled' | undefined> {
  const single = (key: string) => headers[key]?.length === 1 ? headers[key]?.[0] : undefined;
  const taskId = single('x-cloudtasks-taskname');
  const nonce = single('x-urm-moses-pilot-intent');
  const payload = body.data;
  const youtube = 'youtubeUrl' in payload;
  const requestVersion = computeProcessAudioRequestVersion(payload);
  if (!taskId || !/^pa-[0-9a-f]{8}-[0-9a-f]{16}-[0-9a-f]{8}$/u.test(taskId) ||
      !nonce || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(nonce) ||
      Object.keys(body).length !== 1 || doc.id !== payload.id ||
      single('x-cloudtasks-queuename') !== getProcessAudioTaskQueueNameForSource(youtube ? 'youtube' : 'storage') ||
      env.NODE_ENV !== 'production' || env.FIREBASE_PROJECT_ID !== 'urm-app' ||
      env.PROCESS_AUDIO_RUNTIME_ENV !== 'production' || env.FIRESTORE_EMULATOR_HOST !== undefined ||
      env.FIREBASE_DATABASE_EMULATOR_HOST !== undefined ||
      env.PROCESS_AUDIO_RUNTIME_PROFILE !== (youtube ? 'hetzner' : 'cloudrun') ||
      env.PROCESS_AUDIO_RUNTIME_HOST !== (youtube ? 'hetzner' : 'cloud-run')) return;

  const releaseRef = doc.firestore.collection(MOSES_BACKLOG_RELEASES).doc(doc.id);
  const [fence, mirror, releaseDoc, grantDoc] = await Promise.all([
    database.ref(MOSES_BACKLOG_FENCES_PATH + '/' + doc.id).get(),
    doc.firestore.collection(MOSES_BACKLOG_DOCUMENT_FENCES).doc(doc.id).get(),
    releaseRef.get(),
    releaseRef.collection('tasks').doc(taskId).get(),
  ]);
  const receipt: Receipt | null = fence.val();
  const release = releaseDoc.data() as MosesBacklogRelease | undefined;
  const grant = grantDoc.data() as MosesBacklogEditGrant | undefined;
  if (!receipt || receipt.phase !== 'consumed' || receipt.outcome !== 'completed' || !receipt.proof ||
      !receipt.owner || receipt.sermonId !== doc.id || receipt.requestVersion === requestVersion ||
      receipt.taskId === taskId || receipt.priorTaskId === taskId || !grant || !release || !grantDoc.createTime ||
      computeMosesBacklogTaskId(receipt.kind, doc.id, receipt.requestVersion, receipt.custodySha256) !== receipt.taskId ||
      receipt.custodySha256 !== computeMosesBacklogCustody(receipt) ||
      receipt.completedRequestSha256 !== mosesRecoveryDigest(completedRequest(receipt)) ||
      release.schema !== 1 || release.sermonId !== doc.id || release.terminalTaskId !== receipt.taskId ||
      release.terminalRequestVersion !== receipt.requestVersion || release.custodySha256 !== receipt.custodySha256 ||
      release.completedRequestSha256 !== receipt.completedRequestSha256 ||
      !iso(release.authorizedAt) || !release.authorizedUid || !/^[0-9a-f]{16}$/u.test(release.firstEditRequestVersion) ||
      release.firstEditRequestVersion === receipt.requestVersion ||
      grant.schema !== 1 || grant.sermonId !== doc.id || grant.custodySha256 !== receipt.custodySha256 ||
      grant.taskId !== taskId || grant.nonce !== nonce || !grant.authorizedUid || !iso(grant.authorizedAt) ||
      grant.requestVersion !== requestVersion || grant.payloadSha256 !== mosesRecoveryDigest(payload)) return;
  const documentFence = mosesBacklogDocumentFence(receipt);
  if (!isDeepStrictEqual(mirror.data(), documentFence)) return;
  // A lost HTTP acknowledgement after the running owner's successful settlement
  // must not cause the same task to acquire another media run.
  const [head, requestRow] = await Promise.all([
    database.ref(MOSES_BACKLOG_EDITS_PATH + '/' + doc.id).get(),
    database.ref('processAudioRequests/' + doc.id).get(),
  ]);
  const state: StoredProcessAudioRequestState | null = requestRow.val();
  if (head.val()?.phase === 'acknowledged' && head.val().taskId === taskId &&
      head.val().requestVersion === requestVersion && head.val().payloadSha256 === grant.payloadSha256 &&
      state?.sermonId === doc.id && state.currentRequestVersion === requestVersion &&
      state.lastCompletedRequestVersion === requestVersion && iso(state.lastCompletedAt) &&
      isDeepStrictEqual(state.currentPayload, payload) && state.runningRequestId == null && state.queuedTaskId == null) return 'settled';
  rememberConsumedMosesPilotNonce(nonce);
  // The Firestore transaction creates this grant and updates the sermon to PENDING in one commit.
  return { taskId, requestVersion, payload, payloadSha256: grant.payloadSha256, documentFence, pendingWriteTime: grantDoc.createTime };
}

// These reads and transitions run under the same per-sermon claim as the
// callable. The running owner persists across a crash or uncertain media write.
async function editQueueState(db: Database, edit: BacklogEditDelivery, owner?: string) {
  const id = edit.payload.id;
  const [fence, marker, row, deferred, probe, lock] = await Promise.all([
    db.ref(MOSES_BACKLOG_FENCES_PATH + '/' + id).get(),
    db.ref(MOSES_BACKLOG_EDITS_PATH + '/' + id).get(),
    db.ref('processAudioRequests/' + id).get(),
    db.ref('processAudioQueues/youtube/deferred/' + id).get(),
    db.ref('processAudioQueues/youtube/state/probeTaskSermonId').get(),
    db.ref('processAudioLocks/' + id).get(),
  ]);
  const receipt: Receipt | null = fence.val();
  const admission = marker.val();
  const state = row.val() as StoredProcessAudioRequestState | null;
  if (!receipt || receipt.phase !== 'consumed' || receipt.outcome !== 'completed' ||
      !isDeepStrictEqual(mosesBacklogDocumentFence(receipt), edit.documentFence) ||
      admission?.phase !== 'acknowledged' || admission.taskId !== edit.taskId ||
      admission.requestVersion !== edit.requestVersion || admission.payloadSha256 !== edit.payloadSha256 ||
      !/^[0-9a-f]{64}$/u.test(admission.previousRequestSha256) ||
      computeProcessAudioTaskId(id, edit.requestVersion,
        receipt.custodySha256 + admission.previousRequestSha256 + edit.payloadSha256) !== edit.taskId ||
      !state || state.sermonId !== id || state.currentRequestVersion !== edit.requestVersion ||
      state.sourceType !== ('youtubeUrl' in edit.payload ? 'youtube' : 'storage') ||
      state.queuedTaskId !== edit.taskId || !isDeepStrictEqual(state.currentPayload, edit.payload) ||
      state.nextPayload != null || state.nextRequestVersion != null || state.deferredAt != null ||
      deferred.exists() || probe.val() === id || (owner ? lock.val()?.requestId !== owner : lock.exists())) return fail();
  return state;
}

export async function checkBacklogEditQueued(db: Database, edit: BacklogEditDelivery) {
  const state = await editQueueState(db, edit);
  if (state.runningRequestId != null || state.runningTaskId != null || state.runningAt != null ||
      state.runningRequestVersion != null) fail();
}

export async function transitionBacklogEdit(
  db: Database, edit: BacklogEditDelivery, owner: string, stage: 'start' | 'complete',
  authority?: YouTubeSuccessfulAcquisitionAuthority
) {
  await withProcessAudioQueueClaim(db, edit.payload.id, 'backlog-edit:' + stage + ':' + owner, async () => {
    const state = await editQueueState(db, edit, owner);
    const now = new Date().toISOString();
    const next = { ...state, updatedAt: now };
    if (stage === 'start') {
      if (state.runningRequestId != null || state.runningTaskId != null ||
          state.runningRequestVersion != null || state.runningAt != null) fail();
      Object.assign(next, { runningRequestId: owner, runningTaskId: edit.taskId,
        runningRequestVersion: edit.requestVersion, runningAt: now });
    } else {
      if (state.runningRequestId !== owner || state.runningTaskId !== edit.taskId ||
          state.runningRequestVersion !== edit.requestVersion) fail();
      Object.assign(next, { lastCompletedRequestVersion: edit.requestVersion, lastCompletedAt: now,
        ...(authority && { lastSuccessfulYouTubeAcquisitionAuthority: authority,
          lastSuccessfulYouTubeAcquisitionRequestVersion: edit.requestVersion }) });
      for (const field of ['queuedTaskId', 'queuedAt', 'runningRequestId', 'runningTaskId', 'runningRequestVersion', 'runningAt'] as const) delete next[field];
    }
    const result = await db.ref('processAudioRequests/' + edit.payload.id).transaction(
      current => current === null ? null : isDeepStrictEqual(current, state) ? next : undefined, undefined, false);
    if (!result.committed || !isDeepStrictEqual(result.snapshot.val(), next)) fail();
  });
}
