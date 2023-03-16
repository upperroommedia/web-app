import { firestore } from 'firebase-functions';
import { firestore as firestoreAdmin } from 'firebase-admin';
import handleError from '../../handleError';

const seriesSermonOnDelete = firestore
  .document('series/{seriesId}/seriesSermons/{sermonId}')
  .onDelete(async (_snapshot, context) => {
    const { seriesId, sermonId } = context.params;
    try {
      return firestoreAdmin().collection('sermons').doc(sermonId).collection('sermonSeries').doc(seriesId).delete();
    } catch (error) {
      throw handleError(error);
    }
  });

export default seriesSermonOnDelete;
