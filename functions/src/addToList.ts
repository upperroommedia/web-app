import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { ListType, OverflowBehavior } from '../../types/List';
import handleError from './handleError';
import { authenticateSubsplash } from './subsplashUtils';
import {
  MediaItem,
  getListCount,
  removeNOldestItems,
  listMetaDataType,
  addItemToList,
} from './helpers/addToListHelpers';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { firestoreAdminListConverter } from './firestoreDataConverter';
const firestoreDB = firebaseAdmin.firestore();
export interface AddtoListInputType {
  listsMetadata: listMetaDataType[];
  mediaItem: MediaItem;
}

const addToSingleList = async (
  listId: string,
  mediaItem: MediaItem,
  overflowBehavior: OverflowBehavior,
  maxListCount: number,
  token: string,
  type: ListType
) => {
  const currentListCount = await getListCount(listId, token);
  let newListCount = currentListCount + 1;

  // if the new list count is less than the max list count, add the item to the list
  if (newListCount <= maxListCount) {
    logger.log('Adding item to list');
    await addItemToList(mediaItem, listId, newListCount, token);
    return;
  }

  // handle overflow behavior
  if (overflowBehavior === OverflowBehavior.CREATENEWLIST) {
    throw new HttpsError('unimplemented', 'This function is not implemented yet');
  } else if (overflowBehavior === OverflowBehavior.REMOVEOLDEST) {
    logger.log('Handling overflow behavior: REMOVEOLDEST');
    await removeNOldestItems(1, listId, token, 'created_at');
    newListCount--;
    await addItemToList(mediaItem, listId, newListCount, token);
  } else {
    throw new HttpsError(
      'failed-precondition',
      'The list you tried to has reached its max size. Please remove items or set the overflow behavior'
    );
  }
};

const addToList = onCall(async (request: CallableRequest<AddtoListInputType>): Promise<void> => {
  logger.log('addToList');

  // if (request.auth?.token.role !== 'admin') {
  //   throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  // }
  const data = request.data;
  if (!data.listsMetadata || !data.mediaItem) {
    throw new HttpsError('invalid-argument', 'The function must be called with a listsMetadata and mediaItem.');
  }
  const maxListCount = 5;
  try {
    const token = await authenticateSubsplash();
    await Promise.all(
      data.listsMetadata.map(async (list) => {
        const listRef = firestoreDB.collection('lists').withConverter(firestoreAdminListConverter).doc(list.listId);
        firestoreDB.runTransaction(async (transaction) => {
          const firebaseList = await transaction.get(listRef);
          logger.log('firebaseList', firebaseList.data());
          logger.log('list', list.listId);
          await addToSingleList(list.listId, data.mediaItem, list.overflowBehavior, maxListCount, token, list.type);
        });
      })
    );
  } catch (err) {
    throw handleError(err);
  }
});

export default addToList;
