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
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';

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

jest.setTimeout(60_000);

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
    const firestoreListId = 'remove-test-list-2-firestore';
    subsplashMock.createList(listId, 'Test List');
    
    // Create Firestore document for the list
    await createListDocument({
      id: firestoreListId,
      subsplashId: listId,
      title: 'Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    await firebaseAdmin
      .firestore()
      .collection('lists')
      .doc(firestoreListId)
      .collection('listItems')
      .doc('sermon-1')
      .set({
        id: 'sermon-1',
        subsplashId: 'item-1',
        position: 1,
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'missing-row' },
        physicalPlacement: {
          firestoreListId,
          subsplashListId: listId,
          overflowDepth: 0,
          position: 1,
          listItemId: 'missing-row',
        },
      });

    await firebaseAdmin
      .firestore()
      .collection('sermons')
      .doc('sermon-1')
      .collection('sermonLists')
      .doc(firestoreListId)
      .set({
        id: firestoreListId,
        name: 'Test List',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'missing-row' },
        publishGeneration: 0,
      });

    // Try to remove an item that doesn't exist (simulating direct Subsplash edit)
    const request: RemoveFromListTestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        listIds: [listId],
        listItemIds: ['non-existent-row'],
        itemIds: ['item-1'],
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

    const rootProjection = await firebaseAdmin
      .firestore()
      .collection('lists')
      .doc(firestoreListId)
      .collection('listItems')
      .doc('sermon-1')
      .get();
    expect(rootProjection.data()?.uploadStatus).toEqual({ status: uploadStatus.NOT_UPLOADED });
    expect(rootProjection.data()?.physicalPlacement).toBeUndefined();

    const canonicalMembership = await firebaseAdmin
      .firestore()
      .collection('sermons')
      .doc('sermon-1')
      .collection('sermonLists')
      .doc(firestoreListId)
      .get();
    expect(canonicalMembership.data()?.uploadStatus).toEqual({ status: uploadStatus.NOT_UPLOADED });
    expect(canonicalMembership.data()?.publishGeneration).toBe(1);
  });

  it('clears the removed sermon projection by explicit sermon id when projection subsplash ids are stale', async () => {
    const listId = 'remove-test-list-explicit-sermon';
    const firestoreListId = 'remove-test-list-explicit-sermon-firestore';
    subsplashMock.createList(listId, 'Test List');

    const row: SubsplashListRow = {
      id: 'row-1',
      app_key: '9XTSHD',
      method: 'static',
      position: 1,
      type: 'media-item',
      _embedded: {
        'source-list': { id: listId },
        'media-item': { id: 'media-1' },
      },
    };
    subsplashMock.listRows.set(listId, [row]);

    await createListDocument({
      id: firestoreListId,
      subsplashId: listId,
      title: 'Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isRootList: true,
      rootListId: firestoreListId,
      overflowDepth: 0,
      count: 1,
      logicalCount: 1,
      hasOverflowPages: false,
    });

    await firebaseAdmin
      .firestore()
      .collection('lists')
      .doc(firestoreListId)
      .collection('listItems')
      .doc('sermon-1')
      .set({
        id: 'sermon-1',
        title: 'Test Sermon',
        subsplashId: 'stale-media-id',
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-1' },
        physicalPlacement: {
          firestoreListId,
          subsplashListId: listId,
          overflowDepth: 0,
          position: 1,
          listItemId: 'row-1',
        },
      });

    await firebaseAdmin
      .firestore()
      .collection('sermons')
      .doc('sermon-1')
      .collection('sermonLists')
      .doc(firestoreListId)
      .set({
        id: firestoreListId,
        name: 'Test List',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-1' },
        publishGeneration: 0,
      });

    const request: RemoveFromListTestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        listIds: [listId],
        listItemIds: ['row-1'],
        itemIds: ['media-1'],
        itemTypes: ['media-item'],
        sermonIds: ['sermon-1'],
      },
    };

    const result = await removeFromListHandler(request);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');

    const rootProjection = await firebaseAdmin
      .firestore()
      .collection('lists')
      .doc(firestoreListId)
      .collection('listItems')
      .doc('sermon-1')
      .get();
    expect(rootProjection.data()?.uploadStatus).toEqual({ status: uploadStatus.NOT_UPLOADED });
    expect(rootProjection.data()?.physicalPlacement).toBeUndefined();

    const canonicalMembership = await firebaseAdmin
      .firestore()
      .collection('sermons')
      .doc('sermon-1')
      .collection('sermonLists')
      .doc(firestoreListId)
      .get();
    expect(canonicalMembership.data()?.uploadStatus).toEqual({ status: uploadStatus.NOT_UPLOADED });
    expect(canonicalMembership.data()?.publishGeneration).toBe(1);
  });

  it('allows remove on mismatched chains and does not touch unrelated canonical sermon memberships', async () => {
    const rootListId = 'remove-mismatch-root';
    const rootFirestoreId = 'remove-mismatch-root-firestore';
    subsplashMock.createList(rootListId, 'Mismatch Root');
    subsplashMock.listRows.set(rootListId, [
      {
        id: 'row-2',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootListId },
          'media-item': { id: 'media-2' },
        },
      },
      {
        id: 'row-1',
        app_key: '9XTSHD',
        method: 'static',
        position: 2,
        type: 'media-item',
        _embedded: {
          'source-list': { id: rootListId },
          'media-item': { id: 'media-1' },
        },
      },
    ]);

    await createListDocument({
      id: rootFirestoreId,
      subsplashId: rootListId,
      title: 'Mismatch Root',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 2,
      logicalCount: 2,
      hasOverflowPages: false,
      isRootList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 0,
    });

    await firebaseAdmin
      .firestore()
      .collection('sermons')
      .doc('sermon-1')
      .collection('sermonLists')
      .doc(rootFirestoreId)
      .set({
        id: rootFirestoreId,
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-1' },
      });
    await firebaseAdmin
      .firestore()
      .collection('sermons')
      .doc('sermon-2')
      .collection('sermonLists')
      .doc(rootFirestoreId)
      .set({
        id: rootFirestoreId,
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-2' },
      });
    await firebaseAdmin
      .firestore()
      .collection('lists')
      .doc(rootFirestoreId)
      .collection('listItems')
      .doc('sermon-1')
      .set({
        id: 'sermon-1',
        subsplashId: 'media-1',
        position: 1,
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-1' },
      });
    await firebaseAdmin
      .firestore()
      .collection('lists')
      .doc(rootFirestoreId)
      .collection('listItems')
      .doc('sermon-2')
      .set({
        id: 'sermon-2',
        subsplashId: 'media-2',
        position: 2,
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-2' },
      });

    const result = await removeFromListHandler({
      auth: { token: { role: 'admin' } },
      data: {
        listIds: [rootListId],
        listItemIds: ['row-1'],
        itemIds: ['media-1'],
        itemTypes: ['media-item'],
      },
    });

    expect(result).toEqual([
      expect.objectContaining({
        listId: rootListId,
        status: 'success',
      }),
    ]);

    const remainingRows = subsplashMock.getListRows(rootListId);
    expect(remainingRows.map((row) => row._embedded['media-item']?.id)).toEqual(['media-2']);

    const unrelatedMembership = await firebaseAdmin
      .firestore()
      .collection('sermons')
      .doc('sermon-2')
      .collection('sermonLists')
      .doc(rootFirestoreId)
      .get();
    expect(unrelatedMembership.exists).toBe(true);
    expect(unrelatedMembership.data()?.uploadStatus?.listItemId).toBe('row-2');
  });

  it('allows remove from a structurally valid remote-only published list without Firebase mirrors', async () => {
    const listId = 'remove-remote-only-valid-root';
    const firestoreListId = 'remove-remote-only-valid-root-firestore';
    subsplashMock.createList(listId, 'Remote Only Root', 3, 5);
    subsplashMock.listRows.set(listId, [
      {
        id: 'row-1',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: listId },
          'media-item': { id: 'remote-only-1' },
        },
      },
      {
        id: 'row-2',
        app_key: '9XTSHD',
        method: 'static',
        position: 2,
        type: 'media-item',
        _embedded: {
          'source-list': { id: listId },
          'media-item': { id: 'remote-only-2' },
        },
      },
      {
        id: 'row-3',
        app_key: '9XTSHD',
        method: 'static',
        position: 3,
        type: 'media-item',
        _embedded: {
          'source-list': { id: listId },
          'media-item': { id: 'remote-only-3' },
        },
      },
    ]);

    await createListDocument({
      id: firestoreListId,
      subsplashId: listId,
      title: 'Remote Only Root',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 3,
      logicalCount: 3,
      hasOverflowPages: false,
      isRootList: true,
      rootListId: firestoreListId,
      overflowDepth: 0,
    });

    const result = await removeFromListHandler({
      auth: { token: { role: 'admin' } },
      data: {
        listIds: [listId],
        listItemIds: ['row-2'],
        itemIds: ['remote-only-2'],
        itemTypes: ['media-item'],
      },
    });

    expect(result).toEqual([
      expect.objectContaining({
        listId,
        status: 'success',
      }),
    ]);

    const rows = subsplashMock.getListRows(listId);
    expect(rows.map((row) => row._embedded['media-item']?.id)).toEqual(['remote-only-1', 'remote-only-3']);
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
      id: 'remove-test-root-list-firestore',
      subsplashId: rootListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 199,
      logicalCount: 201,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'remove-test-root-list-firestore',
      overflowDepth: 0,
      moreSermonsRef: overflowListId,
    });
    
    await createListDocument({
      subsplashId: overflowListId,
      title: 'More Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isMoreSermonsList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 1,
      count: 2,
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
    
    // Removing one item drops the logical count to 200, so the overflow page should collapse.
    const overflowRows = subsplashMock.getListRows(overflowListId);
    expect(overflowRows).toHaveLength(0);
    
    // Root page should now contain all 200 media rows with no continuation link.
    const rootRowsAfter = subsplashMock.getListRows(rootListId);
    expect(rootRowsAfter).toHaveLength(200);
    expect(rootRowsAfter.every((row) => row.type === 'media-item')).toBe(true);
    expect(rootRowsAfter[rootRowsAfter.length - 1]._embedded['media-item']?.id).toBe('item-2');

    const rootDoc = await getListBySubsplashId(rootListId);
    const overflowDoc = await getListBySubsplashId(overflowListId);
    expect(rootDoc!.data()).toMatchObject({
      count: 200,
      logicalCount: 200,
      hasOverflowPages: false,
      isRootList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 0,
    });
    expect(overflowDoc!.data()).toMatchObject({
      count: 0,
      isMoreSermonsList: true,
    });
    expect(rootDoc!.data()?.moreSermonsRef).toBeUndefined();
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
    const rootFirestoreId = await createListDocument({
      id: 'remove-test-root-list-2-firestore',
      subsplashId: rootListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 0,
      logicalCount: 0,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'remove-test-root-list-2-firestore',
      overflowDepth: 0,
      moreSermonsRef: overflowListId,
    });
    
    await createListDocument({
      subsplashId: overflowListId,
      title: 'More Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isMoreSermonsList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 1,
      count: 0,
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
      id: 'remove-test-multi-overflow-root-firestore',
      subsplashId: rootListId,
      title: 'Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 0,
      logicalCount: 1,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'remove-test-multi-overflow-root-firestore',
      overflowDepth: 0,
      moreSermonsRef: overflowList1Id,
    });
    
    await createListDocument({
      subsplashId: overflowList1Id,
      title: 'More Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isMoreSermonsList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 1,
      count: 0,
      moreSermonsRef: overflowList2Id,
    });
    
    await createListDocument({
      subsplashId: overflowList2Id,
      title: 'More More Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      isMoreSermonsList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 2,
      count: 1,
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
