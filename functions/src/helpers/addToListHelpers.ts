import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { createAxiosConfig } from '../subsplashUtils';
import { SubsplashList, SubsplashListRow, SubsplashMediaType, SubsplashPatchPayload, SubsplashListRowPatch } from '../types/Subsplash';

export const mediaTypes: SubsplashMediaType[] = [
  'media-item',
  'media-series',
  'song',
  'link',
  'rss',
  'list',
  'album',
  'calendar',
  'event',
];

export async function getFullListRows(listId: string, token: string): Promise<SubsplashListRow[]> {
  // Max page size is 200, which is also the list limit, so one call is enough usually.
  // Include unlisted items to get the true total count (unlisted items count toward the 200 limit)
  const listConfig = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/list-rows?filter[app_key]=9XTSHD&filter[source_list]=${listId}&filter[unlisted]=include&page[size]=200&sort=position`,
    token,
    'GET'
  );
  const response = (await axios(listConfig)).data;
  return response['_embedded']['list-rows'];
}

export async function getFullListRowsWithTotal(listId: string, token: string): Promise<{ rows: SubsplashListRow[]; total: number }> {
  // Max page size is 200, which is also the list limit, so one call is enough usually.
  // Include unlisted items to get the true total count (unlisted items count toward the 200 limit)
  const listConfig = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/list-rows?filter[app_key]=9XTSHD&filter[source_list]=${listId}&filter[unlisted]=include&page[size]=200&sort=position`,
    token,
    'GET'
  );
  const response = (await axios(listConfig)).data;
  const rows = response['_embedded']['list-rows'] || [];
  const total = response.total ?? rows.length;
  return {
    rows,
    total
  };
}

export async function getListDetails(listId: string, token: string): Promise<SubsplashList> {
  const config = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/lists/${listId}`,
    token,
    'GET'
  );
  return (await axios(config)).data;
}

export async function createNewList(title: string, token: string, subtitle?: string): Promise<SubsplashList> {
  const payload: Record<string, unknown> = {
    app_key: "9XTSHD",
    title: title,
    type: "standard",
    status: "published"
  };
  
  if (subtitle) {
    payload.subtitle = subtitle;
  }
  
  const config = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/lists`,
    token,
    'POST',
    JSON.stringify(payload)
  );
  
  const response = await axios(config);
  return response.data;
}

export function createListRow(
  item: { id: string, type: SubsplashMediaType }, 
  listId: string, 
  position: number
): SubsplashListRow {
  return {
    app_key: '9XTSHD',
    method: 'static',
    position,
    type: item.type,
    _embedded: {
      [item.type]: { id: item.id },
      'source-list': { id: listId },
    }
  };
}

export async function patchListRows(
  listId: string, 
  rows: SubsplashListRow[], 
  token: string
): Promise<SubsplashListRow[]> {
  logger.log(`Patching list ${listId} with ${rows.length} rows`);
  
  // Get current list details to preserve display-options and images
  const currentList = await getListDetails(listId, token);
  
  // Build list-rows array: existing rows use {id, position}, new rows use full object
  // Ensure positions are correct 1..N
  const reindexedRows: SubsplashListRowPatch[] = rows.map((row, index) => {
    const position = index + 1;
    
    // If row has an ID, it's an existing row - send only {id, position} (matching HAR file)
    if (row.id) {
      return {
        id: row.id,
        position
      };
    }
    
    // If row doesn't have an ID, it's a new row - send full object
    return {
      ...row,
      position
    };
  });

  // Build payload matching HAR file structure
  const payload: SubsplashPatchPayload = {
    id: listId,
    _embedded: {
      // Preserve existing display-options if they exist
      ...(
        currentList._embedded['display-options']
          ? {
              'display-options': currentList._embedded['display-options'].map((opt: { id: string }) => ({
                id: opt.id,
              })),
            }
          : {}
      ),
      // Preserve existing images if they exist
      ...(
        currentList._embedded.images
          ? {
              images: currentList._embedded.images.map((img: { id: string; type: string }) => ({
                id: img.id,
                type: img.type,
              })),
            }
          : {}
      ),
      'list-rows': reindexedRows,
    },
  };

  const config = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/lists/${listId}`,
    token,
    'PATCH',
    payload
  );

  try {
    const response = await axios(config);
    const patchedRows = response?.data?._embedded?.['list-rows'];
    if (Array.isArray(patchedRows)) {
      return patchedRows as SubsplashListRow[];
    }

    return rows.map((row, index) => ({
      ...row,
      position: index + 1,
    }));
  } catch (error: unknown) {
    const errorMessage = error && typeof error === 'object' && 'response' in error 
      ? (error as { response?: { data?: unknown } }).response?.data 
      : error;
    logger.error(`Failed to patch list ${listId}`, errorMessage);
    throw new HttpsError('internal', `Failed to patch list ${listId}`);
  }
}
