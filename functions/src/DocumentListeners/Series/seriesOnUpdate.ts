import { firestore } from 'firebase-functions';
import { firestore as firestoreAdmin } from 'firebase-admin';
import handleError from '../../handleError';

const seriesOnUpdate = firestore.document('series/{seriesId}').onUpdate(async (change, context) => {
  const { seriesId } = context.params;
  const updatedSermon = change.after.data();
  try {
    // update all series instances of sermon
    const sermonSeriesSnapshot = await firestoreAdmin()
      .collectionGroup('sermonSeries')
      .where('id', '==', seriesId)
      .get();
    const batch = firestoreAdmin().batch();
    sermonSeriesSnapshot.docs.forEach((doc) => {
      batch.update(doc.ref, { ...updatedSermon });
    });
    return batch.commit();
  } catch (error) {
    throw handleError(error);
  }
});

export default seriesOnUpdate;
