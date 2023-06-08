import { firestore, logger } from 'firebase-functions';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { firestoreAdminSermonListConverter } from '../../firestoreDataConverter';
import handleError from '../../handleError';

const listOnUpdate = firestore.document('lists/{listId}').onUpdate(async (change, context) => {
  const { listId } = context.params;
  const updatedList = change.after.data();
  const firestore = firebaseAdmin.firestore();
  try {
    // update all series instances of sermon
    logger.log('Updating list: ', listId, ' in all sermon series');
    logger.log('Updated list: ', updatedList);
    const sermonListSnapshot = await firestore
      .collectionGroup('sermonLists')
      .withConverter(firestoreAdminSermonListConverter)
      .where('id', '==', listId)
      .get();
    logger.log('Found ', sermonListSnapshot.size, ' sermon series to update');
    const batch = firestore.batch();
    sermonListSnapshot.docs.forEach((doc) => {
      batch.update(doc.ref, { ...updatedList });
    });
    return batch.commit();
  } catch (error) {
    throw handleError(error);
  }
});

export default listOnUpdate;
