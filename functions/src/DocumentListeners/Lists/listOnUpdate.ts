import { firestore } from 'firebase-functions';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import handleError from '../../handleError';

const listOnUpdate = firestore.document('lists/{listId}').onUpdate(async (change, context) => {
  const { listId } = context.params;
  const updatedSermon = change.after.data();
  const firestore = firebaseAdmin.firestore();
  try {
    // update all series instances of sermon
    const sermonSeriesSnapshot = await firestore.collectionGroup('sermonLists').where('id', '==', listId).get();
    const batch = firestore.batch();
    sermonSeriesSnapshot.docs.forEach((doc) => {
      batch.update(doc.ref, { ...updatedSermon });
    });
    return batch.commit();
  } catch (error) {
    throw handleError(error);
  }
});

export default listOnUpdate;
