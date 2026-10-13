import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { SermonList } from '@upperroom/shared/types/SermonList';
import handleError from '../../handleError';
import { syncMembershipInvariants } from './syncMembershipInvariants';

const sermonListOnUpdate = onDocumentUpdated({ document: 'sermons/{sermonId}/sermonLists/{sermonListId}', retry: true }, async (event) => {
  const { sermonId, sermonListId } = event.params;
  const membership = event.data?.after.data() as SermonList | undefined;
  try {
    await syncMembershipInvariants(
      firebaseAdmin.firestore(), sermonId, sermonListId, membership?.rootListId ?? sermonListId
    );
  } catch (error) {
    throw handleError(error);
  }
});

export default sermonListOnUpdate;
