import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import handleError from '../../handleError';
import { firestoreAdminSermonConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';
import { ensureSermonCountInvariant } from '../../utils/sermonCountInvariantGuard';

const sermonListOnCreate = onDocumentCreated('sermons/{sermonId}/sermonLists/{sermonListId}', async (event) => {
  const { sermonId } = event.params;
  const firestore = firebaseAdmin.firestore();
  // Update counters using transaction for atomicity
  try {
    const sermonRef = firestore.doc(`sermons/${sermonId}`).withConverter(firestoreAdminSermonConverter);
    let didMutate = false;
    await firestore.runTransaction(async (transaction) => {
      const sermonDoc = await transaction.get(sermonRef);
      if (sermonDoc.exists) {
        transaction.update(sermonRef, {
          numberOfLists: FieldValue.increment(1),
        });
        didMutate = true;
      } else {
        console.warn(`Sermon ${sermonId} does not exist, skipping counter updates`);
      }
    });
    if (didMutate) {
      await ensureSermonCountInvariant(sermonId);
    }
  } catch (error) {
    console.error(`Error in sermomListOnCreate for sermon ${sermonId}:`, error);
    throw handleError(error);
  }
});

export default sermonListOnCreate;
