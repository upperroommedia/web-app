import { firestore } from 'firebase-functions';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import handleError from '../../handleError';
import { firestoreAdminSermonConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';

const sermonListOnDelete = firestore
  .document('sermons/{sermonId}/sermonLists/{sermonListId}')
  .onDelete(async (snapshot, context) => {
    const { sermonId } = context.params;
    const firestore = firebaseAdmin.firestore();
    try {
      firestore
        .doc(`sermons/${sermonId}`)
        .withConverter(firestoreAdminSermonConverter)
        .update({
          numberOfLists: FieldValue.increment(-1),
        });
    } catch (error) {
      throw handleError(error);
    }
  });

export default sermonListOnDelete;
