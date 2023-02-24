// add sermon to series and handle condition when list is full
import axios from 'axios';
import { firestore } from 'firebase-admin';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { createNewSubsplashList } from './createNewSubsplashList';
import { firestoreAdminSeriesConverter } from './firestoreDataConverter';
import handleError from './handleError';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';

const mediaTypes = ['media-item', 'media-series', 'song', 'link', 'rss', 'list'] as const;
type MediaType = (typeof mediaTypes)[number];
type MediaItem = { id: string; type: MediaType };
export interface AddToSeriesInputType {
  listId: string;
  mediaItemIds: MediaItem[];
  overflowBehavior: 'ERROR' | 'CREATENEWLIST' | 'REMOVEOLDEST';
}
interface SubsplashListRow {
  id: string;
  _embedded: {
    [key in MediaType]?: { id: string; title: string };
  };
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

async function addItemsToList(
  mediaItems: MediaItem[],
  listId: string,
  newListCount: number,
  token: string
): Promise<void> {
  const listRows = mediaItems.map((mediaItem, index) => {
    logger.log('Adding Item', mediaItem.id);
    return {
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
  });

  const payload = {
    id: listId,
    list_rows_count: newListCount,
    _embedded: {
      'list-rows': listRows,
    },
  };
  logger.log('Payload', payload);
  const patchListConfig = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/lists/${listId}`,
    token,
    'PATCH',
    payload
  );
  await axios(patchListConfig);
}

async function removeListRows(listRows: SubsplashListRow[], token: string): Promise<void> {
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
}

const removeNOldestItems = async (numberToRemove: number, listId: string, token: string): Promise<void> => {
  // get oldest item
  const url = `https://core.subsplash.com/builder/v1/list-rows?filter%5Bapp_key%5D=9XTSHD&filter%5Bsource_list%5D=${listId}&sort=created_at&page%5Bnumber%5D=1&page%5Bsize%5D=${numberToRemove}`;
  const config = createAxiosConfig(url, token, 'GET');
  const response = await axios(config);
  const listRows: Array<SubsplashListRow> = response.data['_embedded']['list-rows'];
  await removeListRows(listRows, token);
};

async function getListRows(listId: string, token: string): Promise<SubsplashListRow[]> {
  const getListRowsConfig = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/list-rows?filter%5Bsource_list%5D=${listId}`,
    token,
    'GET'
  );
  const listRowsResponse = (await axios(getListRowsConfig)).data;
  return listRowsResponse['_embedded']['list-rows'];
}

const addToSeries = onCall(async (request: CallableRequest<AddToSeriesInputType>): Promise<void> => {
  logger.log('addToSeries', request);
  if (request.auth?.token.role !== 'admin') {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  const data = request.data;
  logger.log('series', data.listId);

  //get current list info
  try {
    const token = await authenticateSubsplash();
    const currentListConfig = createAxiosConfig(
      `https://core.subsplash.com/builder/v1/lists/${data.listId}`,
      token,
      'GET'
    );
    const response = (await axios(currentListConfig)).data;
    const currentListCount = response.list_rows_count;
    logger.log('currentListCount', currentListCount);
    const maxListCount = 5;
    if (data.mediaItemIds.length > maxListCount) {
      throw new HttpsError('invalid-argument', `Too many items to add. The list size has a max of ${maxListCount}`);
    }
    logger.log('Number of series to be added', data.mediaItemIds.length);
    let newListCount = currentListCount + data.mediaItemIds.length;

    // handle list overflow
    if (newListCount > maxListCount) {
      if (data.overflowBehavior === 'CREATENEWLIST') {
        //TODO: check if there is already a more list and use that before creating a new one

        //Creating a new list
        const seriesArray = await firestore()
          .collection('series')
          .where('subsplashId', '==', data.listId)
          .limit(1)
          .withConverter(firestoreAdminSeriesConverter)
          .get();

        if (!seriesArray.docs.length) {
          logger.log('Throwing error');
          throw new HttpsError('internal', 'Series id was not found in firestore');
        }
        const series = seriesArray.docs[0].data();
        logger.log('Firebase Series', series);
        const { listId: moreListId } = await createNewSubsplashList({
          title: `More ${series.name} Sermons`,
          images: series.images,
        });

        // TODO: We want to only move any overflowed items to the next list
        // TODO: this should be done recursivly until there is no overflowing list

        // copy the contents of the current list to the new list
        const currentListRows = await getListRows(data.listId, token);
        const currentMediaItems = convertSubsplashListRowToMediaItem(currentListRows);
        await addItemsToList(currentMediaItems, moreListId, currentMediaItems.length, token);

        // clear out contents of current list
        await removeListRows(currentListRows, token);

        // add more list to the data to add
        data.mediaItemIds.push({ id: moreListId, type: 'list' });
      } else if (data.overflowBehavior === 'REMOVEOLDEST') {
        const numberToRemove = newListCount - maxListCount;
        logger.log('Removing', numberToRemove, 'items from list', data.listId);
        await removeNOldestItems(numberToRemove, data.listId, token);
        newListCount -= numberToRemove;
      } else {
        throw new HttpsError('failed-precondition', 'List is full');
      }
    }
    // Add sermons to list

    await addItemsToList(data.mediaItemIds, data.listId, newListCount, token);

    // Handle adding another list
  } catch (error) {
    throw handleError(error);
  }
});

export default addToSeries;
