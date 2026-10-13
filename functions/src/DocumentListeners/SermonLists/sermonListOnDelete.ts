import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import handleError from '../../handleError';
import type { SermonList } from '@upperroom/shared/types/SermonList';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { removeFromList } from '../../removeFromList';
import { isDomainTemporalEnabled } from '../../temporal/ownership';
import { syncMembershipInvariants } from './syncMembershipInvariants';

const sermonListOnDelete = onDocumentDeleted({ document: 'sermons/{sermonId}/sermonLists/{sermonListId}', retry: true }, async (event) => {
  const { sermonId, sermonListId } = event.params;
  const data = event.data?.data() as (SermonList & { _durableMembershipJobId?: string }) | undefined;
  if (!data) return;
  const firestore = firebaseAdmin.firestore();
  try {
    // Durable workflows already own provider cleanup. A delayed legacy delete
    // must also leave a newly recreated membership alone.
    const currentMembership = await firestore.doc(`sermons/${sermonId}/sermonLists/${sermonListId}`).get();
    if (!isDomainTemporalEnabled('publishing') && !data._durableMembershipJobId && !currentMembership.exists && data.uploadStatus?.status === uploadStatus.UPLOADED) {
      const sermon = await firestore.doc(`sermons/${sermonId}`).get();
      if (sermon.exists && data.subsplashId) {
        try {
          await removeFromList(
            [data.subsplashId], [data.uploadStatus.listItemId],
            [sermon.data()?.subsplashId || sermonId], ['media-item']
          );
        } catch (error) {
          logger.error(`Failed to remove sermon ${sermonId} from Subsplash list ${data.subsplashId}:`, error);
        }
      }
    }
    await syncMembershipInvariants(firestore, sermonId, sermonListId, data.rootListId ?? sermonListId);
  } catch (error) {
    throw handleError(error);
  }
});

export default sermonListOnDelete;
