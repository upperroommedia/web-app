import { SubsplashList, SubsplashListRow, SubsplashListRowReference, SubsplashPatchPayload } from '../../types/Subsplash';
import { CallableRequest } from 'firebase-functions/v2/https';
import { AddtoListInputType } from '../../addToList';

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
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  CallableRequest: {} // Type only, not needed at runtime
}));

// --- Subsplash Mock Implementation ---

export class SubsplashMock {
  lists: Map<string, SubsplashList> = new Map();
  listRows: Map<string, SubsplashListRow[]> = new Map();
  maxListSize: number = 200; // Configurable max list size for testing
  private rowIdCounter: number = 0;

  constructor() {
    this.reset();
  }

  reset() {
    this.lists.clear();
    this.listRows.clear();
    this.maxListSize = 200; // Reset to default
    this.rowIdCounter = 0;
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

  getListRows(listId: string): SubsplashListRow[] {
    return this.listRows.get(listId) || [];
  }

  patchList(id: string, payload: SubsplashPatchPayload) {
    if (!this.lists.has(id)) throw new Error(`List ${id} not found`);
    const list = this.lists.get(id)!;
    
    // Validate: Subsplash rejects patches with more than maxListSize items
    const rowCount = payload._embedded['list-rows'].length;
    const maxAllowed = list.max_item_count ?? this.maxListSize;
    if (rowCount > maxAllowed) {
      throw new Error(`Subsplash list cannot have more than ${maxAllowed} items. Attempted to patch with ${rowCount} items.`);
    }
    
    list.list_rows_count = rowCount;
    
    const existingRows = this.listRows.get(id) || [];
    
    const newRows: SubsplashListRow[] = payload._embedded['list-rows'].map((row: SubsplashListRow | SubsplashListRowReference, index: number): SubsplashListRow => {
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

    this.listRows.set(id, newRows);
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
  return jest.fn((config: { method: string; url: string; data?: string }) => {
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
      const updatedList = subsplashMock.patchList(listId, payload);
      return Promise.resolve({ data: updatedList });
    }
    
    if (method === 'POST' && url.includes('/builder/v1/lists')) {
      const failureKey = 'postList';
      if (networkFailureInjector.shouldFail(failureKey)) {
        return Promise.reject(new Error('Network error: Failed to create new list'));
      }
      const payload = JSON.parse(config.data || '{}') as { title: string; subtitle?: string };
      const newList = subsplashMock.postList(payload.title, payload.subtitle);
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
});
