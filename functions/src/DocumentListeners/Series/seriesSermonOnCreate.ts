import { firestore } from 'firebase-functions';
import { firestore as firestoreAdmin } from 'firebase-admin';
import handleError from '../../handleError';
import { HttpsError } from 'firebase-functions/v2/https';

const seriesSermonOnCreate = firestore
  .document('series/{seriesId}/seriesSermons/{sermonId}')
  .onCreate(async (_snapshot, context) => {
    const { seriesId, sermonId } = context.params;
    try {
      const series = (await firestoreAdmin().collection('series').doc(seriesId).get()).data();
      if (!series) {
        throw new HttpsError('internal', 'Something went wrong, please try again later');
      }
      return firestoreAdmin()
        .collection('sermons')
        .doc(sermonId)
        .collection('sermonSeries')
        .doc(seriesId)
        .create(series);
    } catch (error) {
      throw handleError(error);
    }
  });

export default seriesSermonOnCreate;
