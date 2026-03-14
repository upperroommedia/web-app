/**
 * Integration test for transaction isolation bug
 * This test uses the real Firestore emulator to verify transaction isolation behavior
 * 
 * NOTE: This test does NOT use Firestore mocks - it uses the real emulator
 * The Subsplash API is still mocked via the mocks.ts file
 */

// Import Subsplash mocks (these mock the API, not Firestore)
import { 
  subsplashMock,
  TestRequest,
  AddToListHandler
} from './mocks';

// Import real Firestore (not mocked)
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { firestoreAdminListConverter } from '../../firestoreDataConverter';
import { OverflowBehavior } from '@upperroom/shared/types/List';
import { SubsplashListRow } from '../../types/Subsplash';
import { createListDocument, clearFirestore } from './firestoreHelpers';
import addToList from '../../addToList';

const addToListHandler = addToList as unknown as AddToListHandler;
const firestoreDB = firebaseAdmin.firestore();

describe('addToList - Transaction Isolation Bug (Real Firestore Emulator)', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashMock.reset();
    subsplashMock.maxListSize = 10; // Set to 10 for testing
  });

  it('should handle overflow list creation without transaction isolation error', async () => {
    // Setup: Create a full list (200 items) that will overflow
    const listId = 'transactionIsolation-full-list';
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
    const mediaItem = { id: 'new-item', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem,
        maxListSize: 10
      }
    };

    // This should NOT throw a "not found" error
    // The bug: recursive processListStep starts a new transaction that can't see
    // the uncommitted document created in the outer transaction
    const result = await addToListHandler(request);
    
    expect(result).toHaveLength(1);
    if (result[0].status === 'error') {
      console.log('ERROR:', result[0].error);
    }
    expect(result[0].status).toBe('success');
    
    // Verify listItemId is returned even when overflow occurs
    if (result[0].status === 'success') {
      expect(result[0].listItemId).toBeDefined();
      expect(typeof result[0].listItemId).toBe('string');
      
      // Verify the listItemId matches the row at position 1 in the original list
      const originalRows = subsplashMock.getListRows(listId);
      expect(originalRows[0].id).toBe(result[0].listItemId);
      expect(originalRows[0]._embedded['media-item']?.id).toBe('new-item');
    }
    
    // Verify the overflow list was created in Subsplash
    const allLists = Array.from(subsplashMock.lists.keys());
    expect(allLists.length).toBeGreaterThan(1); // Original + overflow list
    
    // Verify items were propagated to the overflow list
    const originalRows = subsplashMock.getListRows(listId);
    expect(originalRows.length).toBe(10); // Should have 9 items + 1 link
    
    // Find the overflow list
    const linkRow = originalRows.find(r => r.type === 'list');
    expect(linkRow).toBeDefined();
    const overflowListId = linkRow!._embedded.list?.id;
    expect(overflowListId).toBeDefined();
    
    // Verify overflow list has items
    const overflowRows = subsplashMock.getListRows(overflowListId!);
    expect(overflowRows.length).toBeGreaterThan(0);
    
    // Verify Firestore document was created for overflow list
    const overflowListQuery = firestoreDB
      .collection('lists')
      .where('subsplashId', '==', overflowListId!)
      .limit(1)
      .withConverter(firestoreAdminListConverter);
    
    const overflowListSnapshot = await overflowListQuery.get();
    expect(overflowListSnapshot.empty).toBe(false);
    
    const overflowListDoc = overflowListSnapshot.docs[0];
    const overflowListData = overflowListDoc.data();
    expect(overflowListData.subsplashId).toBe(overflowListId);
    expect(overflowListData.isMoreSermonsList).toBe(true);
  });

  it('should NOT fail with transaction isolation error (bug is fixed)', async () => {
    // This test verifies the bug is fixed: when creating a new overflow list,
    // the recursive call can now see the committed document
    
    const listId = 'transactionIsolation-full-list-2';
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

    const mediaItem = { id: 'new-item', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem,
        maxListSize: 10
      }
    };

    // The bug is fixed - this should NOT throw "not found" error
    // because the recursive processListStep now runs AFTER the transaction commits
    const result = await addToListHandler(request);
    
    // Verify the operation succeeded
    expect(result[0].status).toBe('success');
    if (result[0].status === 'error') {
      throw new Error(`Expected success but got error: ${result[0].error}`);
    }
    
    // Verify listItemId is returned
    if (result[0].status === 'success') {
      expect(result[0].listItemId).toBeDefined();
      expect(typeof result[0].listItemId).toBe('string');
      
      // Verify the listItemId matches the row at position 1
      const originalRows = subsplashMock.getListRows(listId);
      expect(originalRows[0].id).toBe(result[0].listItemId);
    }
    
    // Verify the overflow list was created and items were propagated
    const allLists = Array.from(subsplashMock.lists.keys());
    expect(allLists.length).toBeGreaterThan(1); // Original + overflow list
    
    const originalRows = subsplashMock.getListRows(listId);
    expect(originalRows.length).toBe(10); // Should have 9 items + 1 link
    
    const linkRow = originalRows.find(r => r.type === 'list');
    expect(linkRow).toBeDefined();
    const overflowListId = linkRow!._embedded.list?.id;
    expect(overflowListId).toBeDefined();
    
    // Verify Firestore document was created for overflow list
    const overflowListQuery = firestoreDB
      .collection('lists')
      .where('subsplashId', '==', overflowListId!)
      .limit(1)
      .withConverter(firestoreAdminListConverter);
    
    const overflowListSnapshot = await overflowListQuery.get();
    expect(overflowListSnapshot.empty).toBe(false);
  });
});

