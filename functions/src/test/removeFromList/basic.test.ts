import { OverflowBehavior } from '@upperroom/shared/types/List';
import { SubsplashListRow } from '../../types/Subsplash';
import { 
  subsplashMock,
} from '../addToList/mocks';
import { createListDocument, clearFirestore, getListBySubsplashId } from '../addToList/firestoreHelpers';
import removeFromList from '../../removeFromList';
import { RemoveFromListInputType } from '../../removeFromList';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import axios from 'axios';
import * as lockStore from '../../locks/subsplashLockStore';

// Type for the handler function (what onCall wraps)
export type RemoveFromListTestRequest = {
  auth?: {
    token?: {
      role?: string;
    };
  };
  data: RemoveFromListInputType;
};

export type RemoveFromListHandler = (request: RemoveFromListTestRequest) => Promise<import('../../removeFromList').RemoveFromListOutputType>;
const axiosMock = axios as unknown as jest.Mock;

// Mock dependencies (Subsplash API only - Firestore uses real emulator)
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

// Don't mock logger - use the real Firebase Functions logger

jest.mock('firebase-functions/v2/https', () => ({
  onCall: jest.fn((handler: (request: RemoveFromListTestRequest) => Promise<unknown>) => {
    return handler as unknown as (request: RemoveFromListTestRequest) => Promise<unknown>;
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

// Use the shared axios mock from addToList tests (which now includes DELETE support)
// The mock is already set up in mocks.ts, so we don't need to redefine it here

const removeFromListHandler = removeFromList as unknown as RemoveFromListHandler;

jest.setTimeout(20_000);

describe('removeFromList - Basic Functionality (Real Firestore Emulator)', () => {
  beforeEach(async () => {
    await clearFirestore();
    await firebaseAdmin.database().ref('subsplashLocks').remove();
    subsplashMock.reset();
  });

  it('should remove item from list successfully', async () => {
    const listId = 'remove-test-list-1';
    subsplashMock.createList(listId, 'Test List');
    
    // Add an item to the list
    const row: SubsplashListRow = {
      id: 'row-1',
      app_key: '9XTSHD',
      method: 'static',
      position: 1,
      type: 'media-item',
      _embedded: {
        'source-list': { id: listId },
        'media-item': { id: 'item-1' }
      }
    };
    subsplashMock.listRows.set(listId, [row]);
    
    // Create Firestore document for the list
    await createListDocument({
      subsplashId: listId,
      title: 'Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    const request: RemoveFromListTestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        listIds: [listId],
        listItemIds: ['row-1'],
        itemIds: ['item-1'],
        itemTypes: ['media-item'],
      }
    };

    const result = await removeFromListHandler(request);
    
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');
    
    // Verify the item was removed from the list
    const rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(0);
  });

  it('should handle item not found gracefully (treat as success)', async () => {
    const listId = 'remove-test-list-2';
    subsplashMock.createList(listId, 'Test List');
    
    // Create Firestore document for the list
    await createListDocument({
      subsplashId: listId,
      title: 'Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    // Try to remove an item that doesn't exist (simulating direct Subsplash edit)
    const request: RemoveFromListTestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        listIds: [listId],
        listItemIds: ['non-existent-row'],
        itemIds: ['non-existent-item'],
        itemTypes: ['media-item'],
      }
    };

    const result = await removeFromListHandler(request);
    
    expect(result).toHaveLength(1);
    // Debug: log the actual result to see what error we're getting
    console.error('Test result:', JSON.stringify(result[0], null, 2));
    expect(result[0].status).toBe('success');
    // Should have itemNotFound flag set
    if (result[0].status === 'success') {
      expect(result[0].itemNotFound).toBe(true);
    }
  });

  it('should find and remove item from overflow list', async () => {
    const rootListId = 'remove-test-root-list';
    const overflowListId = 'remove-test-overflow-list';
    
    subsplashMock.createList(rootListId, 'Root List');
    subsplashMock.createList(overflowListId, 'More Root List');
    
    // Root list has a link to overflow list
    const linkRow: SubsplashListRow = {
      id: 'link-row',
      app_key: '9XTSHD',
      method: 'static',
      position: 200,
      type: 'list',
      _embedded: {
        'source-list': { id: rootListId },
        'list': { id: overflowListId }
      }
    };
    
    // Overflow list has the item we want to remove
    const itemRow: SubsplashListRow = {
      id: 'overflow-row-1',
      app_key: '9XTSHD',
      method: 'static',
      position: 1,
      type: 'media-item',
      _embedded: {
        'source-list': { id: overflowListId },
        'media-item': { id: 'item-1' }
      }
    };
    const itemRow2: SubsplashListRow = {
      id: 'overflow-row-2',
      app_key: '9XTSHD',
      method: 'static',
      position: 2,
      type: 'media-item',
      _embedded: {
        'source-list': { id: overflowListId },
        'media-item': { id: 'item-2' }
      }
    };
    
    // Root list has 199 items + 1 link
    const rootRows = Array.from({ length: 199 }, (_, i) => ({
      id: `root-row-${i}`,
      app_key: '9XTSHD' as const,
      method: 'static' as const,
      position: i + 1,
      type: 'media-item' as const,
      _embedded: {
        'source-list': { id: rootListId },
        'media-item': { id: `root-item-${i}` }
      }
    }));
    subsplashMock.listRows.set(rootListId, [...rootRows, linkRow]);
    subsplashMock.listRows.set(overflowListId, [itemRow, itemRow2]);
    
    // Create Firestore documents
    const rootFirestoreId = await createListDocument({
      subsplashId: rootListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: overflowListId,
    });
    
    await createListDocument({
      subsplashId: overflowListId,
      title: 'More Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isMoreSermonsList: true,
    });

    // Try to remove using the original listItemId (which won't exist in root list)
    // The function should search overflow lists and find it
    const request: RemoveFromListTestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        listIds: [rootListId],
        listItemIds: ['non-existent-in-root'], // This won't be found in root
        itemIds: ['item-1'], // But this item exists in overflow list
        itemTypes: ['media-item'],
      }
    };

    const result = await removeFromListHandler(request);
    
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');
    
    // Verify the item was removed from the overflow list
    const overflowRows = subsplashMock.getListRows(overflowListId);
    expect(overflowRows).toHaveLength(1);
    expect(overflowRows[0]._embedded['media-item']?.id).toBe('item-2');
    
    // Verify root list is unchanged
    const rootRowsAfter = subsplashMock.getListRows(rootListId);
    expect(rootRowsAfter).toHaveLength(200); // 199 items + 1 link

    const rootDoc = await getListBySubsplashId(rootListId);
    const overflowDoc = await getListBySubsplashId(overflowListId);
    expect(rootDoc!.data()).toMatchObject({
      count: 199,
      logicalCount: 200,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 0,
      moreSermonsRef: overflowListId,
    });
    expect(overflowDoc!.data()).toMatchObject({
      count: 1,
      isRootList: false,
      isMoreSermonsList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 1,
    });
  });

  it('should handle item not found in overflow chain (treat as success)', async () => {
    const rootListId = 'remove-test-root-list-2';
    const overflowListId = 'remove-test-overflow-list-2';
    
    subsplashMock.createList(rootListId, 'Root List');
    subsplashMock.createList(overflowListId, 'More Root List');
    
    // Root list has a link to overflow list
    const linkRow: SubsplashListRow = {
      id: 'link-row-2',
      app_key: '9XTSHD',
      method: 'static',
      position: 200,
      type: 'list',
      _embedded: {
        'source-list': { id: rootListId },
        'list': { id: overflowListId }
      }
    };
    
    // Overflow list is empty (item was already removed directly from Subsplash)
    subsplashMock.listRows.set(rootListId, [linkRow]);
    subsplashMock.listRows.set(overflowListId, []);
    
    // Create Firestore documents
    await createListDocument({
      subsplashId: rootListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: overflowListId,
    });
    
    await createListDocument({
      subsplashId: overflowListId,
      title: 'More Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isMoreSermonsList: true,
    });

    // Try to remove an item that doesn't exist anywhere
    const request: RemoveFromListTestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        listIds: [rootListId],
        listItemIds: ['non-existent'],
        itemIds: ['non-existent-item'],
        itemTypes: ['media-item'],
      }
    };

    const result = await removeFromListHandler(request);
    
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');
    // Should have itemNotFound flag set
    if (result[0].status === 'success') {
      expect(result[0].itemNotFound).toBe(true);
    }
  });

  it('should handle multiple items removal', async () => {
    const listId = 'remove-test-multiple';
    subsplashMock.createList(listId, 'Test List');
    
    // Add multiple items
    const rows: SubsplashListRow[] = [
      {
        id: 'row-1',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: listId },
          'media-item': { id: 'item-1' }
        }
      },
      {
        id: 'row-2',
        app_key: '9XTSHD',
        method: 'static',
        position: 2,
        type: 'media-item',
        _embedded: {
          'source-list': { id: listId },
          'media-item': { id: 'item-2' }
        }
      },
      {
        id: 'row-3',
        app_key: '9XTSHD',
        method: 'static',
        position: 3,
        type: 'media-item',
        _embedded: {
          'source-list': { id: listId },
          'media-item': { id: 'item-3' }
        }
      }
    ];
    subsplashMock.listRows.set(listId, rows);
    
    await createListDocument({
      subsplashId: listId,
      title: 'Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    const request: RemoveFromListTestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        listIds: [listId, listId],
        listItemIds: ['row-1', 'row-3'],
        itemIds: ['item-1', 'item-3'],
        itemTypes: ['media-item', 'media-item'],
      }
    };

    const result = await removeFromListHandler(request);
    
    expect(result).toHaveLength(2);
    expect(result[0].status).toBe('success');
    expect(result[1].status).toBe('success');
    
    // Verify items were removed
    const remainingRows = subsplashMock.getListRows(listId);
    expect(remainingRows).toHaveLength(1);
    expect(remainingRows[0]._embedded['media-item']?.id).toBe('item-2');
    expect(remainingRows[0].position).toBe(1); // Position should be reindexed
  });

  it('should traverse multiple overflow lists to find item', async () => {
    const rootListId = 'remove-test-multi-overflow-root';
    const overflowList1Id = 'remove-test-overflow-1';
    const overflowList2Id = 'remove-test-overflow-2';
    
    subsplashMock.createList(rootListId, 'Root List');
    subsplashMock.createList(overflowList1Id, 'More Root List');
    subsplashMock.createList(overflowList2Id, 'More More Root List');
    
    // Root -> Overflow1 -> Overflow2 chain
    const linkRow1: SubsplashListRow = {
      id: 'link-1',
      app_key: '9XTSHD',
      method: 'static',
      position: 200,
      type: 'list',
      _embedded: {
        'source-list': { id: rootListId },
        'list': { id: overflowList1Id }
      }
    };
    
    const linkRow2: SubsplashListRow = {
      id: 'link-2',
      app_key: '9XTSHD',
      method: 'static',
      position: 200,
      type: 'list',
      _embedded: {
        'source-list': { id: overflowList1Id },
        'list': { id: overflowList2Id }
      }
    };
    
    // Item is in the second overflow list
    const itemRow: SubsplashListRow = {
      id: 'overflow2-row-1',
      app_key: '9XTSHD',
      method: 'static',
      position: 1,
      type: 'media-item',
      _embedded: {
        'source-list': { id: overflowList2Id },
        'media-item': { id: 'item-1' }
      }
    };
    
    subsplashMock.listRows.set(rootListId, [linkRow1]);
    subsplashMock.listRows.set(overflowList1Id, [linkRow2]);
    subsplashMock.listRows.set(overflowList2Id, [itemRow]);
    
    // Create Firestore documents
    const rootFirestoreId = await createListDocument({
      subsplashId: rootListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: overflowList1Id,
    });
    
    await createListDocument({
      subsplashId: overflowList1Id,
      title: 'More Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isMoreSermonsList: true,
      moreSermonsRef: overflowList2Id,
    });
    
    await createListDocument({
      subsplashId: overflowList2Id,
      title: 'More More Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isMoreSermonsList: true,
    });

    const request: RemoveFromListTestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        listIds: [rootListId],
        listItemIds: ['non-existent'],
        itemIds: ['item-1'],
        itemTypes: ['media-item'],
      }
    };

    const result = await removeFromListHandler(request);
    
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');
    
    // Verify the item was removed from the second overflow list
    const overflow2Rows = subsplashMock.getListRows(overflowList2Id);
    expect(overflow2Rows).toHaveLength(0);

    const rootRowsAfter = subsplashMock.getListRows(rootListId);
    expect(rootRowsAfter).toHaveLength(0);

    const rootDoc = await getListBySubsplashId(rootListId);
    expect(rootDoc!.data()).toMatchObject({
      count: 0,
      logicalCount: 0,
      hasOverflowPages: false,
      isRootList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 0,
    });
    expect(rootDoc!.data().moreSermonsRef).toBeUndefined();
  });

  it('should replay duplicate operation keys without repeating delete work', async () => {
    const listId = 'remove-test-op-key-replay';
    subsplashMock.createList(listId, 'Replay Remove List');
    subsplashMock.listRows.set(listId, [
      {
        id: 'remove-row-op-key',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: listId },
          'media-item': { id: 'remove-item-op-key' },
        },
      },
    ]);

    await createListDocument({
      subsplashId: listId,
      title: 'Replay Remove List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    const request: RemoveFromListTestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        listIds: [listId],
        listItemIds: ['remove-row-op-key'],
        itemIds: ['remove-item-op-key'],
        itemTypes: ['media-item'],
        operationKey: 'remove-op-key-replay-1',
      } as RemoveFromListInputType & { operationKey: string },
    };

    axiosMock.mockClear();
    const firstResult = await removeFromListHandler(request);
    const callCountAfterFirst = axiosMock.mock.calls.length;
    const secondResult = await removeFromListHandler(request);

    expect(firstResult[0].status).toBe('success');
    expect(secondResult).toEqual(firstResult);
    expect(axiosMock.mock.calls.length).toBe(callCountAfterFirst);
  });

  it('should return busy lock metadata when list lock contention times out', async () => {
    const listId = 'remove-test-lock-timeout';
    subsplashMock.createList(listId, 'Remove Timeout List');
    subsplashMock.listRows.set(listId, [
      {
        id: 'remove-timeout-row',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: listId },
          'media-item': { id: 'remove-timeout-item' },
        },
      },
    ]);

    await createListDocument({
      subsplashId: listId,
      title: 'Remove Timeout List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    await lockStore.acquireWithWait(`list:${listId}`, {
      ownerToken: 'remove-timeout-owner',
      leaseTtlMs: 400,
      pollIntervalMs: 25,
    });
    const heartbeat = lockStore.startHeartbeat(`list:${listId}`, {
      ownerToken: 'remove-timeout-owner',
      leaseTtlMs: 400,
      intervalMs: 100,
    });

    try {
      const result = await removeFromListHandler({
        auth: { token: { role: 'admin' } },
        data: {
          listIds: [listId],
          listItemIds: ['remove-timeout-row'],
          itemIds: ['remove-timeout-item'],
          itemTypes: ['media-item'],
          operationKey: 'remove-op-key-lock-timeout',
        } as RemoveFromListInputType & { operationKey: string },
      });

      expect(result[0].status).toBe('error');
      if (result[0].status === 'error') {
        expect((result[0] as { errorCode?: string }).errorCode).toBe('aborted');
        expect((result[0] as { errorDetails?: { code?: string; locked_keys?: string[]; wait_ms?: number } }).errorDetails)
          .toMatchObject({
            code: 'SUBSPLASH_LOCK_BUSY',
            locked_keys: [`list:${listId}`],
            wait_ms: 10_000,
          });
      }
    } finally {
      heartbeat.stop();
      await lockStore.releaseLock(`list:${listId}`, 'remove-timeout-owner').catch(() => undefined);
    }
  });
});
