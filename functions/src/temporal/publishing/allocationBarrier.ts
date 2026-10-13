import { createHash } from 'node:crypto';
import type { Firestore, Transaction, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { PublishingJobRef } from './types';
import { providerReceiptId, providerPayloadFingerprint } from './providerReceipts';
export const PUBLISHING_ALLOCATIONS = 'temporalPublishingAllocations';
export interface PublishingAllocationSource {
  editedAtMillis: number;
  contentFingerprint: string;
  audioFingerprint: string;
}
export interface PublishingAllocationIdentity {
  ref: PublishingJobRef;
  sermonId: string;
  provider: 'subsplash' | 'soundcloud';
  operationKey: string;
  source?: PublishingAllocationSource;
}
export function capturePublishingAllocationSource(sermon: Record<string, unknown>): PublishingAllocationSource {
  const speakers = Array.isArray(sermon.speakers)
    ? sermon.speakers.map((value) => {
        const speaker = value as Record<string, unknown>;
        return { id: speaker.id, name: speaker.name };
      })
    : [];
  const images = Array.isArray(sermon.images)
    ? sermon.images.map((value) => {
        const image = value as Record<string, unknown>;
        return { id: image.id, type: image.type, downloadLink: image.downloadLink };
      })
    : [];
  return {
    editedAtMillis: typeof sermon.editedAtMillis === 'number' ? sermon.editedAtMillis : 0,
    contentFingerprint: providerPayloadFingerprint({
      title: sermon.title,
      subtitle: sermon.subtitle,
      description: sermon.description,
      dateMillis: sermon.dateMillis,
      speakers,
      topics: sermon.topics,
      images,
    }),
    audioFingerprint: providerPayloadFingerprint({
      audioArtifacts: sermon.audioArtifacts ?? null,
      startTime: sermon.startTime,
      durationSeconds: sermon.durationSeconds,
      audioStoragePath: sermon.audioStoragePath,
    }),
  };
}
const equalSource = (left: unknown, right: PublishingAllocationSource): boolean =>
  Boolean(
    left &&
      typeof left === 'object' &&
      (left as PublishingAllocationSource).editedAtMillis === right.editedAtMillis &&
      (left as PublishingAllocationSource).contentFingerprint === right.contentFingerprint &&
      (left as PublishingAllocationSource).audioFingerprint === right.audioFingerprint
  );
const sourceChanged = (): never => {
  throw Object.assign(
    new Error('The source sermon changed during provider allocation; original results require review'),
    { code: 'PUBLISHING_ALLOCATION_SOURCE_CHANGED' }
  );
};
export interface PublishingAllocationStore {
  commitCurrent(ref: PublishingJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
}
const marker = (db: Firestore, input: Pick<PublishingAllocationIdentity, 'ref' | 'sermonId' | 'provider'>) =>
  db.collection(PUBLISHING_ALLOCATIONS).doc(
    createHash('sha256')
      .update(JSON.stringify([input.ref.projectId, input.sermonId, input.provider]))
      .digest('hex')
  );
const field = (provider: PublishingAllocationIdentity['provider']) =>
  provider === 'subsplash' ? 'subsplashId' : 'soundCloudTrackId';
const pending = (blockingJobId: string): never => {
  throw Object.assign(new Error('An earlier provider allocation must finish or be reviewed'), {
    code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
    details: { blockingJobId },
  });
};
/** Persistent ownership complements the renewable provider lock. Crash/expiry never proves a POST absent. */
export async function claimPublishingAllocation(
  db: Firestore,
  store: PublishingAllocationStore,
  input: PublishingAllocationIdentity
): Promise<void> {
  await store.commitCurrent(input.ref, async (tx) => {
    const target = marker(db, input),
      [previous, sermon, media] = await Promise.all([
        tx.get(target),
        tx.get(db.collection('sermons').doc(input.sermonId)),
        tx.get(db.collection('temporalMediaState').doc(input.sermonId)),
      ]);
    if (media.get('deletionParentRef'))
      throw Object.assign(new Error('Sermon deletion has closed provider allocation'), {
        code: 'PUBLISHING_SUPERSEDED',
      });
    if (!sermon.exists) throw Object.assign(new Error('Sermon removed'), { code: 'PUBLISHING_SUPERSEDED' });
    const captured = input.source ?? capturePublishingAllocationSource(sermon.data() ?? {});
    if (!equalSource(captured, capturePublishingAllocationSource(sermon.data() ?? {}))) sourceChanged();
    if (sermon.get(field(input.provider)))
      throw Object.assign(new Error('Provider identity appeared before allocation'), { code: 'PUBLISHING_TRANSIENT' });
    if (previous.exists && previous.get('state') !== 'cancelled') {
      if (
        previous.get('projectId') !== input.ref.projectId ||
        previous.get('sermonId') !== input.sermonId ||
        previous.get('provider') !== input.provider
      )
        throw new Error('PUBLISHING_ALLOCATION_SCOPE_MISMATCH');
      if (previous.get('ownerJobId') !== input.ref.jobId) pending(previous.get('ownerJobId'));
      if (!equalSource(previous.get('source'), captured)) sourceChanged();
      if (previous.get('operationKey') !== input.operationKey) throw new Error('PUBLISHING_ALLOCATION_INTENT_MISMATCH');
      return;
    }
    const steps =
      input.provider === 'subsplash'
        ? ['subsplash-audio', 'subsplash-transcode', 'subsplash-media-item']
        : ['soundcloud-track'];
    tx.set(target, {
      schemaVersion: 1,
      projectId: input.ref.projectId,
      sermonId: input.sermonId,
      provider: input.provider,
      ownerJobId: input.ref.jobId,
      operationKey: input.operationKey,
      receiptIds: steps.map((step) => providerReceiptId(input.operationKey, step)),
      source: captured,
      state: 'allocating',
      claimedAtMillis: Date.now(),
    });
  });
}
/** Read before canonical writes, then commit the identity and allocation settlement in the SAME fenced transaction. */
export async function preparePublishingAllocationCommit(
  tx: Transaction,
  db: Firestore,
  input: PublishingAllocationIdentity,
  remoteId: string
): Promise<() => void> {
  const target = marker(db, input),
    [snapshot, media, sermon] = await Promise.all([
      tx.get(target),
      tx.get(db.collection('temporalMediaState').doc(input.sermonId)),
      tx.get(db.collection('sermons').doc(input.sermonId)),
    ]);
  if (media.get('deletionParentRef'))
    throw Object.assign(new Error('Sermon deletion has closed provider association'), {
      code: 'PUBLISHING_SUPERSEDED',
    });
  if (
    !snapshot.exists ||
    snapshot.get('projectId') !== input.ref.projectId ||
    snapshot.get('ownerJobId') !== input.ref.jobId ||
    snapshot.get('operationKey') !== input.operationKey ||
    !['allocating', 'bound'].includes(snapshot.get('state'))
  )
    throw new Error('PUBLISHING_ALLOCATION_OWNER_CHANGED');
  if (
    !sermon.exists ||
    !equalSource(snapshot.get('source'), capturePublishingAllocationSource(sermon.data() ?? {})) ||
    (input.source && !equalSource(snapshot.get('source'), input.source))
  )
    sourceChanged();
  if (snapshot.get('state') === 'bound' && snapshot.get('remoteId') !== remoteId)
    throw new Error('PUBLISHING_ALLOCATION_ID_CHANGED');
  return () => tx.update(target, { state: 'bound', remoteId, boundAtMillis: Date.now() });
}
/** Only completed domain cancellation proof may release owners. No timeout/lease expiry grants this authority. */
export async function settleCancelledPublishingAllocations(
  db: Firestore,
  store: PublishingAllocationStore,
  ref: PublishingJobRef
): Promise<void> {
  const query = db
    .collection(PUBLISHING_ALLOCATIONS)
    .where('projectId', '==', ref.projectId)
    .where('ownerJobId', '==', ref.jobId)
    .orderBy('__name__')
    .limit(400);
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    const page = await (cursor ? query.startAfter(cursor) : query).get();
    for (const doc of page.docs)
      await store.commitCurrent(ref, async (tx) => {
        const current = await tx.get(doc.ref);
        if (!current.exists) return;
        if (current.get('projectId') !== ref.projectId || current.get('ownerJobId') !== ref.jobId)
          throw new Error('PUBLISHING_ALLOCATION_OWNER_CHANGED');
        if (current.get('state') === 'cancelled') return;
        const sermon = await tx.get(db.collection('sermons').doc(current.get('sermonId')));
        if (sermon.get(field(current.get('provider')))) return;
        tx.update(doc.ref, {
          state: 'cancelled',
          settledAtMillis: Date.now(),
          settlement: 'verified_domain_cancellation',
        });
      });
    if (page.size < 400) return;
    cursor = page.docs[page.docs.length - 1];
  }
}

/** Caller must have a fixed-ID provider absence checkpoint before atomically clearing canonical ownership. */
export async function preparePublishingAllocationRetirement(
  tx: Transaction,
  db: Firestore,
  input: Pick<PublishingAllocationIdentity, 'ref' | 'sermonId' | 'provider'>,
  remoteId: string
): Promise<() => void> {
  const target = marker(db, input),
    snapshot = await tx.get(target);
  if (!snapshot.exists || snapshot.get('state') === 'cancelled') return () => {};
  if (
    snapshot.get('projectId') !== input.ref.projectId ||
    snapshot.get('sermonId') !== input.sermonId ||
    snapshot.get('provider') !== input.provider ||
    snapshot.get('state') !== 'bound' ||
    snapshot.get('remoteId') !== remoteId
  )
    throw new Error('PUBLISHING_ALLOCATION_RETIREMENT_MISMATCH');
  return () =>
    tx.update(target, {
      state: 'cancelled',
      settlement: 'verified_provider_absence',
      retiredByJobId: input.ref.jobId,
      settledAtMillis: Date.now(),
    });
}
/** A confirmed explicit replacement advances the shared identity along with the canonical pointer. */
export async function preparePublishingAllocationReplacement(
  tx: Transaction,
  db: Firestore,
  input: PublishingAllocationIdentity,
  previousId: string,
  remoteId: string
): Promise<() => void> {
  const target = marker(db, input),
    [snapshot, media] = await Promise.all([
      tx.get(target),
      tx.get(db.collection('temporalMediaState').doc(input.sermonId)),
    ]);
  if (media.get('deletionParentRef'))
    throw Object.assign(new Error('Sermon deletion has closed provider replacement'), {
      code: 'PUBLISHING_SUPERSEDED',
    });
  if (
    snapshot.exists &&
    (snapshot.get('projectId') !== input.ref.projectId ||
      snapshot.get('sermonId') !== input.sermonId ||
      snapshot.get('provider') !== input.provider ||
      snapshot.get('state') !== 'bound' ||
      ![previousId, remoteId].includes(snapshot.get('remoteId')))
  )
    throw new Error('PUBLISHING_ALLOCATION_REPLACEMENT_MISMATCH');
  return () =>
    tx.set(target, {
      schemaVersion: 1,
      projectId: input.ref.projectId,
      sermonId: input.sermonId,
      provider: input.provider,
      ownerJobId: input.ref.jobId,
      operationKey: input.operationKey,
      receiptIds: [providerReceiptId(input.operationKey, 'soundcloud-track')],
      state: 'bound',
      remoteId,
      boundAtMillis: Date.now(),
      previousRemoteId: previousId,
    });
}

/** The media deletion tombstone closes future allocation claims; this read also
 * proves that no earlier allocation still owns a possible in-flight POST. */
export async function assertPublishingDeletionAllocationsSettled(
  tx: Transaction,
  db: Firestore,
  input: { ref: PublishingJobRef; sermonId: string; subsplashId?: string; soundCloudTrackId?: string }
): Promise<void> {
  const media = await tx.get(db.collection('temporalMediaState').doc(input.sermonId));
  if (
    media.get('deletionParentRef.projectId') !== input.ref.projectId ||
    media.get('deletionParentRef.jobId') !== input.ref.jobId
  )
    throw Object.assign(new Error('Provider allocation must be closed before deletion'), {
      code: 'PUBLISHING_PROVIDER_REPAIR_REQUIRED',
    });
  for (const provider of ['subsplash', 'soundcloud'] as const) {
    const saved = await tx.get(marker(db, { ref: input.ref, sermonId: input.sermonId, provider }));
    if (!saved.exists || saved.get('state') === 'cancelled') continue;
    if (
      saved.get('projectId') !== input.ref.projectId ||
      saved.get('sermonId') !== input.sermonId ||
      saved.get('provider') !== provider
    )
      throw new Error('PUBLISHING_ALLOCATION_SCOPE_MISMATCH');
    const known = provider === 'subsplash' ? input.subsplashId : input.soundCloudTrackId;
    if (saved.get('state') !== 'bound' || !known || saved.get('remoteId') !== known) {
      const owner = saved.get('ownerJobId');
      if (typeof owner !== 'string' || !owner) throw new Error('PUBLISHING_ALLOCATION_SCOPE_MISMATCH');
      pending(owner);
    }
  }
}

/** Read in both admission and final canonical edit transactions. A bound owner
 * permits metadata edits only when its fixed identity is actually canonical. */
export async function assertPublishingContentUpdateAllocationsSettled(
  tx: Transaction,
  db: Firestore,
  input: { ref: PublishingJobRef; sermonId: string }
): Promise<void> {
  const sermon = await tx.get(db.collection('sermons').doc(input.sermonId));
  if (!sermon.exists) throw Object.assign(new Error('Sermon removed'), { code: 'PUBLISHING_SUPERSEDED' });
  for (const provider of ['subsplash', 'soundcloud'] as const) {
    const saved = await tx.get(marker(db, { ref: input.ref, sermonId: input.sermonId, provider }));
    if (!saved.exists || saved.get('state') === 'cancelled') continue;
    if (
      saved.get('projectId') !== input.ref.projectId ||
      saved.get('sermonId') !== input.sermonId ||
      saved.get('provider') !== provider
    )
      throw new Error('PUBLISHING_ALLOCATION_SCOPE_MISMATCH');
    if (saved.get('state') === 'bound' && sermon.get(field(provider)) === saved.get('remoteId')) continue;
    const owner = saved.get('ownerJobId');
    if (typeof owner !== 'string' || !owner) throw new Error('PUBLISHING_ALLOCATION_SCOPE_MISMATCH');
    pending(owner);
  }
}
