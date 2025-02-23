import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { ListType, OverflowBehavior } from '../../../types/List';
import { createAxiosConfig } from '../subsplashUtils';

export const mediaTypes = ['media-item', 'media-series', 'song', 'link', 'rss', 'list'] as const;
export type MediaType = (typeof mediaTypes)[number];
export type MediaItem = { id: string; type: MediaType };

export type listMetaDataType = { overflowBehavior: OverflowBehavior; listId: string; type: ListType };

export interface SubsplashListRow {
  id: string;
  position: number;
  created_at: string;
  updated_at: string;
  _embedded: {
    [key in MediaType]: {
      id: string;
      title: string;
    };
  };
}

export interface ListData {
  _links: {
    self: {
      href: string;
    };
    'list-rows': {
      href: string;
    };
  };
  id: string;
  app_key: string;
  type: string;
  title: string;
  status: string;
  max_item_count: number;
  generated: boolean;
  include_seriesless_media_items: boolean;
  short_code: string;
  list_rows_count: number;
  updated_at: string;
}

export type existingSubsplashListRow = Omit<SubsplashListRow, '_embedded'>;
export interface newSubsplashListRow extends Omit<SubsplashListRow, 'id' | '_embedded'> {
  app_key: '9XTSHD';
  method: 'static';
  type: MediaType;
  _embedded: { [key in MediaType & 'source-list']: { id: string } };
}
export type sortType = 'position' | 'created_at';

async function getFullList(listId: string, token: string, maxListCount: number): Promise<SubsplashListRow[]> {
  const listConfig = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/list-rows?filter[app_key]=9XTSHD&filter[source_list]=${listId}&page[size]=${maxListCount}&sort=position`,
    token,
    'GET'
  );
  const response = (await axios(listConfig)).data;
  return response['_embedded']['list-rows'];
}

export async function isAlreadyInList(
  mediaItem: MediaItem,
  listId: string,
  token: string,
  maxListCount: number
): Promise<{ isInList: true; listItemId: string } | { isInList: false }> {
  // check if item is already in the list
  const fullList = await getFullList(listId, token, maxListCount);
  const listRow = fullList.find((listRow) => {
    const listRowId = convertSubsplashListRowToMediaItem(listRow).id;
    logger.log(`listRowId: ${listRowId}, mediaItem.id: ${mediaItem.id}`);
    return listRowId === mediaItem.id;
  });
  return listRow ? { isInList: true, listItemId: listRow.id } : { isInList: false };
}

export async function addItemToList(mediaItem: MediaItem, listId: string, newListCount: number, token: string) {
  logger.log(`Adding item: ${JSON.stringify(mediaItem)} to subsplash list: ${listId}`);
  const position = 1;
  const listRow = {
    app_key: '9XTSHD',
    method: 'static',
    position,
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

  const payload = {
    id: listId,
    list_rows_count: newListCount,
    _embedded: {
      'list-rows': [listRow],
    },
  };
  const patchListConfig = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/lists/${listId}`,
    token,
    'PATCH',
    payload
  );
  const response = await axios(patchListConfig);
  const data = response.data;
  const listItemId = data._embedded['list-rows'][0].id;
  if (!listItemId) {
    throw new HttpsError('internal', 'The subsplash list you are adding to is corrupted: unable to find listItemId');
  }
  return listItemId;
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

export async function removeListRows(listId: string, listRows: SubsplashListRow[], token: string): Promise<void> {
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
  // TODO: remove from firebase list
}

export const removeNOldestItems = async (
  numberToRemove: number,
  listId: string,
  token: string,
  sort: sortType
): Promise<void> => {
  const listRows = await getLastNOldestItems(numberToRemove, listId, token, sort);
  await removeListRows(listId, listRows, token);
};

export function convertSubsplashListRowToMediaItem(listRow: SubsplashListRow): MediaItem {
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
}
export async function getListCount(listId: string, token: string): Promise<number> {
  logger.log(`Getting list count for list: ${listId}`);
  const currentListConfig = createAxiosConfig(`https://core.subsplash.com/builder/v1/lists/${listId}`, token, 'GET');
  const response = (await axios(currentListConfig)).data;
  const currentListCount: number = response.list_rows_count;
  logger.log(`Current list count for list: ${listId} is: ${currentListCount}`);
  return currentListCount;
}

export async function handleOverflow(
  listId: string,
  mediaItem: MediaItem,
  maxListCount: number,
  token: string,
  type: ListType
) {
  logger.log(
    `handleOverflow(listId: ${listId}, itemsToAdd: ${JSON.stringify(mediaItem)}, maxListCount: ${maxListCount})`
  );
  const currentListCount = await getListCount(listId, token);
  const newListCount = currentListCount + 1;

  // Base case: list is not full
  if (newListCount <= maxListCount) {
    await addItemToList(mediaItem, listId, newListCount, token);
    return;
  }

  // Recursive case: list is full
  //TODO: 'handle overflow';
}
