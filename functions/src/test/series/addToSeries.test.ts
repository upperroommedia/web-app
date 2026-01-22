/**
 * Tests for addToSeries Firebase function
 * TDD approach: Tests written first
 */

import { subsplashSeriesMock, networkFailureInjector, TestRequest } from './mocks';
import {
  clearFirestore,
  createSeriesDocument,
} from './firestoreHelpers';
import addToSeries, { AddToSeriesInputType, AddToSeriesOutputType } from '../../addToSeries';

// Type for the handler function
type AddToSeriesHandler = (request: TestRequest<AddToSeriesInputType>) => Promise<AddToSeriesOutputType>;
const addToSeriesHandler = addToSeries as unknown as AddToSeriesHandler;

describe('addToSeries - Basic Functionality', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should add a media item to an empty series', async () => {
    // Create series in Subsplash mock and Firestore
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });

    // Create a media item not in any series
    const mediaItem = subsplashSeriesMock.createMediaItem('Sermon 1');

    const request: TestRequest<AddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        seriesSubsplashId: subsplashSeries.id,
        mediaItemId: mediaItem.id,
      },
    };

    const result = await addToSeriesHandler(request);

    expect(result.status).toBe('success');

    // Verify media item is now in the series
    const updatedItem = subsplashSeriesMock.getMediaItem(mediaItem.id);
    expect(updatedItem?._embedded?.['media-series']?.id).toBe(subsplashSeries.id);
  });

  it('should add a media item to a series with existing items', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
      itemCount: 1,
    });

    // Create existing item in series
    subsplashSeriesMock.createMediaItem('Existing Item', {
      seriesId: subsplashSeries.id,
      position: 1,
    });

    // Create new item to add
    const newItem = subsplashSeriesMock.createMediaItem('New Item');

    const request: TestRequest<AddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        seriesSubsplashId: subsplashSeries.id,
        mediaItemId: newItem.id,
      },
    };

    const result = await addToSeriesHandler(request);

    expect(result.status).toBe('success');

    // Verify new item is in the series
    const updatedItem = subsplashSeriesMock.getMediaItem(newItem.id);
    expect(updatedItem?._embedded?.['media-series']?.id).toBe(subsplashSeries.id);

    // Verify series now has 2 items
    const seriesItems = subsplashSeriesMock.getSeriesItems(subsplashSeries.id);
    expect(seriesItems).toHaveLength(2);
  });

  it('should move a media item from one series to another', async () => {
    // Create two series
    const series1 = subsplashSeriesMock.createSeries('Series 1');
    const series2 = subsplashSeriesMock.createSeries('Series 2');

    await createSeriesDocument({
      subsplashId: series1.id,
      name: 'Series 1',
    });
    await createSeriesDocument({
      subsplashId: series2.id,
      name: 'Series 2',
    });

    // Create item in series 1
    const mediaItem = subsplashSeriesMock.createMediaItem('Moving Item', {
      seriesId: series1.id,
      position: 1,
    });

    const request: TestRequest<AddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        seriesSubsplashId: series2.id,
        mediaItemId: mediaItem.id,
      },
    };

    const result = await addToSeriesHandler(request);

    expect(result.status).toBe('success');

    // Verify item is now in series 2
    const updatedItem = subsplashSeriesMock.getMediaItem(mediaItem.id);
    expect(updatedItem?._embedded?.['media-series']?.id).toBe(series2.id);

    // Verify item is no longer in series 1
    const series1Items = subsplashSeriesMock.getSeriesItems(series1.id);
    expect(series1Items.find((i) => i.id === mediaItem.id)).toBeUndefined();

    // Verify item is in series 2
    const series2Items = subsplashSeriesMock.getSeriesItems(series2.id);
    expect(series2Items.find((i) => i.id === mediaItem.id)).toBeDefined();
  });

  it('should be idempotent - adding item already in series should succeed', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });

    // Create item already in the series
    const mediaItem = subsplashSeriesMock.createMediaItem('Existing Item', {
      seriesId: subsplashSeries.id,
      position: 1,
    });

    const request: TestRequest<AddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        seriesSubsplashId: subsplashSeries.id,
        mediaItemId: mediaItem.id,
      },
    };

    const result = await addToSeriesHandler(request);

    expect(result.status).toBe('success');

    // Item should still be in the series
    const updatedItem = subsplashSeriesMock.getMediaItem(mediaItem.id);
    expect(updatedItem?._embedded?.['media-series']?.id).toBe(subsplashSeries.id);
  });

  it('should allow setting a position when adding to series', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });

    const mediaItem = subsplashSeriesMock.createMediaItem('Positioned Item');

    const request: TestRequest<AddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        seriesSubsplashId: subsplashSeries.id,
        mediaItemId: mediaItem.id,
        position: 5,
      },
    };

    const result = await addToSeriesHandler(request);

    expect(result.status).toBe('success');

    const updatedItem = subsplashSeriesMock.getMediaItem(mediaItem.id);
    expect(updatedItem?.position).toBe(5);
  });
});

describe('addToSeries - Authentication', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should reject unauthenticated requests', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });
    const mediaItem = subsplashSeriesMock.createMediaItem('Item');

    const request: TestRequest<AddToSeriesInputType> = {
      auth: undefined,
      data: {
        seriesSubsplashId: subsplashSeries.id,
        mediaItemId: mediaItem.id,
      },
    };

    await expect(addToSeriesHandler(request)).rejects.toThrow();
  });

  it('should reject requests from users without publish role', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });
    const mediaItem = subsplashSeriesMock.createMediaItem('Item');

    const request: TestRequest<AddToSeriesInputType> = {
      auth: { token: { role: 'viewer' } },
      data: {
        seriesSubsplashId: subsplashSeries.id,
        mediaItemId: mediaItem.id,
      },
    };

    await expect(addToSeriesHandler(request)).rejects.toThrow();
  });

  it('should allow admin role', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });
    const mediaItem = subsplashSeriesMock.createMediaItem('Item');

    const request: TestRequest<AddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        seriesSubsplashId: subsplashSeries.id,
        mediaItemId: mediaItem.id,
      },
    };

    const result = await addToSeriesHandler(request);
    expect(result.status).toBe('success');
  });
});

describe('addToSeries - Validation', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should reject requests without seriesSubsplashId', async () => {
    const mediaItem = subsplashSeriesMock.createMediaItem('Item');

    const request: TestRequest<AddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        seriesSubsplashId: '',
        mediaItemId: mediaItem.id,
      },
    };

    await expect(addToSeriesHandler(request)).rejects.toThrow();
  });

  it('should reject requests without mediaItemId', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });

    const request: TestRequest<AddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        seriesSubsplashId: subsplashSeries.id,
        mediaItemId: '',
      },
    };

    await expect(addToSeriesHandler(request)).rejects.toThrow();
  });
});

describe('addToSeries - Error Handling', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should handle Subsplash API failure gracefully', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });
    const mediaItem = subsplashSeriesMock.createMediaItem('Item');

    // Inject network failure for patching the media item
    networkFailureInjector.registerFailure(`patchMediaItem:${mediaItem.id}`, () => true);

    const request: TestRequest<AddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        seriesSubsplashId: subsplashSeries.id,
        mediaItemId: mediaItem.id,
      },
    };

    await expect(addToSeriesHandler(request)).rejects.toThrow();
  });

  it('should handle media item not found', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });

    const request: TestRequest<AddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        seriesSubsplashId: subsplashSeries.id,
        mediaItemId: 'non-existent-item',
      },
    };

    await expect(addToSeriesHandler(request)).rejects.toThrow();
  });
});
