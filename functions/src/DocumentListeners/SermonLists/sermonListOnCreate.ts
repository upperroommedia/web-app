import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import handleError from '../../handleError';
import { firestoreAdminSermonConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';
import { ensureSermonCountInvariant } from '../../utils/sermonCountInvariantGuard';
import { syncRootProjectionStatusFromCanonical } from '../../helpers/syncRootProjectionStatusFromCanonical';
import { SermonList } from '@upperroom/shared/types/SermonList';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { deriveSubsplashStatus } from '../../utils/deriveSubsplashStatus';

const sermonListOnCreate = onDocumentCreated('sermons/{sermonId}/sermonLists/{sermonListId}', async (event) => {
  const { sermonId, sermonListId } = event.params;
  const firestore = firebaseAdmin.firestore();
  const sermonList = event.data?.data() as SermonList | undefined;
  // Update counters using transaction for atomicity
  try {
    const sermonRef = firestore.doc(`sermons/${sermonId}`).withConverter(firestoreAdminSermonConverter);
    let didMutate = false;
    await firestore.runTransaction(async (transaction) => {
      const sermonDoc = await transaction.get(sermonRef);
      if (sermonDoc.exists) {
        const sermon = sermonDoc.data();
        const nextNumberOfLists = (sermon?.numberOfLists ?? 0) + 1;
        const nextNumberOfListsUploadedTo = (sermon?.numberOfListsUploadedTo ?? 0)
          + (sermonList?.uploadStatus?.status === uploadStatus.UPLOADED ? 1 : 0);

        transaction.update(sermonRef, {
          numberOfLists: FieldValue.increment(1),
          ...(sermonList?.uploadStatus?.status === uploadStatus.UPLOADED
            ? { numberOfListsUploadedTo: FieldValue.increment(1) }
            : {}),
          'status.subsplash': deriveSubsplashStatus(nextNumberOfLists, nextNumberOfListsUploadedTo),
        });
        didMutate = true;
      } else {
        console.warn(`Sermon ${sermonId} does not exist, skipping counter updates`);
      }
    });
    if (didMutate) {
      await ensureSermonCountInvariant(sermonId);
    }
    await syncRootProjectionStatusFromCanonical({
      sermonId,
      rootListId: sermonList?.rootListId ?? sermonListId,
      canonicalMembership: sermonList,
    });
  } catch (error) {
    console.error(`Error in sermomListOnCreate for sermon ${sermonId}:`, error);
    throw handleError(error);
  }
});

export default sermonListOnCreate;
