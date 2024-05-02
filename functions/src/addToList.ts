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
  isAlreadyInList,
} from './helpers/addToListHelpers';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { firestoreAdminListConverter } from './firestoreDataConverter';
import { Timestamp } from 'firebase-admin/firestore';
import { canUserRolePublish } from '../../types/User';
const firestoreDB = firebaseAdmin.firestore();
export interface AddtoListInputType {
  listsMetadata: listMetaDataType[];
  mediaItem: MediaItem;
}
type status = 'success' | 'error';
type OutputTypes =
  | {
      listId: string;
      status: 'success';
      listItemId: string;
    }
  | {
      listId: string;
      status: 'error';
      error: string;
    };
export type AddToListOutputType = OutputTypes[];

const addToSingleList = async (
  listId: string,
  mediaItem: MediaItem,
  overflowBehavior: OverflowBehavior,
  maxListCount: number,
  token: string,
  type: ListType
): Promise<string> => {
  const currentListCount = await getListCount(listId, token);
  let newListCount = currentListCount + 1;

  // if the new list count is less than the max list count, add the item to the list
  if (newListCount <= maxListCount) {
    logger.log('Adding item to list');
    return await addItemToList(mediaItem, listId, newListCount, token);
  }

  // handle overflow behavior
  if (overflowBehavior === OverflowBehavior.CREATENEWLIST) {
    logger.log('Handling overflow behavior: CREATENEWLIST for list: ', listId);
    throw new HttpsError(
      'unimplemented',
      'OverflowBehavior "CREATENEWLIST" is not yet implemented. To upload to this list please manually adjust the list size in subsplash to be less than 200 items then try again.'
    );
  } else if (overflowBehavior === OverflowBehavior.REMOVEOLDEST) {
    logger.log('Handling overflow behavior: REMOVEOLDEST for list: ', listId);
    await removeNOldestItems(1, listId, token, 'created_at');
    newListCount--;
    return await addItemToList(mediaItem, listId, newListCount, token);
  } else {
    throw new HttpsError(
      'failed-precondition',
      'The list you tried to has reached its max size. Please remove items or set the overflow behavior'
    );
  }
};

const addToList = onCall(async (request: CallableRequest<AddtoListInputType>): Promise<AddToListOutputType> => {
  logger.log('addToList');

  if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  const data = request.data;
  if (!data.listsMetadata || !data.mediaItem) {
    throw new HttpsError('invalid-argument', 'The function must be called with a listsMetadata and mediaItem.');
  }
  const maxListCount = 200;
  try {
    const token = await authenticateSubsplash();
    const result = await Promise.allSettled(
      data.listsMetadata.map(async (list) => {
        const listRef = firestoreDB
          .collection('lists')
          .where('subsplashId', '==', list.listId)
          .limit(1)
          .withConverter(firestoreAdminListConverter);
        return await firestoreDB.runTransaction(async (transaction) => {
          const firebaseListSnapshot = await transaction.get(listRef);
          if (firebaseListSnapshot.empty) {
            throw new HttpsError(
              'not-found',
              `The list you tried to add to does not exist in firestore: ${list.listId}`
            );
          }
          const firebaseList = firebaseListSnapshot.docs[0];
          firebaseList.ref.update({ updatedAtMillis: Timestamp.now().toMillis() }); // block other transactions from moving past this point
          const alreadyInList = await isAlreadyInList(data.mediaItem, list.listId, token, maxListCount);
          let listItemId: string;
          if (!alreadyInList.isInList) {
            listItemId = await addToSingleList(
              list.listId,
              data.mediaItem,
              list.overflowBehavior,
              maxListCount,
              token,
              list.type
            );
          } else {
            logger.log(`Media item: ${data.mediaItem.id} is already in list: ${list.listId}, skipping...`);
            listItemId = alreadyInList.listItemId;
          }
          firebaseList.ref.update({ updatedAtMillis: Timestamp.now().toMillis() });
          return listItemId;
        });
      })
    );
    const returnResult = result.map((r, index) => {
      if (r.status === 'fulfilled') {
        const status: status = 'success';
        return { listId: data.listsMetadata[index].listId, status, listItemId: r.value };
      } else {
        const status: status = 'error';
        let message = '';
        if ('message' in r.reason) {
          message = r.reason.message;
        } else {
          message = JSON.stringify(r.reason);
        }
        logger.error(r.status, r.reason);
        return { listId: data.listsMetadata[index].listId, status, error: message };
      }
    });
    return returnResult;
  } catch (err) {
    throw handleError(err);
  }
});

export default addToList;
