/**
 * Mock implementations for Series tests
 * Mocks the Subsplash API (axios) but uses real Firestore emulator
 */

import { CallableRequest } from 'firebase-functions/v2/https';
import {
  SubsplashSeries,
  SubsplashSeriesMediaItem,
  CreateSeriesPayload,
  PatchSeriesPayload,
  PatchMediaItemSeriesPayload,
} from '../../types/SubsplashSeries';

// --- Mock Firebase Functions ---
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: jest.fn().mockResolvedValue('fake-token'),
  createAxiosConfig: jest.fn((url: string, token: string, method: string, data?: unknown) => ({
    url,
    token,
    method,
    data,
    headers: {},
  })),
}));

jest.mock('firebase-functions/v2/https', () => ({
  onCall: jest.fn(<T,>(
    optsOrHandler: ((request: CallableRequest<T>) => Promise<unknown>) | unknown,
    maybeHandler?: (request: CallableRequest<T>) => Promise<unknown>
  ) => {
    const handler = typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler;
    return handler as unknown as (request: unknown) => Promise<unknown>;
  }),
  HttpsError: class extends Error {
    code: string;
    details?: unknown;
    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
  CallableRequest: {},
}));

// --- Subsplash Series Mock Implementation ---

export class SubsplashSeriesMock {
  series: Map<string, SubsplashSeries> = new Map();
  mediaItems: Map<string, SubsplashSeriesMediaItem> = new Map();
  operations: Array<{ type: 'unlink' | 'deleteSeries'; mediaItemId?: string; seriesId?: string }> = [];
  private idCounter = 0;

  constructor() {
    this.reset();
  }

  reset() {
    this.series.clear();
    this.mediaItems.clear();
    this.operations = [];
    this.idCounter = 0;
  }

  private generateId(): string {
    this.idCounter++;
    return `series-${Date.now()}-${this.idCounter}`;
  }

  private generateMediaItemId(): string {
    this.idCounter++;
    return `media-item-${Date.now()}-${this.idCounter}`;
  }

  /**
   * Create a series in the mock
   */
  createSeries(title: string, options?: { subtitle?: string; summary?: string; id?: string }): SubsplashSeries {
    const id = options?.id || this.generateId();
    const series: SubsplashSeries = {
      id,
      app_key: '9XTSHD',
      title,
      subtitle: options?.subtitle,
      summary: options?.summary,
      slug: title.toLowerCase().replace(/\s+/g, '-'),
      media_items_count: 0,
      published_media_items_count: 0,
      display_type: 'thumbnails',
      published_at: null,
      status: 'draft',
      short_code: Math.random().toString(36).substring(2, 9),
      is_default: false,
      position: this.series.size + 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      _links: {
        self: { href: `https://core.subsplash.com/media/v1/media-series/${id}` },
        'media-items': { href: `https://core.subsplash.com/media/v1/media-items?filter[media_series]=${id}` },
      },
    };
    this.series.set(id, series);
    return series;
  }

  /**
   * Get a series by ID
   */
  getSeries(id: string): SubsplashSeries | undefined {
    return this.series.get(id);
  }

  patchSeriesMetadata(seriesId: string, payload: PatchSeriesPayload): SubsplashSeries {
    const series = this.series.get(seriesId);
    if (!series) {
      throw new Error(`Series ${seriesId} not found`);
    }

    if (payload.title !== undefined) {
      series.title = payload.title;
    }
    if (payload.subtitle !== undefined) {
      series.subtitle = payload.subtitle;
    }
    if (payload.summary !== undefined) {
      series.summary = payload.summary;
    }
    if (payload.published_at !== undefined) {
      series.published_at = payload.published_at;
      series.status = payload.published_at ? 'published' : 'draft';
    }
    if (payload._embedded?.images) {
      series._embedded = {
        ...series._embedded,
        images: payload._embedded.images.map((image) => ({
          id: image.id,
          type: image.type as 'square' | 'wide' | 'banner',
        })),
      };
    }
    if (payload._embedded?.['media-items']) {
      this.patchSeriesItemPositions(seriesId, payload._embedded['media-items']);
    }

    series.updated_at = new Date().toISOString();
    this.series.set(seriesId, series);
    return series;
  }

  /**
   * Delete a series
   */
  deleteSeries(id: string): boolean {
    this.operations.push({ type: 'deleteSeries', seriesId: id });
    // Remove series association from all media items
    for (const [itemId, item] of this.mediaItems.entries()) {
      if (item._embedded?.['media-series']?.id === id) {
        item._embedded['media-series'] = null;
        this.mediaItems.set(itemId, item);
      }
    }
    return this.series.delete(id);
  }

  /**
   * Create a media item in the mock
   */
  createMediaItem(title: string, options?: { id?: string; seriesId?: string; position?: number }): SubsplashSeriesMediaItem {
    const id = options?.id || this.generateMediaItemId();
    const item: SubsplashSeriesMediaItem = {
      id,
      app_key: '9XTSHD',
      title,
      position: options?.position ?? null,
      status: 'published',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      _embedded: {
        'media-series': options?.seriesId ? { id: options.seriesId } : null,
      },
    };
    this.mediaItems.set(id, item);

    // Update series count if assigned
    if (options?.seriesId) {
      const series = this.series.get(options.seriesId);
      if (series) {
        series.media_items_count++;
        series.published_media_items_count++;
        this.series.set(options.seriesId, series);
      }
    }

    return item;
  }

  /**
   * Get a media item by ID
   */
  getMediaItem(id: string): SubsplashSeriesMediaItem | undefined {
    return this.mediaItems.get(id);
  }

  /**
   * Get all media items in a series
   */
  getSeriesItems(seriesId: string): SubsplashSeriesMediaItem[] {
    const items: SubsplashSeriesMediaItem[] = [];
    for (const item of this.mediaItems.values()) {
      if (item._embedded?.['media-series']?.id === seriesId) {
        items.push(item);
      }
    }
    // Sort by position (nulls last)
    return items.sort((a, b) => {
      if (a.position === null && b.position === null) return 0;
      if (a.position === null) return 1;
      if (b.position === null) return -1;
      return a.position - b.position;
    });
  }

  /**
   * Assign/unassign a media item to/from a series
   */
  patchMediaItemSeries(itemId: string, seriesId: string | null, position?: number): SubsplashSeriesMediaItem {
    const item = this.mediaItems.get(itemId);
    if (!item) {
      throw new Error(`Media item ${itemId} not found`);
    }

    const oldSeriesId = item._embedded?.['media-series']?.id;

    // Update old series count
    if (oldSeriesId && oldSeriesId !== seriesId) {
      const oldSeries = this.series.get(oldSeriesId);
      if (oldSeries) {
        oldSeries.media_items_count = Math.max(0, oldSeries.media_items_count - 1);
        oldSeries.published_media_items_count = Math.max(0, oldSeries.published_media_items_count - 1);
        this.series.set(oldSeriesId, oldSeries);
      }
    }

    // Update item
    item._embedded = {
      ...item._embedded,
      'media-series': seriesId ? { id: seriesId } : null,
    };
    if (seriesId === null) {
      this.operations.push({ type: 'unlink', mediaItemId: itemId });
    }
    if (position !== undefined) {
      item.position = position;
    }
    item.updated_at = new Date().toISOString();
    this.mediaItems.set(itemId, item);

    // Update new series count
    if (seriesId && seriesId !== oldSeriesId) {
      const newSeries = this.series.get(seriesId);
      if (newSeries) {
        newSeries.media_items_count++;
        newSeries.published_media_items_count++;
        this.series.set(seriesId, newSeries);
      }
    }

    return item;
  }

  /**
   * Update item positions within a series
   */
  patchSeriesItemPositions(seriesId: string, items: Array<{ id: string; position: number | null }>): void {
    for (const { id, position } of items) {
      const item = this.mediaItems.get(id);
      if (item && item._embedded?.['media-series']?.id === seriesId) {
        item.position = position;
        item.updated_at = new Date().toISOString();
        this.mediaItems.set(id, item);
      }
    }
  }

  getOperationLog(): Array<{ type: 'unlink' | 'deleteSeries'; mediaItemId?: string; seriesId?: string }> {
    return [...this.operations];
  }
}

export const subsplashSeriesMock = new SubsplashSeriesMock();

// --- Network Failure Injector ---

export class NetworkFailureInjector {
  private failures: Map<string, () => boolean> = new Map();
  private callCounts: Map<string, number> = new Map();

  registerFailure(key: string, shouldFail: () => boolean) {
    this.failures.set(key, shouldFail);
    this.callCounts.set(key, 0);
  }

  shouldFail(key: string): boolean {
    const count = (this.callCounts.get(key) || 0) + 1;
    this.callCounts.set(key, count);

    const failureFn = this.failures.get(key);
    if (!failureFn) return false;

    return failureFn();
  }

  clear() {
    this.failures.clear();
    this.callCounts.clear();
  }

  resetCounts() {
    this.callCounts.clear();
  }
}

export const networkFailureInjector = new NetworkFailureInjector();

// --- Axios Mock ---

const mockAxios = jest.fn((config: { method: string; url: string; data?: unknown }) => {
    const method = config.method.toUpperCase();
    const url = config.url;

    // POST /media/v1/media-series - Create series
    if (method === 'POST' && url.includes('/media/v1/media-series')) {
      const failureKey = 'createSeries';
      if (networkFailureInjector.shouldFail(failureKey)) {
        return Promise.reject(new Error('Network error: Failed to create series'));
      }
      const payload = config.data as CreateSeriesPayload;
      const series = subsplashSeriesMock.createSeries(payload.title, {
        subtitle: payload.subtitle,
        summary: payload.summary,
      });
      return Promise.resolve({ data: series, status: 201 });
    }

    // GET /media/v1/media-series/{id} - Get series details
    const getSeriesMatch = url.match(/media\/v1\/media-series\/([a-zA-Z0-9-]+)$/);
    if (method === 'GET' && getSeriesMatch) {
      const seriesId = getSeriesMatch[1];
      const failureKey = `getSeries:${seriesId}`;
      if (networkFailureInjector.shouldFail(failureKey)) {
        return Promise.reject(new Error(`Network error: Failed to get series ${seriesId}`));
      }
      const series = subsplashSeriesMock.getSeries(seriesId);
      if (series) return Promise.resolve({ data: series, status: 200 });
      return Promise.reject({ response: { status: 404, data: { error: 'Series not found' } } });
    }

    // DELETE /media/v1/media-series/{id} - Delete series
    const deleteSeriesMatch = url.match(/media\/v1\/media-series\/([a-zA-Z0-9-]+)$/);
    if (method === 'DELETE' && deleteSeriesMatch) {
      const seriesId = deleteSeriesMatch[1];
      const failureKey = `deleteSeries:${seriesId}`;
      if (networkFailureInjector.shouldFail(failureKey)) {
        return Promise.reject(new Error(`Network error: Failed to delete series ${seriesId}`));
      }
      const deleted = subsplashSeriesMock.deleteSeries(seriesId);
      if (deleted) return Promise.resolve({ status: 204, data: null });
      return Promise.reject({ response: { status: 404, data: { error: 'Series not found' } } });
    }

    // PATCH /media/v1/media-series/{id} - Update series metadata / publish state / reorder items
    const patchSeriesMatch = url.match(/media\/v1\/media-series\/([a-zA-Z0-9-]+)$/);
    if (method === 'PATCH' && patchSeriesMatch) {
      const seriesId = patchSeriesMatch[1];
      const failureKey = `patchSeries:${seriesId}`;
      if (networkFailureInjector.shouldFail(failureKey)) {
        return Promise.reject(new Error(`Network error: Failed to patch series ${seriesId}`));
      }
      const series = subsplashSeriesMock.getSeries(seriesId);
      if (!series) {
        return Promise.reject({ response: { status: 404, data: { error: 'Series not found' } } });
      }
      const payload = config.data as PatchSeriesPayload;
      return Promise.resolve({ data: subsplashSeriesMock.patchSeriesMetadata(seriesId, payload), status: 200 });
    }

    // GET /media/v1/media-items?filter[media_series]=... - Get series items
    if (method === 'GET' && url.includes('/media/v1/media-items') && url.includes('filter[media_series]')) {
      const match = url.match(/filter\[media_series\]=([a-zA-Z0-9-]+)/);
      if (match) {
        const seriesId = match[1];
        const failureKey = `getSeriesItems:${seriesId}`;
        if (networkFailureInjector.shouldFail(failureKey)) {
          return Promise.reject(new Error(`Network error: Failed to get series items ${seriesId}`));
        }
        const items = subsplashSeriesMock.getSeriesItems(seriesId);
        return Promise.resolve({ data: { _embedded: { 'media-items': items } }, status: 200 });
      }
    }

    // PATCH /media/v1/media-items/{id} - Assign/unassign series
    const patchItemMatch = url.match(/media\/v1\/media-items\/([a-zA-Z0-9-]+)$/);
    if (method === 'PATCH' && patchItemMatch) {
      const itemId = patchItemMatch[1];
      const notFoundKey = `patchMediaItemNotFound:${itemId}`;
      if (networkFailureInjector.shouldFail(notFoundKey)) {
        return Promise.reject({ response: { status: 404, data: { error: 'Media item not found' } } });
      }
      const failureKey = `patchMediaItem:${itemId}`;
      if (networkFailureInjector.shouldFail(failureKey)) {
        return Promise.reject(new Error(`Network error: Failed to patch media item ${itemId}`));
      }
      const payload = config.data as PatchMediaItemSeriesPayload;
      try {
        const item = subsplashSeriesMock.patchMediaItemSeries(
          itemId,
          payload._embedded['media-series']?.id || null,
          payload.position
        );
        return Promise.resolve({ data: item, status: 200 });
      } catch {
        return Promise.reject({ response: { status: 404, data: { error: 'Media item not found' } } });
      }
    }

    return Promise.reject(new Error(`Unhandled mock request: ${method} ${url}`));
  });

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return {
    __esModule: true,
    default: mockAxios,
    isAxiosError: actual.isAxiosError || ((error: unknown) => error && typeof error === 'object' && 'isAxiosError' in error),
  };
});

// --- Test Request Types ---

export type TestRequest<T> = {
  auth?: {
    token?: {
      role?: string;
    };
  };
  data: T;
};
