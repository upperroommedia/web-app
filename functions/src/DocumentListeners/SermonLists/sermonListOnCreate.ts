import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import handleError from '../../handleError';
import { firestoreAdminSermonConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';

const sermonListOnCreate = onDocumentCreated(
  'sermons/{sermonId}/sermonLists/{sermonListId}',
  async (event) => {
    const { sermonId } = event.params;
    const firestore = firebaseAdmin.firestore();
    try {
      await firestore
        .doc(`sermons/${sermonId}`)
        .withConverter(firestoreAdminSermonConverter)
        .update({
          numberOfLists: FieldValue.increment(1),
        });
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default sermonListOnCreate;
