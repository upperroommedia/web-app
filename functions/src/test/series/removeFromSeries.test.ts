/**
 * Tests for removeFromSeries Firebase function
 * TDD approach: Tests written first
 */

import { subsplashSeriesMock, networkFailureInjector, TestRequest } from './mocks';
import { clearFirestore, createSeriesDocument } from './firestoreHelpers';
import removeFromSeries, { RemoveFromSeriesInputType, RemoveFromSeriesOutputType } from '../../removeFromSeries';
import * as seriesHelpers from '../../helpers/seriesHelpers';
import { claimOperation } from '../../locks/withIdempotency';

// Type for the handler function
type RemoveFromSeriesHandler = (request: TestRequest<RemoveFromSeriesInputType>) => Promise<RemoveFromSeriesOutputType>;
const removeFromSeriesHandler = removeFromSeries as unknown as RemoveFromSeriesHandler;

describe('removeFromSeries - Basic Functionality', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should remove a media item from a series', async () => {
    // Create series with an item
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const mediaItem = subsplashSeriesMock.createMediaItem('Item To Remove', {
      seriesId: subsplashSeries.id,
      position: 1,
    });

    await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
      itemCount: 1,
    });

    const request: TestRequest<RemoveFromSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        mediaItemId: mediaItem.id,
      },
    };

    const result = await removeFromSeriesHandler(request);

    expect(result.status).toBe('success');

    // Verify media item is no longer in any series
    const updatedItem = subsplashSeriesMock.getMediaItem(mediaItem.id);
    expect(updatedItem?._embedded?.['media-series']).toBeNull();
  });

  it('should be idempotent - removing item not in any series should succeed', async () => {
    // Create item not in any series
    const mediaItem = subsplashSeriesMock.createMediaItem('Unassigned Item');

    const request: TestRequest<RemoveFromSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        mediaItemId: mediaItem.id,
      },
    };

    const result = await removeFromSeriesHandler(request);

    expect(result.status).toBe('success');

    // Item should still not be in any series
    const updatedItem = subsplashSeriesMock.getMediaItem(mediaItem.id);
    expect(updatedItem?._embedded?.['media-series']).toBeNull();
  });

  it('should not affect other items in the series', async () => {
    // Create series with multiple items
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const item1 = subsplashSeriesMock.createMediaItem('Item 1', {
      seriesId: subsplashSeries.id,
      position: 1,
    });
    const item2 = subsplashSeriesMock.createMediaItem('Item 2', {
      seriesId: subsplashSeries.id,
      position: 2,
    });

    await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
      itemCount: 2,
    });

    // Remove only item1
    const request: TestRequest<RemoveFromSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        mediaItemId: item1.id,
      },
    };

    const result = await removeFromSeriesHandler(request);

    expect(result.status).toBe('success');

    // Item1 should be removed
    const updatedItem1 = subsplashSeriesMock.getMediaItem(item1.id);
    expect(updatedItem1?._embedded?.['media-series']).toBeNull();

    // Item2 should still be in the series
    const updatedItem2 = subsplashSeriesMock.getMediaItem(item2.id);
    expect(updatedItem2?._embedded?.['media-series']?.id).toBe(subsplashSeries.id);
  });
});

describe('removeFromSeries - Authentication', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should reject unauthenticated requests', async () => {
    const mediaItem = subsplashSeriesMock.createMediaItem('Item');

    const request: TestRequest<RemoveFromSeriesInputType> = {
      auth: undefined,
      data: {
        mediaItemId: mediaItem.id,
      },
    };

    await expect(removeFromSeriesHandler(request)).rejects.toThrow();
  });

  it('should reject requests from users without publish role', async () => {
    const mediaItem = subsplashSeriesMock.createMediaItem('Item');

    const request: TestRequest<RemoveFromSeriesInputType> = {
      auth: { token: { role: 'viewer' } },
      data: {
        mediaItemId: mediaItem.id,
      },
    };

    await expect(removeFromSeriesHandler(request)).rejects.toThrow();
  });

  it('should allow admin role', async () => {
    const mediaItem = subsplashSeriesMock.createMediaItem('Item');

    const request: TestRequest<RemoveFromSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        mediaItemId: mediaItem.id,
      },
    };

    const result = await removeFromSeriesHandler(request);
    expect(result.status).toBe('success');
  });
});

describe('removeFromSeries - Validation', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should reject requests without mediaItemId', async () => {
    const request: TestRequest<RemoveFromSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        mediaItemId: '',
      },
    };

    await expect(removeFromSeriesHandler(request)).rejects.toThrow();
  });
});

describe('removeFromSeries - Error Handling', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should handle Subsplash API failure gracefully', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const mediaItem = subsplashSeriesMock.createMediaItem('Item', {
      seriesId: subsplashSeries.id,
    });

    // Inject network failure
    networkFailureInjector.registerFailure(`patchMediaItem:${mediaItem.id}`, () => true);

    const request: TestRequest<RemoveFromSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        mediaItemId: mediaItem.id,
      },
    };

    await expect(removeFromSeriesHandler(request)).rejects.toThrow();
  });

  it('should handle media item not found', async () => {
    const request: TestRequest<RemoveFromSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        mediaItemId: 'non-existent-item',
      },
    };

    await expect(removeFromSeriesHandler(request)).rejects.toThrow();
  });
});

describe('removeFromSeries - Locking and Idempotency', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
    jest.restoreAllMocks();
  });

  it('should replay prior terminal result for duplicate operation key', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Replay Series');
    const mediaItem = subsplashSeriesMock.createMediaItem('Replay Item', {
      seriesId: subsplashSeries.id,
    });
    const patchSpy = jest.spyOn(seriesHelpers, 'patchMediaItemSeries');

    const request: TestRequest<RemoveFromSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        mediaItemId: mediaItem.id,
        operationKey: 'remove-op-replay-1',
      } as RemoveFromSeriesInputType,
    };

    const firstResult = await removeFromSeriesHandler(request);
    const secondResult = await removeFromSeriesHandler(request);

    expect(firstResult).toEqual(secondResult);
    expect(patchSpy).toHaveBeenCalledTimes(1);
  });

  it('should return busy payload details when operation key is already in progress', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Busy Remove Series');
    const mediaItem = subsplashSeriesMock.createMediaItem('Busy Remove Item', {
      seriesId: subsplashSeries.id,
    });
    const patchSpy = jest.spyOn(seriesHelpers, 'patchMediaItemSeries');
    await claimOperation('remove-op-busy-1');

    const request: TestRequest<RemoveFromSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        mediaItemId: mediaItem.id,
        operationKey: 'remove-op-busy-1',
      } as RemoveFromSeriesInputType,
    };

    await expect(removeFromSeriesHandler(request)).rejects.toMatchObject({
      code: 'aborted',
      details: {
        code: 'SUBSPLASH_LOCK_BUSY',
        locked_keys: ['operation:remove-op-busy-1'],
        wait_ms: 10000,
        retry_after_ms: 1000,
      },
    });
    expect(patchSpy).not.toHaveBeenCalled();
  });
});
