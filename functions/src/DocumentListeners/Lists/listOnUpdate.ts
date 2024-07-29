import { firestore, logger } from 'firebase-functions';
import { isEqual } from 'lodash';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { List } from '../../../../types/List';
import { firestoreAdminSermonListConverter } from '../../firestoreDataConverter';
import handleError from '../../handleError';

const listOnUpdate = firestore.document('lists/{listId}').onUpdate(async (change, context) => {
  const { listId } = context.params;
  logger.log('listOnUpdate triggered for: ', listId);
  const originalList = change.before.data() as List;
  const updatedList = change.after.data() as List;
  const firestore = firebaseAdmin.firestore();

  const {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    count: _countBefore,
    updatedAtMillis: _updatedAtMillisBefore,
    /* eslint-enable @typescript-eslint/no-unused-vars */
    ...originalListNoCountOrUpdatedAt
  } = originalList;
  const {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    count: _countAfter,
    updatedAtMillis: _updatedAtMillisAfter,
    /* eslint-enable @typescript-eslint/no-unused-vars */
    ...updatedListNoCountOrUpdatedAt
  } = updatedList;
  const onlyCountUpdated = isEqual(originalListNoCountOrUpdatedAt, updatedListNoCountOrUpdatedAt);
  logger.debug('Original list: ', originalList);
  logger.debug('Updated list: ', updatedList);
  if (onlyCountUpdated) {
    logger.log(`The count or updatedAtMillis were the only properties that changed for ${listId}. Returning early`);
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
