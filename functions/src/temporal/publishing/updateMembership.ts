import { createHash } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { PrivatePublishingIntent, PublishingDomainDependencies } from './types';

type Store = Pick<
  PublishingDomainDependencies,
  'assertCurrent' | 'mutateLists' | 'mutateSeries' | 'ensureSubsplashMedia' | 'awaitSubsplashReady'
> & {
  commitCurrent(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
};
const db = () => firebaseAdmin.firestore();
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && !!id && !id.includes('/')) : [];
function selection(intent: PrivatePublishingIntent) {
  const payload = intent.payload;
  const previousSeriesId = typeof payload.previousSeriesId === 'string' ? payload.previousSeriesId : null;
  const desiredSeriesId = typeof payload.desiredSeriesId === 'string' ? payload.desiredSeriesId : null;
  return {
    previousSeriesId,
    desiredSeriesId,
    previousSeriesPublished: payload.previousSeriesPublished === true,
    previousListIds: ids(payload.previousListIds),
    publishedListIds: ids(payload.publishedListIds),
    desiredListIds: intent.destinations.listIds,
  };
}
function assertWriteBudget(removed: number, selected: number, seriesChanged: boolean, physicalExtras = removed): void {
  if (removed * 2 + selected * 2 + physicalExtras + (seriesChanged ? 3 : 0) + 1 > 450)
    throw new HttpsError(
      'failed-precondition',
      'Too many membership changes for one edit. Save smaller groups of list changes.',
      { reason: 'PUBLISHING_MEMBERSHIP_CLEANUP_LIMIT' }
    );
}
function canonicalSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSnapshot);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalSnapshot(item)])
    );
  return value;
}
function assertRetainedMemberships(
  intent: PrivatePublishingIntent,
  rows: Array<{ id: string; get(field: string): unknown }>
) {
  if (typeof intent.payload.previousMembershipHash !== 'string') return;
  const plan = selection(intent),
    current = rows.map((row) => row.id).sort(),
    expected = [...plan.previousListIds].sort();
  if (JSON.stringify(current) !== JSON.stringify(expected))
    throw Object.assign(new HttpsError('failed-precondition', 'Memberships changed while this edit was pending.'), {
      code: 'PUBLISHING_DRIFT',
    });
  const retained = new Set(plan.desiredListIds),
    published = new Set(plan.publishedListIds);
  if (
    rows.some(
      (row) =>
        retained.has(row.id) && (row.get('uploadStatus.status') === uploadStatus.UPLOADED) !== published.has(row.id)
    )
  )
    throw Object.assign(
      new HttpsError('failed-precondition', 'A retained publication changed while this edit was pending.'),
      { code: 'PUBLISHING_DRIFT' }
    );
}
/** Metadata edits retain draft memberships; only existing publications are moved/removed. */
export async function reconcilePublishingUpdateMemberships(
  ref: DurableJobRef,
  intent: PrivatePublishingIntent,
  store: Store
): Promise<void> {
  if (intent.action !== 'update' || intent.payload.hasMembershipSelection !== true) return;
  const plan = selection(intent),
    desired = new Set(plan.desiredListIds);
  assertWriteBudget(
    plan.previousListIds.filter((id) => !desired.has(id)).length,
    plan.desiredListIds.length,
    plan.previousSeriesId !== plan.desiredSeriesId
  );
  const removedPublished = plan.publishedListIds.filter((id) => !desired.has(id));
  await store.assertCurrent(ref, intent);
  if (typeof intent.payload.previousMembershipHash === 'string')
    await store.commitCurrent(ref, async (tx) => {
      const checkpoint = db().doc(`temporalPublishingUpdateCheckpoints/${ref.jobId}`);
      const [existing, memberships] = await Promise.all([
        tx.get(checkpoint),
        tx.get(db().doc(`sermons/${intent.sermonId}`).collection('sermonLists').limit(451)),
      ]);
      if (memberships.size > 450) throw new HttpsError('failed-precondition', 'Too many memberships for one edit.');
      assertRetainedMemberships(intent, memberships.docs);
      if (!existing.exists) {
        const previousSeries = plan.previousSeriesId
          ? await tx.get(db().doc(`series/${plan.previousSeriesId}/seriesItems/${intent.sermonId}`))
          : undefined;
        const snapshot = {
          lists: memberships.docs
            .map((doc) => ({
              id: doc.id,
              publishGeneration: doc.get('publishGeneration') ?? 0,
              uploadStatus: doc.get('uploadStatus') ?? { status: 'NOT_UPLOADED' },
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
          previousSeriesId: plan.previousSeriesId,
          previousSeriesPublished: previousSeries?.get('publishedToSubsplash') === true,
        };
        if (
          createHash('sha256')
            .update(JSON.stringify(canonicalSnapshot(snapshot)))
            .digest('hex') !== intent.payload.previousMembershipHash
        )
          throw Object.assign(
            new HttpsError('failed-precondition', 'Memberships changed before this edit could begin.'),
            { code: 'PUBLISHING_DRIFT' }
          );
        tx.set(checkpoint, {
          projectId: ref.projectId,
          jobId: ref.jobId,
          sermonId: intent.sermonId,
          membershipHash: intent.payload.previousMembershipHash,
        });
      }
    });
  if (removedPublished.length)
    await store.mutateLists(ref, {
      ...intent,
      action: 'unpublish',
      destinations: { listIds: removedPublished, soundcloud: false },
    });
  if (plan.previousSeriesId !== plan.desiredSeriesId && plan.previousSeriesPublished) {
    if (plan.previousSeriesId)
      await store.mutateSeries(ref, {
        ...intent,
        action: 'unpublish',
        destinations: { listIds: [], seriesId: plan.previousSeriesId, soundcloud: false },
      });
    if (plan.desiredSeriesId) {
      const moved = {
        ...intent,
        action: 'publish' as const,
        destinations: { listIds: [], seriesId: plan.desiredSeriesId, soundcloud: false },
        payload: { ...intent.payload, removals: { listIds: [], soundcloud: false } },
      };
      await store.ensureSubsplashMedia(ref, moved);
      await store.awaitSubsplashReady(ref, moved);
      await store.mutateSeries(ref, moved);
    }
  }
  await store.assertCurrent(ref, intent);
}
/** Called in the same root generation transaction as the final sermon patch. All reads precede writes. */
export async function commitPublishingUpdateMemberships(
  ref: DurableJobRef,
  intent: PrivatePublishingIntent,
  tx: Transaction,
  markCompleted = false
): Promise<void> {
  if (intent.action !== 'update' || intent.payload.hasMembershipSelection !== true) return;
  const checkpoint = db().doc(`temporalPublishingUpdateCheckpoints/${ref.jobId}`);
  const completed = await tx.get(checkpoint);
  if (completed.get('finalMembershipsCommitted') === true) {
    if (
      completed.get('projectId') !== ref.projectId ||
      completed.get('jobId') !== ref.jobId ||
      completed.get('sermonId') !== intent.sermonId
    )
      throw new HttpsError('failed-precondition', 'Membership completion proof has a different scope.');
    return;
  }
  const plan = selection(intent),
    sermonRef = db().doc(`sermons/${intent.sermonId}`);
  const sermon = await tx.get(sermonRef);
  if (!sermon.exists) throw new HttpsError('not-found', 'The edited sermon no longer exists.');
  const memberships = await tx.get(sermonRef.collection('sermonLists').limit(451));
  assertRetainedMemberships(intent, memberships.docs);
  if (memberships.size > 450)
    throw new HttpsError('failed-precondition', 'Too many existing memberships for one edit.', {
      reason: 'PUBLISHING_MEMBERSHIP_CLEANUP_LIMIT',
    });
  const selected = await Promise.all(
    plan.desiredListIds.map(async (id) => {
      const listRef = db().doc(`lists/${id}`),
        list = await tx.get(listRef),
        row = await tx.get(listRef.collection('listItems').doc(intent.sermonId));
      if (!list.exists) throw new HttpsError('not-found', 'A selected list no longer exists.');
      return { id, list, row };
    })
  );
  const previousSeries = plan.previousSeriesId ? db().doc(`series/${plan.previousSeriesId}`) : undefined;
  const desiredSeries = plan.desiredSeriesId ? db().doc(`series/${plan.desiredSeriesId}`) : undefined;
  const desiredSeriesDoc = desiredSeries ? await tx.get(desiredSeries) : undefined;
  const desiredRow = desiredSeries
    ? await tx.get(desiredSeries.collection('seriesItems').doc(intent.sermonId))
    : undefined;
  const latest = desiredSeries
    ? await tx.get(desiredSeries.collection('seriesItems').orderBy('position', 'desc').limit(1))
    : undefined;
  if (desiredSeries && !desiredSeriesDoc?.exists)
    throw new HttpsError('not-found', 'The selected series no longer exists.');
  const desiredIds = new Set(plan.desiredListIds),
    byId = new Map(memberships.docs.map((doc) => [doc.id, doc]));
  const removed = memberships.docs.filter((membership) => !desiredIds.has(membership.id));
  const physicalExtras = removed.filter((membership) => {
    const physicalId = record(membership.data().physicalPlacement).firestoreListId;
    return typeof physicalId === 'string' && physicalId && !physicalId.includes('/') && physicalId !== membership.id;
  }).length;
  assertWriteBudget(removed.length, selected.length, plan.previousSeriesId !== plan.desiredSeriesId, physicalExtras);
  const content = { ...sermon.data(), ...record(intent.payload.patch), id: intent.sermonId };
  for (const membership of memberships.docs) {
    if (desiredIds.has(membership.id)) continue;
    tx.delete(membership.ref);
    tx.delete(db().doc(`lists/${membership.id}/listItems/${intent.sermonId}`));
    const physicalId = record(membership.data().physicalPlacement).firestoreListId;
    if (typeof physicalId === 'string' && physicalId && !physicalId.includes('/') && physicalId !== membership.id)
      tx.delete(db().doc(`lists/${physicalId}/listItems/${intent.sermonId}`));
  }
  for (const item of selected) {
    const current = byId.get(item.id)?.data();
    const status = current?.uploadStatus ?? { status: uploadStatus.NOT_UPLOADED };
    // Membership generations belong to the worker. New selections are always drafts.
    tx.set(
      sermonRef.collection('sermonLists').doc(item.id),
      {
        ...item.list.data(),
        id: item.id,
        uploadStatus: status,
        publishGeneration: current?.publishGeneration ?? 0,
        _durableMembershipJobId: ref.jobId,
      },
      { merge: true }
    );
    tx.set(item.row.ref, { ...content, uploadStatus: status, _durableMembershipJobId: ref.jobId }, { merge: true });
  }
  if (plan.previousSeriesId !== plan.desiredSeriesId) {
    if (previousSeries) tx.delete(previousSeries.collection('seriesItems').doc(intent.sermonId));
    if (desiredSeries) {
      const maximum = latest?.docs[0]?.get('position');
      const currentPosition = desiredRow?.get('position');
      tx.set(
        desiredSeries.collection('seriesItems').doc(intent.sermonId),
        {
          id: intent.sermonId,
          position:
            typeof currentPosition === 'number' ? currentPosition : typeof maximum === 'number' ? maximum + 1 : 1,
          publishedToSubsplash: plan.previousSeriesPublished,
          ...(plan.previousSeriesPublished && sermon.get('subsplashId')
            ? { sermonSubsplashId: sermon.get('subsplashId') }
            : {}),
          addedAt: desiredRow?.get('addedAt') ?? FieldValue.serverTimestamp(),
          _durableMembershipJobId: ref.jobId,
        },
        { merge: true }
      );
    }
    tx.update(sermonRef, {
      seriesId: plan.desiredSeriesId,
      seriesPublishedToSubsplash: !!plan.desiredSeriesId && plan.previousSeriesPublished,
    });
  }
  if (markCompleted)
    tx.set(
      checkpoint,
      { projectId: ref.projectId, jobId: ref.jobId, sermonId: intent.sermonId, finalMembershipsCommitted: true },
      { merge: true }
    );
}
