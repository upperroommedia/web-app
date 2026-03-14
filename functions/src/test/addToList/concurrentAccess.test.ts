import { OverflowBehavior } from '@upperroom/shared/types/List';
import { 
  subsplashMock, 
  TestRequest,
  AddToListHandler
} from './mocks';
import { createListDocument, clearFirestore } from './firestoreHelpers';
import addToList from '../../addToList';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import axios from 'axios';

const firestoreDB = firebaseAdmin.firestore();
const axiosMock = axios as unknown as jest.Mock;

const addToListHandler = addToList as unknown as AddToListHandler;

describe('addToList - Concurrent Access with Firestore Transactions (Real Firestore Emulator)', () => {
  beforeEach(async () => {
    await clearFirestore();
    await firebaseAdmin.database().ref('subsplashLocks').remove();
    subsplashMock.reset();
    subsplashMock.maxListSize = 10; // Set to 10 for testing
  });


  it('should handle two concurrent adds to same list', async () => {
    const listId = 'concurrentAccess-concurrent-list';
    subsplashMock.createList(listId, 'Concurrent Test List');

    // Create Firestore document for the list
    await createListDocument({
      subsplashId: listId,
      title: 'Concurrent Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    // Verify document exists before starting concurrent operations
    const verifyDoc = await firestoreDB
      .collection('lists')
      .where('subsplashId', '==', listId)
      .limit(1)
      .get();
    expect(verifyDoc.empty).toBe(false);

    const item1 = { id: 'item-1', type: 'media-item' as const };
    const item2 = { id: 'item-2', type: 'media-item' as const };

    const request1: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: item1, maxListSize: 10 }
    };

    const request2: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: item2, maxListSize: 10 }
    };

    // Firestore emulator handles transaction retries automatically
    const [result1, result2] = await Promise.all([
      addToListHandler(request1),
      addToListHandler(request2)
    ]);

    if (result1[0].status === 'error') {
      console.error('Result1 error:', result1[0].error);
    }
    if (result2[0].status === 'error') {
      console.error('Result2 error:', result2[0].error);
    }
    expect(result1[0].status).toBe('success');
    expect(result2[0].status).toBe('success');

    // Verify listItemId is returned for both concurrent operations
    if (result1[0].status === 'success' && result2[0].status === 'success') {
      expect(result1[0].listItemId).toBeDefined();
      expect(result2[0].listItemId).toBeDefined();
      // Each should have a different listItemId (different rows)
      expect(result1[0].listItemId).not.toBe(result2[0].listItemId);
    }

    const rows = subsplashMock.getListRows(listId);
    expect(rows.length).toBe(2);
    
    const itemIds = rows.map(r => r._embedded['media-item']?.id);
    expect(itemIds).toContain('item-1');
    expect(itemIds).toContain('item-2');
    
    // Verify listItemIds match actual row IDs
    if (result1[0].status === 'success' && result2[0].status === 'success') {
      const row1 = rows.find(r => r._embedded['media-item']?.id === 'item-1');
      const row2 = rows.find(r => r._embedded['media-item']?.id === 'item-2');
      if (row1) expect(row1.id).toBe(result1[0].listItemId);
      if (row2) expect(row2.id).toBe(result2[0].listItemId);
    }
  });

  it('should handle three concurrent adds to same list', async () => {
    const listId = 'concurrentAccess-concurrent-list-3';
    subsplashMock.createList(listId, 'Concurrent Test List 3');

    // Create Firestore document for the list
    await createListDocument({
      subsplashId: listId,
      title: 'Concurrent Test List 3',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    // Verify document exists before starting concurrent operations
    const verifyDoc = await firestoreDB
      .collection('lists')
      .where('subsplashId', '==', listId)
      .limit(1)
      .get();
    expect(verifyDoc.empty).toBe(false);

    const items = [
      { id: 'item-1', type: 'media-item' as const },
      { id: 'item-2', type: 'media-item' as const },
      { id: 'item-3', type: 'media-item' as const }
    ];

    const requests: TestRequest[] = items.map(item => ({
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: item, maxListSize: 10 }
    }));

    // Firestore emulator handles transaction retries automatically
    const results = await Promise.all(
      requests.map(req => addToListHandler(req))
    );

    results.forEach((result, index) => {
      if (result[0].status === 'error') {
        console.error(`Result ${index} error:`, result[0].error);
      }
      expect(result[0].status).toBe('success');
      // Verify listItemId is returned for each concurrent operation
      if (result[0].status === 'success') {
        expect(result[0].listItemId).toBeDefined();
        expect(typeof result[0].listItemId).toBe('string');
      }
    });

    // Verify all listItemIds are unique
    const listItemIds = results
      .filter(r => r[0].status === 'success')
      .map(r => r[0].status === 'success' ? r[0].listItemId : null)
      .filter((id): id is string => id !== null && id !== undefined);
    expect(new Set(listItemIds).size).toBe(listItemIds.length); // All unique

    const rows = subsplashMock.getListRows(listId);
    expect(rows.length).toBe(3);
    
    const itemIds = rows.map(r => r._embedded['media-item']?.id);
    expect(itemIds).toContain('item-1');
    expect(itemIds).toContain('item-2');
    expect(itemIds).toContain('item-3');
    
    // Verify listItemIds match actual row IDs
    results.forEach((result, index) => {
      if (result[0].status === 'success') {
        const row = rows.find(r => r._embedded['media-item']?.id === items[index].id);
        if (row) {
          expect(row.id).toBe(result[0].listItemId);
        }
      }
    });
  });

  it('should retry transactions when conflicts occur', async () => {
    const listId = 'concurrentAccess-conflict-list';
    subsplashMock.createList(listId, 'Conflict Test List');

    // Create Firestore document for the list
    await createListDocument({
      subsplashId: listId,
      title: 'Conflict Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    // Verify document exists before starting concurrent operations
    const verifyDoc = await firestoreDB
      .collection('lists')
      .where('subsplashId', '==', listId)
      .limit(1)
      .get();
    expect(verifyDoc.empty).toBe(false);

    // Firestore emulator automatically handles transaction retries on conflicts
    // We trigger a conflict by making concurrent requests
    const item1 = { id: 'conflict-item-1', type: 'media-item' as const };
    const item2 = { id: 'conflict-item-2', type: 'media-item' as const };

    const request1: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: item1, maxListSize: 10 }
    };

    const request2: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: item2, maxListSize: 10 }
    };

    // Concurrent requests will cause transaction conflicts that Firestore handles automatically
    const [result1, result2] = await Promise.all([
      addToListHandler(request1),
      addToListHandler(request2)
    ]);

    if (result1[0].status === 'error') {
      console.error('Result1 error:', result1[0].error);
    }
    if (result2[0].status === 'error') {
      console.error('Result2 error:', result2[0].error);
    }
    expect(result1[0].status).toBe('success');
    expect(result2[0].status).toBe('success');

    const rows = subsplashMock.getListRows(listId);
    expect(rows.length).toBe(2);
    
    const itemIds = rows.map(r => r._embedded['media-item']?.id);
    expect(itemIds).toContain('conflict-item-1');
    expect(itemIds).toContain('conflict-item-2');
  });

  it('should allow concurrent adds to different lists without conflicts', async () => {
    const listId1 = 'concurrentAccess-list-1';
    const listId2 = 'concurrentAccess-list-2';
    
    subsplashMock.createList(listId1, 'List 1');
    subsplashMock.createList(listId2, 'List 2');

    // Create Firestore documents for both lists
    await createListDocument({
      subsplashId: listId1,
      title: 'List 1',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    await createListDocument({
      subsplashId: listId2,
      title: 'List 2',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    // Verify documents exist before starting concurrent operations
    const verifyDoc1 = await firestoreDB
      .collection('lists')
      .where('subsplashId', '==', listId1)
      .limit(1)
      .get();
    expect(verifyDoc1.empty).toBe(false);
    const verifyDoc2 = await firestoreDB
      .collection('lists')
      .where('subsplashId', '==', listId2)
      .limit(1)
      .get();
    expect(verifyDoc2.empty).toBe(false);

    const item1 = { id: 'item-1', type: 'media-item' as const };
    const item2 = { id: 'item-2', type: 'media-item' as const };

    const request1: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId1], mediaItem: item1, maxListSize: 10 }
    };

    const request2: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId2], mediaItem: item2, maxListSize: 10 }
    };

    // Different lists should not conflict - Firestore handles this automatically
    const [result1, result2] = await Promise.all([
      addToListHandler(request1),
      addToListHandler(request2)
    ]);

    expect(result1[0].status).toBe('success');
    expect(result2[0].status).toBe('success');

    const rows1 = subsplashMock.getListRows(listId1);
    const rows2 = subsplashMock.getListRows(listId2);
    
    expect(rows1.length).toBe(1);
    expect(rows2.length).toBe(1);
    expect(rows1[0]._embedded['media-item']?.id).toBe('item-1');
    expect(rows2[0]._embedded['media-item']?.id).toBe('item-2');
  });

  it('should handle concurrent adds with network delays', async () => {
    const listId = 'concurrentAccess-delayed-list';
    subsplashMock.createList(listId, 'Delayed Test List');

    // Create Firestore document for the list
    await createListDocument({
      subsplashId: listId,
      title: 'Delayed Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    // Verify document exists before starting concurrent operations
    const verifyDoc = await firestoreDB
      .collection('lists')
      .where('subsplashId', '==', listId)
      .limit(1)
      .get();
    expect(verifyDoc.empty).toBe(false);

    // Note: Network delays are handled by the axios mock in mocks.ts
    // Firestore emulator handles transaction retries automatically
    // even when network calls take different amounts of time

    const items = [
      { id: 'delayed-item-1', type: 'media-item' as const },
      { id: 'delayed-item-2', type: 'media-item' as const }
    ];

    const requests: TestRequest[] = items.map(item => ({
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: item, maxListSize: 10 }
    }));

    const results = await Promise.all(
      requests.map(req => addToListHandler(req))
    );

    results.forEach((result, index) => {
      if (result[0].status === 'error') {
        console.error(`Delayed result ${index} error:`, result[0].error);
      }
      expect(result[0].status).toBe('success');
    });

    const rows = subsplashMock.getListRows(listId);
    expect(rows.length).toBe(2);
    
    const itemIds = rows.map(r => r._embedded['media-item']?.id);
    expect(itemIds).toContain('delayed-item-1');
    expect(itemIds).toContain('delayed-item-2');
  });

  it('should replay duplicate operation keys without repeating write work', async () => {
    const listId = 'concurrentAccess-op-key-replay';
    const mediaItem = { id: 'item-op-key', type: 'media-item' as const };
    subsplashMock.createList(listId, 'Operation Key Replay List');

    await createListDocument({
      subsplashId: listId,
      title: 'Operation Key Replay List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem,
        maxListSize: 10,
        operationKey: 'add-list-replay-1',
      } as TestRequest['data'] & { operationKey: string },
    };

    axiosMock.mockClear();
    const firstResult = await addToListHandler(request);
    const callCountAfterFirst = axiosMock.mock.calls.length;
    const secondResult = await addToListHandler(request);

    expect(firstResult[0].status).toBe('success');
    expect(secondResult).toEqual(firstResult);
    expect(axiosMock.mock.calls.length).toBe(callCountAfterFirst);
  });
});
