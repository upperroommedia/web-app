// add sermon to series and handle condition when list is full
import axios from 'axios';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { List, ListType, OverflowBehavior } from '../../types/List';
import { ListItem } from '../../types/ListItem';
import { Sermon } from '../../types/SermonTypes';
import { createNewSubsplashList } from './createNewSubsplashList';
import {
  firestoreAdminListConverter,
  firestoreAdminListItemConverter,
  firestoreAdminSermonConverter,
} from './firestoreDataConverter';
import handleError from './handleError';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { canUserRolePublish } from '../../types/User';
const firestore = firebaseAdmin.firestore();
const mediaTypes = ['media-item', 'media-series', 'song', 'link', 'rss', 'list'] as const;
type MediaType = (typeof mediaTypes)[number];
type MediaItem = { id: string; type: MediaType };
type sortType = 'position' | 'created_at';

type listMetaDataType = { overflowBehavior: OverflowBehavior; listId: string; type: ListType };

export interface AddtoListInputType {
  listMetadata: listMetaDataType[];
  mediaItemIds: MediaItem[];
}
interface SubsplashListRow {
  id: string;
  position: number;
  _embedded: {
    [key in MediaType]: {
      id: string;
    };
  };
}

type existingSubsplashListRow = Omit<SubsplashListRow, '_embedded'>;
interface newSubsplashListRow extends Omit<SubsplashListRow, 'id' | '_embedded'> {
  app_key: '9XTSHD';
  method: 'static';
  type: MediaType;
  _embedded: { [key in MediaType & 'source-list']: { id: string } };
}

function convertSubsplashListRowToMediaItem(listRows: SubsplashListRow[]): MediaItem[] {
  return listRows.map((listRow) => {
    let mediaKey = undefined;
    for (const key in listRow._embedded) {
      mediaKey = mediaTypes.find((type) => type === key);
      if (mediaKey) {
        break;
      }
    }
    if (!mediaKey || !listRow._embedded[mediaKey]) {
      throw new HttpsError('internal', 'The subsplash list you are adding to is corrupted');
    }
    const mediaItemFull = listRow._embedded[mediaKey];
    if (!mediaItemFull) {
      throw new HttpsError('internal', 'The subsplash list you are adding to is corrupted');
    }
    const mediaItem: MediaItem = {
      id: mediaItemFull.id,
      type: mediaKey,
    };
    return mediaItem;
  });
}

async function getFirestoreSermonFromMediaItem(mediaItems: MediaItem[]) {
  //get sermons from firebase
  const sermons: Sermon[] = await Promise.all(
    mediaItems.map(async (item) => {
      logger.log('Getting sermon from firestore', item.id);
      const sermonDoc = await firestore
        .collection('sermons')
        .where('subsplashId', '==', item.id)
        .withConverter(firestoreAdminSermonConverter)
        .get();
      if (!sermonDoc.docs.length) {
        throw new HttpsError('internal', 'Sermon id was not found in firestore');
      }
      return sermonDoc.docs[0].data();
    })
  );
  return sermons;
}

async function addItemsToList(
  mediaItems: MediaItem[],
  listId: string,
  newListCount: number,
  token: string,
  lastItemAtBottom?: true
): Promise<void> {
  let listRows: Array<newSubsplashListRow | existingSubsplashListRow> = mediaItems.map((mediaItem, index) => {
    logger.log('Adding Item', mediaItem.id);
    const subSplashListRow: newSubsplashListRow = {
      app_key: '9XTSHD',
      method: 'static',
      position: index + 1,
      type: mediaItem.type,
      _embedded: {
        [mediaItem.type]: {
          id: mediaItem.id,
        },
        'source-list': {
          id: listId,
        },
      },
    };
    return subSplashListRow;
  });
  if (lastItemAtBottom) {
    const lastItem = listRows.pop();
    if (!lastItem) {
      throw new HttpsError('internal', 'something went wrong when adding more sermons list');
    }
    lastItem.position = newListCount;
    const startingCount = listRows.length;
    const existingListItems: existingSubsplashListRow[] = (await getFullList(listId, token, newListCount)).map(
      (row) => ({
        id: row.id,
        position: startingCount + row.position,
      })
    );

    listRows = [...listRows, ...existingListItems, lastItem];
    listRows = listRows.map((row, index) => ({ ...row, position: index + 1 }));
    logger.log('Reordered List Rows:', listRows);
  }

  const payload = {
    id: listId,
    list_rows_count: newListCount,
    _embedded: {
      'list-rows': listRows,
    },
  };
  logger.log(`Adding items: ${JSON.stringify(mediaItems)} to subsplash list: ${listId}`);
  const patchListConfig = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/lists/${listId}`,
    token,
    'PATCH',
    payload
  );
  await axios(patchListConfig);
  const listArray = await firestore
    .collection('lists')
    .where('subsplashId', '==', listId)
    .limit(1)
    .withConverter(firestoreAdminListConverter)
    .get();
  if (!listArray.docs.length) {
    logger.log('Throwing error');
    throw new HttpsError('internal', 'List id was not found in firestore');
  }
  const sermons = await getFirestoreSermonFromMediaItem(mediaItems);
  logger.log(`Adding items: ${sermons} for firestore list: ${listArray.docs[0].data().name}`);
  // add sermon to list if it is not already there

  const bulkWriter = firestore.bulkWriter();
  const list = listArray.docs[0];
  sermons.forEach((sermon, index) => {
    logger.log(`Adding "${sermon.title}" to series - ${list.id}`);
    const listItem: ListItem<Sermon> = {
      id: sermon.id,
      position: index,
      name: sermon.title,
      images: sermon.images,
      updatedAtMillis: sermon.dateMillis, // TODO: add updatedAtMillis to sermon
      createdAtMillis: sermon.dateMillis,
      subsplashId: sermon.subsplashId,
      type: 'sermon',
      mediaItem: sermon,
    };

    const listItemRef = firestore
      .doc(`list/${list.id}/listItems/${sermon.id}`)
      .withConverter(firestoreAdminListItemConverter);
    // this single call will fail if the sermon already exists which is ok
    bulkWriter.create(listItemRef, listItem);
  });

  await bulkWriter.close();
}

async function removeListRows(listId: string, listRows: SubsplashListRow[], token: string): Promise<void> {
  if (!listRows.length) {
    return;
  }
  await Promise.all(
    listRows.map(async (item) => {
      const itemId = item['id'];
      logger.log(`Deleting item with id: ${itemId}`);
      const deleteConfig = createAxiosConfig(
        `https://core.subsplash.com/builder/v1/list-rows/${itemId}`,
        token,
        'DELETE'
      );
      await axios(deleteConfig);
    })
  );

  const seriesArray = await firestore
    .collection('lists')
    .where('subsplashId', '==', listId)
    .limit(1)
    .withConverter(firestoreAdminListConverter)
    .get();
  if (!seriesArray.docs.length) {
    logger.log('Throwing error');
    throw new HttpsError('internal', 'Series id was not found in firestore');
  }
  const sermons = await getFirestoreSermonFromMediaItem(convertSubsplashListRowToMediaItem(listRows));
  logger.log(`Removing items: ${sermons} for firestore series: ${seriesArray.docs[0].data().name}`);

  // delete sermons from firebase series
  const bulkWriter = firestore.bulkWriter();
  const series = seriesArray.docs[0];
  sermons.forEach((sermon) => {
    logger.log(`Adding "${sermon.title}" to series - ${series.id}`);
    const sermonRef = firestore.doc(`lists/${series.id}/listItems/${sermon.id}`);
    bulkWriter.delete(sermonRef);
  });
  await bulkWriter.close();
}

async function getLastNOldestItems(
  n: number,
  listId: string,
  token: string,
  sort: sortType
): Promise<SubsplashListRow[]> {
  const sortOrder = sort === 'position' ? '-' : '';
  const url = `https://core.subsplash.com/builder/v1/list-rows?filter%5Bapp_key%5D=9XTSHD&filter%5Bsource_list%5D=${listId}&sort=${`${sortOrder}${sort}`}&page%5Bnumber%5D=1&page%5Bsize%5D=${n}`;
  const config = createAxiosConfig(url, token, 'GET');
  const response = await axios(config);
  const listRows: SubsplashListRow[] = response.data['_embedded']['list-rows'];
  return listRows;
}

const removeNOldestItems = async (
  numberToRemove: number,
  listId: string,
  token: string,
  sort: sortType
): Promise<void> => {
  const listRows = await getLastNOldestItems(numberToRemove, listId, token, sort);
  await removeListRows(listId, listRows, token);
};

async function createMoreList(listId: string, type: ListType): Promise<string> {
  //Creating a new list
  logger.log(`createMoreList{listId: ${listId}}`);
  const seriesArray = await firestore
    .collection('lists')
    .where('subsplashId', '==', listId)
    .limit(1)
    .withConverter(firestoreAdminListConverter)
    .get();

  if (!seriesArray.docs.length) {
    logger.log('Throwing error');
    throw new HttpsError('internal', 'Series id was not found in firestore');
  }
  const series = seriesArray.docs[0].data();
  const title = series.isMoreSermonsList ? series.name : `More ${series.name} Sermons`;
  const { listId: moreListId } = await createNewSubsplashList({
    title: title,
    images: series.images,
  });
  // create new series in firestore
  const moreSermonsList: List = {
    id: moreListId,
    name: title,
    images: series.images,
    count: series.count,
    type,
    updatedAtMillis: new Date().getTime(),
    createdAtMillis: new Date().getTime(),
    overflowBehavior: series.overflowBehavior,
    subsplashId: moreListId,
    isMoreSermonsList: true,
  };
  await firestore.collection('lists').withConverter(firestoreAdminListConverter).add(moreSermonsList);
  await seriesArray.docs[0].ref.update({ moreSermonsRef: moreListId });
  return moreListId;
}

async function getListCount(listId: string, token: string): Promise<number> {
  const currentListConfig = createAxiosConfig(`https://core.subsplash.com/builder/v1/lists/${listId}`, token, 'GET');
  const response = (await axios(currentListConfig)).data;
  const currentListCount: number = response.list_rows_count;
  return currentListCount;
}

async function getFullList(listId: string, token: string, maxListCount: number): Promise<SubsplashListRow[]> {
  const listConfig = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/list-rows?filter[app_key]=9XTSHD&filter[source_list]=${listId}&page[size]=${maxListCount}&sort=position`,
    token,
    'GET'
  );
  const response = (await axios(listConfig)).data;
  return response['_embedded']['list-rows'];
}

async function getMoreListId(listId: string, token: string): Promise<string | undefined> {
  logger.log(`getMoreListId(listId: ${listId})`);
  const seriesArray = await firestore
    .collection('lists')
    .where('subsplashId', '==', listId)
    .limit(1)
    .withConverter(firestoreAdminListConverter)
    .get();

  if (!seriesArray.docs.length) {
    logger.log('Throwing error');
    throw new HttpsError('internal', 'Series id was not found in firestore');
  }
  const moreSermonsRef = seriesArray.docs[0].data().moreSermonsRef;
  logger.log(`moreSermonsRef: ${moreSermonsRef}`);
  // check if moreSermonsRef exists in subsplash
  if (moreSermonsRef) {
    const listConfig = createAxiosConfig(`https://core.subsplash.com/builder/v1/lists/${moreSermonsRef}`, token, 'GET');
    try {
      await axios(listConfig);
    } catch (err) {
      logger.log('Error getting moreSermonsRef from subsplash');
      logger.log(err);
      await seriesArray.docs[0].ref.update({ moreSermonsRef: FieldValue.delete() });
      return undefined;
    }
  }

  return moreSermonsRef;
}

async function handleOverflow(
  listId: string,
  itemsToAdd: MediaItem[],
  maxListCount: number,
  token: string,
  type: ListType
) {
  // if items to add + current list items <= maxListCount add items to list
  logger.log(
    `handleOverflow(listId: ${listId}, itemsToAdd: ${JSON.stringify(itemsToAdd)}, maxListCount: ${maxListCount})`
  );
  const currentListCount = await getListCount(listId, token);
  const newListCount = currentListCount + itemsToAdd.length;
  if (newListCount <= maxListCount) {
    logger.log('In basecase of handleOverflow');
    await addItemsToList(itemsToAdd, listId, newListCount, token);
    return;
  }
  // we have overflow
  // get nextMoreListId
  let moreListId = await getMoreListId(listId, token);

  // move last n items (not including moreList) to moreList
  const nOldest = Math.min(itemsToAdd.length + 1, currentListCount);

  let itemsToRemove: SubsplashListRow[] = await getLastNOldestItems(nOldest, listId, token, 'position');
  let newMoreListCreated = false;
  if (moreListId) {
    // do not remove moreList if it exists
    itemsToRemove = itemsToRemove.filter((item) => item.id !== moreListId);
  } else {
    // create more list and add it to items to add
    moreListId = await createMoreList(listId, type);
    newMoreListCreated = true;
  }
  logger.log('Items to remove', itemsToRemove);

  // fill current list as much as possible
  const remainingSpace = maxListCount - currentListCount - (newMoreListCreated ? 1 : 0);
  if (remainingSpace > 0) {
    const items = itemsToAdd.splice(maxListCount - remainingSpace - (newMoreListCreated ? 1 : 0), remainingSpace);
    logger.log(`Filling remaing space for ${listId} with ${items.length} items: ${JSON.stringify(items)}`);
    await addItemsToList(items, listId, maxListCount, token);
  }

  let overflowItems = convertSubsplashListRowToMediaItem(itemsToRemove);
  if (itemsToAdd.length > itemsToRemove.length) {
    const countToOverflow = itemsToAdd.length - itemsToRemove.length;
    overflowItems = [...itemsToAdd.splice(-countToOverflow), ...overflowItems];
  }

  // recursively call handleOverflow to add items to moreList before removing them from the current list
  await handleOverflow(moreListId, overflowItems, maxListCount, token, type);
  // remove items from current list
  await removeListRows(listId, itemsToRemove, token);
  // add items to list after room is available
  if (newMoreListCreated) {
    itemsToAdd.push({ id: moreListId, type: 'list' });
    await addItemsToList(itemsToAdd, listId, maxListCount, token, true);
  } else {
    await addItemsToList(itemsToAdd, listId, maxListCount, token);
  }
}

const addToSingleList = async (
  listId: string,
  mediaItemIds: MediaItem[],
  overflowBehavior: OverflowBehavior,
  maxListCount: number,
  token: string,
  type: ListType
) => {
  const currentListCount = await getListCount(listId, token);
  let newListCount = currentListCount + mediaItemIds.length;

  if (newListCount <= maxListCount) {
    await addItemsToList(mediaItemIds, listId, newListCount, token);
    return;
  }

  // handle list overflow
  if (overflowBehavior === 'CREATENEWLIST') {
    await handleOverflow(listId, mediaItemIds, maxListCount, token, type);
  } else if (overflowBehavior === 'REMOVEOLDEST') {
    const numberToRemove = newListCount - maxListCount;
    logger.log('Removing', numberToRemove, 'items from list', listId);
    await removeNOldestItems(numberToRemove, listId, token, 'created_at');
    newListCount -= numberToRemove;
    // Add sermons to list
    await addItemsToList(mediaItemIds, listId, newListCount, token);
  } else {
    throw new HttpsError('failed-precondition', 'List is full');
  }
};

const addToList = onCall(async (request: CallableRequest<AddtoListInputType>): Promise<void> => {
  logger.log('addToList', request);
  if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  const data = request.data;
  const maxListCount = 200;
  const tooManyItemsError = new HttpsError(
    'invalid-argument',
    `Too many items to add. The list size has a max of ${maxListCount}`
  );
  const token = await authenticateSubsplash();
  try {
    await Promise.all(
      data.listMetadata.map(async (list) => {
        if (list.overflowBehavior !== 'CREATENEWLIST' && data.mediaItemIds.length > maxListCount) {
          throw tooManyItemsError;
        }
        logger.log('list', list.listId);
        await addToSingleList(list.listId, data.mediaItemIds, list.overflowBehavior, maxListCount, token, list.type);
      })
    );
  } catch (err) {
    throw handleError(err);
  }
});

export default addToList;
