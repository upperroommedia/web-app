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

type SubsplashRequestContext = {
  operation: string;
  url: string;
  method: string;
  listId?: string;
  rowId?: string;
};

const getAxiosStatus = (error: unknown): number | undefined =>
  error && typeof error === 'object' && 'response' in error
    ? (error as { response?: { status?: number } }).response?.status
    : undefined;

const getAxiosData = (error: unknown): unknown =>
  error && typeof error === 'object' && 'response' in error
    ? (error as { response?: { data?: unknown } }).response?.data
    : undefined;

const isTransientSubsplashError = (status?: number): boolean =>
  status === 429 || status === 502 || status === 503 || status === 504;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const getConfigUrl = (config: ReturnType<typeof createAxiosConfig>): string => config.url ?? 'unknown-url';

async function runSubsplashRequest<T>(
  config: ReturnType<typeof createAxiosConfig>,
  context: SubsplashRequestContext
): Promise<T> {
  const maxAttempts = 3;
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const response = await axios(config);
      return response.data as T;
    } catch (error) {
      lastError = error;
      const upstreamStatus = getAxiosStatus(error);
      const upstream = getAxiosData(error);
      const isRetryable = isTransientSubsplashError(upstreamStatus);

      logger.warn('Subsplash request failed', {
        ...context,
        attempt,
        maxAttempts,
        upstreamStatus,
        upstream,
        isRetryable,
      });

      if (!isRetryable || attempt >= maxAttempts) {
        throw new HttpsError('internal', `Subsplash ${context.operation} failed for list ${context.listId ?? 'unknown'}`, {
          code: 'SUBSPLASH_REQUEST_FAILED',
          operation: context.operation,
          method: context.method,
          url: context.url,
          ...(context.listId ? { listId: context.listId } : {}),
          ...(context.rowId ? { rowId: context.rowId } : {}),
          ...(typeof upstreamStatus === 'number' ? { upstream_status: upstreamStatus } : {}),
          ...(upstream !== undefined ? { upstream } : {}),
        });
      }

      await sleep(250 * attempt);
    }
  }

  throw lastError;
}

export async function getFullListRows(listId: string, token: string): Promise<SubsplashListRow[]> {
  // Max page size is 200, which is also the list limit, so one call is enough usually.
  // Include unlisted items to get the true total count (unlisted items count toward the 200 limit)
  const listConfig = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/list-rows?filter[app_key]=9XTSHD&filter[source_list]=${listId}&filter[unlisted]=include&page[size]=200&sort=position`,
    token,
    'GET'
  );
  const response = await runSubsplashRequest<{ _embedded: { 'list-rows': SubsplashListRow[] } }>(listConfig, {
    operation: 'getListRows',
    method: 'GET',
    url: getConfigUrl(listConfig),
    listId,
  });
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
  const response = await runSubsplashRequest<{ _embedded?: { 'list-rows'?: SubsplashListRow[] }; total?: number }>(listConfig, {
    operation: 'getListRowsWithTotal',
    method: 'GET',
    url: getConfigUrl(listConfig),
    listId,
  });
  const rows = response._embedded?.['list-rows'] || [];
  const total = response.total ?? rows.length;
  return {
    rows,
    total
  };
}

export type ReconciledSubsplashListState = {
  listDetails: SubsplashList;
  rows: SubsplashListRow[];
  materializedRowCount: number;
  listRowsCount: number;
  enforcedRowCount: number;
  phantomRowCount: number;
  maxItemCount: number;
};

export async function getReconciledListState(listId: string, token: string): Promise<ReconciledSubsplashListState> {
  const [listDetails, { rows }] = await Promise.all([
    getListDetails(listId, token),
    getFullListRowsWithTotal(listId, token),
  ]);

  const materializedRowCount = rows.length;
  const listRowsCount = Math.max(0, listDetails.list_rows_count ?? 0);
  const enforcedRowCount = Math.max(listRowsCount, materializedRowCount);
  const maxItemCount = listDetails.max_item_count ?? enforcedRowCount;
  const phantomRowCount = Math.max(0, enforcedRowCount - materializedRowCount);

  if (phantomRowCount > 0) {
    logger.warn('Subsplash list count mismatch detected', {
      listId,
      listRowsCount,
      materializedRowCount,
      enforcedRowCount,
      phantomRowCount,
      maxItemCount,
    });
  }

  return {
    listDetails,
    rows,
    materializedRowCount,
    listRowsCount,
    enforcedRowCount,
    phantomRowCount,
    maxItemCount,
  };
}

export async function getListDetails(listId: string, token: string): Promise<SubsplashList> {
  const config = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/lists/${listId}`,
    token,
    'GET'
  );
  return await runSubsplashRequest<SubsplashList>(config, {
    operation: 'getListDetails',
    method: 'GET',
    url: getConfigUrl(config),
    listId,
  });
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

  return await runSubsplashRequest<SubsplashList>(config, {
    operation: 'createList',
    method: 'POST',
    url: getConfigUrl(config),
  });
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
  token: string,
  options?: {
    forceFullRows?: boolean;
  }
): Promise<SubsplashListRow[]> {
  logger.log(`Patching list ${listId} with ${rows.length} rows`);
  
  // Get current list details to preserve display-options and images
  const currentList = await getListDetails(listId, token);
  
  // Build list-rows array: existing rows use {id, position}, new rows use full object
  // Ensure positions are correct 1..N
  const reindexedRows: SubsplashListRowPatch[] = rows.map((row, index) => {
    const position = index + 1;
    
    // If row has an ID, it's an existing row - send only {id, position} (matching HAR file)
    if (row.id && !options?.forceFullRows) {
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
    const response = await runSubsplashRequest<{ _embedded?: { 'list-rows'?: SubsplashListRow[] } }>(config, {
      operation: options?.forceFullRows ? 'patchListRowsRestore' : 'patchListRows',
      method: 'PATCH',
      url: getConfigUrl(config),
      listId,
    });
    const patchedRows = response?._embedded?.['list-rows'];
    if (Array.isArray(patchedRows)) {
      return patchedRows as SubsplashListRow[];
    }

    return rows.map((row, index) => ({
      ...row,
      position: index + 1,
    }));
  } catch (error: unknown) {
    logger.error(`Failed to patch list ${listId}`, getAxiosData(error) ?? error);
    throw error;
  }
}

export async function deleteListRow(rowId: string, listId: string, token: string): Promise<void> {
  const config = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/list-rows/${rowId}`,
    token,
    'DELETE'
  );

  await runSubsplashRequest<unknown>(config, {
    operation: 'deleteListRow',
    method: 'DELETE',
    url: getConfigUrl(config),
    listId,
    rowId,
  });
}
