import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { authenticateSubsplash } from '../../subsplashUtils';
import { getSeriesSubtitleFromPublishedCount, patchSeriesMetadata } from '../../helpers/seriesHelpers';
import handleError from '../../handleError';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import { subsplashSecretsWithRuntimeAlerts } from '../../subsplashSecrets';
import { isDomainTemporalEnabled } from '../../temporal/ownership';

const firestore = firebaseAdmin.firestore();
/** Derive counts from current rows; duplicate or reordered events cannot drift counters. */
export const deriveCurrentSeriesMetadata = async (seriesId: string, eventId?: string) => {
  const seriesRef = firestore.collection('series').doc(seriesId);
  return firestore.runTransaction(async transaction => {
    const series = await transaction.get(seriesRef);
    if (!series.exists) return undefined;
    const rows=seriesRef.collection('seriesItems');
    const [total,published]=await Promise.all([transaction.get(rows.count()),transaction.get(rows.where('publishedToSubsplash','==',true).count())]);
    const metadata={itemCount:total.data().count,publishedItemCount:published.data().count,subtitle:getSeriesSubtitleFromPublishedCount(published.data().count)};
    const current = series.data()!;
    const subtitleChanged=current.subtitle!==metadata.subtitle;
    const changed = current.itemCount !== metadata.itemCount ||
      current.publishedItemCount !== metadata.publishedItemCount || current.subtitle !== metadata.subtitle;
    const pendingEventId=current.subsplashId && current.subtitle!==metadata.subtitle && eventId
      ? eventId : typeof current._durableMetadataPendingEventId==='string'?current._durableMetadataPendingEventId:undefined;
    if (changed) transaction.update(seriesRef, { ...metadata, updatedAt: FieldValue.serverTimestamp(),...(pendingEventId?{_durableMetadataPendingEventId:pendingEventId}:{}) });
    return { ...metadata, subsplashId: typeof current.subsplashId === 'string' ? current.subsplashId : '',
      subtitleChanged,...(pendingEventId?{pendingEventId}:{}) };
  });
};

export const handleSeriesItemWrite = async (event: { id: string; params: { seriesId: string } }): Promise<void> => {
  const { seriesId } = event.params;
  try {
    const metadata = await deriveCurrentSeriesMetadata(seriesId,event.id);
    if (!metadata) return;
    if (metadata.subsplashId && (metadata.subtitleChanged || metadata.pendingEventId)) {
      if (isDomainTemporalEnabled('publishing')) {
        const { enqueueSystemJob } = await import('../../temporal/bridge');
        await enqueueSystemJob({
          kind: 'series.sync_metadata', entity: { type: 'series', id: seriesId }, eventId: metadata.pendingEventId ?? event.id,
          payload: {},
          dispatch: { workflowType: 'publishingEntityWorkflow', workflowId: `series-metadata:${seriesId}:${metadata.pendingEventId ?? event.id}`, taskQueue: 'urm-orchestration' },
        });
      } else {
        await withSubsplashLocks([`series:${metadata.subsplashId}`], async () => {
          // Re-read after taking the provider lock so a delayed event cannot patch an older count.
          const latest = await deriveCurrentSeriesMetadata(seriesId);
          if (!latest?.subsplashId) return;
          await patchSeriesMetadata(latest.subsplashId, { subtitle: latest.subtitle }, await authenticateSubsplash());
        });
      }
      await firestore.runTransaction(async tx=> {
        const ref=firestore.collection('series').doc(seriesId);
        const current=await tx.get(ref);
        if(current.exists && current.get('_durableMetadataPendingEventId')===metadata.pendingEventId) tx.update(ref,{_durableMetadataPendingEventId:FieldValue.delete()});
      });
    }
    logger.info(`seriesItemOnWrite: recalculated metadata for series/${seriesId}`, {
      itemCount: metadata.itemCount, publishedItemCount: metadata.publishedItemCount,
    });
  } catch (error) { throw handleError(error); }
};

const seriesItemOnWrite = onDocumentWritten(
  { document: 'series/{seriesId}/seriesItems/{itemId}', retry: true, secrets: subsplashSecretsWithRuntimeAlerts },
  async event => handleSeriesItemWrite({ id: event.id, params: event.params })
);
export default seriesItemOnWrite;
