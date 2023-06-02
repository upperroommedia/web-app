import { firestore } from 'firebase-functions';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import handleError from '../../handleError';

const listOnDelete = firestore.document('lists/{listId}').onDelete(async (_snapshot, context) => {
  const { listId } = context.params;
  const firestore = firebaseAdmin.firestore();
  try {
    return firestore.recursiveDelete(firestore.doc(`lists/${listId}`));
  } catch (error) {
    throw handleError(error);
  }
});

export default listOnDelete;
