/**
 * Helper functions for Subsplash Media Series API operations
 */

import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { createAxiosConfig } from '../subsplashUtils';
import {
  SubsplashSeries,
  CreateSeriesPayload,
  PatchSeriesPayload,
  PatchMediaItemSeriesPayload,
  SubsplashSeriesMediaItem,
} from '../types/SubsplashSeries';

const APP_KEY = '9XTSHD';
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;
const RETRY_MAX_DELAY_MS = 5000;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const getAxiosStatusCode = (error: unknown): number | undefined => (
  error && typeof error === 'object' && 'response' in error
    ? (error as { response?: { status?: number } }).response?.status
    : undefined
);

const getRetryAfterDelayMs = (error: unknown): number | undefined => {
  if (!(error && typeof error === 'object' && 'response' in error)) {
    return undefined;
  }

  const headers = (error as { response?: { headers?: Record<string, unknown> } }).response?.headers;
  if (!headers) return undefined;

  const retryAfter = headers['retry-after'];
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
    return retryAfter * 1000;
  }
  if (typeof retryAfter === 'string') {
    const numeric = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(numeric)) {
      return numeric * 1000;
    }
  }

  return undefined;
};

const shouldRetryRequest = (status?: number): boolean => (
  status === 429 || status === 408 || status === 502 || status === 503 || status === 504
);

const withSubsplashRetry = async <T>(operationName: string, requestFn: () => Promise<T>): Promise<T> => {
  let attempt = 0;

  while (true) {
    try {
      return await requestFn();
    } catch (error) {
      const status = getAxiosStatusCode(error);
      if (!shouldRetryRequest(status) || attempt >= MAX_RETRY_ATTEMPTS) {
        throw error;
      }

      const retryAfterMs = getRetryAfterDelayMs(error);
      const computedBackoffMs = Math.min(RETRY_BASE_DELAY_MS * (2 ** attempt), RETRY_MAX_DELAY_MS);
      const delayMs = retryAfterMs ?? computedBackoffMs;

      logger.warn(`Subsplash ${operationName} received retryable status ${status}; retrying`, {
        operationName,
        status,
        attempt: attempt + 1,
        maxAttempts: MAX_RETRY_ATTEMPTS + 1,
        delayMs,
      });

      await sleep(delayMs);
      attempt += 1;
    }
  }
};

export interface DerivedSeriesMetadata {
  itemCount: number;
  publishedItemCount: number;
  subtitle: string;
}

export function getSeriesSubtitleFromPublishedCount(publishedItemCount: number): string {
  const safePublishedCount = Math.max(0, publishedItemCount);
  return `${safePublishedCount} part series`;
}

export function deriveSeriesMetadata(
  seriesItems: Array<{ publishedToSubsplash?: boolean | null }>
): DerivedSeriesMetadata {
  const itemCount = seriesItems.length;
  const publishedItemCount = seriesItems.reduce((count, item) => {
    return item.publishedToSubsplash === true ? count + 1 : count;
  }, 0);

  return {
    itemCount,
    publishedItemCount,
    subtitle: getSeriesSubtitleFromPublishedCount(publishedItemCount),
  };
}

/**
 * Create a new Subsplash media series
 */
export async function createSubsplashSeries(
  title: string,
  token: string,
  options?: { subtitle?: string; summary?: string }
): Promise<SubsplashSeries> {
  const payload: CreateSeriesPayload = {
    app_key: APP_KEY,
    title,
    ...(options?.subtitle && { subtitle: options.subtitle }),
    ...(options?.summary && { summary: options.summary }),
  };

  const config = createAxiosConfig(
    'https://core.subsplash.com/media/v1/media-series',
    token,
    'POST',
    payload
  );

  try {
    const response = await withSubsplashRetry('createSeries', () => axios(config));
    return response.data;
  } catch (error: unknown) {
    const errorMessage = error && typeof error === 'object' && 'response' in error
      ? (error as { response?: { data?: unknown } }).response?.data
      : error;
    logger.error('Failed to create series', errorMessage);
    throw new HttpsError('internal', `Failed to create series: ${JSON.stringify(errorMessage)}`);
  }
}

/**
 * Get details of a Subsplash media series
 */
export async function getSeriesDetails(seriesId: string, token: string): Promise<SubsplashSeries> {
  const config = createAxiosConfig(
    `https://core.subsplash.com/media/v1/media-series/${seriesId}`,
    token,
    'GET'
  );

  try {
    const response = await withSubsplashRetry('getSeriesDetails', () => axios(config));
    return response.data;
  } catch (error: unknown) {
    const errorMessage = error && typeof error === 'object' && 'response' in error
      ? (error as { response?: { data?: unknown } }).response?.data
      : error;
    logger.error(`Failed to get series ${seriesId}`, errorMessage);
    throw new HttpsError('not-found', `Series ${seriesId} not found`);
  }
}

/**
 * Get media items belonging to a series
 */
export async function getSeriesItems(
  seriesId: string,
  token: string,
  options?: { status?: 'published' | 'draft' | 'scheduled'; pageSize?: number }
): Promise<SubsplashSeriesMediaItem[]> {
  const status = options?.status || 'published';
  const pageSize = options?.pageSize || 200;
  
  const config = createAxiosConfig(
    `https://core.subsplash.com/media/v1/media-items?filter[app_key]=${APP_KEY}&filter[media_series]=${seriesId}&filter[status]=${status}&filter[unlisted]=include&page[size]=${pageSize}&sort=-position`,
    token,
    'GET'
  );

  try {
    const response = await withSubsplashRetry('getSeriesItems', () => axios(config));
    return response.data._embedded?.['media-items'] || [];
  } catch (error: unknown) {
    const errorMessage = error && typeof error === 'object' && 'response' in error
      ? (error as { response?: { data?: unknown } }).response?.data
      : error;
    logger.error(`Failed to get items for series ${seriesId}`, errorMessage);
    throw new HttpsError('internal', `Failed to get series items: ${JSON.stringify(errorMessage)}`);
  }
}

/**
 * Get all media items belonging to a series across supported statuses.
 * Deduplicates by media item ID.
 */
export async function getAllSeriesItemsAcrossStatuses(
  seriesId: string,
  token: string,
  options?: { pageSize?: number }
): Promise<SubsplashSeriesMediaItem[]> {
  const statuses: Array<'published' | 'draft' | 'scheduled'> = ['published', 'draft', 'scheduled'];
  const allResults = await Promise.all(
    statuses.map((status) => getSeriesItems(seriesId, token, { status, pageSize: options?.pageSize }))
  );

  const dedupedItems = new Map<string, SubsplashSeriesMediaItem>();
  allResults.flat().forEach((item) => {
    dedupedItems.set(item.id, item);
  });

  return Array.from(dedupedItems.values());
}

export function isMediaItemUnlinkedFromSeries(item: SubsplashSeriesMediaItem): boolean {
  return (item._embedded?.['media-series'] ?? null) === null;
}

/**
 * Assign or unassign a media item to/from a series
 * To assign: pass seriesId
 * To unassign: pass null
 */
export async function patchMediaItemSeries(
  mediaItemId: string,
  seriesId: string | null,
  token: string,
  options?: {
    position?: number;
    audio?: { id: string };
    images?: Array<{ id: string; type: string }>;
  }
): Promise<SubsplashSeriesMediaItem> {
  const embeddedPayload: PatchMediaItemSeriesPayload['_embedded'] = {
    'media-series': seriesId ? { id: seriesId } : null,
    ...(options?.audio && { audio: options.audio }),
    ...(options?.images && options.images.length > 0 && { images: options.images }),
  };

  const payload: PatchMediaItemSeriesPayload = {
    id: mediaItemId,
    ...(options?.position !== undefined && { position: options.position }),
    _embedded: embeddedPayload,
  };

  const config = createAxiosConfig(
    `https://core.subsplash.com/media/v1/media-items/${mediaItemId}`,
    token,
    'PATCH',
    payload
  );

  try {
    const response = await withSubsplashRetry('patchMediaItemSeries', () => axios(config));
    logger.log(`Successfully ${seriesId ? 'assigned' : 'unassigned'} media item ${mediaItemId} ${seriesId ? `to series ${seriesId}` : 'from series'}`);
    return response.data;
  } catch (error: unknown) {
    const axiosStatus = error && typeof error === 'object' && 'response' in error
      ? (error as { response?: { status?: number } }).response?.status
      : undefined;
    if (axiosStatus === 404) {
      throw new HttpsError('not-found', `Media item ${mediaItemId} was not found in Subsplash.`);
    }

    const errorMessage = error && typeof error === 'object' && 'response' in error
      ? (error as { response?: { data?: unknown } }).response?.data
      : error;
    logger.error(`Failed to patch media item ${mediaItemId}`, errorMessage);
    throw new HttpsError('internal', `Failed to update media item series: ${JSON.stringify(errorMessage)}`);
  }
}

export interface UnlinkMediaItemFromSeriesResult {
  status: 'success' | 'not-found';
  mediaItemId: string;
  item?: SubsplashSeriesMediaItem;
}

export async function unlinkMediaItemFromSeries(
  mediaItemId: string,
  token: string,
  options?: {
    audio?: { id: string };
    images?: Array<{ id: string; type: string }>;
  }
): Promise<UnlinkMediaItemFromSeriesResult> {
  try {
    const patchedItem = await patchMediaItemSeries(mediaItemId, null, token, {
      audio: options?.audio,
      images: options?.images,
    });

    if (!isMediaItemUnlinkedFromSeries(patchedItem)) {
      throw new HttpsError(
        'failed-precondition',
        `Subsplash did not confirm unlink for media item ${mediaItemId}.`
      );
    }

    return {
      status: 'success',
      mediaItemId,
      item: patchedItem,
    };
  } catch (error) {
    if (error instanceof HttpsError && error.code === 'not-found') {
      return {
        status: 'not-found',
        mediaItemId,
      };
    }
    throw error;
  }
}

/**
 * Update item positions within a series
 */
export async function patchSeriesItemPositions(
  seriesId: string,
  items: Array<{ id: string; position: number | null }>,
  token: string
): Promise<void> {
  const payload: PatchSeriesPayload = {
    id: seriesId,
    _embedded: {
      'media-items': items,
    },
  };

  const config = createAxiosConfig(
    `https://core.subsplash.com/media/v1/media-series/${seriesId}`,
    token,
    'PATCH',
    payload
  );

  try {
    await withSubsplashRetry('patchSeriesItemPositions', () => axios(config));
    logger.log(`Successfully updated positions for ${items.length} items in series ${seriesId}`);
  } catch (error: unknown) {
    const errorMessage = error && typeof error === 'object' && 'response' in error
      ? (error as { response?: { data?: unknown } }).response?.data
      : error;
    logger.error(`Failed to update series item positions for ${seriesId}`, errorMessage);
    throw new HttpsError('internal', `Failed to update series item positions: ${JSON.stringify(errorMessage)}`);
  }
}

/**
 * Delete a Subsplash media series
 */
export async function deleteSubsplashSeries(seriesId: string, token: string): Promise<void> {
  const config = createAxiosConfig(
    `https://core.subsplash.com/media/v1/media-series/${seriesId}`,
    token,
    'DELETE'
  );

  try {
    await withSubsplashRetry('deleteSubsplashSeries', () => axios(config));
    logger.log(`Successfully deleted series ${seriesId}`);
  } catch (error: unknown) {
    // Check if it's a 404 - series already deleted
    const axiosError = error as { response?: { status?: number } };
    if (axiosError.response?.status === 404) {
      logger.log(`Series ${seriesId} already deleted or not found`);
      return;
    }
    
    const errorMessage = error && typeof error === 'object' && 'response' in error
      ? (error as { response?: { data?: unknown } }).response?.data
      : error;
    logger.error(`Failed to delete series ${seriesId}`, errorMessage);
    throw new HttpsError('internal', `Failed to delete series: ${JSON.stringify(errorMessage)}`);
  }
}

/**
 * Update series metadata (title, subtitle, summary, images)
 */
export async function patchSeriesMetadata(
  seriesId: string,
  updates: {
    title?: string;
    subtitle?: string;
    summary?: string;
    publishedAt?: string | null;
    images?: Array<{ id: string; type: string }>;
  },
  token: string
): Promise<SubsplashSeries> {
  const embeddedPayload: PatchSeriesPayload['_embedded'] = {
    ...(updates.images ? { images: updates.images } : {}),
  };

  const payload: PatchSeriesPayload = {
    id: seriesId,
    ...(updates.title && { title: updates.title }),
    ...(updates.subtitle && { subtitle: updates.subtitle }),
    ...(updates.summary && { summary: updates.summary }),
    ...(updates.publishedAt !== undefined && { published_at: updates.publishedAt }),
    ...(Object.keys(embeddedPayload).length > 0 && { _embedded: embeddedPayload }),
  };

  const config = createAxiosConfig(
    `https://core.subsplash.com/media/v1/media-series/${seriesId}`,
    token,
    'PATCH',
    payload
  );

  try {
    const response = await withSubsplashRetry('patchSeriesMetadata', () => axios(config));
    logger.log(`Successfully updated metadata for series ${seriesId}`);
    return response.data;
  } catch (error: unknown) {
    const errorMessage = error && typeof error === 'object' && 'response' in error
      ? (error as { response?: { data?: unknown } }).response?.data
      : error;
    logger.error(`Failed to update series metadata for ${seriesId}`, errorMessage);
    throw new HttpsError('internal', `Failed to update series metadata: ${JSON.stringify(errorMessage)}`);
  }
}
