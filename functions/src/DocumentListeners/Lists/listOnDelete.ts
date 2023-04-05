import { firestore } from 'firebase-functions';
import { firestore as firestoreAdmin } from 'firebase-admin';
import handleError from '../../handleError';

const listOnDelete = firestore.document('lists/{listId}').onDelete(async (_snapshot, context) => {
  const { listId } = context.params;
  try {
    return firestoreAdmin().recursiveDelete(firestoreAdmin().doc(`lists/${listId}`));
  } catch (error) {
    throw handleError(error);
  }
});

export default listOnDelete;
