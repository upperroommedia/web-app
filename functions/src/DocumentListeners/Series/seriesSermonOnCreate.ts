import { firestore } from 'firebase-functions';
import { firestore as firestoreAdmin } from 'firebase-admin';
import handleError from '../../handleError';
import { firestoreAdminSeriesConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
// TODO: add on update listener
const seriesSermonOnCreate = firestore
  .document('series/{seriesId}/seriesSermons/{sermonId}')
  .onCreate(async (snapshot, context) => {
    const { seriesId, sermonId } = context.params;
    try {
      const series = (await firestoreAdmin().collection('series').doc(seriesId).get()).data();
      if (!series) {
        throw new HttpsError('internal', 'Something went wrong, please try again later');
      }
      const batch = firestoreAdmin().batch();
      batch.create(
        firestoreAdmin()
          .collection('sermons')
          .doc(sermonId)
          .collection('sermonSeries')
          .doc(seriesId)
          .withConverter(firestoreAdminSeriesConverter),
        series
      );
      batch.update(firestoreAdmin().doc(`series/${seriesId}`).withConverter(firestoreAdminSeriesConverter), {
        count: FieldValue.increment(1),
      });
      return batch.commit();
    } catch (error) {
      throw handleError(error);
    }
  });

export default seriesSermonOnCreate;
