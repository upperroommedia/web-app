import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import handleError from '../../handleError';

const listOnDelete = onDocumentDeleted('lists/{listId}', async (event) => {
  const { listId } = event.params;
  const firestore = firebaseAdmin.firestore();
  try {
    return firestore.recursiveDelete(firestore.doc(`lists/${listId}`));
  } catch (error) {
    throw handleError(error);
  }
});

export default listOnDelete;
