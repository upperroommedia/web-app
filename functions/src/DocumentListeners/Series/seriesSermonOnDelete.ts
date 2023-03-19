import { firestore } from 'firebase-functions';
import { firestore as firestoreAdmin } from 'firebase-admin';
import handleError from '../../handleError';
import { firestoreAdminSeriesConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';

const seriesSermonOnDelete = firestore
  .document('series/{seriesId}/seriesSermons/{sermonId}')
  .onDelete(async (snapshot, context) => {
    const { seriesId, sermonId } = context.params;
    try {
      const batch = firestoreAdmin().batch();
      batch.delete(firestoreAdmin().collection('sermons').doc(sermonId).collection('sermonSeries').doc(seriesId));
      console.log('decrementing count');
      batch.update(snapshot.ref.withConverter(firestoreAdminSeriesConverter), {
        count: FieldValue.increment(-1),
      });
      return batch.commit();
    } catch (error) {
      throw handleError(error);
    }
  });

export default seriesSermonOnDelete;
