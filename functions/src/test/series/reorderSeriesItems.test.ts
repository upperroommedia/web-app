/**
 * Tests for reorderSeriesItems Firebase function
 * TDD approach: Tests written first
 */

import { subsplashSeriesMock, networkFailureInjector, TestRequest } from './mocks';
import { clearFirestore, createSeriesDocument } from './firestoreHelpers';
import reorderSeriesItems, { ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType } from '../../reorderSeriesItems';
import * as seriesHelpers from '../../helpers/seriesHelpers';
import * as lockStore from '../../locks/subsplashLockStore';

// Type for the handler function
type ReorderSeriesItemsHandler = (request: TestRequest<ReorderSeriesItemsInputType>) => Promise<ReorderSeriesItemsOutputType>;
const reorderSeriesItemsHandler = reorderSeriesItems as unknown as ReorderSeriesItemsHandler;

const createExpectedRemoteMembershipHash = (seriesId: string): string => {
  const remoteItems = [...subsplashSeriesMock.getSeriesItems(seriesId)]
    .sort((left, right) => (right.position ?? Number.NEGATIVE_INFINITY) - (left.position ?? Number.NEGATIVE_INFINITY));

  if (remoteItems.length === 0) {
    return 'empty';
  }

  return remoteItems.map((item) => `${item.id}:${item.status}`).join('|');
};

describe('reorderSeriesItems - Basic Functionality', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should reorder items in a series', async () => {
    // Create series with items
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const item1 = subsplashSeriesMock.createMediaItem('Item 1', {
      seriesId: subsplashSeries.id,
      position: 1,
    });
    const item2 = subsplashSeriesMock.createMediaItem('Item 2', {
      seriesId: subsplashSeries.id,
      position: 2,
    });
    const item3 = subsplashSeriesMock.createMediaItem('Item 3', {
      seriesId: subsplashSeries.id,
      position: 3,
    });

    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
      itemCount: 3,
    });

    // Reorder: move item3 to position 1
    const request: TestRequest<ReorderSeriesItemsInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId: firestoreId,
        expectedRemoteMembershipHash: createExpectedRemoteMembershipHash(subsplashSeries.id),
        itemOrder: [
          { mediaItemId: item3.id, position: 1 },
          { mediaItemId: item1.id, position: 2 },
          { mediaItemId: item2.id, position: 3 },
        ],
      },
    };

    const result = await reorderSeriesItemsHandler(request);

    expect(result.status).toBe('success');

    // Verify new positions
    const items = subsplashSeriesMock.getSeriesItems(subsplashSeries.id);
    expect(items[0].id).toBe(item3.id);
    expect(items[1].id).toBe(item1.id);
    expect(items[2].id).toBe(item2.id);
  });

  it('should update only changed positions', async () => {
    // Create series with items
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const item1 = subsplashSeriesMock.createMediaItem('Item 1', {
      seriesId: subsplashSeries.id,
      position: 1,
    });
    const item2 = subsplashSeriesMock.createMediaItem('Item 2', {
      seriesId: subsplashSeries.id,
      position: 2,
    });

    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
      itemCount: 2,
    });

    // Keep same order but verify it works
    const request: TestRequest<ReorderSeriesItemsInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId: firestoreId,
        expectedRemoteMembershipHash: createExpectedRemoteMembershipHash(subsplashSeries.id),
        itemOrder: [
          { mediaItemId: item1.id, position: 1 },
          { mediaItemId: item2.id, position: 2 },
        ],
      },
    };

    const result = await reorderSeriesItemsHandler(request);

    expect(result.status).toBe('success');

    // Verify positions unchanged
    const updatedItem1 = subsplashSeriesMock.getMediaItem(item1.id);
    const updatedItem2 = subsplashSeriesMock.getMediaItem(item2.id);
    expect(updatedItem1?.position).toBe(1);
    expect(updatedItem2?.position).toBe(2);
  });

  it('should handle empty item list', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Empty Series');
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Empty Series',
      itemCount: 0,
    });

    const request: TestRequest<ReorderSeriesItemsInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId: firestoreId,
        expectedRemoteMembershipHash: createExpectedRemoteMembershipHash(subsplashSeries.id),
        itemOrder: [],
      },
    };

    const result = await reorderSeriesItemsHandler(request);

    expect(result.status).toBe('success');
  });

});

describe('reorderSeriesItems - Authentication', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should reject unauthenticated requests', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });

    const request: TestRequest<ReorderSeriesItemsInputType> = {
      auth: undefined,
      data: {
        firestoreSeriesId: firestoreId,
        expectedRemoteMembershipHash: createExpectedRemoteMembershipHash(subsplashSeries.id),
        itemOrder: [],
      },
    };

    await expect(reorderSeriesItemsHandler(request)).rejects.toThrow();
  });

  it('should reject requests from users without publish role', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });

    const request: TestRequest<ReorderSeriesItemsInputType> = {
      auth: { token: { role: 'viewer' } },
      data: {
        firestoreSeriesId: firestoreId,
        expectedRemoteMembershipHash: createExpectedRemoteMembershipHash(subsplashSeries.id),
        itemOrder: [],
      },
    };

    await expect(reorderSeriesItemsHandler(request)).rejects.toThrow();
  });

  it('should allow admin role', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });

    const request: TestRequest<ReorderSeriesItemsInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId: firestoreId,
        expectedRemoteMembershipHash: createExpectedRemoteMembershipHash(subsplashSeries.id),
        itemOrder: [],
      },
    };

    const result = await reorderSeriesItemsHandler(request);
    expect(result.status).toBe('success');
  });
});

describe('reorderSeriesItems - Validation', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should reject requests without firestoreSeriesId', async () => {
    const request: TestRequest<ReorderSeriesItemsInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId: '',
        expectedRemoteMembershipHash: 'empty',
        itemOrder: [],
      },
    };

    await expect(reorderSeriesItemsHandler(request)).rejects.toThrow();
  });

  it('should reject requests for non-existent series', async () => {
    const request: TestRequest<ReorderSeriesItemsInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId: 'non-existent-id',
        expectedRemoteMembershipHash: 'empty',
        itemOrder: [],
      },
    };

    await expect(reorderSeriesItemsHandler(request)).rejects.toThrow();
  });
});

describe('reorderSeriesItems - Error Handling', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should handle Subsplash API failure gracefully', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const item = subsplashSeriesMock.createMediaItem('Item', {
      seriesId: subsplashSeries.id,
      position: 1,
    });

    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
      itemCount: 1,
    });

    // Inject network failure
    networkFailureInjector.registerFailure(`patchSeries:${subsplashSeries.id}`, () => true);

    const request: TestRequest<ReorderSeriesItemsInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId: firestoreId,
        expectedRemoteMembershipHash: createExpectedRemoteMembershipHash(subsplashSeries.id),
        itemOrder: [{ mediaItemId: item.id, position: 1 }],
      },
    };

    await expect(reorderSeriesItemsHandler(request)).rejects.toThrow();
  });
});

describe('reorderSeriesItems - Locking and Idempotency', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
    jest.restoreAllMocks();
  });

  it('should replay prior terminal result for duplicate operation key', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Replay Series');
    const item = subsplashSeriesMock.createMediaItem('Replay Item', {
      seriesId: subsplashSeries.id,
      position: 1,
    });
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Replay Series',
      itemCount: 1,
    });
    const patchSpy = jest.spyOn(seriesHelpers, 'patchSeriesItemPositions');

    const request: TestRequest<ReorderSeriesItemsInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId: firestoreId,
        expectedRemoteMembershipHash: createExpectedRemoteMembershipHash(subsplashSeries.id),
        itemOrder: [{ mediaItemId: item.id, position: 1 }],
        operationKey: 'reorder-op-replay-1',
      } as ReorderSeriesItemsInputType,
    };

    const firstResult = await reorderSeriesItemsHandler(request);
    const secondResult = await reorderSeriesItemsHandler(request);

    expect(firstResult).toEqual(secondResult);
    expect(patchSpy).toHaveBeenCalledTimes(1);
  });

  it('should wait for lock then return busy before reading remote membership', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Busy Series');
    const item = subsplashSeriesMock.createMediaItem('Busy Item', {
      seriesId: subsplashSeries.id,
      position: 1,
    });
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Busy Series',
      itemCount: 1,
    });

    const lockKey = `series:${subsplashSeries.id}`;
    await lockStore.acquireWithWait(lockKey, {
      ownerToken: 'reorder-owner-1',
      leaseTtlMs: 400,
      pollIntervalMs: 25,
    });
    const heartbeat = lockStore.startHeartbeat(lockKey, {
      ownerToken: 'reorder-owner-1',
      leaseTtlMs: 400,
      intervalMs: 100,
    });

    let getSeriesItemsCalls = 0;
    networkFailureInjector.registerFailure(`getSeriesItems:${subsplashSeries.id}`, () => {
      getSeriesItemsCalls += 1;
      return true;
    });

    const request: TestRequest<ReorderSeriesItemsInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId: firestoreId,
        expectedRemoteMembershipHash: createExpectedRemoteMembershipHash(subsplashSeries.id),
        itemOrder: [{ mediaItemId: item.id, position: 1 }],
        operationKey: 'reorder-op-busy-1',
      } as ReorderSeriesItemsInputType,
    };

    try {
      await expect(reorderSeriesItemsHandler(request)).rejects.toMatchObject({
        code: 'aborted',
        details: {
          code: 'SUBSPLASH_LOCK_BUSY',
          locked_keys: [lockKey],
          wait_ms: 10000,
          retry_after_ms: 200,
        },
      });
      expect(getSeriesItemsCalls).toBe(0);
    } finally {
      heartbeat.stop();
      await lockStore.releaseLock(lockKey, 'reorder-owner-1').catch(() => undefined);
    }
  });
});

describe('reorderSeriesItems - Remote source of truth', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('rejects stale remote membership hashes', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Stale Series');
    const item1 = subsplashSeriesMock.createMediaItem('Item 1', {
      seriesId: subsplashSeries.id,
      position: 1,
    });
    const item2 = subsplashSeriesMock.createMediaItem('Item 2', {
      seriesId: subsplashSeries.id,
      position: 2,
    });
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Stale Series',
      itemCount: 2,
    });

    const request: TestRequest<ReorderSeriesItemsInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId: firestoreId,
        expectedRemoteMembershipHash: `${createExpectedRemoteMembershipHash(subsplashSeries.id)}-stale`,
        itemOrder: [
          { mediaItemId: item2.id, position: 1 },
          { mediaItemId: item1.id, position: 2 },
        ],
      },
    };

    await expect(reorderSeriesItemsHandler(request)).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('rejects reorder payloads that omit remote-only series items', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Mixed Series');
    const trackedItem = subsplashSeriesMock.createMediaItem('Tracked Item', {
      seriesId: subsplashSeries.id,
      position: 1,
    });
    const remoteOnlyItem = subsplashSeriesMock.createMediaItem('Remote Only Item', {
      seriesId: subsplashSeries.id,
      position: 2,
    });
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Mixed Series',
      itemCount: 1,
    });

    const request: TestRequest<ReorderSeriesItemsInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId: firestoreId,
        expectedRemoteMembershipHash: createExpectedRemoteMembershipHash(subsplashSeries.id),
        itemOrder: [{ mediaItemId: trackedItem.id, position: 1 }],
      },
    };

    await expect(reorderSeriesItemsHandler(request)).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('include every media item'),
    });

    expect(subsplashSeriesMock.getMediaItem(remoteOnlyItem.id)?.position).toBe(2);
  });

  it('reorders a full mixed remote membership including remote-only items', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Mixed Series');
    const trackedItem = subsplashSeriesMock.createMediaItem('Tracked Item', {
      seriesId: subsplashSeries.id,
      position: 1,
    });
    const remoteOnlyItem = subsplashSeriesMock.createMediaItem('Remote Only Item', {
      seriesId: subsplashSeries.id,
      position: 2,
    });
    const anotherTrackedItem = subsplashSeriesMock.createMediaItem('Another Tracked Item', {
      seriesId: subsplashSeries.id,
      position: 3,
    });
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Mixed Series',
      itemCount: 2,
    });

    const request: TestRequest<ReorderSeriesItemsInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId: firestoreId,
        expectedRemoteMembershipHash: createExpectedRemoteMembershipHash(subsplashSeries.id),
        itemOrder: [
          { mediaItemId: remoteOnlyItem.id, position: 1 },
          { mediaItemId: anotherTrackedItem.id, position: 2 },
          { mediaItemId: trackedItem.id, position: 3 },
        ],
      },
    };

    const result = await reorderSeriesItemsHandler(request);
    expect(result.status).toBe('success');

    const reorderedItems = subsplashSeriesMock.getSeriesItems(subsplashSeries.id);
    expect(reorderedItems.map((item) => item.id)).toEqual([
      remoteOnlyItem.id,
      anotherTrackedItem.id,
      trackedItem.id,
    ]);
  });
});
