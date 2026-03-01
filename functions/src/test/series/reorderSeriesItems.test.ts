/**
 * Tests for reorderSeriesItems Firebase function
 * TDD approach: Tests written first
 */

import { subsplashSeriesMock, networkFailureInjector, TestRequest } from './mocks';
import { clearFirestore, createSeriesDocument } from './firestoreHelpers';
import reorderSeriesItems, { ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType } from '../../reorderSeriesItems';

// Type for the handler function
type ReorderSeriesItemsHandler = (request: TestRequest<ReorderSeriesItemsInputType>) => Promise<ReorderSeriesItemsOutputType>;
const reorderSeriesItemsHandler = reorderSeriesItems as unknown as ReorderSeriesItemsHandler;

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
        itemOrder: [{ mediaItemId: item.id, position: 1 }],
      },
    };

    await expect(reorderSeriesItemsHandler(request)).rejects.toThrow();
  });
});
