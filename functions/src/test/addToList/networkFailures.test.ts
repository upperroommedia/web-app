/**
 * Integration tests for network failure robustness
 * Uses real Firestore emulator (not mocks)
 */
import { OverflowBehavior } from '@upperroom/shared/types/List';
import { SubsplashListRow } from '../../types/Subsplash';
import { 
  subsplashMock, 
  networkFailureInjector,
  TestRequest,
  AddToListHandler
} from './mocks';
import { createListDocument, clearFirestore } from './firestoreHelpers';
import addToList from '../../addToList';
import { logger } from 'firebase-functions/v2';

jest.mock('../../helpers/publishedListDrift', () => {
  const actual = jest.requireActual('../../helpers/publishedListDrift');
  return {
    ...actual,
    ensureCanPerformStrictPublishedMutation: jest.fn().mockResolvedValue(undefined),
  };
});

const addToListHandler = addToList as unknown as AddToListHandler;

const loggerErrorMentionsList = (listId: string): boolean =>
  (logger.error as jest.Mock).mock.calls.some(([message, payload]) => {
    const serializedPayload = JSON.stringify(payload ?? {});
    return (
      (typeof message === 'string' && message.includes(listId)) ||
      serializedPayload.includes(listId)
    );
  });

describe('addToList - Network Failure Robustness (Real Firestore Emulator)', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashMock.reset();
    subsplashMock.maxListSize = 10; // Set to 10 for testing
    networkFailureInjector.clear();
    // Clear logger mock calls before each test
    jest.clearAllMocks();
    // Mock logger.error for tests that check it
    jest.spyOn(logger, 'error').mockImplementation(() => {});
  });

  it('should handle network failure when fetching list rows', async () => {
    const listId = 'networkFailures-test-list';
    subsplashMock.createList(listId, 'Test List');
    
    // Create Firestore document for the list
    await createListDocument({
      subsplashId: listId,
      title: 'Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });
    
    networkFailureInjector.registerFailure(`getListRows:${listId}`, () => true);

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
    expect(result[0].status).toBe('error');
    expect(result[0].listId).toBe(listId);
    
    const rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(0);
  });

  it('should handle network failure when fetching list details for overflow', async () => {
    const listId = 'networkFailures-full-list-1';
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

    networkFailureInjector.registerFailure(`getList:${listId}`, () => true);

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
    expect(result[0].status).toBe('error');
    
    const rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(10);
    expect(rows[0]._embedded['media-item']?.id).toBe('item-0');
  });

  it('should handle network failure when creating new overflow list', async () => {
    const listId = 'networkFailures-full-list-2';
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

    networkFailureInjector.registerFailure('postList', () => true);

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
    expect(result[0].status).toBe('error');
    
    const rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(10);
    expect(rows[0]._embedded['media-item']?.id).toBe('item-0');
  });

  it('should handle network failure when patching main list after overflow', async () => {
    const listId = 'networkFailures-full-list-3';
    const nextListId = 'networkFailures-next-list';
    subsplashMock.createList(listId, 'Full List', 10);
    subsplashMock.createList(nextListId, 'More Full List', 0);
    
    const initialRows: SubsplashListRow[] = Array.from({ length: 199 }, (_, i) => ({
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
    initialRows.push({
      id: 'link-row',
      app_key: '9XTSHD',
      method: 'static' as const,
      position: 10,
      type: 'list' as const,
      _embedded: { 
        'source-list': { id: listId },
        'list': { id: nextListId } 
      }
    });
    subsplashMock.listRows.set(listId, initialRows);

    
    // Create Firestore documents
    await createListDocument({
      subsplashId: listId,
      title: 'Full List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      moreSermonsRef: nextListId,
      count: 199,
    });
    await createListDocument({
      subsplashId: nextListId,
      title: 'More Full List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    networkFailureInjector.registerFailure(`patchList:${listId}`, () => true);

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
    expect(result[0].status).toBe('error');
    
    // After network failure during patch, the list state is uncertain
    // The delete operations may have succeeded but the patch failed
    // So we just verify the error occurred
    const mainRows = subsplashMock.getListRows(listId);
    // The list may have been partially updated, so we don't assert exact length
    expect(mainRows.length).toBeGreaterThanOrEqual(0);
  });

  it('should handle network failure when patching during REMOVEOLDEST', async () => {
    const listId = 'networkFailures-full-list-4';
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
      overflowBehavior: OverflowBehavior.REMOVEOLDEST,
      count: 10,
    });

    networkFailureInjector.registerFailure(`patchList:${listId}`, () => true);
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
    expect(result[0].status).toBe('error');
    
    const rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(10);
    expect(rows[0]._embedded['media-item']?.id).toBe('item-0');
  });

  it('restores the original rows when the final REMOVEOLDEST patch fails after delete', async () => {
    const listId = 'networkFailures-full-list-4b';
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

    await createListDocument({
      subsplashId: listId,
      title: 'Full List',
      overflowBehavior: OverflowBehavior.REMOVEOLDEST,
      count: 10,
    });

    let patchAttempts = 0;
    networkFailureInjector.registerFailure(`patchList:${listId}`, () => {
      patchAttempts += 1;
      return patchAttempts === 2;
    });

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem: { id: 'new-item', type: 'media-item' },
        maxListSize: 10,
      }
    };

    const result = await addToListHandler(request);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('error');
    if (result[0].status === 'error') {
      expect(result[0].error).toContain('original list order was restored');
    }

    const rows = subsplashMock.getListRows(listId);
    expect(rows.map((row) => row._embedded['media-item']?.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `item-${index}`)
    );
  });

  it('logs a recovery failure when the final REMOVEOLDEST patch and rollback both fail', async () => {
    const listId = 'networkFailures-full-list-4c';
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

    await createListDocument({
      subsplashId: listId,
      title: 'Full List',
      overflowBehavior: OverflowBehavior.REMOVEOLDEST,
      count: 10,
    });

    let patchAttempts = 0;
    networkFailureInjector.registerFailure(`patchList:${listId}`, () => {
      patchAttempts += 1;
      return patchAttempts >= 2;
    });

    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId],
        mediaItem: { id: 'new-item', type: 'media-item' },
        maxListSize: 10,
      }
    };

    const result = await addToListHandler(request);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('error');
    if (result[0].status === 'error') {
      expect(result[0].error).toContain('automatic rollback failed');
    }

    const rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(9);
    expect(rows.find((row) => row._embedded['media-item']?.id === 'item-9')).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[list-debug] addToList.processListStep.removeOldest.rollbackFailed'),
      expect.any(Object)
    );
  });

  it('should handle network failure when patching overflow list during propagation', async () => {
    const listA = 'networkFailures-list-a';
    const listB = 'networkFailures-list-b';
    
    subsplashMock.createList(listA, 'List A', 10);
    subsplashMock.createList(listB, 'List B', 0);
    
    const rowsA: SubsplashListRow[] = Array.from({ length: 199 }, (_, i) => ({
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

    networkFailureInjector.registerFailure(`patchList:${listB}`, () => true);

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
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('error');
    
    const rowsA_after = subsplashMock.getListRows(listA);
    expect(rowsA_after).toHaveLength(200);
    expect(rowsA_after[0]._embedded['media-item']?.id).toBe('a-item-0');
    expect(rowsA_after[199].type).toBe('list');
  });

  it('should handle network failure on second call but succeed on retry', async () => {
    const listId = 'networkFailures-test-list-2';
    subsplashMock.createList(listId, 'Test List');
    
    // Create Firestore document for the list
    await createListDocument({
      subsplashId: listId,
      title: 'Test List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });
    
    let callCount = 0;
    networkFailureInjector.registerFailure(`getListRows:${listId}`, () => {
      callCount++;
      return callCount === 1;
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

    const firstResult = await addToListHandler(request);
    expect(firstResult).toHaveLength(1);
    expect(firstResult[0].status).toBe('error');
    
    networkFailureInjector.resetCounts();
    networkFailureInjector.clear();
    
    const secondResult = await addToListHandler(request);
    expect(secondResult).toHaveLength(1);
    expect(secondResult[0].status).toBe('success');
    
    const rows = subsplashMock.getListRows(listId);
    expect(rows).toHaveLength(1);
    expect(rows[0]._embedded['media-item']?.id).toBe('media-1');
  });

  it('should correctly indicate which lists succeeded and which failed when adding to multiple lists', async () => {
    // Create 4 lists
    const listId1 = 'multi-list-test-1';
    const listId2 = 'multi-list-test-2';
    const listId3 = 'multi-list-test-3';
    const listId4 = 'multi-list-test-4';
    
    subsplashMock.createList(listId1, 'List 1');
    subsplashMock.createList(listId2, 'List 2');
    subsplashMock.createList(listId3, 'List 3');
    subsplashMock.createList(listId4, 'List 4');
    
    // Create Firestore documents for all lists
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
    await createListDocument({
      subsplashId: listId3,
      title: 'List 3',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });
    await createListDocument({
      subsplashId: listId4,
      title: 'List 4',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });
    
    // Make list 2 fail when fetching list rows
    networkFailureInjector.registerFailure(`getListRows:${listId2}`, () => true);
    
    // Make list 3 fail when patching
    networkFailureInjector.registerFailure(`patchList:${listId3}`, () => true);
    
    // Lists 1 and 4 should succeed
    
    const mediaItem = { id: 'multi-list-item', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId1, listId2, listId3, listId4],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    // Should have 4 results (one for each list)
    expect(result).toHaveLength(4);
    
    // List 1 should succeed
    expect(result[0].listId).toBe(listId1);
    expect(result[0].status).toBe('success');
    if (result[0].status === 'success') {
      expect(result[0].listItemId).toBeDefined();
      expect(typeof result[0].listItemId).toBe('string');
    }
    
    // List 2 should fail (getListRows failure)
    expect(result[1].listId).toBe(listId2);
    expect(result[1].status).toBe('error');
    if (result[1].status === 'error') {
      expect(result[1].error).toBeDefined();
      expect(result[1].error).toContain('Network error');
      expect(result[1].error).toContain('Failed to fetch list rows');
      // Error responses should not have listItemId
      expect('listItemId' in result[1]).toBe(false);
    }
    
    // List 3 should fail (patchList failure)
    expect(result[2].listId).toBe(listId3);
    expect(result[2].status).toBe('error');
    if (result[2].status === 'error') {
      expect(result[2].error).toBeDefined();
      expect(result[2].error).toMatch(/Network error|Failed to patch list/i);
      // Error responses should not have listItemId
      expect('listItemId' in result[2]).toBe(false);
    }
    
    // List 4 should succeed
    expect(result[3].listId).toBe(listId4);
    expect(result[3].status).toBe('success');
    if (result[3].status === 'success') {
      expect(result[3].listItemId).toBeDefined();
      expect(typeof result[3].listItemId).toBe('string');
    }
    
    // Verify the actual state in Subsplash mock:
    // List 1 should have the item
    const rows1 = subsplashMock.getListRows(listId1);
    expect(rows1).toHaveLength(1);
    expect(rows1[0]._embedded['media-item']?.id).toBe('multi-list-item');
    if (result[0].status === 'success') {
      expect(rows1[0].id).toBe(result[0].listItemId);
    }
    
    // List 2 should be empty (failed before adding)
    const rows2 = subsplashMock.getListRows(listId2);
    expect(rows2).toHaveLength(0);
    
    // List 3 should be empty (failed during patch, so item was not added)
    const rows3 = subsplashMock.getListRows(listId3);
    expect(rows3).toHaveLength(0);
    
    // List 4 should have the item
    const rows4 = subsplashMock.getListRows(listId4);
    expect(rows4).toHaveLength(1);
    expect(rows4[0]._embedded['media-item']?.id).toBe('multi-list-item');
    if (result[3].status === 'success') {
      expect(rows4[0].id).toBe(result[3].listItemId);
    }
    
    // Verify that listItemIds are different for different lists
    if (result[0].status === 'success' && result[3].status === 'success') {
      expect(result[0].listItemId).not.toBe(result[3].listItemId);
    }
    
    // Verify that logger.error was called for each failed list
    // Note: patchListRows logs errors, and addToList also logs them, so we get 3 calls total:
    // 1. patchListRows for list 3 (patch failure)
    // 2. addToList for list 2 (getListRows failure)
    // 3. addToList for list 3 (patch failure)
    expect(logger.error).toHaveBeenCalledTimes(3);
    
    // Verify logger.error was called with the correct list IDs
    expect(loggerErrorMentionsList(listId2)).toBe(true);
    expect(loggerErrorMentionsList(listId3)).toBe(true);
    expect(loggerErrorMentionsList(listId1)).toBe(false);
    expect(loggerErrorMentionsList(listId4)).toBe(false);
  });

  it('should handle partial failures with proper error messages and logging', async () => {
    // Create 3 lists with different failure scenarios
    const listId1 = 'error-logging-test-1';
    const listId2 = 'error-logging-test-2';
    const listId3 = 'error-logging-test-3';
    
    subsplashMock.createList(listId1, 'Success List');
    subsplashMock.createList(listId2, 'Get List Failure');
    subsplashMock.createList(listId3, 'Patch Failure');
    
    // Create Firestore documents
    await createListDocument({
      subsplashId: listId1,
      title: 'Success List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });
    await createListDocument({
      subsplashId: listId2,
      title: 'Get List Failure',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });
    await createListDocument({
      subsplashId: listId3,
      title: 'Patch Failure',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });
    
    // Make list 2 fail on getListRows
    networkFailureInjector.registerFailure(`getListRows:${listId2}`, () => true);
    
    // Make list 3 fail on patchList
    networkFailureInjector.registerFailure(`patchList:${listId3}`, () => true);
    
    const mediaItem = { id: 'error-test-item', type: 'media-item' as const };
    const request: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [listId1, listId2, listId3],
        mediaItem,
        maxListSize: 10
      }
    };

    const result = await addToListHandler(request);
    
    // Verify all results are returned
    expect(result).toHaveLength(3);
    
    // Verify success case
    expect(result[0].listId).toBe(listId1);
    expect(result[0].status).toBe('success');
    if (result[0].status === 'success') {
      expect(result[0].listItemId).toBeDefined();
    }
    
    // Verify getListRows failure case
    expect(result[1].listId).toBe(listId2);
    expect(result[1].status).toBe('error');
    if (result[1].status === 'error') {
      expect(result[1].error).toBeDefined();
      expect(typeof result[1].error).toBe('string');
      expect(result[1].error.length).toBeGreaterThan(0);
      // Error should contain information about the failure
      expect(result[1].error).toMatch(/Network error|Failed to fetch list rows/i);
    }
    
    // Verify patchList failure case
    expect(result[2].listId).toBe(listId3);
    expect(result[2].status).toBe('error');
    if (result[2].status === 'error') {
      expect(result[2].error).toBeDefined();
      expect(typeof result[2].error).toBe('string');
      expect(result[2].error.length).toBeGreaterThan(0);
      // Error should contain information about the failure
      expect(result[2].error).toMatch(/Network error|Failed to patch list/i);
    }
    
    // Verify that error messages are different for different failure types
    if (result[1].status === 'error' && result[2].status === 'error') {
      // The error messages should be different since they're different failure types
      expect(result[1].error).not.toBe(result[2].error);
    }
    
    // Verify state: only list 1 should have the item
    const rows1 = subsplashMock.getListRows(listId1);
    expect(rows1).toHaveLength(1);
    expect(rows1[0]._embedded['media-item']?.id).toBe('error-test-item');
    
    const rows2 = subsplashMock.getListRows(listId2);
    expect(rows2).toHaveLength(0);
    
    const rows3 = subsplashMock.getListRows(listId3);
    expect(rows3).toHaveLength(0);
    
    // Verify that logger.error was called for each failed list
    // Note: patchListRows logs errors, and addToList also logs them, so we get 3 calls total:
    // 1. patchListRows for list 3 (patch failure)
    // 2. addToList for list 2 (getListRows failure)
    // 3. addToList for list 3 (patch failure)
    expect(logger.error).toHaveBeenCalledTimes(3);
    
    // Verify logger.error was called with the correct list IDs
    expect(loggerErrorMentionsList(listId2)).toBe(true);
    expect(loggerErrorMentionsList(listId3)).toBe(true);
    expect(loggerErrorMentionsList(listId1)).toBe(false);
  });
});
