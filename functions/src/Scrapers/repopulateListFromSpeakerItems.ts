// add sermon to series and handle condition when list is full
import axios from 'axios';
import { firestore } from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { List, ListType, OverflowBehavior } from '../../../types/List';
import { Sermon } from '../../../types/SermonTypes';
import { createNewSubsplashList } from '../createNewSubsplashList';
import {
  firestoreAdminListConverter,
  firestoreAdminListItemConverter,
  firestoreAdminSermonConverter,
} from '../firestoreDataConverter';
import handleError from '../handleError';
import { authenticateSubsplash, createAxiosConfig } from '../subsplashUtils';

const mediaTypes = ['media-item', 'media-series', 'song', 'link', 'rss', 'list'] as const;
type MediaType = (typeof mediaTypes)[number];
type MediaItem = { id: string; type: MediaType };
type MediaItemWithUpdatedAt = MediaItem & { updatedAt: Date };

type sortType = 'position' | 'created_at';

type listMetaDataType = { overflowBehavior: OverflowBehavior; listId: string; type: ListType };

export interface repopulateListFromSpeakerItemsInputType {
  listId: string;
  speakerId: string;
}
interface SubsplashListRow {
  id: string;
  position: number;
  _embedded: {
    [key in MediaType]: {
      id: string;
      updated_at: string;
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

function convertSubsplashListRowToMediaItemWithUpdateAt(listRows: SubsplashListRow[]): MediaItemWithUpdatedAt[] {
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
    const mediaItem: MediaItemWithUpdatedAt = {
      id: mediaItemFull.id,
      updatedAt: new Date(mediaItemFull.updated_at),
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
  const listRows: Array<newSubsplashListRow | existingSubsplashListRow> = mediaItems.map((mediaItem, index) => {
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
}

async function getListCount(listId: string, token: string): Promise<number> {
  const currentListConfig = createAxiosConfig(`https://core.subsplash.com/builder/v1/lists/${listId}`, token, 'GET');
  const response = (await axios(currentListConfig)).data;
  const currentListCount: number = response.list_rows_count;
  return currentListCount;
}

const addToSingleList = async (listId: string, mediaItemIds: MediaItem[], maxListCount: number, token: string) => {
  const currentListCount = await getListCount(listId, token);
  const newListCount = currentListCount + mediaItemIds.length;

  if (newListCount <= maxListCount) {
    await addItemsToList(mediaItemIds, listId, newListCount, token);
    return;
  }

  throw new HttpsError('failed-precondition', 'List is full');
};

// gets up to 200 items from subsplash
async function getSpeakerItems(speakerId: string, token: string): Promise<MediaItem[]> {
  const mediaItemsWithUpdatedAt: MediaItemWithUpdatedAt[] = [];
  let count = 0;
  let page = 1;
  let loop = true;
  while (loop) {
    const listConfig = createAxiosConfig(
      `https://core.subsplash.com/tags/v1/taggings?filter%5Bapp_key%5D=9XTSHD&filter%5Btag.id%5D=${speakerId}&include=media-item&page%5Bnumber%5D=${page++}&page%5Bsize%5D=100`,
      token,
      'GET',
      undefined,
      { 'collection-total': 'include' }
    );
    const response = (await axios(listConfig)).data;
    count += response.count;
    logger.log('count', count, 'total', response.total);
    if (count >= response.total) {
      loop = false;
    }
    const taggings = response._embedded.taggings;
    mediaItemsWithUpdatedAt.push(...convertSubsplashListRowToMediaItemWithUpdateAt(taggings));
  }

  return mediaItemsWithUpdatedAt
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .map((item) => {
      return { id: item.id, type: item.type };
    });
}

const repopulateListFromSpeakerItems = onCall(
  async (request: CallableRequest<repopulateListFromSpeakerItemsInputType>): Promise<void> => {
    // logger.log('repopulateListFromSpeakerItems', request);
    if (request.auth?.token.role !== 'admin') {
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
      const mediaItemIds: MediaItem[] = await getSpeakerItems(data.speakerId, token);
      await addToSingleList(data.listId, mediaItemIds, maxListCount, token);
    } catch (err) {
      throw handleError(err);
    }
  }
);

export default repopulateListFromSpeakerItems;
