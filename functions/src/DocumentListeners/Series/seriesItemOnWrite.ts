import { createHash } from 'node:crypto';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { authenticateSubsplash } from '../../subsplashUtils';
import { getSeriesSubtitleFromPublishedCount, patchSeriesMetadata } from '../../helpers/seriesHelpers';
import handleError from '../../handleError';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import { subsplashSecretsWithRuntimeAlerts } from '../../subsplashSecrets';
import { withLegacyAdmissionLease } from '../../temporal/legacyAdmissionLease';
import { isDomainTemporalEnabled } from '../../temporal/ownership';
import {
  NativeEventTimestamp,
  ProviderListenerEvent,
  runLegacyProviderListener,
  timestampAtOrBefore,
  validNativeTimestamp,
  sameNativeTimestamp,
  parseProviderEventTime,
  assertProviderListenerEventInTransaction,
  type ProviderListenerLeaseContext,
} from '../providerListenerContinuation';

type SeriesListenerLeaseContext = ProviderListenerLeaseContext & { event: ProviderListenerEvent };
const firestore = firebaseAdmin.firestore();
const nativeIdentity = (timestamp: NativeEventTimestamp) => [timestamp.seconds, timestamp.nanoseconds];
export const SERIES_METADATA_CONTINUATIONS = 'seriesMetadataContinuations';
interface SeriesMetadataContinuation {
  schemaVersion: 1;
  projectId: string;
  seriesId: string;
  seriesCreatedAt: NativeEventTimestamp;
  metadataRevision: NativeEventTimestamp;
  admittedProjection: { itemCount: number; publishedItemCount: number; subtitle: string };
  event: ProviderListenerEvent;
  state: 'pending' | 'completed';
}
function storedContinuation(value: unknown, seriesId: string): SeriesMetadataContinuation | undefined {
  if (value === undefined) return undefined;
  const candidate = value as Partial<SeriesMetadataContinuation> | null;
  const event = candidate?.event,
    projection = candidate?.admittedProjection;
  if (
    !candidate ||
    candidate.schemaVersion !== 1 ||
    candidate.projectId !== firebaseAdmin.app().options.projectId ||
    candidate.seriesId !== seriesId ||
    !['pending', 'completed'].includes(candidate.state ?? '') ||
    !validNativeTimestamp(candidate.seriesCreatedAt) ||
    !validNativeTimestamp(candidate.metadataRevision) ||
    !event ||
    typeof event.id !== 'string' ||
    !event.id ||
    typeof event.time !== 'string' ||
    !validNativeTimestamp(event.sourceCreatedAt) ||
    !projection ||
    !Number.isSafeInteger(projection.itemCount) ||
    !Number.isSafeInteger(projection.publishedItemCount) ||
    projection.itemCount < 0 ||
    projection.publishedItemCount < 0 ||
    projection.publishedItemCount > projection.itemCount ||
    typeof projection.subtitle !== 'string'
  )
    throw new HttpsError('failed-precondition', 'The private pending series metadata event needs reconciliation.');
  parseProviderEventTime(event.time);
  return candidate as SeriesMetadataContinuation;
}
const sameEvent = (a: ProviderListenerEvent, b: ProviderListenerEvent) =>
  a.id === b.id && a.time === b.time && sameNativeTimestamp(a.sourceCreatedAt, b.sourceCreatedAt);

/** Derive counts from current rows; duplicate or reordered events cannot drift counters. */
export const deriveCurrentSeriesMetadata = async (
  seriesId: string,
  event?: ProviderListenerEvent,
  sourceCreatedAt = event?.sourceCreatedAt,
  legacyContext?: SeriesListenerLeaseContext
) => {
  const seriesRef = firestore.collection('series').doc(seriesId);
  const continuationRef = firestore.collection(SERIES_METADATA_CONTINUATIONS).doc(seriesId);
  return firestore.runTransaction(async (transaction) => {
    if (legacyContext) {
      await assertProviderListenerEventInTransaction(transaction, firestore, legacyContext.event, legacyContext);
    }
    const [series, continuationSnapshot] = await Promise.all([
      transaction.get(seriesRef),
      transaction.get(continuationRef),
    ]);
    if (
      !series.exists ||
      !series.createTime ||
      (sourceCreatedAt && !timestampAtOrBefore(series.createTime, sourceCreatedAt))
    )
      return undefined;
    const previous = storedContinuation(continuationSnapshot.data(), seriesId);
    const rows = seriesRef.collection('seriesItems');
    const [total, published] = await Promise.all([
      transaction.get(rows.count()),
      transaction.get(rows.where('publishedToSubsplash', '==', true).count()),
    ]);
    const metadata = {
      itemCount: total.data().count,
      publishedItemCount: published.data().count,
      subtitle: getSeriesSubtitleFromPublishedCount(published.data().count),
    };
    const current = series.data()!;
    const subtitleChanged = current.subtitle !== metadata.subtitle;
    const changed =
      current.itemCount !== metadata.itemCount ||
      current.publishedItemCount !== metadata.publishedItemCount ||
      subtitleChanged;
    let pendingEvent =
      previous?.state === 'pending' && sameNativeTimestamp(previous.seriesCreatedAt, series.createTime)
        ? previous.event
        : undefined;
    let newContinuation: SeriesMetadataContinuation | undefined;
    if (current.subsplashId && subtitleChanged && event) {
      if (!series.updateTime)
        throw new HttpsError('failed-precondition', 'The current series metadata revision is unavailable.');
      // An old duplicate may observe newer rows; native revision also distinguishes A -> B -> A.
      const id = `series-metadata-${createHash('sha256')
        .update(
          JSON.stringify([
            firebaseAdmin.app().options.projectId,
            seriesId,
            nativeIdentity(series.createTime),
            nativeIdentity(series.updateTime),
            metadata,
            event.id,
          ])
        )
        .digest('hex')}`;
      pendingEvent = {
        id,
        time: event.time,
        sourceCreatedAt: {
          seconds: event.sourceCreatedAt.seconds,
          nanoseconds: event.sourceCreatedAt.nanoseconds,
        },
      };
    } else if (
      !previous &&
      !pendingEvent &&
      typeof current._durableMetadataPendingEventId === 'string' &&
      event?.id === current._durableMetadataPendingEventId
    ) {
      // An old public marker alone is never timestamp authority. Only the original platform
      // event can upgrade it to protected facts; forged client time/generation fields are ignored.
      pendingEvent = {
        id: event.id,
        time: event.time,
        sourceCreatedAt: {
          seconds: event.sourceCreatedAt.seconds,
          nanoseconds: event.sourceCreatedAt.nanoseconds,
        },
      };
    }
    if (pendingEvent && pendingEvent !== previous?.event) {
      if (!series.updateTime)
        throw new HttpsError('failed-precondition', 'The current series metadata revision is unavailable.');
      newContinuation = {
        schemaVersion: 1,
        projectId: firebaseAdmin.app().options.projectId || '',
        seriesId,
        seriesCreatedAt: { seconds: series.createTime.seconds, nanoseconds: series.createTime.nanoseconds },
        metadataRevision: { seconds: series.updateTime.seconds, nanoseconds: series.updateTime.nanoseconds },
        admittedProjection: metadata,
        event: pendingEvent,
        state: 'pending',
      };
    }
    if (changed || newContinuation)
      transaction.update(seriesRef, {
        ...metadata,
        updatedAt: FieldValue.serverTimestamp(),
        ...(pendingEvent ? { _durableMetadataPendingEventId: pendingEvent.id } : {}),
      });
    if (newContinuation) transaction.set(continuationRef, newContinuation);
    return {
      ...metadata,
      subsplashId: typeof current.subsplashId === 'string' ? current.subsplashId : '',
      seriesCreatedAt: { seconds: series.createTime.seconds, nanoseconds: series.createTime.nanoseconds },
      ...(pendingEvent ? { pendingEventId: pendingEvent.id, pendingEvent } : {}),
    };
  });
};

export const handleSeriesItemWrite = async (
  event: ProviderListenerEvent & { params: { seriesId: string } }
): Promise<void> => {
  const { seriesId } = event.params;
  try {
    const temporal = isDomainTemporalEnabled('publishing');
    const run = async (legacyContext?: SeriesListenerLeaseContext) => {
      if (legacyContext) {
        await firestore.runTransaction((tx) =>
          assertProviderListenerEventInTransaction(tx, firestore, event, legacyContext)
        );
        await legacyContext.lease.markEffectsStarted();
      }
      const metadata = await deriveCurrentSeriesMetadata(seriesId, event, event.sourceCreatedAt, legacyContext);
      if (!metadata) return;
      if (metadata.subsplashId && metadata.pendingEventId) {
        if (temporal) {
          const { enqueueSystemJob } = await import('../../temporal/bridge');
          await enqueueSystemJob({
            kind: 'series.sync_metadata',
            entity: { type: 'series', id: seriesId },
            eventId: metadata.pendingEventId,
            payload: {},
            dispatch: {
              workflowType: 'publishingEntityWorkflow',
              workflowId: `series-metadata:${seriesId}:${metadata.pendingEventId}`,
              taskQueue: 'urm-orchestration',
            },
          });
        } else {
          if (!metadata.pendingEvent)
            throw new HttpsError(
              'failed-precondition',
              'The original pending series event is required before provider work.'
            );
          await withSubsplashLocks([`series:${metadata.subsplashId}`], async () => {
            await runLegacyProviderListener({
              firestore,
              projectId: firebaseAdmin.app().options.projectId || '',
              operation: 'seriesItemOnWrite',
              entityPath: `series/${seriesId}`,
              event: metadata.pendingEvent!,
              existingLease: legacyContext?.lease,
              async validateCurrent(tx) {
                const current = await tx.get(firestore.collection('series').doc(seriesId));
                return (
                  current.exists &&
                  Boolean(current.createTime) &&
                  sameNativeTimestamp(current.createTime!, metadata.seriesCreatedAt) &&
                  current.get('subsplashId') === metadata.subsplashId
                );
              },
              async effect() {
                // Current counts under the provider lock, never an old event projection.
                const latest = await deriveCurrentSeriesMetadata(
                  seriesId,
                  undefined,
                  metadata.seriesCreatedAt,
                  legacyContext
                );
                if (latest?.subsplashId === metadata.subsplashId)
                  await patchSeriesMetadata(
                    latest.subsplashId,
                    { subtitle: latest.subtitle },
                    await authenticateSubsplash()
                  );
              },
            });
          });
        }
        await firestore.runTransaction(async (tx) => {
          if (legacyContext) await assertProviderListenerEventInTransaction(tx, firestore, event, legacyContext);
          const ref = firestore.collection('series').doc(seriesId);
          const continuationRef = firestore.collection(SERIES_METADATA_CONTINUATIONS).doc(seriesId);
          const [current, privateSnapshot] = await Promise.all([tx.get(ref), tx.get(continuationRef)]);
          const privateHead = storedContinuation(privateSnapshot.data(), seriesId);
          if (
            current.exists &&
            current.createTime &&
            sameNativeTimestamp(current.createTime, metadata.seriesCreatedAt) &&
            privateHead?.state === 'pending' &&
            sameNativeTimestamp(privateHead.seriesCreatedAt, metadata.seriesCreatedAt) &&
            metadata.pendingEvent &&
            sameEvent(privateHead.event, metadata.pendingEvent)
          ) {
            // Retain the completed native revision and projection as the authoritative head.
            tx.update(continuationRef, { state: 'completed', completedAt: FieldValue.serverTimestamp() });
            if (current.get('_durableMetadataPendingEventId') === metadata.pendingEventId)
              tx.update(ref, { _durableMetadataPendingEventId: FieldValue.delete() });
          }
        });
      }
      logger.info(`seriesItemOnWrite: recalculated metadata for series/${seriesId}`, {
        itemCount: metadata.itemCount,
        publishedItemCount: metadata.publishedItemCount,
      });
    };
    if (temporal) await run();
    else
      await withLegacyAdmissionLease(
        firestore,
        {
          projectId: firebaseAdmin.app().options.projectId || '',
          domain: 'publishing',
          actorUid: 'system:firebase-event',
          operation: 'seriesItemOnWrite',
          continuation: true,
        },
        (lease) =>
          run({ lease, projectId: firebaseAdmin.app().options.projectId || '', operation: 'seriesItemOnWrite', event })
      );
  } catch (error) {
    throw handleError(error);
  }
};

const seriesItemOnWrite = onDocumentWritten(
  { document: 'series/{seriesId}/seriesItems/{itemId}', retry: true, secrets: subsplashSecretsWithRuntimeAlerts },
  async (event) => {
    const source = event.data?.after.exists ? event.data.after : event.data?.before;
    if (!source?.createTime) return;
    await handleSeriesItemWrite({
      id: event.id,
      time: event.time,
      sourceCreatedAt: source.createTime,
      params: event.params,
    });
  }
);
export default seriesItemOnWrite;
