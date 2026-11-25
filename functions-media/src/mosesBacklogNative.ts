import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Bucket } from '@google-cloud/storage';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import { MOSES_BACKLOG_DELETIONS, MOSES_BACKLOG_DOCUMENT_FENCES, MOSES_BACKLOG_RELEASES, mosesBacklogClosurePath, mosesBacklogDocumentFence, mosesRecoveryDigest,
  type MosesBacklogContinuation, type MosesBacklogHeldPredecessor, type MosesBacklogReceipt } from '@upperroom/contracts/mosesDeferredRecovery';
import { sanitizeProcessAudioPayload } from '@upperroom/contracts/processAudioQueue';
import { buildFirebaseStorageDownloadUrl } from '@upperroom/shared/shared/firebaseStorageUrls';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { BacklogActivation, BacklogSelection, MosesBacklogNativeHead } from './mosesBacklogRecovery';
import { verifyMosesBacklogClosure, verifyMosesBacklogWitness, type VerifiedBacklogClosure } from './mosesBacklogWitness';

const BUCKET = 'urm-app.appspot.com';
const timestamp = (v: {seconds: number; nanoseconds: number}) => `${v.seconds}.${String(v.nanoseconds).padStart(9, '0')}`;
const refuse = (): never => { throw new Error('Backlog native evidence unavailable.'); };
const missing = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && Number(error.code) === 404;

export async function pinBacklogBumper(bucket: Bucket, kind: 'intro' | 'outro', subtitle: unknown, savedUrl?: string) {
  let path: string;
  let token: string | undefined;
  if (savedUrl !== undefined) {
    const url = new URL(savedUrl);
    const prefix = `/v0/b/${BUCKET}/o/`;
    if (url.origin !== 'https://firebasestorage.googleapis.com' || url.username || url.password || url.hash ||
        !url.pathname.startsWith(prefix) || url.searchParams.get('alt') !== 'media' || url.searchParams.size !== 2) return refuse();
    path = decodeURIComponent(url.pathname.slice(prefix.length));
    token = url.searchParams.get('token') ?? undefined;
    if (!token || buildFirebaseStorageDownloadUrl(BUCKET, path, token) !== savedUrl) return refuse();
  } else {
    if (subtitle == null) subtitle = '';
    if (typeof subtitle !== 'string' || /[/\\%\u0000-\u001f]/u.test(subtitle)) return refuse();
    const specific = `${kind}s/${subtitle}_${kind}.mp3`;
    path = subtitle && (await bucket.file(specific).exists())[0] ? specific : `${kind}s/default_${kind}.mp3`;
  }
  if (!path.startsWith(kind + 's/') || !path.endsWith('_' + kind + '.mp3') || /[/\\%\u0000-\u001f]/u.test(path.slice(kind.length + 2))) return refuse();
  const [meta] = await bucket.file(path).getMetadata();
  const generation = String(meta.generation ?? '');
  const raw = meta.metadata?.firebaseStorageDownloadTokens;
  if (meta.name !== path || meta.bucket !== BUCKET || !/^[1-9][0-9]*$/u.test(generation) ||
      !(Number(meta.size) > 0) || typeof raw !== 'string') return refuse();
  const tokens = raw.split(',').map(v => v.trim()).filter(Boolean);
  const selected = token ?? tokens[0];
  if (!selected || !tokens.includes(selected)) return refuse();
  return { url: savedUrl ?? buildFirebaseStorageDownloadUrl(BUCKET, path, selected), pin: { path, generation } };
}

export async function readMosesBacklogNativeHead(sel: BacklogSelection, original: AddIntroOutroInputType | undefined,
  previousTask: string | undefined, ownTask: string | undefined, token: string,
  checkTasks: (id: string, own: string | undefined, token: string) => Promise<void>, continuation?: MosesBacklogContinuation): Promise<MosesBacklogNativeHead> {
  const doc = await firebaseAdmin.firestore().collection('sermons').doc(sel.sermonId).get();
  const data = doc.data();
  if (!doc.createTime || !doc.updateTime || !data || (data.id != null && data.id !== sel.sermonId) ||
      data.youtubeUrl !== `https://www.youtube.com/watch?v=${sel.videoId}` ||
      !Number.isFinite(data.sourceStartTime) || data.sourceStartTime < 0 || !Number.isFinite(data.trimDurationSeconds) || data.trimDurationSeconds <= 0 ||
      data.status?.audioStatus !== (continuation?.sourceAudioStatus ?? (sel.kind === 'failed_request' ? 'ERROR' : 'PENDING')) ||
      data.status?.subsplash !== 'NOT_UPLOADED' || data.status?.soundCloud !== 'NOT_UPLOADED' || data.audioSource === 'subsplash' ||
      ['subsplashId', 'subsplashAudioUrl', 'soundCloudTrackId', 'soundCloudTrackUrl', 'audioUrl', 'processedAudioUrl', 'finalAudioUrl', 'canonicalAudioUrl']
        .some(k => data[k] != null && data[k] !== '')) return refuse();
  if (original && (!('youtubeUrl' in original) || original.id !== sel.sermonId || original.youtubeUrl !== data.youtubeUrl ||
      original.startTime !== data.sourceStartTime || original.duration !== data.trimDurationSeconds || !original.introUrl || !original.outroUrl)) return refuse();
  const bucket = firebaseAdmin.storage().bucket();
  const [intro, outro, processed, final] = await Promise.all([
    pinBacklogBumper(bucket, 'intro', data.subtitle, original?.introUrl), pinBacklogBumper(bucket, 'outro', data.subtitle, original?.outroUrl),
    bucket.file(`processed-sermons/${sel.sermonId}`).exists(), bucket.file(`intro-outro-sermons/${sel.sermonId}`).exists(),
    checkTasks(sel.sermonId, ownTask, token),
  ]);
  if (processed[0] || final[0]) return refuse();
  for (const previous of new Set([previousTask, continuation?.predecessor.taskId].filter((id): id is string => !!id))) {
    // This complements the list and is explicitly not the forward exclusion proof.
    const url = 'https://cloudtasks.googleapis.com/v2/projects/urm-app/locations/us-central1/queues/processaudioyoutubetask/tasks/' + encodeURIComponent(previous);
    const task = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(4000) });
    if (task.status !== 404) return refuse();
  }
  return {
    payload: original ?? sanitizeProcessAudioPayload({ id: sel.sermonId, youtubeUrl: data.youtubeUrl, startTime: data.sourceStartTime,
      duration: data.trimDurationSeconds, deleteOriginal: true, introUrl: intro.url, outroUrl: outro.url }),
    bumperGenerations: { intro: intro.pin, outro: outro.pin }, documentCreateTime: timestamp(doc.createTime), documentUpdateTime: timestamp(doc.updateTime),
  };
}

export async function readNativeBacklogWitness(fence: MosesBacklogReceipt, expectedGeneration?: string) {
  const key = `_ops/moses-backlog-drain/${fence.sermonId}/${fence.nonce}.json`;
  const bucket = firebaseAdmin.storage().bucket();
  let meta;
  if (expectedGeneration && (!/^[1-9][0-9]*$/u.test(expectedGeneration) || !Number.isSafeInteger(Number(expectedGeneration)))) return refuse();
  try { [meta] = await bucket.file(key, expectedGeneration ? { generation: expectedGeneration } : undefined).getMetadata(); } catch (error) { if (missing(error)) return null; throw error; }
  const generation = String(meta.generation ?? '');
  if ((expectedGeneration && expectedGeneration !== generation) || !Number.isSafeInteger(Number(generation)) ||
      meta.bucket !== BUCKET || meta.name !== key || !/^[1-9][0-9]*$/u.test(generation) ||
      meta.contentEncoding || !(Number(meta.size) > 0 && Number(meta.size) <= 65536)) return refuse();
  const [bytes] = await bucket.file(key, { generation }).download({ validation: 'crc32c', decompress: false });
  const observedAt = verifyMosesBacklogWitness(bytes, fence, process.env.PROCESS_AUDIO_MOSES_BACKLOG_SIGNER_FINGERPRINT ?? '');
  return { generation, sha256: createHash('sha256').update(bytes).digest('hex'), observedAt, releaseSha: fence.releaseSha };
}


export async function verifyNativeBacklogDocumentFence(fence: MosesBacklogReceipt, install: boolean) {
  const db = firebaseAdmin.firestore();
  const native = db.collection(MOSES_BACKLOG_DOCUMENT_FENCES).doc(fence.sermonId);
  const expected = mosesBacklogDocumentFence(fence);
  await db.runTransaction(async tx => {
    const [actual, doc, deletion] = await tx.getAll(native, db.collection('sermons').doc(fence.sermonId), db.collection(MOSES_BACKLOG_DELETIONS).doc(fence.sermonId));
    if (deletion.exists) return refuse();
    if (fence.continuation) {
      const grants = await tx.get(db.collection(MOSES_BACKLOG_RELEASES).doc(fence.sermonId));
      const published = await tx.get(doc.ref.collection('sermonLists').where('uploadStatus.status', '==', 'UPLOADED').limit(1));
      if (grants.exists || !published.empty || doc.get('seriesPublishedToSubsplash') === true || Number(doc.get('numberOfListsUploadedTo') ?? 0) !== 0) return refuse();
    }
    if (!doc.createTime || !doc.updateTime || timestamp(doc.createTime) !== fence.documentCreateTime ||
        timestamp(doc.updateTime) !== fence.documentUpdateTime) return refuse();
    if (actual.exists) {
      if (!isDeepStrictEqual(actual.data(), expected)) return refuse();
    } else {
      if (fence.continuation || !install || fence.phase !== 'fenced') return refuse();
      tx.create(native, expected);
    }
  });
}

// A sealed completion describes the historical job. The operator must also observe
// that the protected source incarnation still exists before reporting its status.
export async function verifyNativeBacklogSourcePresent(fence: MosesBacklogReceipt) {
  const db = firebaseAdmin.firestore();
  await db.runTransaction(async tx => {
    const [doc, mirror, deletion] = await tx.getAll(db.collection('sermons').doc(fence.sermonId),
      db.collection(MOSES_BACKLOG_DOCUMENT_FENCES).doc(fence.sermonId), db.collection(MOSES_BACKLOG_DELETIONS).doc(fence.sermonId));
    if (!doc.createTime || timestamp(doc.createTime) !== fence.documentCreateTime || deletion.exists ||
        !isDeepStrictEqual(mirror.data(), mosesBacklogDocumentFence(fence))) return refuse();
  }, { readOnly: true });
}

// The signed original complete-document digest comes from the archived native read.
// Verify the current complete typed fields and the independently signed unchanged projection.
export function verifyBacklogClosureSource(fields: Record<string, unknown>, closure: VerifiedBacklogClosure) {
  if (mosesRecoveryDigest(fields) !== closure.afterSha256) return refuse();
  const status = fields.status as { mapValue?: { fields?: Record<string, unknown> } } | undefined;
  const entries = status?.mapValue?.fields;
  if (!entries || !isDeepStrictEqual(entries.audioStatus, { stringValue: closure.sourceAudioStatus }) ||
      !isDeepStrictEqual(entries.subsplash, { stringValue: 'NOT_UPLOADED' }) ||
      !isDeepStrictEqual(entries.soundCloud, { stringValue: 'NOT_UPLOADED' })) return refuse();
  const unchanged = { ...entries };
  if (closure.sourceAudioStatus !== 'ERROR') delete unchanged.audioStatus;
  if (closure.changedMessage) delete unchanged.message;
  const projection = { ...fields, status: { mapValue: { fields: unchanged } } };
  if (mosesRecoveryDigest(projection) !== closure.unchangedFieldsSha256) return refuse();
}

export async function readNativeBacklogClosure(prior: MosesBacklogHeldPredecessor, activation: BacklogActivation, releaseSha: string, token: string) {
  const generation = activation.closureGeneration;
  if (!/^[1-9][0-9]*$/u.test(generation) || !Number.isSafeInteger(Number(generation))) return refuse();
  const key = mosesBacklogClosurePath(prior.sermonId, prior.nonce);
  const file = firebaseAdmin.storage().bucket(BUCKET).file(key, { generation });
  const [meta] = await file.getMetadata();
  if (meta.bucket !== BUCKET || meta.name !== key || String(meta.generation) !== generation || meta.contentEncoding ||
      !(Number(meta.size) > 0 && Number(meta.size) <= 65536)) return refuse();
  const [bytes] = await file.download({ validation: 'crc32c', decompress: false });
  if (bytes.length !== Number(meta.size) || createHash('sha256').update(bytes).digest('hex') !== activation.closureSha256) return refuse();
  const closure = verifyMosesBacklogClosure(bytes, prior, releaseSha, process.env.PROCESS_AUDIO_MOSES_BACKLOG_SIGNER_FINGERPRINT ?? '');
  const name = 'projects/urm-app/databases/(default)/documents/sermons/' + prior.sermonId;
  const doc = await fetch('https://firestore.googleapis.com/v1/' + name, { headers: { Authorization: 'Bearer ' + token },
    redirect: 'error', signal: AbortSignal.timeout(4000) });
  if (!doc.ok) return refuse();
  const raw = await doc.json() as { name?: unknown; createTime?: string; updateTime?: string; fields?: Record<string, unknown> };
  const stamp = (iso?: string) => {
    const match = typeof iso === 'string' && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/u.exec(iso);
    return match && Math.floor(Date.parse(match[1] + 'Z') / 1000) + '.' + (match[2] ?? '').padEnd(9, '0');
  };
  if (raw.name !== name || !raw.fields || stamp(raw.createTime) !== closure.documentCreateTime || stamp(raw.updateTime) !== closure.documentUpdateTime) return refuse();
  verifyBacklogClosureSource(raw.fields, closure);
  return closure;
}
