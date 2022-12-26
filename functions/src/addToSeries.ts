// add sermon to series and handle condition when list is full
import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import handleError from './handleError';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';

export interface AddToSeriesInputType {
  listId: string;
  mediaItemIds: { id: string; type: MediaType }[];
  overflowBehavior: 'ERROR' | 'CREATENEWLIST' | 'REMOVEOLDEST';
}
const mediaTypes = ['media-item', 'media-series', 'song', 'link', 'rss'] as const;
type MediaType = typeof mediaTypes[number];
interface SubsplashListRow {
  id: string;
  _embedded: {
    [key in MediaType]?: { id: string; title: string };
  };
}

const removeNOldestItems = async (numberToRemove: number, listId: string, token: string): Promise<void> => {
  // get oldest item
  const url = `https://core.subsplash.com/builder/v1/list-rows?filter%5Bapp_key%5D=9XTSHD&filter%5Bsource_list%5D=${listId}&sort=created_at&page%5Bnumber%5D=1&page%5Bsize%5D=${numberToRemove}`;
  const config = createAxiosConfig(url, token, 'GET');
  const response = await axios(config);
  const mediaItems: Array<SubsplashListRow> = response.data['_embedded']['list-rows'];
  await Promise.all(
    mediaItems.map(async (item) => {
      // find item key in _embedded
      let mediaKey = undefined;
      for (const key in item._embedded) {
        mediaKey = mediaTypes.find((type) => type === key);
        if (mediaKey) {
          break;
        }
      }
      if (mediaKey) {
        logger.log('Removing Item', item._embedded[mediaKey]?.title, 'with id', item._embedded[mediaKey]?.id);
      } else {
        logger.log('Removing Item with list-row-id', item.id);
      }
      const itemId = item['id'];
      const deleteConfig = createAxiosConfig(
        `https://core.subsplash.com/builder/v1/list-rows/${itemId}`,
        token,
        'DELETE'
      );
      await axios(deleteConfig);
    })
  );
};

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
    const maxListCount = 200;
    if (data.mediaItemIds.length > maxListCount) {
      throw new HttpsError('invalid-argument', `Too many items to add. The list size has a max of ${maxListCount}`);
    }
    logger.log('Number of series to be added', data.mediaItemIds.length);
    let newListCount = currentListCount + data.mediaItemIds.length;
    if (newListCount > maxListCount) {
      if (data.overflowBehavior === 'CREATENEWLIST') {
        //TODO[1]: Handle creating a new list
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
    const listRows = data.mediaItemIds.map((mediaItem, index) => {
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
            id: data.listId,
          },
        },
      };
    });

    const payload = {
      id: data.listId,
      list_rows_count: newListCount,
      _embedded: {
        'list-rows': listRows,
      },
    };
    logger.log('Payload', payload);
    const patchListConfig = createAxiosConfig(
      `https://core.subsplash.com/builder/v1/lists/${data.listId}`,
      token,
      'PATCH',
      payload
    );
    logger.log('Patch List Response', (await axios(patchListConfig)).status);
    // Handle adding another list
  } catch (error) {
    handleError(error);
  }
});

export default addToSeries;
