import { firestore } from 'firebase-functions';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import handleError from '../../handleError';
import { firestoreAdminSermonConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';
import { SermonList } from '../../../../types/SermonList';
import { removeFromList } from '../../removeFromList';

const sermonListOnDelete = firestore
  .document('sermons/{sermonId}/sermonLists/{sermonListId}')
  .onDelete(async (snapshot, context) => {
    const { sermonId } = context.params;
    const data = snapshot.data() as SermonList;
    const firestoreDb = firebaseAdmin.firestore();

    try {
      const sermonRef = firestoreDb.doc(`sermons/${sermonId}`).withConverter(firestoreAdminSermonConverter);

      // First, try to remove from Subsplash if it was uploaded
      let removeFromSubsplashSuccess = true;
      if (data.uploadStatus && data.uploadStatus.status === 'UPLOADED') {
        try {
          await removeFromList([data.id], [data.uploadStatus.listItemId]);
        } catch (error) {
          console.error(`Failed to remove sermon ${sermonId} from Subsplash list ${data.id}:`, error);
          removeFromSubsplashSuccess = false;
          // Continue with counter updates even if Subsplash removal fails
        }
      }

      // Update counters using transaction for atomicity
      await firestoreDb.runTransaction(async (transaction) => {
        const sermonDoc = await transaction.get(sermonRef);
        if (sermonDoc.exists) {
          const decrementUploadedCount = data.uploadStatus && data.uploadStatus.status === 'UPLOADED' && removeFromSubsplashSuccess ? -1 : 0;

          transaction.update(sermonRef, {
            numberOfLists: FieldValue.increment(-1),
            numberOfListsUploadedTo: FieldValue.increment(decrementUploadedCount),
          });
        } else {
          console.warn(`Sermon ${sermonId} does not exist, skipping counter updates`);
        }
      });

    } catch (error) {
      console.error(`Error in sermonListOnDelete for sermon ${sermonId}:`, error);
      throw handleError(error);
    }
  });

export default sermonListOnDelete;
