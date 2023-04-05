import { firestore } from 'firebase-functions';
import { db } from '../../../../firebase/firebaseAdmin';
import handleError from '../../handleError';

const listOnDelete = firestore.document('lists/{listId}').onDelete(async (_snapshot, context) => {
  const { listId } = context.params;
  try {
    return db.recursiveDelete(db.doc(`lists/${listId}`));
  } catch (error) {
    throw handleError(error);
  }
});

export default listOnDelete;
