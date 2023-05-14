import { firestore } from 'firebase-functions';
import { adminFirestore } from '../../../../firebase/initFirebaseAdmin';
import handleError from '../../handleError';

const listOnDelete = firestore.document('lists/{listId}').onDelete(async (_snapshot, context) => {
  const { listId } = context.params;
  try {
    return adminFirestore.recursiveDelete(adminFirestore.doc(`lists/${listId}`));
  } catch (error) {
    throw handleError(error);
  }
});

export default listOnDelete;
