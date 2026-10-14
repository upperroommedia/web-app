import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import handleError from '../../handleError';
import type { SermonList } from '@upperroom/shared/types/SermonList';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { removeFromList } from '../../removeFromList';
import { isDomainTemporalEnabled } from '../../temporal/ownership';
import { syncMembershipInvariants } from './syncMembershipInvariants';
import { runLegacyProviderListener, timestampAtOrBefore, sameNativeTimestamp } from '../providerListenerContinuation';
import { HttpsError } from 'firebase-functions/v2/https';

const sermonListOnDelete = onDocumentDeleted(
  { document: 'sermons/{sermonId}/sermonLists/{sermonListId}', retry: true },
  async (event) => {
    const { sermonId, sermonListId } = event.params;
    const data = event.data?.data() as (SermonList & { _durableMembershipJobId?: string }) | undefined;
    if (!data) return;
    const firestore = firebaseAdmin.firestore();
    try {
      // Durable workflows already own provider cleanup. A delayed legacy delete
      // must also leave a newly recreated membership alone.
      if (
        !isDomainTemporalEnabled('publishing') &&
        !data._durableMembershipJobId &&
        data.uploadStatus?.status === uploadStatus.UPLOADED
      ) {
        const listItemId = data.uploadStatus.listItemId;
        const sermonRef = firestore.doc(`sermons/${sermonId}`);
        const sourceCreatedAt = event.data?.createTime;
        const originalSermon = await sermonRef.get();
        if (originalSermon.exists && data.subsplashId) {
          if (!sourceCreatedAt)
            throw new HttpsError('failed-precondition', 'The original membership generation is required.');
          const remoteMediaId = originalSermon.get('subsplashId') || sermonId;
          await runLegacyProviderListener({
            firestore,
            projectId: firebaseAdmin.app().options.projectId || '',
            operation: 'sermonListOnDelete',
            entityPath: `sermons/${sermonId}/sermonLists/${sermonListId}`,
            event: { id: event.id, time: event.time, sourceCreatedAt },
            async validateCurrent(tx) {
              const [membership, sermon] = await Promise.all([
                tx.get(firestore.doc(`sermons/${sermonId}/sermonLists/${sermonListId}`)),
                tx.get(sermonRef),
              ]);
              return (
                !membership.exists &&
                sermon.exists &&
                Boolean(sermon.createTime) &&
                timestampAtOrBefore(sermon.createTime!, sourceCreatedAt) &&
                Boolean(originalSermon.createTime) &&
                sameNativeTimestamp(sermon.createTime!, originalSermon.createTime!) &&
                (sermon.get('subsplashId') || sermonId) === remoteMediaId
              );
            },
            async effect(operationKey, verifyCurrent) {
              const results = await removeFromList(
                [data.subsplashId!],
                [listItemId],
                [remoteMediaId],
                ['media-item'],
                undefined,
                operationKey,
                verifyCurrent
              );
              if (results?.length === 0) return 'stale';
              if (!results || results.length !== 1 || results.some((result) => result.status !== 'success'))
                throw new HttpsError('unknown', 'The provider membership removal needs reconciliation.');
              return undefined;
            },
          });
        }
      }
      await syncMembershipInvariants(firestore, sermonId, sermonListId, data.rootListId ?? sermonListId);
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default sermonListOnDelete;
