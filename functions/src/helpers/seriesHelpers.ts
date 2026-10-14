import {freezeSeriesMutationProjection} from '../temporal/publishing/seriesMutationProjection';
import { assertSynchronousProviderMutationCompleted } from '../temporal/publishing/providerMutationCompletion';
import {markPublishingCritical, getPublishingMutationOperation, runPublishingProviderMutation} from '../temporal/publishing/durableOperationContext';
import {providerPayloadFingerprint} from '../temporal/publishing/providerReceipts';
import {reserveSubsplashAssociation} from '../temporal/publishing/providerAssociations';
/**
 * Helper functions for Subsplash Media Series API operations
 */

import axios from '../providerSandbox/http';
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
import {
  getSubsplashMediaItemDiagnostics,
} from './subsplashMediaItems';
import { getHtmlEdgeBlock } from './upstreamHttpErrors';

// Provider responses can contain large artwork and descriptions. Retain only
// domain-consumed fields before writing an acknowledgement fact.
const pickProviderFields = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(keys.flatMap((key) => {
    const field = source[key];
    return typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean' || field === null
      ? [[key, field]] : [];
  }));
};

export const normalizeSeriesMutationAcknowledgement = (value: unknown): SubsplashSeries =>
  pickProviderFields(value, ['id', 'app_key', 'title', 'subtitle', 'slug', 'summary', 'published_at',
    'media_items_count', 'published_media_items_count', 'display_type', 'status', 'short_code',
    'is_default', 'position', 'created_at', 'updated_at']) as unknown as SubsplashSeries;

export const normalizeSeriesMediaMutationAcknowledgement = (value: unknown): SubsplashSeriesMediaItem => {
  const result = pickProviderFields(value, ['id', 'app_key', 'title', 'subtitle', 'position', 'status', 'created_at', 'updated_at']);
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const embedded = source._embedded && typeof source._embedded === 'object'
    ? source._embedded as Record<string, unknown> : undefined;
  if (embedded) {
    const references: Record<string, unknown> = {};
    if (embedded['media-series'] === null) references['media-series'] = null;
    else if (embedded['media-series']) references['media-series'] = pickProviderFields(embedded['media-series'], ['id']);
    if (embedded.audio) references.audio = pickProviderFields(embedded.audio, ['id']);
    if (Array.isArray(embedded.images)) references.images = embedded.images.map((image) => pickProviderFields(image, ['id', 'type']));
    result._embedded = references;
  }
  return result as unknown as SubsplashSeriesMediaItem;
};

const synchronousMutationData = <T>(response: { status?: unknown; data: T }): T => {
  assertSynchronousProviderMutationCompleted(response);
  return response.data;
};

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

const shouldRetryRequest = (error: unknown, status?: number): boolean => (
  Boolean(getHtmlEdgeBlock(error)) || status === 429 || status === 408 || status === 502 || status === 503 || status === 504
);

const withSubsplashRetry = async <T>(operationName: string, requestFn: () => Promise<T>): Promise<T> => {
  let attempt = 0;

  while (true) {
    try {
      return await requestFn();
    } catch (error) {
      const status = getAxiosStatusCode(error);
      if (!shouldRetryRequest(error, status) || attempt >= MAX_RETRY_ATTEMPTS) {
        throw error;
      }

      const retryAfterMs = getRetryAfterDelayMs(error);
      const computedBackoffMs = Math.min(RETRY_BASE_DELAY_MS * (2 ** attempt), RETRY_MAX_DELAY_MS);
      const delayMs = retryAfterMs ?? computedBackoffMs;

      logger.warn(`Subsplash ${operationName} received retryable status ${status}; retrying`, {
        operationName,
        status,
        edgeRequestId: getHtmlEdgeBlock(error)?.requestId,
        attempt: attempt + 1,
        maxAttempts: MAX_RETRY_ATTEMPTS + 1,
        delayMs,
      });

      await sleep(delayMs);
      attempt += 1;
    }
  }
};

const throwIfSubsplashEdgeBlocked = (error: unknown): void => {
  const edgeBlock = getHtmlEdgeBlock(error);
  if (!edgeBlock) return;

  logger.error('Subsplash series request was blocked by its edge network', {
    requestId: edgeBlock.requestId,
  });
  throw new HttpsError('unavailable', 'Subsplash is temporarily blocking requests from our server. Please retry shortly.');
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
    const response = await axios({ ...config, ...{ skipSubsplashEdgeRetry: true } });
    return response.data;
  } catch (error: unknown) {
    if(error instanceof HttpsError || error && typeof error==='object' && 'code' in error && typeof error.code==='string' && (error.code.startsWith('PUBLISHING_') || ['PERMISSION_CHANGED','CANCEL_REQUESTED'].includes(error.code)))throw error;
    throwIfSubsplashEdgeBlocked(error);
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
    if(error instanceof HttpsError || error && typeof error==='object' && 'code' in error && typeof error.code==='string' && (error.code.startsWith('PUBLISHING_') || ['PERMISSION_CHANGED','CANCEL_REQUESTED'].includes(error.code)))throw error;
    throwIfSubsplashEdgeBlocked(error);
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
  
  try {
    const items: SubsplashSeriesMediaItem[] = [];
    const seenItemIds = new Set<string>();
    let pageNumber = 1;

    while (true) {
      const config = createAxiosConfig(
        `https://core.subsplash.com/media/v1/media-items?filter[app_key]=${APP_KEY}&filter[media_series]=${seriesId}&filter[status]=${status}&filter[unlisted]=include&page[size]=${pageSize}&page[number]=${pageNumber}&sort=-position`,
        token,
        'GET'
      );
      const response = await withSubsplashRetry('getSeriesItems', () => axios(config));
      const pageItems = (response.data._embedded?.['media-items'] || []) as SubsplashSeriesMediaItem[];
      const newPageItems = pageItems.filter((item) => !seenItemIds.has(item.id));
      newPageItems.forEach((item) => seenItemIds.add(item.id));
      items.push(...newPageItems);
      if (pageItems.length < pageSize) {
        return items;
      }
      if (newPageItems.length === 0 || pageNumber >= 100) {
        throw new Error(`Subsplash pagination did not advance for series ${seriesId}.`);
      }
      pageNumber += 1;
    }
  } catch (error: unknown) {
    if(error instanceof HttpsError || error && typeof error==='object' && 'code' in error && typeof error.code==='string' && (error.code.startsWith('PUBLISHING_') || ['PERMISSION_CHANGED','CANCEL_REQUESTED'].includes(error.code)))throw error;
    throwIfSubsplashEdgeBlocked(error);
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
    subtitle?: string | null;
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
    app_key: APP_KEY,
    ...(options?.position !== undefined && { position: options.position }),
    ...(options?.subtitle !== undefined && { subtitle: options.subtitle }),
    _embedded: embeddedPayload,
  };

  const config = createAxiosConfig(
    `https://core.subsplash.com/media/v1/media-items/${mediaItemId}`,
    token,
    'PATCH',
    payload
  );

  await freezeSeriesMutationProjection({provider:'subsplash',account:'app:9XTSHD',resourceType:'media',resourceId:mediaItemId},`patchMediaItemSeries:${mediaItemId}:${providerPayloadFingerprint(payload)}`,'PATCH',payload);
  await markPublishingCritical('PUBLISHING_ASSOCIATION_CRITICAL',{provider:'subsplash',resourceType:'media',resourceId:mediaItemId,accountId:'app:9XTSHD',method:'PATCH',requestFingerprint:providerPayloadFingerprint(payload)});
  await reserveSubsplashAssociation(`seriesitem:${seriesId ?? 'none'}:${mediaItemId}`,[mediaItemId,seriesId,options?.audio?.id,...(options?.images??[]).map(image=>image.id)],payload,{target:{provider:'subsplash',kind:'media-item',remoteId:mediaItemId}});
  try {
    const response = await runPublishingProviderMutation({operation:getPublishingMutationOperation() ?? 'patchMediaItemSeries',target:{provider:'subsplash',account:'app:9XTSHD',resourceType:'media',resourceId:mediaItemId},step:`patchMediaItemSeries:${mediaItemId}:${providerPayloadFingerprint(payload)}`,method:'PATCH',payload:payload,send:async()=>({completion:'acknowledged',result:normalizeSeriesMediaMutationAcknowledgement(synchronousMutationData(await axios(Object.assign(config,{skipSubsplashEdgeRetry:true}))))})});
    logger.log(`Successfully ${seriesId ? 'assigned' : 'unassigned'} media item ${mediaItemId} ${seriesId ? `to series ${seriesId}` : 'from series'}`);
    if(response.id===mediaItemId)return response;
    // A bodyless synchronous ACK is already journaled. Read factual fields only
    // after that fact exists, so a failed GET cannot erase a positive response.
    const observed=normalizeSeriesMediaMutationAcknowledgement((await axios(createAxiosConfig(`https://core.subsplash.com/media/v1/media-items/${encodeURIComponent(mediaItemId)}?include=media-series,audio,images`,token,'GET'))).data);
    if(observed.id!==mediaItemId||observed.app_key!==APP_KEY)throw new Error('PUBLISHING_PROVIDER_REPAIR_REQUIRED');
    return observed;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('PROVIDER_MUTATION_')) throw error;
    if(error instanceof HttpsError || error && typeof error==='object' && 'code' in error && typeof error.code==='string' && (error.code.startsWith('PUBLISHING_') || ['PERMISSION_CHANGED','CANCEL_REQUESTED'].includes(error.code)))throw error;
    throwIfSubsplashEdgeBlocked(error);
    const axiosStatus = error && typeof error === 'object' && 'response' in error
      ? (error as { response?: { status?: number } }).response?.status
      : undefined;
    if (axiosStatus === 404) {
      throw new HttpsError('not-found', `Media item ${mediaItemId} was not found in Subsplash.`);
    }

    const errorMessage = error && typeof error === 'object' && 'response' in error
      ? (error as { response?: { data?: unknown } }).response?.data
      : error;
    const mediaItemDiagnostics = await getSubsplashMediaItemDiagnostics(mediaItemId, token);
    const targetSeriesDiagnostics = seriesId
      ? await getSeriesDetails(seriesId, token)
        .then((series) => ({
          found: true,
          summary: {
            id: series.id,
            title: series.title,
            status: series.status,
            publishedAt: series.published_at ?? undefined,
            itemCount: series.media_items_count,
            publishedItemCount: series.published_media_items_count,
          },
        }))
        .catch((seriesError: unknown) => ({
          found: false,
          error: seriesError instanceof Error ? seriesError.message : String(seriesError),
        }))
      : undefined;

    if (
      seriesId &&
      mediaItemDiagnostics.found &&
      mediaItemDiagnostics.item._embedded?.['media-series']?.id === seriesId
      && (options?.subtitle === undefined || mediaItemDiagnostics.item.subtitle === options.subtitle)
    ) {
      logger.warn('patchMediaItemSeries received an upstream error but the media item is already assigned to the target series', {
        mediaItemId,
        seriesId,
        requestSummary: {
          position: options?.position,
          subtitle: options?.subtitle,
          hasAudio: Boolean(options?.audio),
          imageCount: options?.images?.length ?? 0,
        },
        upstreamError: errorMessage,
        mediaItemDiagnostics: mediaItemDiagnostics.summary,
        targetSeriesDiagnostics,
      });
      return mediaItemDiagnostics.item as SubsplashSeriesMediaItem;
    }

    logger.error(`Failed to patch media item ${mediaItemId}`, {
      upstreamError: errorMessage,
      requestSummary: {
        mediaItemId,
        seriesId,
        position: options?.position,
        subtitle: options?.subtitle,
        hasAudio: Boolean(options?.audio),
        imageCount: options?.images?.length ?? 0,
      },
      mediaItemDiagnostics: mediaItemDiagnostics.found
        ? mediaItemDiagnostics.summary
        : mediaItemDiagnostics,
      targetSeriesDiagnostics,
      payloadSummary: {
        id: payload.id,
        position: payload.position,
        embedded: {
          mediaSeriesId: payload._embedded?.['media-series']?.id ?? null,
          audioId: payload._embedded?.audio?.id,
          imageIds: payload._embedded?.images?.map((image) => image.id) ?? [],
        },
      },
    });
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
      subtitle: null,
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

  await freezeSeriesMutationProjection({provider:'subsplash',account:'app:9XTSHD',resourceType:'series',resourceId:seriesId},`patchSeriesItemPositions:${seriesId}:${providerPayloadFingerprint(payload)}`,'PATCH',payload);
  await markPublishingCritical('PUBLISHING_ASSOCIATION_CRITICAL',{provider:'subsplash',resourceType:'series',resourceId:seriesId,accountId:'app:9XTSHD',method:'PATCH',requestFingerprint:providerPayloadFingerprint(payload)});
  await reserveSubsplashAssociation(`seriesorder:${seriesId}`,[seriesId,...items.map(item=>item.id)],payload,{target:{provider:'subsplash',kind:'series',remoteId:seriesId}});

  const config = createAxiosConfig(
    `https://core.subsplash.com/media/v1/media-series/${seriesId}`,
    token,
    'PATCH',
    payload
  );

  try {
    await runPublishingProviderMutation({operation:getPublishingMutationOperation() ?? 'patchSeriesItemPositions',target:{provider:'subsplash',account:'app:9XTSHD',resourceType:'series',resourceId:seriesId},step:`patchSeriesItemPositions:${seriesId}:${providerPayloadFingerprint(payload)}`,method:'PATCH',payload:payload,send:async()=>{synchronousMutationData(await axios(Object.assign(config,{skipSubsplashEdgeRetry:true})));return {completion:'acknowledged',result:null};}});
    logger.log(`Successfully updated positions for ${items.length} items in series ${seriesId}`);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('PROVIDER_MUTATION_')) throw error;
    if(error instanceof HttpsError || error && typeof error==='object' && 'code' in error && typeof error.code==='string' && (error.code.startsWith('PUBLISHING_') || ['PERMISSION_CHANGED','CANCEL_REQUESTED'].includes(error.code)))throw error;
    throwIfSubsplashEdgeBlocked(error);
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
  await markPublishingCritical('PUBLISHING_DELETE_CRITICAL',{provider:'subsplash',resourceType:'series',resourceId:seriesId,accountId:'app:9XTSHD',method:'DELETE'});
  const config = createAxiosConfig(
    `https://core.subsplash.com/media/v1/media-series/${seriesId}`,
    token,
    'DELETE'
  );

  try {
    await runPublishingProviderMutation({operation:getPublishingMutationOperation() ?? 'deleteSubsplashSeries',target:{provider:'subsplash',account:'app:9XTSHD',resourceType:'series',resourceId:seriesId},step:`deleteSubsplashSeries:${seriesId}:${providerPayloadFingerprint({id:seriesId})}`,method:'DELETE',payload:{id:seriesId},send:async()=>{synchronousMutationData(await axios(Object.assign(config,{skipSubsplashEdgeRetry:true})));return {completion:'acknowledged',result:null};}});
    logger.log(`Successfully deleted series ${seriesId}`);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('PROVIDER_MUTATION_')) throw error;
    if(error instanceof HttpsError || error && typeof error==='object' && 'code' in error && typeof error.code==='string' && (error.code.startsWith('PUBLISHING_') || ['PERMISSION_CHANGED','CANCEL_REQUESTED'].includes(error.code)))throw error;
    throwIfSubsplashEdgeBlocked(error);
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
    summary?: string | null;
    publishedAt?: string | null;
    images?: Array<{ id: string; type: string }>;
  },
  token: string,
  options?: {canonicalPatch?:Record<string,unknown>}
): Promise<SubsplashSeries> {
  const embeddedPayload: PatchSeriesPayload['_embedded'] = {
    ...(updates.images ? { images: updates.images } : {}),
  };

  const payload: PatchSeriesPayload = {
    id: seriesId,
    ...(updates.title !== undefined ? { title: updates.title } : {}),
    ...(updates.subtitle !== undefined ? { subtitle: updates.subtitle } : {}),
    ...(updates.summary !== undefined ? { summary: updates.summary } : {}),
    ...(updates.publishedAt !== undefined && { published_at: updates.publishedAt }),
    ...(Object.keys(embeddedPayload).length > 0 && { _embedded: embeddedPayload }),
  };

  const config = createAxiosConfig(
    `https://core.subsplash.com/media/v1/media-series/${seriesId}`,
    token,
    'PATCH',
    payload
  );

  await freezeSeriesMutationProjection({provider:'subsplash',account:'app:9XTSHD',resourceType:'series',resourceId:seriesId},`patchSeriesMetadata:${seriesId}:${providerPayloadFingerprint(payload)}`,'PATCH',payload,options?.canonicalPatch);
  await markPublishingCritical('PUBLISHING_ASSOCIATION_CRITICAL',{provider:'subsplash',resourceType:'series',resourceId:seriesId,accountId:'app:9XTSHD',method:'PATCH',requestFingerprint:providerPayloadFingerprint(payload)});
  await reserveSubsplashAssociation(`seriesmetadata:${seriesId}`,[seriesId,...(updates.images??[]).map(image=>image.id)],payload,{target:{provider:'subsplash',kind:'series',remoteId:seriesId}});
  try {
    const response = await runPublishingProviderMutation({operation:getPublishingMutationOperation() ?? 'patchSeriesMetadata',target:{provider:'subsplash',account:'app:9XTSHD',resourceType:'series',resourceId:seriesId},step:`patchSeriesMetadata:${seriesId}:${providerPayloadFingerprint(payload)}`,method:'PATCH',payload:payload,send:async()=>({completion:'acknowledged',result:normalizeSeriesMutationAcknowledgement(synchronousMutationData(await axios(Object.assign(config,{skipSubsplashEdgeRetry:true}))))})});
    logger.log(`Successfully updated metadata for series ${seriesId}`);
    if(response.id===seriesId&&typeof response.title==='string'&&typeof response.status==='string')return response;
    const observed=await getSeriesDetails(seriesId,token);
    if(observed.id!==seriesId||observed.app_key!==APP_KEY)throw new Error('PUBLISHING_PROVIDER_REPAIR_REQUIRED');
    return observed;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('PROVIDER_MUTATION_')) throw error;
    if(error instanceof HttpsError || error && typeof error==='object' && 'code' in error && typeof error.code==='string' && (error.code.startsWith('PUBLISHING_') || ['PERMISSION_CHANGED','CANCEL_REQUESTED'].includes(error.code)))throw error;
    throwIfSubsplashEdgeBlocked(error);
    const errorMessage = error && typeof error === 'object' && 'response' in error
      ? (error as { response?: { data?: unknown } }).response?.data
      : error;
    logger.error(`Failed to update series metadata for ${seriesId}`, errorMessage);
    throw new HttpsError('internal', `Failed to update series metadata: ${JSON.stringify(errorMessage)}`);
  }
}
