import { firestore } from 'firebase-functions';
import { firestore as firestoreAdmin } from 'firebase-admin';
import handleError from '../../handleError';

const listOnUpdate = firestore.document('lists/{listId}').onUpdate(async (change, context) => {
  const { listId } = context.params;
  const updatedSermon = change.after.data();
  try {
    // update all series instances of sermon
    const sermonSeriesSnapshot = await firestoreAdmin().collectionGroup('sermonLists').where('id', '==', listId).get();
    const batch = firestoreAdmin().batch();
    sermonSeriesSnapshot.docs.forEach((doc) => {
      batch.update(doc.ref, { ...updatedSermon });
    });
    return batch.commit();
  } catch (error) {
    throw handleError(error);
  }
});

export default listOnUpdate;
