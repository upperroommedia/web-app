/**
 * Test to verify the transaction retry duplication bug
 * 
 * BUG: itemsToPropagateAfterCommit is declared outside the transaction callback
 * but populated inside it. When Firestore transactions retry, the array is not
 * reset, causing duplicate items to be propagated to overflow lists.
 * 
 * NOTE: This test requires the Firestore emulator. Run with:
 *   pnpm test transactionRetryDuplication
 * NOT with:
 *   pnpm test:unit transactionRetryDuplication
 */

import { OverflowBehavior } from '../../../../types/List';
import { 
  subsplashMock, 
  TestRequest,
  AddToListHandler
} from './mocks';
import { createListDocument, clearFirestore } from './firestoreHelpers';
import addToList from '../../addToList';
import { SubsplashListRow } from '../../types/Subsplash';
import axios from 'axios';

const addToListHandler = addToList as unknown as AddToListHandler;
const axiosMock = axios as unknown as jest.Mock;

describe('addToList - Transaction Retry Duplication Bug', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashMock.reset();
    subsplashMock.maxListSize = 10; // Set to 10 for testing
  });

  it('should NOT duplicate items in overflow list when transaction retries', async () => {
    // Setup: Create a full list (200 items) that will overflow
    const listId = 'retry-duplication-full-list';
    subsplashMock.createList(listId, 'Full List', 10);
    
    // Create 10 initial rows in Subsplash mock
    const initialRows: SubsplashListRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `row-${i}`,
      app_key: '9XTSHD',
      method: 'static' as const,
      position: i + 1,
      type: 'media-item' as const,
      _embedded: { 
        'source-list': { id: listId },
        'media-item': { id: `item-${i}` } 
      }
    }));
    subsplashMock.listRows.set(listId, initialRows);

    // Create Firestore document for the list
    await createListDocument({
      subsplashId: listId,
      title: 'Full List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 10,
    });

    // Add one more item to trigger overflow
    // This will cause overflow and create a new overflow list
    const mediaItem = { id: 'new-item-trigger-overflow', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    expect(result[0].status).toBe('success');
    
    // Verify the overflow list was created
    const originalRows = subsplashMock.getListRows(listId);
    const linkRow = originalRows.find(r => r.type === 'list');
    expect(linkRow).toBeDefined();
    const overflowListId = linkRow!._embedded.list?.id;
    expect(overflowListId).toBeDefined();
    
    // Get overflow list rows
    const overflowRows = subsplashMock.getListRows(overflowListId!);
    
    // Count unique item IDs in overflow list
    const itemIds = overflowRows
      .filter(r => r.type === 'media-item')
      .map(r => r._embedded['media-item']?.id)
      .filter((id): id is string => id !== undefined);
    
    const uniqueItemIds = new Set(itemIds);
    
    // BUG VERIFICATION: If the bug exists, we'll have duplicates
    // When a list with 10 items gets one more item added:
    // - New item goes to position 1
    // - Original items shift: item-0 to position 2, ..., item-9 to position 11
    // - We keep top 9 content items: new item + items 0-7
    // - Items that overflow: item-8 and item-9 (positions 10-11)
    // So 2 items should overflow, not 1
    console.log(`Overflow list has ${itemIds.length} items, ${uniqueItemIds.size} unique`);
    console.log('Item IDs:', itemIds);
    
    // This test verifies no duplicates from transaction retries
    // We expect exactly 2 items in overflow (item-8 and item-9)
    // If transaction retried and bug exists, we'd have MORE than 2 items (duplicates)
    expect(itemIds.length).toBe(uniqueItemIds.size); // No duplicates
    expect(uniqueItemIds.size).toBe(2); // Exactly two items should overflow (item-8 and item-9)
  });

  it('should handle concurrent overflow operations without duplicating items', async () => {
    // This test forces transaction retries by making concurrent requests
    // that both trigger overflow on the same list
    
    const listId = 'retry-duplication-concurrent-overflow';
    subsplashMock.createList(listId, 'Concurrent Overflow List', 10);
    
    // Create 9 initial rows (one less than max to allow two items to be added)
    const initialRows: SubsplashListRow[] = Array.from({ length: 9 }, (_, i) => ({
      id: `row-${i}`,
      app_key: '9XTSHD',
      method: 'static' as const,
      position: i + 1,
      type: 'media-item' as const,
      _embedded: { 
        'source-list': { id: listId },
        'media-item': { id: `item-${i}` } 
      }
    }));
    subsplashMock.listRows.set(listId, initialRows);

    await createListDocument({
      subsplashId: listId,
      title: 'Concurrent Overflow List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 9,
    });

    // Add two items concurrently - both will trigger overflow
    // This will cause transaction conflicts and retries
    const item1 = { id: 'concurrent-overflow-item-1', type: 'media-item' as const };
    const item2 = { id: 'concurrent-overflow-item-2', type: 'media-item' as const };

    const request1: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: item1, maxListSize: 10 }
    };

    const request2: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: item2, maxListSize: 10 }
    };

    // Concurrent requests will cause transaction retries
    // Start both requests at nearly the same time to maximize conflict probability
    const [result1, result2] = await Promise.all([
      addToListHandler(request1),
      addToListHandler(request2)
    ]);

    expect(result1[0].status).toBe('success');
    expect(result2[0].status).toBe('success');

    // Verify overflow list was created
    const originalRows = subsplashMock.getListRows(listId);
    const linkRow = originalRows.find(r => r.type === 'list');
    expect(linkRow).toBeDefined();
    const overflowListId = linkRow!._embedded.list?.id;
    expect(overflowListId).toBeDefined();
    
    // Get overflow list rows
    const overflowRows = subsplashMock.getListRows(overflowListId!);
    
    // Count unique item IDs
    const itemIds = overflowRows
      .filter(r => r.type === 'media-item')
      .map(r => r._embedded['media-item']?.id)
      .filter((id): id is string => id !== undefined);
    
    const uniqueItemIds = new Set(itemIds);
    
    console.log(`Concurrent overflow: ${itemIds.length} items, ${uniqueItemIds.size} unique`);
    console.log('Item IDs:', itemIds);
    
    // BUG VERIFICATION: If the bug exists, we'll have duplicates
    // We expect at most 2 items in overflow (one from each concurrent operation)
    // But if transaction retried, we might have duplicates
    expect(itemIds.length).toBe(uniqueItemIds.size); // No duplicates
    expect(uniqueItemIds.size).toBeLessThanOrEqual(2); // At most 2 items
  });

  it('should NOT accumulate items when transaction retries multiple times', async () => {
    // This test specifically targets the bug: itemsToPropagateAfterCommit is declared
    // outside the transaction but populated inside it. If the transaction retries,
    // items accumulate in the array.
    // 
    // We force retries by making many concurrent requests to the same list
    
    const listId = 'retry-duplication-multiple-retries';
    subsplashMock.createList(listId, 'Multiple Retries List', 10);
    
    // Create 10 initial rows to trigger overflow on any addition
    const initialRows: SubsplashListRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `row-${i}`,
      app_key: '9XTSHD',
      method: 'static' as const,
      position: i + 1,
      type: 'media-item' as const,
      _embedded: { 
        'source-list': { id: listId },
        'media-item': { id: `item-${i}` } 
      }
    }));
    subsplashMock.listRows.set(listId, initialRows);

    await createListDocument({
      subsplashId: listId,
      title: 'Multiple Retries List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 10,
    });

    // Add one item - this will trigger overflow and create an overflow list
    // The transaction may retry due to conflicts, and if the bug exists,
    // items will accumulate in itemsToPropagateAfterCommit
    const mediaItem = { id: 'single-item-trigger-overflow', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    expect(result[0].status).toBe('success');
    
    // Verify the overflow list was created
    const originalRows = subsplashMock.getListRows(listId);
    const linkRow = originalRows.find(r => r.type === 'list');
    expect(linkRow).toBeDefined();
    const overflowListId = linkRow!._embedded.list?.id;
    expect(overflowListId).toBeDefined();
    
    // Get overflow list rows
    const overflowRows = subsplashMock.getListRows(overflowListId!);
    
    // Count unique item IDs in overflow list
    const itemIds = overflowRows
      .filter(r => r.type === 'media-item')
      .map(r => r._embedded['media-item']?.id)
      .filter((id): id is string => id !== undefined);
    
    const uniqueItemIds = new Set(itemIds);
    
    console.log(`Multiple retries test: ${itemIds.length} items, ${uniqueItemIds.size} unique`);
    console.log('Item IDs:', itemIds);
    
    // BUG VERIFICATION: 
    // When a list with 10 items gets one more item added:
    // - New item goes to position 1
    // - Original items shift: item-0 to position 2, ..., item-9 to position 11
    // - We keep top 9 content items: new item + items 0-7
    // - Items that overflow: item-8 and item-9 (positions 10-11)
    // So exactly 2 items should overflow
    // If the transaction retried and the bug exists, we'd have MORE than 2 items (duplicates)
    expect(itemIds.length).toBe(uniqueItemIds.size); // No duplicates
    expect(uniqueItemIds.size).toBe(2); // Exactly two items should overflow (item-8 and item-9)
    
    // Verify the specific items that should overflow
    expect(uniqueItemIds).toContain('item-8');
    expect(uniqueItemIds).toContain('item-9');
  });

  it('should replay overflow mutation result for duplicate operation keys', async () => {
    const listId = 'retry-duplication-op-key-replay';
    subsplashMock.createList(listId, 'Replay Duplication List', 10);

    const initialRows: SubsplashListRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `row-${i}`,
      app_key: '9XTSHD',
      method: 'static' as const,
      position: i + 1,
      type: 'media-item' as const,
      _embedded: {
        'source-list': { id: listId },
        'media-item': { id: `item-${i}` },
      },
    }));
    subsplashMock.listRows.set(listId, initialRows);

    await createListDocument({
      subsplashId: listId,
      title: 'Replay Duplication List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 10,
    });

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem: { id: 'replay-item', type: 'media-item' as const },
        maxListSize: 10,
        operationKey: 'duplication-replay-op-1',
      },
    };

    axiosMock.mockClear();
    const firstResult = await addToListHandler(request);
    const callCountAfterFirst = axiosMock.mock.calls.length;
    const secondResult = await addToListHandler(request);

    expect(firstResult).toEqual(secondResult);
    expect(axiosMock.mock.calls.length).toBe(callCountAfterFirst);
  });
});
