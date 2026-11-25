import { isDeepStrictEqual } from 'node:util';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import type { DocumentReference, Timestamp } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { MOSES_BACKLOG_DELETIONS, MOSES_BACKLOG_DOCUMENT_FENCES, mosesBacklogDocumentFence, type MosesBacklogReceipt } from '@upperroom/contracts/mosesDeferredRecovery';
import handleError from '../../handleError';
import {
  INTRO_OUTRO_SERMONS_BUCKET,
  PROCESSED_SERMONS_BUCKET,
  UNPROCESSED_SERMONS_BUCKET,
} from '@upperroom/shared/constants/storage_constants';
import { cleanupDeletedSermonProcessAudioState } from '../../processAudioQueueCleanup';

type DeletedIncarnation = { eventId: string; eventTime: string; documentCreateTime: string; deletedDocumentUpdateTime: string };
const stamp = (v: Timestamp) => v.seconds + '.' + String(v.nanoseconds).padStart(9, '0');

export async function classifyDeletedSermon(doc: DocumentReference, event: DeletedIncarnation, backlog: unknown) {
  const db = doc.firestore;
  const deletion = db.collection(MOSES_BACKLOG_DELETIONS).doc(doc.id);
  return db.runTransaction(async tx => {
    const [source, mirror, held] = await tx.getAll(doc, db.collection(MOSES_BACKLOG_DOCUMENT_FENCES).doc(doc.id), deletion);
    if (!backlog && !mirror.exists && !held.exists) return source.exists ? 'stale' as const : 'ordinary' as const;
    const active = backlog as Record<string, unknown> | null;
    const receipt: Record<string, unknown> | null = active && 'continuation' in active
      ? mosesBacklogDocumentFence(active as unknown as MosesBacklogReceipt) : active;
    if (active && 'continuation' in active && !isDeepStrictEqual(mirror.data(), receipt))
      throw new Error('Cannot confirm continuation origin mirror.');
    const identity = mirror.data() ?? receipt;
    if (!identity || identity.schema !== 2 || identity.sermonId !== doc.id ||
        !/^[a-f0-9]{64}$/u.test(String(identity.custodySha256)) || !/^[a-f0-9]{16}$/u.test(String(identity.requestVersion)) ||
        !/^\d+\.\d{9}$/u.test(String(identity.documentCreateTime)) ||
        (mirror.exists && receipt && ['schema','kind','sermonId','documentCreateTime','requestVersion','custodySha256'].some(k => receipt[k] !== identity[k])))
      throw new Error('Cannot confirm deleted recovery incarnation.');
    if (identity.documentCreateTime !== event.documentCreateTime || (source.createTime && stamp(source.createTime) === event.documentCreateTime)) return 'stale' as const;
    const record = { schema: 1, disposition: 'held_source_deleted', sermonId: doc.id, custodySha256: identity.custodySha256,
      requestVersion: identity.requestVersion, ...event };
    if (held.exists) {
      if (Object.entries(record).some(([k, value]) => held.get(k) !== value)) throw new Error('Conflicting historical deletion.');
    } else tx.create(deletion, record);
    return 'held' as const;
  });
}

// The native event already deleted the root. Restrict every child deletion to the
// original time window while checking the absent parent in the same transaction.
export async function cleanDeletedSermonDescendants(root: DocumentReference, beforeMs: number, parent = root): Promise<void> {
  if ((await root.get()).exists) return;
  for (const collection of await parent.listCollections()) {
    for (const ref of await collection.listDocuments()) {
      const snap = await ref.get();
      if (snap.createTime && snap.createTime.toMillis() >= beforeMs) continue;
      await cleanDeletedSermonDescendants(root, beforeMs, ref);
      await root.firestore.runTransaction(async tx => {
        const [currentRoot, child] = await tx.getAll(root, ref);
        if (!currentRoot.exists && child.updateTime && child.updateTime.toMillis() < beforeMs)
          tx.delete(ref, { lastUpdateTime: child.updateTime });
      });
    }
  }
}

export async function cleanDeletedSermonFile(bucket: Bucket, path: string, beforeMs: number) {
  let metadata;
  try { [metadata] = await bucket.file(path).getMetadata(); }
  catch (e) { if ((e as { code?: number })?.code === 404) return; throw e; }
  const generation = String(metadata.generation);
  const created = Date.parse(metadata.timeCreated ?? '');
  if (metadata.name !== path || metadata.bucket !== bucket.name || !Number.isFinite(created) ||
      !/^[1-9][0-9]*$/u.test(generation) || !Number.isSafeInteger(Number(generation))) throw new Error('Unconfirmed deleted media generation.');
  if (created >= beforeMs) return;
  // Generation-bound delete cannot remove an object replaced between metadata read and delete.
  await bucket.file(path, { generation }).delete({ ignoreNotFound: true });
}

const sermonOnDelete = onDocumentDeleted('sermons/{sermonId}', async event => {
  const snapshot = event.data;
  if (!snapshot?.createTime || !snapshot.updateTime || !event.id || !Number.isFinite(Date.parse(event.time)))
    throw new Error('Missing native sermon deletion identity.');
  const id = event.params.sermonId;
  const beforeMs = Date.parse(event.time);
  const doc = firebaseAdmin.firestore().collection('sermons').doc(id);
  const incarnation = { eventId: event.id, eventTime: event.time, documentCreateTime: stamp(snapshot.createTime),
    deletedDocumentUpdateTime: stamp(snapshot.updateTime) };
  try {
    const result = await cleanupDeletedSermonProcessAudioState({
      database: firebaseAdmin.database(), sermonId: id, ownerId: 'sermon-delete:' + event.id, deletedAtMs: beforeMs,
      classifySource: backlog => classifyDeletedSermon(doc, incarnation, backlog),
    });
    if (result.disposition || (await doc.get()).exists) return;
    await cleanDeletedSermonDescendants(doc, beforeMs);
    const bucket = firebaseAdmin.storage().bucket();
    if ((await doc.get()).exists) return;
    await Promise.all([UNPROCESSED_SERMONS_BUCKET, PROCESSED_SERMONS_BUCKET, INTRO_OUTRO_SERMONS_BUCKET]
      .map(folder => cleanDeletedSermonFile(bucket, folder + '/' + id, beforeMs)));
  } catch (error) {
    throw handleError(error);
  }
});

export default sermonOnDelete;
