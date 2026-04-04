/**
 * Test to verify the transaction retry inconsistency bug
 * 
 * BUG: When a Firestore transaction fails after Subsplash API calls have been made
 * (createNewList at line 81, patchListRows at line 182), the retry fetches the
 * already-patched Subsplash state. The `exists` check at line 56 then returns `true`
 * and causes early return at line 62, preventing the overflow list Firestore document
 * from being created and the parent's `moreSermonsRef` from being set. This leaves
 * Subsplash and Firestore in an inconsistent state, and propagation fails because the
 * overflow list document doesn't exist, resulting in data loss of overflowed items.
 * 
 * NOTE: This test requires the Firestore emulator. Run with:
 *   pnpm test transactionRetryInconsistency
 * NOT with:
 *   pnpm test:unit transactionRetryInconsistency
 */

import { OverflowBehavior } from '@upperroom/shared/types/List';
import { 
  subsplashMock, 
  TestRequest,
  AddToListHandler
} from './mocks';
import { createListDocument, clearFirestore, getListBySubsplashId } from './firestoreHelpers';
import addToList from '../../addToList';
import { SubsplashListRow } from '../../types/Subsplash';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { firestoreAdminListConverter } from '../../firestoreDataConverter';
import axios from 'axios';

jest.mock('../../helpers/publishedListDrift', () => {
  const actual = jest.requireActual('../../helpers/publishedListDrift');
  return {
    ...actual,
    ensureCanPerformStrictPublishedMutation: jest.fn().mockResolvedValue(undefined),
  };
});

const addToListHandler = addToList as unknown as AddToListHandler;
const firestoreDB = firebaseAdmin.firestore();
const axiosMock = axios as unknown as jest.Mock;

describe('addToList - Transaction Retry Inconsistency Bug', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashMock.reset();
    subsplashMock.maxListSize = 10; // Set to 10 for testing
  });

  it('should NOT skip Firestore document creation when transaction retries after Subsplash calls', async () => {
    // Setup: Create a full list (200 items) that will overflow
    const listId = 'retry-inconsistency-full-list';
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
    // This will:
    // 1. Call createNewList (line 81) - updates Subsplash
    // 2. Call transaction.set (line 102) - creates Firestore doc (not committed)
    // 3. Call transaction.update (line 104) - updates parent (not committed)
    // 4. Call patchListRows (line 182) - updates Subsplash
    // 5. If transaction fails and retries, Subsplash is already updated
    // 6. On retry, exists check returns true, early return, Firestore doc never created
    
    const mediaItem = { id: 'new-item-trigger-overflow', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem,
        maxListSize: 10
      }
    };

    // Force a transaction conflict by concurrently updating the list document
    // This will cause the transaction to retry after Subsplash calls have been made
    const conflictPromise = (async () => {
      // Wait a bit to ensure the transaction has started
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Update the list document to cause a conflict
      const listQuery = firestoreDB
        .collection('lists')
        .where('subsplashId', '==', listId)
        .limit(1)
        .withConverter(firestoreAdminListConverter);
      
      const snapshot = await listQuery.get();
      if (!snapshot.empty) {
        const listDoc = snapshot.docs[0];
        await firestoreDB.runTransaction(async (tx) => {
          const doc = await tx.get(listDoc.ref);
          if (doc.exists) {
            tx.update(listDoc.ref, { 
              updatedAtMillis: Date.now() + 1 // Force conflict
            });
          }
        });
      }
    })();

    // Start the addToList operation
    const addToListPromise = addToListHandler(request);

    // Wait for both to complete
    await Promise.all([conflictPromise, addToListPromise]);
    
    // The operation should succeed (or fail gracefully)
    // But the key issue is: if the transaction retried after Subsplash calls,
    // the overflow list Firestore document might not be created
    
    // Verify the overflow list was created in Subsplash
    const originalRows = subsplashMock.getListRows(listId);
    const linkRow = originalRows.find(r => r.type === 'list');
    
    if (linkRow && linkRow._embedded.list?.id) {
      const overflowListId = linkRow._embedded.list.id;
      
      // BUG VERIFICATION: The overflow list exists in Subsplash but NOT in Firestore
      // This is the inconsistency bug
      const overflowListDoc = await getListBySubsplashId(overflowListId);
      
      if (!overflowListDoc) {
        // BUG CONFIRMED: Overflow list exists in Subsplash but not in Firestore
        // This means the transaction retried, saw the item already exists in Subsplash,
        // returned early, and never created the Firestore document
        
        // Also verify the parent's moreSermonsRef is not set
        const parentDoc = await getListBySubsplashId(listId);
        expect(parentDoc).not.toBeNull();
        if (parentDoc) {
          const parentData = parentDoc.data();
          expect(parentData.moreSermonsRef).toBeUndefined();
        }
        
        // This test should FAIL if the bug exists
        throw new Error(
          `BUG CONFIRMED: Overflow list ${overflowListId} exists in Subsplash but not in Firestore. ` +
          `The transaction retried after Subsplash calls, saw the item already exists, ` +
          `returned early, and never created the Firestore document.`
        );
      }
      
      // If we get here, the bug is fixed - verify the document exists
      expect(overflowListDoc).not.toBeNull();
      const overflowData = overflowListDoc!.data();
      expect(overflowData.subsplashId).toBe(overflowListId);
      expect(overflowData.isMoreSermonsList).toBe(true);
      
      // Verify parent's moreSermonsRef is set
      const parentDoc = await getListBySubsplashId(listId);
      expect(parentDoc).not.toBeNull();
      if (parentDoc) {
        const parentData = parentDoc.data();
        expect(parentData.moreSermonsRef).toBe(overflowListId);
      }
    }
  });

  it.skip('should handle transaction retry correctly when Subsplash is already updated', async () => {
    // This test simulates the exact scenario:
    // 1. Transaction starts, creates overflow list in Subsplash
    // 2. Transaction fails (e.g., due to conflict)
    // 3. Transaction retries, but Subsplash already has the item
    // 4. Exists check returns true, but we should still create Firestore doc
    
    const listId = 'retry-inconsistency-simulated';
    subsplashMock.createList(listId, 'Simulated Retry List', 10);
    
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
      title: 'Simulated Retry List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 10,
    });

    // Manually simulate the bug scenario:
    // 1. First, manually add the item to Subsplash (simulating successful first attempt)
    const mediaItem = { id: 'simulated-item', type: 'media-item' as const };
    const newRow: SubsplashListRow = {
      id: 'new-row',
      app_key: '9XTSHD',
      method: 'static' as const,
      position: 1,
      type: 'media-item' as const,
      _embedded: { 
        'source-list': { id: listId },
        'media-item': { id: mediaItem.id } 
      }
    };
    const updatedRows = [newRow, ...initialRows];
    
    // Create overflow list in Subsplash (simulating successful first attempt)
    const overflowList = subsplashMock.postList('More Simulated Retry List');
    const overflowListId = overflowList.id;
    
    // Patch the list in Subsplash (simulating successful first attempt)
    // Keep top 9 items + link (maxListSize is 10)
    const itemsToKeep = updatedRows.slice(0, 9);
    const linkRow: SubsplashListRow = {
      app_key: '9XTSHD',
      method: 'static' as const,
      position: 10,
      type: 'list' as const,
      _embedded: { 
        'source-list': { id: listId },
        'list': { id: overflowListId } 
      }
    };
    const finalRows = [...itemsToKeep, linkRow];
    subsplashMock.patchList(listId, {
      id: listId,
      _embedded: { 'list-rows': finalRows }
    });
    
    // Now try to add the same item again (simulating transaction retry)
    // The exists check should return true, but we should still ensure
    // the Firestore document exists
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    // The operation should succeed (item already exists, early return)
    expect(result[0].status).toBe('success');
    
    // BUG VERIFICATION: Even though we returned early, the overflow list
    // Firestore document should exist (it was created in the first attempt)
    // But if the bug exists, it might not exist because the transaction failed
    // and the retry returned early
    
    // Check if overflow list document exists in Firestore
    const overflowListDoc = await getListBySubsplashId(overflowListId);
    
    if (!overflowListDoc) {
      // BUG CONFIRMED: Overflow list exists in Subsplash but not in Firestore
      throw new Error(
        `BUG CONFIRMED: Overflow list ${overflowListId} exists in Subsplash but not in Firestore. ` +
        `The transaction retried, saw the item already exists, returned early, ` +
        `and the Firestore document was never created.`
      );
    }
    
    // Verify the document exists and is correct
    expect(overflowListDoc).not.toBeNull();
    const overflowData = overflowListDoc!.data();
    expect(overflowData.subsplashId).toBe(overflowListId);
    expect(overflowData.isMoreSermonsList).toBe(true);
  });

  it('should replay deterministic result for duplicate operation keys after overflow writes', async () => {
    const listId = 'retry-inconsistency-op-key-replay';
    subsplashMock.createList(listId, 'Replay Inconsistency List', 10);

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
      title: 'Replay Inconsistency List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 10,
    });

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem: { id: 'replay-inconsistency-item', type: 'media-item' as const },
        maxListSize: 10,
        operationKey: 'inconsistency-replay-op-1',
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
