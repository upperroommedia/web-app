import {
  SubsplashList,
  SubsplashListRow,
  SubsplashListRowReference,
  SubsplashPatchPayload,
  SubsplashImage,
} from '../../types/Subsplash';
import { CallableRequest } from 'firebase-functions/v2/https';
import { AddtoListInputType } from '../../addToList';

export type MockSubsplashMutation = 'patch' | 'delete-row' | 'create-list';

export interface MockSubsplashHistoryEntry {
  event: MockSubsplashMutation;
  listId: string;
  rows: SubsplashListRow[];
}

export interface MockSubsplashMediaItem {
  id: string;
  title: string;
  subtitle?: string;
  summary?: string;
  date?: string;
  duration?: number;
  tags?: string[];
  audio_url?: string;
  _embedded?: {
    images?: SubsplashImage[];
  };
}

// Type for the handler function (what onCall wraps)
export type TestRequest = {
  auth?: {
    token?: {
      role?: string;
    };
  };
  data: AddtoListInputType;
};

export type AddToListHandler = (request: TestRequest) => Promise<import('../../addToList').AddToListOutputType>;

// Mock dependencies (Subsplash API only - Firestore uses real emulator)
// NOTE: Firestore is NOT mocked - we use the real emulator via setup.ts
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: jest.fn().mockResolvedValue('fake-token'),
  createAxiosConfig: jest.fn((url: string, token: string, method: string, data?: unknown) => ({ 
    url, 
    token, 
    method, 
    data, 
    headers: {} 
  })),
}));

// NOTE: We do NOT mock firebaseAdmin - we use the real Firestore emulator

// Don't mock logger - use the real Firebase Functions logger
// The logger works fine in tests without mocking

jest.mock('firebase-functions/v2/https', () => ({
  onCall: jest.fn(<T,>(
    optsOrHandler: ((request: CallableRequest<T>) => Promise<unknown>) | unknown,
    maybeHandler?: (request: CallableRequest<T>) => Promise<unknown>
  ) => {
    const handler = typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler;
    return handler as unknown as (request: TestRequest) => Promise<unknown>;
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
  CallableRequest: {} // Type only, not needed at runtime
}));

// --- Subsplash Mock Implementation ---

export class SubsplashMock {
  lists: Map<string, SubsplashList> = new Map();
  listRows: Map<string, SubsplashListRow[]> = new Map();
  mediaItems: Map<string, MockSubsplashMediaItem> = new Map();
  maxListSize: number = 200; // Configurable max list size for testing
  patchRetainsOmittedRows: boolean = true;
  private rowIdCounter: number = 0;
  private staleListRowsAfterPatch: Map<string, number> = new Map();
  private staleListRowsSnapshots: Map<string, SubsplashListRow[]> = new Map();
  private history: MockSubsplashHistoryEntry[] = [];
  private fullCapacityPatchCreateFailures: Set<string> = new Set();
  private hiddenFullCapacityPatchCreateFailures: Set<string> = new Set();
  private missingMediaItemIds: Set<string> = new Set();
  private unknownRowPatchFailures: Map<string, { rowId: string; remaining: number }> = new Map();

  constructor() {
    this.reset();
  }

  reset() {
    this.lists.clear();
    this.listRows.clear();
    this.mediaItems.clear();
    this.maxListSize = 200; // Reset to default
    this.patchRetainsOmittedRows = true;
    this.rowIdCounter = 0;
    this.staleListRowsAfterPatch.clear();
    this.staleListRowsSnapshots.clear();
    this.history = [];
    this.fullCapacityPatchCreateFailures.clear();
    this.hiddenFullCapacityPatchCreateFailures.clear();
    this.missingMediaItemIds.clear();
    this.unknownRowPatchFailures.clear();
  }

  createList(id: string, title: string, count: number = 0, maxItemCount?: number, subtitle?: string): SubsplashList {
    const list: SubsplashList = {
      id,
      app_key: '9XTSHD',
      title,
      type: 'standard',
      status: 'published',
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      list_rows_count: count,
      max_item_count: maxItemCount ?? this.maxListSize,
      _links: {
        self: { href: `https://core.subsplash.com/builder/v1/lists/${id}` },
        'list-rows': { href: `https://core.subsplash.com/builder/v1/list-rows?filter[source_list]=${id}` },
      },
      _embedded: {},
    };
    if (subtitle) {
      list.subtitle = subtitle;
    }
    this.lists.set(id, list);
    this.listRows.set(id, []);
    return list;
  }

  getList(id: string): SubsplashList | undefined {
    return this.lists.get(id);
  }

  createMediaItem(item: MockSubsplashMediaItem): MockSubsplashMediaItem {
    this.mediaItems.set(item.id, JSON.parse(JSON.stringify(item)) as MockSubsplashMediaItem);
    return this.getMediaItem(item.id)!;
  }

  getMediaItem(id: string): MockSubsplashMediaItem | undefined {
    const item = this.mediaItems.get(id);
    if (!item) {
      return undefined;
    }
    return JSON.parse(JSON.stringify(item)) as MockSubsplashMediaItem;
  }

  markMediaItemMissing(id: string) {
    this.missingMediaItemIds.add(id);
    this.mediaItems.delete(id);
  }

  isMediaItemMissing(id: string): boolean {
    return this.missingMediaItemIds.has(id);
  }

  getHistory(): MockSubsplashHistoryEntry[] {
    return JSON.parse(JSON.stringify(this.history)) as MockSubsplashHistoryEntry[];
  }

  clearHistory() {
    this.history = [];
  }

  failPatchWhenAtCapacityWithNewRows(listId: string) {
    this.fullCapacityPatchCreateFailures.add(listId);
  }

  failPatchWhenHiddenCapacityIsFull(listId: string) {
    this.hiddenFullCapacityPatchCreateFailures.add(listId);
  }

  failNextPatchesWithUnknownRow(listId: string, rowId: string, attempts: number = 1) {
    this.unknownRowPatchFailures.set(listId, {
      rowId,
      remaining: Math.max(1, attempts),
    });
  }

  setPatchRetainsOmittedRows(value: boolean) {
    this.patchRetainsOmittedRows = value;
  }

  recordHistory(event: MockSubsplashMutation, listId: string) {
    this.history.push({
      event,
      listId,
      rows: JSON.parse(JSON.stringify(this.listRows.get(listId) || [])) as SubsplashListRow[],
    });
  }

  getListRows(listId: string): SubsplashListRow[] {
    const staleReadsRemaining = this.staleListRowsAfterPatch.get(listId) ?? 0;
    const staleSnapshot = this.staleListRowsSnapshots.get(listId);
    if (staleReadsRemaining > 0 && staleSnapshot) {
      if (staleReadsRemaining === 1) {
        this.staleListRowsAfterPatch.delete(listId);
        this.staleListRowsSnapshots.delete(listId);
      } else {
        this.staleListRowsAfterPatch.set(listId, staleReadsRemaining - 1);
      }
      return JSON.parse(JSON.stringify(staleSnapshot)) as SubsplashListRow[];
    }

    return this.listRows.get(listId) || [];
  }

  returnStaleListRowsAfterNextPatch(listId: string, reads: number = 1) {
    this.staleListRowsAfterPatch.set(listId, reads);
  }

  patchList(id: string, payload: SubsplashPatchPayload) {
    if (!this.lists.has(id)) throw new Error(`List ${id} not found`);
    const list = this.lists.get(id)!;

    const unknownRowFailure = this.unknownRowPatchFailures.get(id);
    if (unknownRowFailure) {
      const freshRows = (this.listRows.get(id) || []).filter((row) => row.id !== unknownRowFailure.rowId);
      this.listRows.set(id, freshRows);
      list.list_rows_count = freshRows.length;

      if (unknownRowFailure.remaining <= 1) {
        this.unknownRowPatchFailures.delete(id);
      } else {
        this.unknownRowPatchFailures.set(id, {
          ...unknownRowFailure,
          remaining: unknownRowFailure.remaining - 1,
        });
      }

      const error = new Error(`Subsplash list row ${unknownRowFailure.rowId} is unknown.`);
      (error as Error & { upstreamStatus?: number; upstreamData?: unknown }).upstreamStatus = 400;
      (error as Error & { upstreamStatus?: number; upstreamData?: unknown }).upstreamData = {
        errors: [{ code: 'bad_request', detail: `list row error - unknown list row: ${unknownRowFailure.rowId}` }],
      };
      throw error;
    }
    
    // Validate: Subsplash rejects patches with more than maxListSize items
    const rowCount = payload._embedded['list-rows'].length;
    const maxAllowed = list.max_item_count ?? this.maxListSize;
    if (rowCount > maxAllowed) {
      throw new Error(`Subsplash list cannot have more than ${maxAllowed} items. Attempted to patch with ${rowCount} items.`);
    }

    const existingRows = this.listRows.get(id) || [];
    const containsNewRows = payload._embedded['list-rows'].some((row) => !('id' in row) || ('app_key' in row));
    const existingRowsIncludeContinuationLink = existingRows.some((row) => row.type === 'list');
    if (
      this.fullCapacityPatchCreateFailures.has(id) &&
      containsNewRows &&
      (
        existingRows.length >= maxAllowed ||
        list.list_rows_count >= maxAllowed ||
        (existingRowsIncludeContinuationLink && existingRows.length >= maxAllowed - 1)
      ) &&
      rowCount >= maxAllowed
    ) {
      const error = new Error(`Subsplash list cannot have more than ${maxAllowed} items. Attempted to patch with ${rowCount} items.`);
      (error as Error & { upstreamStatus?: number; upstreamData?: unknown }).upstreamStatus = 400;
      (error as Error & { upstreamStatus?: number; upstreamData?: unknown }).upstreamData = {
        errors: [{ code: 'bad_request', detail: `max number of list rows exceeded: ${maxAllowed}` }],
      };
      throw error;
    }

    if (
      this.hiddenFullCapacityPatchCreateFailures.has(id) &&
      containsNewRows &&
      rowCount >= maxAllowed - 1
    ) {
      const error = new Error(`Subsplash list cannot have more than ${maxAllowed} items. Attempted to patch with ${rowCount} items.`);
      (error as Error & { upstreamStatus?: number; upstreamData?: unknown }).upstreamStatus = 400;
      (error as Error & { upstreamStatus?: number; upstreamData?: unknown }).upstreamData = {
        errors: [{ code: 'bad_request', detail: `max number of list rows exceeded: ${maxAllowed}` }],
      };
      throw error;
    }

    if (
      this.hiddenFullCapacityPatchCreateFailures.has(id) &&
      !containsNewRows &&
      rowCount <= maxAllowed - 2
    ) {
      this.hiddenFullCapacityPatchCreateFailures.delete(id);
    }
    
    list.list_rows_count = rowCount;
    
    const existingRowsSnapshot = JSON.parse(JSON.stringify(existingRows)) as SubsplashListRow[];
    
    const requestedRows: SubsplashListRow[] = payload._embedded['list-rows'].map((row: SubsplashListRow | SubsplashListRowReference, index: number): SubsplashListRow => {
      if ('id' in row && 'position' in row && !('app_key' in row)) {
        const existingRow = existingRows.find(r => r.id === row.id);
        if (existingRow) {
          return {
            ...existingRow,
            position: row.position
          };
        }
        return {
          id: row.id,
          app_key: '9XTSHD',
          method: 'static' as const,
          position: row.position,
          type: 'media-item' as const,
          _embedded: {
            'source-list': { id }
          }
        };
      }
      
      const fullRow = row as SubsplashListRow;
      return {
        ...fullRow,
        // Generate deterministic-but-unique row IDs across parallel list patches.
        // Date.now() + index can collide when multiple lists are patched in the same millisecond.
        id: fullRow.id || `row-${id}-${Date.now()}-${this.rowIdCounter++}`,
        position: fullRow.position || index + 1
      };
    });

    const newRows = this.patchRetainsOmittedRows
      ? [
          ...requestedRows,
          ...existingRows.filter((row) => !requestedRows.some((requestedRow) => requestedRow.id === row.id)),
        ].map((row, index) => ({
          ...row,
          position: index + 1,
        }))
      : requestedRows;

    this.listRows.set(id, newRows);
    this.recordHistory('patch', id);
    if ((this.staleListRowsAfterPatch.get(id) ?? 0) > 0) {
      this.staleListRowsSnapshots.set(id, existingRowsSnapshot);
    }
    return { ...list, _embedded: { 'list-rows': newRows } };
  }
  
  postList(title: string, subtitle?: string): SubsplashList {
    const id = `list-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    return this.createList(id, title, 0, undefined, subtitle);
  }
}

export const subsplashMock = new SubsplashMock();

// Network failure injection system
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

// Mock Axios to use SubsplashMock with failure injection
jest.mock('axios', () => {
  const mockAxios = jest.fn((config: { method: string; url: string; data?: string }) => {
    const method = config.method.toUpperCase();
    const url = config.url;

    const getListMatch = url.match(/builder\/v1\/lists\/([a-zA-Z0-9-]+)$/);
    if (method === 'GET' && getListMatch) {
      const listId = getListMatch[1];
      const failureKey = `getList:${listId}`;
      if (networkFailureInjector.shouldFail(failureKey)) {
        return Promise.reject(new Error(`Network error: Failed to fetch list ${listId}`));
      }
      const list = subsplashMock.getList(listId);
      if (list) return Promise.resolve({ data: list });
      return Promise.reject({ response: { status: 404 } });
    }

    if (method === 'GET' && url.includes('/builder/v1/list-rows')) {
      const match = url.match(/filter\[source_list\]=([a-zA-Z0-9-]+)/);
      if (match) {
        const listId = match[1];
        const failureKey = `getListRows:${listId}`;
        if (networkFailureInjector.shouldFail(failureKey)) {
          return Promise.reject(new Error(`Network error: Failed to fetch list rows for ${listId}`));
        }
        const rows = subsplashMock.getListRows(listId);
        return Promise.resolve({ data: { _embedded: { 'list-rows': rows } } });
      }
    }

    const getMediaItemMatch = url.match(/media\/v1\/media-items\/([a-zA-Z0-9-]+)$/);
    if (method === 'GET' && getMediaItemMatch) {
      const mediaItemId = getMediaItemMatch[1];
      const mediaItem = subsplashMock.getMediaItem(mediaItemId);
      if (mediaItem) {
        return Promise.resolve({ data: mediaItem, status: 200 });
      }
      if (!subsplashMock.isMediaItemMissing(mediaItemId)) {
        return Promise.resolve({ data: { id: mediaItemId, title: mediaItemId }, status: 200 });
      }
      return Promise.reject({
        message: 'Request failed with status code 404',
        name: 'AxiosError',
        code: 'ERR_BAD_REQUEST',
        response: { status: 404, data: { error: 'Media item not found' } },
        isAxiosError: true,
      });
    }

    const patchListMatch = url.match(/builder\/v1\/lists\/([a-zA-Z0-9-]+)$/);
    if (method === 'PATCH' && patchListMatch) {
      const listId = patchListMatch[1];
      const failureKey = `patchList:${listId}`;
      if (networkFailureInjector.shouldFail(failureKey)) {
        return Promise.reject(new Error(`Network error: Failed to patch list ${listId}`));
      }
      if (!config.data) {
        return Promise.reject(new Error('Missing payload for PATCH request'));
      }
      const payload = typeof config.data === 'string' 
        ? JSON.parse(config.data) as SubsplashPatchPayload
        : config.data as SubsplashPatchPayload;
      let updatedList;
      try {
        updatedList = subsplashMock.patchList(listId, payload);
      } catch (error) {
        const upstreamStatus =
          error && typeof error === 'object' && 'upstreamStatus' in error
            ? (error as { upstreamStatus?: number }).upstreamStatus
            : undefined;
        const upstreamData =
          error && typeof error === 'object' && 'upstreamData' in error
            ? (error as { upstreamData?: unknown }).upstreamData
            : undefined;

        if (upstreamStatus && upstreamData) {
          return Promise.reject({
            message: `Request failed with status code ${upstreamStatus}`,
            name: 'AxiosError',
            code: upstreamStatus >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
            response: {
              status: upstreamStatus,
              statusText: upstreamStatus === 400 ? 'Bad Request' : 'Error',
              data: upstreamData,
              headers: {},
              config: {},
            },
            isAxiosError: true,
            toJSON: () => ({ message: `Request failed with status code ${upstreamStatus}`, name: 'AxiosError' }),
          });
        }

        throw error;
      }
      const afterMutationFailureKey = `patchListAfterMutation:${listId}`;
      if (networkFailureInjector.shouldFail(afterMutationFailureKey)) {
        return Promise.reject({
          message: 'Request failed with status code 502',
          name: 'AxiosError',
          code: 'ERR_BAD_RESPONSE',
          response: {
            status: 502,
            statusText: 'Bad Gateway',
            data: { errors: [{ code: 'bad_gateway', detail: `Upstream patch applied but connection failed for ${listId}` }] },
            headers: {},
            config: {}
          },
          isAxiosError: true,
          toJSON: () => ({ message: 'Request failed with status code 502', name: 'AxiosError' })
        });
      }
      return Promise.resolve({ data: updatedList });
    }
    
    if (method === 'POST' && url.includes('/builder/v1/lists')) {
      const failureKey = 'postList';
      if (networkFailureInjector.shouldFail(failureKey)) {
        return Promise.reject(new Error('Network error: Failed to create new list'));
      }
      const payload = JSON.parse(config.data || '{}') as { title: string; subtitle?: string };
      const newList = subsplashMock.postList(payload.title, payload.subtitle);
      subsplashMock.recordHistory('create-list', newList.id);
      return Promise.resolve({ data: newList });
    }

    // Handle DELETE requests for list-rows
    const deleteRowMatch = url.match(/builder\/v1\/list-rows\/([a-zA-Z0-9-]+)$/);
    if (method === 'DELETE' && deleteRowMatch) {
      const listItemId = deleteRowMatch[1];
      
      // Find which list contains this row
      for (const [listId, rows] of subsplashMock.listRows.entries()) {
        const row = rows.find(r => r.id === listItemId);
        if (row) {
          // Remove the row from the list
          const updatedRows = rows.filter(r => r.id !== listItemId);
          // Reindex positions
          updatedRows.forEach((r, index) => {
            r.position = index + 1;
          });
          subsplashMock.listRows.set(listId, updatedRows);
          subsplashMock.recordHistory('delete-row', listId);
          
          // Update list count
          const list = subsplashMock.getList(listId);
          if (list) {
            list.list_rows_count = updatedRows.length;
          }
          
          return Promise.resolve({ status: 204, data: null });
        }
      }
      
      // Row not found - return 404 in axios error format
      // Axios errors have a specific structure that axios checks with isAxiosError
      const axiosError = {
        message: 'Request failed with status code 404',
        name: 'AxiosError',
        code: 'ERR_BAD_REQUEST',
        response: {
          status: 404,
          statusText: 'Not Found',
          data: { errors: [{ code: 'not_found', detail: 'List row not found' }] },
          headers: {},
          config: {}
        },
        isAxiosError: true,
        toJSON: () => ({ message: axiosError.message, name: axiosError.name })
      };
      return Promise.reject(axiosError);
    }

    return Promise.reject(new Error(`Unhandled mock request: ${method} ${url}`));
  });

  return Object.assign(mockAxios, {
    isAxiosError: (error: unknown) =>
      Boolean(error && typeof error === 'object' && 'isAxiosError' in error),
  });
});
