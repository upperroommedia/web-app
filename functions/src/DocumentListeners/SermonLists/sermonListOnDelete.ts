import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import handleError from '../../handleError';
import { firestoreAdminSermonConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';
import { SermonList } from '../../../../types/SermonList';
import { removeFromList } from '../../removeFromList';

const sermonListOnDelete = onDocumentDeleted('sermons/{sermonId}/sermonLists/{sermonListId}', async (event) => {
  const snapshot = event.data;
  const { sermonId } = event.params;

  if (!snapshot) {
    console.error('Snapshot is undefined in sermonListOnDelete');
    return;
  }

  const data = snapshot.data() as SermonList;
  const firestoreDb = firebaseAdmin.firestore();

  try {
    const sermonRef = firestoreDb.doc(`sermons/${sermonId}`).withConverter(firestoreAdminSermonConverter);

    // First, try to remove from Subsplash if it was uploaded
    let decrementListUploadedToValue = 0;
    if (data.uploadStatus && data.uploadStatus.status === 'UPLOADED') {
      try {
        await removeFromList([data.id], [data.uploadStatus.listItemId]);
        decrementListUploadedToValue = -1;
        logger.info(`Successfully removed sermon ${sermonId} from Subsplash list ${data.id}`);
      } catch (error) {
        logger.error(`Failed to remove sermon ${sermonId} from Subsplash list ${data.id}:`, error);
        // Continue with counter updates even if Subsplash removal fails
      }
    }

    // Update counters using transaction for atomicity
    await firestoreDb.runTransaction(async (transaction) => {
      const sermonDoc = await transaction.get(sermonRef);
      if (sermonDoc.exists) {
        transaction.update(sermonRef, {
          numberOfLists: FieldValue.increment(-1),
          numberOfListsUploadedTo: FieldValue.increment(decrementListUploadedToValue),
        });
        logger.info(`Successfully decremented numberOfLists for sermon ${sermonId}`, {
          oldValues: {
            numberOfLists: sermonDoc.data()?.numberOfLists,
            numberOfListsUploadedTo: sermonDoc.data()?.numberOfListsUploadedTo,
          },
          changedBy: { numberOfLists: -1, numberOfListsUploadedTo: decrementListUploadedToValue },
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
