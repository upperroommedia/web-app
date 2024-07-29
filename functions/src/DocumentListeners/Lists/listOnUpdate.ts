import { firestore, logger } from 'firebase-functions';
import { isEqual } from 'lodash';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { firestoreAdminSermonListConverter } from '../../firestoreDataConverter';
import handleError from '../../handleError';

const listOnUpdate = firestore.document('lists/{listId}').onUpdate(async (change, context) => {
  const { listId } = context.params;
  logger.log('listOnUpdate triggered for: ', listId);
  const updatedList = change.after.data();
  const firestore = firebaseAdmin.firestore();
  const originalList = change.before.data();
  const { count: _countBefore, ...originalListNoCount } = originalList;
  const { count: _countAfter, ...updatedListNoCount } = updatedList;
  const onlyCountUpdated = isEqual(originalListNoCount, updatedListNoCount);
  logger.debug('Original list vs updated list for list id: ', listId, originalList, updatedList);
  if (onlyCountUpdated) {
    logger.log(`The count was the only property that changed for ${listId}. Returning early`);
    return;
  }
  try {
    // update all series instances of sermon

    logger.log('Updating list: ', listId, ' in all sermon series');
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
