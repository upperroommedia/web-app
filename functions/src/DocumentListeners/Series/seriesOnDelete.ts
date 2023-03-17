import { firestore } from 'firebase-functions';
import { firestore as firestoreAdmin } from 'firebase-admin';
import handleError from '../../handleError';

const seriesOnDelete = firestore.document('series/{seriesId}').onDelete(async (_snapshot, context) => {
  const { seriesId } = context.params;
  try {
    return firestoreAdmin().recursiveDelete(firestoreAdmin().doc(`series/${seriesId}`));
  } catch (error) {
    throw handleError(error);
  }
});

export default seriesOnDelete;
