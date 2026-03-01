/**
 * Tests for bulkAddToSeries Firebase function
 */

import { subsplashSeriesMock, networkFailureInjector, TestRequest } from './mocks';
import { clearFirestore, createSeriesDocument } from './firestoreHelpers';
import bulkAddToSeries, {
  BulkAddToSeriesInputType,
  BulkAddToSeriesOutputType,
} from '../../bulkAddToSeries';

type BulkAddToSeriesHandler = (request: TestRequest<BulkAddToSeriesInputType>) => Promise<BulkAddToSeriesOutputType>;
const bulkAddToSeriesHandler = bulkAddToSeries as unknown as BulkAddToSeriesHandler;

describe('bulkAddToSeries - Basic Functionality', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should bulk add items and reorder once', async () => {
    const series = subsplashSeriesMock.createSeries('Bulk Series');
    const firestoreSeriesId = await createSeriesDocument({
      subsplashId: series.id,
      name: 'Bulk Series',
    });

    const existing = subsplashSeriesMock.createMediaItem('Existing', {
      seriesId: series.id,
      position: 1,
    });
    const addA = subsplashSeriesMock.createMediaItem('Add A');
    const addB = subsplashSeriesMock.createMediaItem('Add B');

    const request: TestRequest<BulkAddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId,
        seriesSubsplashId: series.id,
        adds: [
          { mediaItemId: addA.id, sermonId: 'sermon-a' },
          { mediaItemId: addB.id, sermonId: 'sermon-b' },
        ],
        publishedItemOrder: [addB.id, addA.id, existing.id],
      },
    };

    const result = await bulkAddToSeriesHandler(request);
    expect(result.status).toBe('success');
    expect(result.failed).toBe(0);
    expect(result.reorderApplied).toBe(true);

    const updatedA = subsplashSeriesMock.getMediaItem(addA.id);
    const updatedB = subsplashSeriesMock.getMediaItem(addB.id);
    const updatedExisting = subsplashSeriesMock.getMediaItem(existing.id);

    expect(updatedA?._embedded?.['media-series']?.id).toBe(series.id);
    expect(updatedB?._embedded?.['media-series']?.id).toBe(series.id);
    expect(updatedExisting?._embedded?.['media-series']?.id).toBe(series.id);

    // position 1 is bottom in Subsplash
    expect(updatedB?.position).toBe(3);
    expect(updatedA?.position).toBe(2);
    expect(updatedExisting?.position).toBe(1);
  });
});

describe('bulkAddToSeries - Rollback Behavior', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should roll back successful adds when one add fails', async () => {
    const series = subsplashSeriesMock.createSeries('Rollback Series');
    const firestoreSeriesId = await createSeriesDocument({
      subsplashId: series.id,
      name: 'Rollback Series',
    });

    const addA = subsplashSeriesMock.createMediaItem('Add A');
    const addB = subsplashSeriesMock.createMediaItem('Add B');

    networkFailureInjector.registerFailure(`patchMediaItem:${addB.id}`, () => true);

    const request: TestRequest<BulkAddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId,
        seriesSubsplashId: series.id,
        adds: [
          { mediaItemId: addA.id, sermonId: 'sermon-a' },
          { mediaItemId: addB.id, sermonId: 'sermon-b' },
        ],
        publishedItemOrder: [addA.id],
        rollbackOnFailure: true,
      },
    };

    const result = await bulkAddToSeriesHandler(request);
    expect(result.status).toBe('partial');
    expect(result.failed).toBe(1);
    expect(result.reorderApplied).toBe(false);
    expect(result.rolledBackMediaItemIds).toContain(addA.id);

    const updatedA = subsplashSeriesMock.getMediaItem(addA.id);
    const updatedB = subsplashSeriesMock.getMediaItem(addB.id);
    expect(updatedA?._embedded?.['media-series']).toBeNull();
    expect(updatedB?._embedded?.['media-series']).toBeNull();
  });

  it('should roll back additions when reorder cannot be applied', async () => {
    const series = subsplashSeriesMock.createSeries('Reorder Failure Series');
    const firestoreSeriesId = await createSeriesDocument({
      subsplashId: series.id,
      name: 'Reorder Failure Series',
    });

    const addA = subsplashSeriesMock.createMediaItem('Add A');

    const request: TestRequest<BulkAddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId,
        seriesSubsplashId: series.id,
        adds: [{ mediaItemId: addA.id, sermonId: 'sermon-a' }],
        publishedItemOrder: [addA.id, 'missing-item-id'],
        rollbackOnFailure: true,
      },
    };

    const result = await bulkAddToSeriesHandler(request);
    expect(result.status).toBe('error');
    expect(result.reorderApplied).toBe(false);
    expect(result.rolledBackMediaItemIds).toContain(addA.id);

    const updatedA = subsplashSeriesMock.getMediaItem(addA.id);
    expect(updatedA?._embedded?.['media-series']).toBeNull();
  });
});
