import { OverflowBehavior } from '../../../../types/List';
import { SubsplashListRow, SubsplashPatchPayload } from '../../types/Subsplash';
import { 
  subsplashMock,
  TestRequest,
  AddToListHandler
} from './mocks';
import { createListDocument, clearFirestore } from './firestoreHelpers';
import addToList from '../../addToList';

const addToListHandler = addToList as unknown as AddToListHandler;

describe('addToList - Basic Functionality (Real Firestore Emulator)', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashMock.reset();
    subsplashMock.maxListSize = 10; // Set to 10 for testing
  });

  it('should add item to empty list', async () => {
    const listId = 'basic-test-list-1';
    subsplashMock.createList(listId, 'Test List');
    
    // Create Firestore document for the list
    await createListDocument({
      subsplashId: listId,
      title: 'Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });
    const mediaItem = { id: 'media-1', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');
    if (result[0].status === 'success') {
      expect(result[0].listItemId).toBeDefined();
      expect(typeof result[0].listItemId).toBe('string');
      
      // Verify the listItemId matches the actual row ID
      const rows = subsplashMock.getListRows(listId);
      expect(rows).toHaveLength(1);
      expect(rows[0]._embedded['media-item']?.id).toBe('media-1');
      expect(rows[0].id).toBe(result[0].listItemId);
    }
  });

  it('should handle overflow by creating new list and linking', async () => {
    const listId = 'basic-full-list';
    subsplashMock.createList(listId, 'Full List', 10);
    const initialRows = Array.from({ length: 10 }, (_, i) => ({
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

    const mediaItem = { id: 'new-item', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');
    
    const updatedOriginalRows = subsplashMock.getListRows(listId);
    expect(updatedOriginalRows).toHaveLength(10);
    expect(updatedOriginalRows[0]._embedded['media-item']?.id).toBe('new-item');
    
    if (result[0].status === 'success') {
      // Verify listItemId is returned for the newly added item
      expect(result[0].listItemId).toBeDefined();
      expect(typeof result[0].listItemId).toBe('string');
      // Verify the listItemId matches the row at position 1
      expect(updatedOriginalRows[0].id).toBe(result[0].listItemId);
    }
    
    const lastRow = updatedOriginalRows[9];
    expect(lastRow.type).toBe('list');
    
    const newListId = lastRow._embedded['list']?.id;
    expect(newListId).toBeDefined();
    
    const newListRows = subsplashMock.getListRows(newListId!);
    expect(newListRows).toHaveLength(2);
    expect(newListRows[0]._embedded['media-item']?.id).toBe('item-8');
    expect(newListRows[1]._embedded['media-item']?.id).toBe('item-9');
  });

  it('should propagate overflow down multiple lists in chain', async () => {
    const listA = 'basic-list-a';
    const listB = 'basic-list-b';
    
    subsplashMock.createList(listA, 'List A', 10);
    subsplashMock.createList(listB, 'List B', 10);
    
    const rowsA: SubsplashListRow[] = Array.from({ length: 9 }, (_, i) => ({
      id: `a-row-${i}`,
      app_key: '9XTSHD',
      method: 'static',
      position: i + 1,
      type: 'media-item',
      _embedded: { 'source-list': { id: listA }, 'media-item': { id: `a-item-${i}` } }
    }));
    rowsA.push({
      id: 'a-link',
      app_key: '9XTSHD',
      method: 'static',
      position: 10,
      type: 'list',
      _embedded: { 'source-list': { id: listA }, 'list': { id: listB } }
    });
    subsplashMock.listRows.set(listA, rowsA);
    
    const rowsB: SubsplashListRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `b-row-${i}`,
      app_key: '9XTSHD',
      method: 'static',
      position: i + 1,
      type: 'media-item',
      _embedded: { 'source-list': { id: listB }, 'media-item': { id: `b-item-${i}` } }
    }));
    subsplashMock.listRows.set(listB, rowsB);
    
    // Create Firestore documents
    await createListDocument({
      subsplashId: listA,
      title: 'List A',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: listB,
    });
    await createListDocument({
      subsplashId: listB,
      title: 'List B',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    const mediaItem = { id: 'new-item-a', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listA],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    expect(result[0].status).toBe('success');
    
    const updatedA = subsplashMock.getListRows(listA);
    expect(updatedA).toHaveLength(10);
    expect(updatedA[0]._embedded['media-item']?.id).toBe('new-item-a');
    expect(updatedA[9].type).toBe('list');
    expect(updatedA[9]._embedded.list?.id).toBe(listB);
    
    const updatedB = subsplashMock.getListRows(listB);
    expect(updatedB).toHaveLength(10);
    expect(updatedB[0]._embedded['media-item']?.id).toBe('a-item-8');
    expect(updatedB[9].type).toBe('list');
    
    const listCId = updatedB[9]._embedded.list?.id;
    expect(listCId).toBeDefined();
    
    const updatedC = subsplashMock.getListRows(listCId!);
    expect(updatedC).toHaveLength(2);
    expect(updatedC[0]._embedded['media-item']?.id).toBe('b-item-8');
    expect(updatedC[1]._embedded['media-item']?.id).toBe('b-item-9');
  });

  it('should handle overflow when both main and overflow lists are at 10', async () => {
    const listA = 'basic-list-a-2';
    const listB = 'basic-list-b-2';
    
    subsplashMock.createList(listA, 'List A', 10);
    subsplashMock.createList(listB, 'List B', 10);
    
    const rowsA: SubsplashListRow[] = Array.from({ length: 9 }, (_, i) => ({
      id: `a-row-${i}`,
      app_key: '9XTSHD',
      method: 'static',
      position: i + 1,
      type: 'media-item',
      _embedded: { 'source-list': { id: listA }, 'media-item': { id: `a-item-${i}` } }
    }));
    rowsA.push({
      id: 'a-link',
      app_key: '9XTSHD',
      method: 'static',
      position: 10,
      type: 'list',
      _embedded: { 'source-list': { id: listA }, 'list': { id: listB } }
    });
    subsplashMock.listRows.set(listA, rowsA);
    
    const rowsB: SubsplashListRow[] = Array.from({ length: 9 }, (_, i) => ({
      id: `b-row-${i}`,
      app_key: '9XTSHD',
      method: 'static',
      position: i + 1,
      type: 'media-item',
      _embedded: { 'source-list': { id: listB }, 'media-item': { id: `b-item-${i}` } }
    }));
    rowsB.push({
      id: 'b-link',
      app_key: '9XTSHD',
      method: 'static',
      position: 10,
      type: 'list',
      _embedded: { 'source-list': { id: listB }, 'list': { id: 'list-c-placeholder' } }
    });
    subsplashMock.listRows.set(listB, rowsB);
    
    // Create Firestore documents
    await createListDocument({
      subsplashId: listA,
      title: 'List A',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: listB,
    });
    await createListDocument({
      subsplashId: listB,
      title: 'List B',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    const mediaItem = { id: 'new-item', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listA],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    expect(result[0].status).toBe('success');
    
    const updatedA = subsplashMock.getListRows(listA);
    expect(updatedA).toHaveLength(10);
    expect(updatedA[0]._embedded['media-item']?.id).toBe('new-item');
    expect(updatedA[9].type).toBe('list');
    
    const updatedB = subsplashMock.getListRows(listB);
    expect(updatedB).toHaveLength(10);
    expect(updatedB[0]._embedded['media-item']?.id).toBe('a-item-8');
    expect(updatedB[9].type).toBe('list');
    
    const listCId = updatedB[9]._embedded.list?.id;
    expect(listCId).toBeDefined();
    expect(listCId).not.toBe('list-c-placeholder');
    
    const updatedC = subsplashMock.getListRows(listCId!);
    expect(updatedC.length).toBeLessThanOrEqual(10);
    expect(updatedC[0]._embedded['media-item']?.id).toBe('b-item-8');
  });

  it('should never attempt to patch with more than 10 items', async () => {
    const listId = 'basic-max-size-list';
    subsplashMock.createList(listId, 'Max Size Test List', 10);
    
    // Create exactly 10 items (all content, no link)
    const rows: SubsplashListRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `row-${i}`,
      app_key: '9XTSHD',
      method: 'static',
      position: i + 1,
      type: 'media-item',
      _embedded: { 'source-list': { id: listId }, 'media-item': { id: `item-${i}` } }
    }));
    subsplashMock.listRows.set(listId, rows);
    
    // Create Firestore document for the list
    await createListDocument({
      subsplashId: listId,
      title: 'Max Size Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 10,
    });
    
    // Spy on patchList to verify it's never called with >10 items
    const patchListSpy = jest.spyOn(subsplashMock, 'patchList');
    
    const mediaItem = { id: 'new-item', type: 'media-item' as const };
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
    
    // Verify patchList was never called with more than 10 items
    const patchCalls = patchListSpy.mock.calls;
    expect(patchCalls.length).toBeGreaterThan(0);
    
    for (const call of patchCalls) {
      const payload = call[1] as SubsplashPatchPayload;
      const rowCount = payload._embedded['list-rows'].length;
      expect(rowCount).toBeLessThanOrEqual(10);
      expect(rowCount).toBeGreaterThan(0);
    }
    
    // Verify final state: list should have exactly 10 items (9 content + 1 link)
    const finalRows = subsplashMock.getListRows(listId);
    expect(finalRows).toHaveLength(10);
    expect(finalRows[0]._embedded['media-item']?.id).toBe('new-item');
    expect(finalRows[9].type).toBe('list'); // Last item should be link
    
    patchListSpy.mockRestore();
  });

  it('should never exceed 10 items in any list during propagation', async () => {
    const listA = 'basic-list-a-3';
    const listB = 'basic-list-b-3';
    const listC = 'basic-list-c-3';
    
    subsplashMock.createList(listA, 'List A', 10);
    subsplashMock.createList(listB, 'List B', 10);
    subsplashMock.createList(listC, 'List C', 10);
    
    const setupList = (id: string, prefix: string, nextId?: string) => {
      const rows: SubsplashListRow[] = Array.from({ length: nextId ? 9 : 10 }, (_, i) => ({
        id: `${prefix}-row-${i}`,
        app_key: '9XTSHD',
        method: 'static',
        position: i + 1,
        type: 'media-item',
        _embedded: { 'source-list': { id }, 'media-item': { id: `${prefix}-item-${i}` } }
      }));
      if (nextId) {
        rows.push({
          id: `${prefix}-link`,
          app_key: '9XTSHD',
          method: 'static',
          position: 10,
          type: 'list',
          _embedded: { 'source-list': { id }, 'list': { id: nextId } }
        });
      }
      subsplashMock.listRows.set(id, rows);
    };
    
    setupList(listA, 'a', listB);
    setupList(listB, 'b', listC);
    setupList(listC, 'c');
    
    // Create Firestore documents
    await createListDocument({
      subsplashId: listA,
      title: 'List A',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: listB,
    });
    await createListDocument({
      subsplashId: listB,
      title: 'List B',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: listC,
    });
    await createListDocument({
      subsplashId: listC,
      title: 'List C',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    const mediaItem = { id: 'new-item', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listA],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    expect(result[0].status).toBe('success');
    
    const finalA = subsplashMock.getListRows(listA);
    const finalB = subsplashMock.getListRows(listB);
    const finalC = subsplashMock.getListRows(listC);
    
    expect(finalA.length).toBeLessThanOrEqual(10);
    expect(finalB.length).toBeLessThanOrEqual(10);
    expect(finalC.length).toBeLessThanOrEqual(10);
    
    expect(finalA[0]._embedded['media-item']?.id).toBe('new-item');
    
    expect(finalB.length).toBeGreaterThan(0);
    expect(finalC.length).toBeGreaterThan(0);
  });

  it('should always place new items at top and overflow list links at bottom', async () => {
    const listId = 'basic-ordering-test';
    subsplashMock.createList(listId, 'Ordering Test List', 0);
    
    // Create Firestore document for the list
    await createListDocument({
      subsplashId: listId,
      title: 'Ordering Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 0,
    });

    // Add first item
    const item1 = { id: 'item-1', type: 'media-item' as const };
    const request1: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: item1, maxListSize: 10 }
    };
    await addToListHandler(request1);
    
    let rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(1);
    expect(rows[0]._embedded['media-item']?.id).toBe('item-1');
    expect(rows[0].position).toBe(1);
    
    // Add second item - should go to top
    const item2 = { id: 'item-2', type: 'media-item' as const };
    const request2: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: item2, maxListSize: 10 }
    };
    await addToListHandler(request2);
    
    rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(2);
    expect(rows[0]._embedded['media-item']?.id).toBe('item-2'); // New item at top
    expect(rows[0].position).toBe(1);
    expect(rows[1]._embedded['media-item']?.id).toBe('item-1'); // Old item pushed down
    expect(rows[1].position).toBe(2);
    
    // Add third item - should go to top
    const item3 = { id: 'item-3', type: 'media-item' as const };
    const request3: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: item3, maxListSize: 10 }
    };
    await addToListHandler(request3);
    
    rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(3);
    expect(rows[0]._embedded['media-item']?.id).toBe('item-3'); // Newest at top
    expect(rows[1]._embedded['media-item']?.id).toBe('item-2');
    expect(rows[2]._embedded['media-item']?.id).toBe('item-1'); // Oldest at bottom
    
    // Now fill the list to trigger overflow
    // We need 7 more items to reach 10 (3 + 7 = 10)
    for (let i = 4; i <= 10; i++) {
      const item = { id: `item-${i}`, type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: { destinationListIds: [listId], mediaItem: item, maxListSize: 10 }
      };
      await addToListHandler(request);
    }
    
    rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(10);
    // Verify newest item is at top
    expect(rows[0]._embedded['media-item']?.id).toBe('item-10');
    // Verify second-to-last item is item-2
    expect(rows[8]._embedded['media-item']?.id).toBe('item-2');
    // Verify oldest item is at position 10 (no link yet - link only appears after overflow)
    expect(rows[9]._embedded['media-item']?.id).toBe('item-1');
    // No link at this point - we have exactly 10 items, no overflow yet
    
    // Add one more item to trigger overflow
    const overflowItem = { id: 'overflow-item', type: 'media-item' as const };
    const overflowRequest: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: overflowItem, maxListSize: 10 }
    };
    await addToListHandler(overflowRequest);
    
    rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(10);
    // Verify newest item is at top
    expect(rows[0]._embedded['media-item']?.id).toBe('overflow-item');
    // Verify link is still at bottom
    expect(rows[9].type).toBe('list');
    expect(rows[9].position).toBe(10);
    
    // Verify overflow list was created and has the overflowed items
    const overflowListId = rows[9]._embedded.list?.id;
    expect(overflowListId).toBeDefined();
    
    const overflowRows = subsplashMock.getListRows(overflowListId!);
    expect(overflowRows.length).toBeGreaterThan(0);
    // Verify overflow list also has newest items at top
    // The overflowed items should be item-1 and item-2 (the oldest ones)
    const overflowItemIds = overflowRows
      .filter(r => r.type === 'media-item')
      .map(r => r._embedded['media-item']?.id);
    expect(overflowItemIds).toContain('item-1');
    expect(overflowItemIds).toContain('item-2');
    
    // Add another item to the original list
    const anotherItem = { id: 'another-item', type: 'media-item' as const };
    const anotherRequest: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: { destinationListIds: [listId], mediaItem: anotherItem, maxListSize: 10 }
    };
    await addToListHandler(anotherRequest);
    
    rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(10);
    // Verify newest item is at top
    expect(rows[0]._embedded['media-item']?.id).toBe('another-item');
    // Verify link is still at bottom
    expect(rows[9].type).toBe('list');
    expect(rows[9].position).toBe(10);
    
    // Verify no link rows appear in the middle of the list
    const allLinks = rows.filter(r => r.type === 'list');
    expect(allLinks).toHaveLength(1);
    expect(allLinks[0].position).toBe(10); // Only one link, at the bottom
  });

  describe('listItemId functionality', () => {
    it('should return listItemId for newly added item', async () => {
      const listId = 'listitemid-test-1';
      subsplashMock.createList(listId, 'Test List');
      
      await createListDocument({
        subsplashId: listId,
        title: 'Test List',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
      });
      
      const mediaItem = { id: 'new-item-1', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem,
          maxListSize: 10
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      if (result[0].status === 'success') {
        expect(result[0].listItemId).toBeDefined();
        expect(typeof result[0].listItemId).toBe('string');
        expect(result[0].listItemId!.length).toBeGreaterThan(0);
        
        // Verify the listItemId matches the actual row in Subsplash
        const rows = subsplashMock.getListRows(listId);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(result[0].listItemId);
        expect(rows[0]._embedded['media-item']?.id).toBe('new-item-1');
        expect(rows[0].position).toBe(1);
      }
    });

    it('should return existing listItemId when item already exists', async () => {
      const listId = 'listitemid-test-2';
      subsplashMock.createList(listId, 'Test List');
      
      // Create a list with an existing item
      const existingRow: SubsplashListRow = {
        id: 'existing-row-id-123',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: listId },
          'media-item': { id: 'existing-item' }
        }
      };
      subsplashMock.listRows.set(listId, [existingRow]);
      
      await createListDocument({
        subsplashId: listId,
        title: 'Test List',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
        count: 1,
      });
      
      // Try to add the same item again
      const mediaItem = { id: 'existing-item', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem,
          maxListSize: 10
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      if (result[0].status === 'success') {
        // Should return the existing listItemId
        expect(result[0].listItemId).toBe('existing-row-id-123');
        
        // Verify the list still has only one item
        const rows = subsplashMock.getListRows(listId);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('existing-row-id-123');
      }
    });

    it('should return different listItemIds for multiple lists', async () => {
      const listId1 = 'listitemid-test-3a';
      const listId2 = 'listitemid-test-3b';
      
      subsplashMock.createList(listId1, 'Test List 1');
      subsplashMock.createList(listId2, 'Test List 2');
      
      await createListDocument({
        subsplashId: listId1,
        title: 'Test List 1',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
      });
      await createListDocument({
        subsplashId: listId2,
        title: 'Test List 2',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
      });
      
      const mediaItem = { id: 'shared-item', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId1, listId2],
          mediaItem
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('success');
      expect(result[1].status).toBe('success');
      
      if (result[0].status === 'success' && result[1].status === 'success') {
        // Each list should have its own listItemId
        expect(result[0].listItemId).toBeDefined();
        expect(result[1].listItemId).toBeDefined();
        expect(result[0].listItemId).not.toBe(result[1].listItemId);
        
        // Verify the listItemIds match the actual rows
        const rows1 = subsplashMock.getListRows(listId1);
        const rows2 = subsplashMock.getListRows(listId2);
        
        expect(rows1[0].id).toBe(result[0].listItemId);
        expect(rows2[0].id).toBe(result[1].listItemId);
      }
    });

    it('should not return listItemId on error', async () => {
      const listId = 'listitemid-test-4';
      // Don't create the list in Firestore - this should cause an error
      
      const mediaItem = { id: 'item-1', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('error');
      if (result[0].status === 'error') {
        expect(result[0].error).toBeDefined();
        // Error responses should not have listItemId (it's not in the type, but verify)
        expect('listItemId' in result[0]).toBe(false);
      }
    });

    it('should return listItemId for original list even when overflow occurs', async () => {
      const listId = 'listitemid-test-5';
      subsplashMock.createList(listId, 'Full List', 10);
      
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
        title: 'Full List',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
        count: 10,
      });
      
      const mediaItem = { id: 'overflow-trigger-item', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem,
          maxListSize: 10
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      if (result[0].status === 'success') {
        // Should return listItemId for the item in the original list (position 1)
        expect(result[0].listItemId).toBeDefined();
        
        const rows = subsplashMock.getListRows(listId);
        expect(rows).toHaveLength(10);
        // The new item should be at position 1
        expect(rows[0]._embedded['media-item']?.id).toBe('overflow-trigger-item');
        expect(rows[0].id).toBe(result[0].listItemId);
      }
    });

    it('should handle listItemId when item exists in overflow list', async () => {
      const listId = 'listitemid-test-6';
      const overflowListId = 'listitemid-test-6-overflow';
      
      subsplashMock.createList(listId, 'Main List', 10);
      subsplashMock.createList(overflowListId, 'Overflow List', 0);
      
      // Create main list with 9 items + 1 link
      const mainRows: SubsplashListRow[] = Array.from({ length: 9 }, (_, i) => ({
        id: `main-row-${i}`,
        app_key: '9XTSHD',
        method: 'static' as const,
        position: i + 1,
        type: 'media-item' as const,
        _embedded: { 
          'source-list': { id: listId },
          'media-item': { id: `item-${i}` } 
        }
      }));
      mainRows.push({
        id: 'main-link',
        app_key: '9XTSHD',
        method: 'static' as const,
        position: 10,
        type: 'list' as const,
        _embedded: { 
          'source-list': { id: listId },
          'list': { id: overflowListId }
        }
      });
      subsplashMock.listRows.set(listId, mainRows);
      
      // Create overflow list with an existing item
      const overflowRow: SubsplashListRow = {
        id: 'overflow-row-existing',
        app_key: '9XTSHD',
        method: 'static',
        position: 1,
        type: 'media-item',
        _embedded: {
          'source-list': { id: overflowListId },
          'media-item': { id: 'existing-in-overflow' }
        }
      };
      subsplashMock.listRows.set(overflowListId, [overflowRow]);
      
      await createListDocument({
        subsplashId: listId,
        title: 'Main List',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
        moreSermonsRef: overflowListId,
        count: 10,
      });
      await createListDocument({
        subsplashId: overflowListId,
        title: 'Overflow List',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
        count: 1,
        isMoreSermonsList: true,
      });
      
      // Try to add item that already exists in overflow list
      const mediaItem = { id: 'existing-in-overflow', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem,
          maxListSize: 10
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      if (result[0].status === 'success') {
        // Should return the listItemId from the main list (where it was added)
        // The item should be added to the main list first, then overflow logic handles it
        expect(result[0].listItemId).toBeDefined();
        
        // The item should be in the main list at position 1
        const mainListRows = subsplashMock.getListRows(listId);
        const addedRow = mainListRows.find(r => 
          r._embedded['media-item']?.id === 'existing-in-overflow'
        );
        // The item might have been moved to overflow, so we check if it exists
        // If it's still in main list, verify the ID matches
        if (addedRow) {
          expect(addedRow.id).toBe(result[0].listItemId);
        }
      }
    });

    it('should return listItemId for each list in parallel processing', async () => {
      const listIds = ['listitemid-test-7a', 'listitemid-test-7b', 'listitemid-test-7c'];
      
      listIds.forEach(id => {
        subsplashMock.createList(id, `Test List ${id}`);
      });
      
      await Promise.all(listIds.map(id => 
        createListDocument({
          subsplashId: id,
          title: `Test List ${id}`,
          overflowBehavior: OverflowBehavior.CREATENEWLIST,
        })
      ));
      
      const mediaItem = { id: 'parallel-item', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: listIds,
          mediaItem,
          maxListSize: 10
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(3);
      result.forEach((r, index) => {
        expect(r.status).toBe('success');
        if (r.status === 'success') {
          expect(r.listId).toBe(listIds[index]);
          expect(r.listItemId).toBeDefined();
          
          // Verify each listItemId is unique
          const otherResults = result.filter((other, otherIndex) => 
            otherIndex !== index && other.status === 'success'
          );
          otherResults.forEach(other => {
            if (other.status === 'success') {
              expect(r.listItemId).not.toBe(other.listItemId);
            }
          });
          
          // Verify the listItemId matches the actual row
          const rows = subsplashMock.getListRows(listIds[index]);
          expect(rows[0].id).toBe(r.listItemId);
        }
      });
    });

    it('should handle case where listItemId might be undefined gracefully', async () => {
      const listId = 'listitemid-test-edge';
      subsplashMock.createList(listId, 'Edge Case Test');
      
      await createListDocument({
        subsplashId: listId,
        title: 'Edge Case Test',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
      });
      
      // Add an item normally
      const mediaItem = { id: 'normal-item', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem
        }
      };
      
      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      
      // In normal cases, listItemId should be defined
      // But the type allows it to be optional, so we verify the structure is correct
      if (result[0].status === 'success') {
        // listItemId should be defined in normal operation
        // If it's undefined, that's an edge case we want to know about
        expect(result[0].listItemId).toBeDefined();
      }
    });

    it('should return listItemId even when multiple items are added sequentially', async () => {
      const listId = 'listitemid-test-sequential';
      subsplashMock.createList(listId, 'Sequential Test');
      
      await createListDocument({
        subsplashId: listId,
        title: 'Sequential Test',
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
      });
      
      const items = [
        { id: 'seq-item-1', type: 'media-item' as const },
        { id: 'seq-item-2', type: 'media-item' as const },
        { id: 'seq-item-3', type: 'media-item' as const },
      ];
      
      const results: Array<{ listItemId?: string }> = [];
      
      for (const item of items) {
        const request: TestRequest = {
          auth: { token: { role: 'admin' } },
          data: {
            destinationListIds: [listId],
            mediaItem: item
          }
        };
        
        const result = await addToListHandler(request);
        expect(result[0].status).toBe('success');
        if (result[0].status === 'success') {
          results.push({ listItemId: result[0].listItemId });
        }
      }
      
      // Each sequential add should return a listItemId
      expect(results).toHaveLength(3);
      
      // After all adds, the newest item should be at position 1
      const finalRows = subsplashMock.getListRows(listId);
      expect(finalRows[0]._embedded['media-item']?.id).toBe('seq-item-3'); // Last added
      
      // The last result's listItemId should match the row at position 1
      expect(results[2].listItemId).toBeDefined();
      expect(finalRows[0].id).toBe(results[2].listItemId);
      
      // All results should have listItemIds
      results.forEach((r) => {
        expect(r.listItemId).toBeDefined();
      });
    });
  });

  describe('REMOVEOLDEST overflow behavior (latest list functionality)', () => {
    it('should add item to top of list when list is not at max length', async () => {
      const listId = 'removeoldest-not-full';
      subsplashMock.createList(listId, 'Latest List');
      
      // Create a list with 2 items (not at max length of 4)
      const initialRows: SubsplashListRow[] = [
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
        }
      ];
      subsplashMock.listRows.set(listId, initialRows);
      
      // Create Firestore document with REMOVEOLDEST behavior
      await createListDocument({
        subsplashId: listId,
        title: 'Latest List',
        overflowBehavior: OverflowBehavior.REMOVEOLDEST,
        count: 2,
      });
      
      const mediaItem = { id: 'new-item', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem,
          maxListSize: 4
        }
      };

      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      if (result[0].status === 'success') {
        expect(result[0].listItemId).toBeDefined();
      }
      
      // Verify the item was added at the top
      const rows = subsplashMock.getListRows(listId);
      expect(rows).toHaveLength(3); // 2 existing + 1 new
      
      // New item should be at position 1 (top)
      expect(rows[0]._embedded['media-item']?.id).toBe('new-item');
      expect(rows[0].position).toBe(1);
      if (result[0].status === 'success') {
        expect(rows[0].id).toBe(result[0].listItemId);
      }
      
      // Previous top item should be at position 2
      expect(rows[1]._embedded['media-item']?.id).toBe('item-1');
      expect(rows[1].position).toBe(2);
      
      // Previous second item should be at position 3
      expect(rows[2]._embedded['media-item']?.id).toBe('item-2');
      expect(rows[2].position).toBe(3);
    });

    it('should remove bottom item and add new item to top when list is at max length', async () => {
      const listId = 'removeoldest-full';
      subsplashMock.createList(listId, 'Full Latest List');
      
      // Create a list with 4 items (at max length of 4)
      const initialRows: SubsplashListRow[] = [
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
        },
        {
          id: 'row-4',
          app_key: '9XTSHD',
          method: 'static',
          position: 4,
          type: 'media-item',
          _embedded: { 
            'source-list': { id: listId },
            'media-item': { id: 'item-4' } 
          }
        }
      ];
      subsplashMock.listRows.set(listId, initialRows);
      
      // Create Firestore document with REMOVEOLDEST behavior
      await createListDocument({
        subsplashId: listId,
        title: 'Full Latest List',
        overflowBehavior: OverflowBehavior.REMOVEOLDEST,
        count: 4,
      });
      
      const mediaItem = { id: 'new-item', type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [listId],
          mediaItem,
          maxListSize: 4
        }
      };

      const result = await addToListHandler(request);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
      if (result[0].status === 'success') {
        expect(result[0].listItemId).toBeDefined();
      }
      
      // Verify the list still has 4 items (max length)
      const rows = subsplashMock.getListRows(listId);
      expect(rows).toHaveLength(4);
      
      // New item should be at position 1 (top)
      expect(rows[0]._embedded['media-item']?.id).toBe('new-item');
      expect(rows[0].position).toBe(1);
      if (result[0].status === 'success') {
        expect(rows[0].id).toBe(result[0].listItemId);
      }
      
      // Previous items should shift down
      expect(rows[1]._embedded['media-item']?.id).toBe('item-1');
      expect(rows[1].position).toBe(2);
      
      expect(rows[2]._embedded['media-item']?.id).toBe('item-2');
      expect(rows[2].position).toBe(3);
      
      expect(rows[3]._embedded['media-item']?.id).toBe('item-3');
      expect(rows[3].position).toBe(4);
      
      // Bottom item (item-4) should be removed
      const item4Row = rows.find(r => r._embedded['media-item']?.id === 'item-4');
      expect(item4Row).toBeUndefined();
    });
  });
});
