import { firestore } from 'firebase-functions';
import { adminFirestore } from '../../../../firebase/initFirebaseAdmin';
import handleError from '../../handleError';

const listOnUpdate = firestore.document('lists/{listId}').onUpdate(async (change, context) => {
  const { listId } = context.params;
  const updatedSermon = change.after.data();
  try {
    // update all series instances of sermon
    const sermonSeriesSnapshot = await adminFirestore.collectionGroup('sermonLists').where('id', '==', listId).get();
    const batch = adminFirestore.batch();
    sermonSeriesSnapshot.docs.forEach((doc) => {
      batch.update(doc.ref, { ...updatedSermon });
    });
    return batch.commit();
  } catch (error) {
    throw handleError(error);
  }
});

export default listOnUpdate;
