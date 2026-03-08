/**
 * Tests for bulkAddToSeries Firebase function
 */

import { subsplashSeriesMock, networkFailureInjector, TestRequest } from './mocks';
import { clearFirestore, createSeriesDocument } from './firestoreHelpers';
import * as seriesHelpers from '../../helpers/seriesHelpers';
import bulkAddToSeries, {
  BulkAddToSeriesInputType,
  BulkAddToSeriesOutputType,
} from '../../bulkAddToSeries';

type BulkAddToSeriesHandler = (request: TestRequest<BulkAddToSeriesInputType>) => Promise<BulkAddToSeriesOutputType>;
const bulkAddToSeriesHandler = bulkAddToSeries as unknown as BulkAddToSeriesHandler;
const toMembershipHash = (mediaItemIds: string[]): string => {
  const normalized = Array.from(new Set(mediaItemIds.map((mediaItemId) => mediaItemId.trim()).filter(Boolean))).sort();
  return normalized.length > 0 ? normalized.join('|') : 'empty';
};

const withConcurrencyEnvelope = (
  input: Omit<BulkAddToSeriesInputType, 'adds' | 'publishedItemOrder'> & {
    adds: BulkAddToSeriesInputType['adds'];
    publishedItemOrder: string[];
    operationKey?: string;
    expectedPublishedMembershipHash?: string;
  }
): BulkAddToSeriesInputType => input as unknown as BulkAddToSeriesInputType;

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
      data: withConcurrencyEnvelope({
        firestoreSeriesId,
        seriesSubsplashId: series.id,
        operationKey: 'bulk-add-basic-op-1',
        expectedPublishedMembershipHash: toMembershipHash([existing.id]),
        adds: [
          { mediaItemId: addA.id, sermonId: 'sermon-a' },
          { mediaItemId: addB.id, sermonId: 'sermon-b' },
        ],
        publishedItemOrder: [addB.id, addA.id, existing.id],
      }),
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
      data: withConcurrencyEnvelope({
        firestoreSeriesId,
        seriesSubsplashId: series.id,
        operationKey: 'bulk-add-rollback-op-1',
        expectedPublishedMembershipHash: toMembershipHash([]),
        adds: [
          { mediaItemId: addA.id, sermonId: 'sermon-a' },
          { mediaItemId: addB.id, sermonId: 'sermon-b' },
        ],
        publishedItemOrder: [addA.id],
        rollbackOnFailure: true,
      }),
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
      data: withConcurrencyEnvelope({
        firestoreSeriesId,
        seriesSubsplashId: series.id,
        operationKey: 'bulk-add-reorder-fail-op-1',
        expectedPublishedMembershipHash: toMembershipHash([]),
        adds: [{ mediaItemId: addA.id, sermonId: 'sermon-a' }],
        publishedItemOrder: [addA.id, 'missing-item-id'],
        rollbackOnFailure: true,
      }),
    };

    const result = await bulkAddToSeriesHandler(request);
    expect(result.status).toBe('error');
    expect(result.reorderApplied).toBe(false);
    expect(result.rolledBackMediaItemIds).toContain(addA.id);

    const updatedA = subsplashSeriesMock.getMediaItem(addA.id);
    expect(updatedA?._embedded?.['media-series']).toBeNull();
  });
});

describe('bulkAddToSeries - Lock and Idempotency Contract', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
    jest.restoreAllMocks();
  });

  it('rejects missing or blank operation keys', async () => {
    const series = subsplashSeriesMock.createSeries('Missing Operation Key Series');
    const existing = subsplashSeriesMock.createMediaItem('Existing', {
      seriesId: series.id,
      position: 1,
    });
    const addA = subsplashSeriesMock.createMediaItem('Add A');
    const firestoreSeriesId = await createSeriesDocument({
      subsplashId: series.id,
      name: 'Missing Operation Key Series',
    });

    const request: TestRequest<BulkAddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: withConcurrencyEnvelope({
        firestoreSeriesId,
        seriesSubsplashId: series.id,
        operationKey: '   ',
        expectedPublishedMembershipHash: toMembershipHash([existing.id]),
        adds: [{ mediaItemId: addA.id, sermonId: 'sermon-a' }],
        publishedItemOrder: [existing.id, addA.id],
      }),
    };

    await expect(bulkAddToSeriesHandler(request)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('replays terminal result for duplicate operation key without duplicate side effects', async () => {
    const series = subsplashSeriesMock.createSeries('Replay Series');
    const existing = subsplashSeriesMock.createMediaItem('Existing', {
      seriesId: series.id,
      position: 1,
    });
    const addA = subsplashSeriesMock.createMediaItem('Add A');
    const addB = subsplashSeriesMock.createMediaItem('Add B');
    const firestoreSeriesId = await createSeriesDocument({
      subsplashId: series.id,
      name: 'Replay Series',
    });

    const patchMediaSpy = jest.spyOn(seriesHelpers, 'patchMediaItemSeries');
    const patchReorderSpy = jest.spyOn(seriesHelpers, 'patchSeriesItemPositions');

    const request: TestRequest<BulkAddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: withConcurrencyEnvelope({
        firestoreSeriesId,
        seriesSubsplashId: series.id,
        operationKey: 'bulk-add-replay-op-1',
        expectedPublishedMembershipHash: toMembershipHash([existing.id]),
        adds: [
          { mediaItemId: addA.id, sermonId: 'sermon-a' },
          { mediaItemId: addB.id, sermonId: 'sermon-b' },
        ],
        publishedItemOrder: [addB.id, addA.id, existing.id],
      }),
    };

    const firstResult = await bulkAddToSeriesHandler(request);
    const secondResult = await bulkAddToSeriesHandler(request);

    expect(firstResult).toEqual(secondResult);
    expect(patchMediaSpy).toHaveBeenCalledTimes(2);
    expect(patchReorderSpy).toHaveBeenCalledTimes(1);
  });

  it('fails stale expected membership hash before reorder writes', async () => {
    const series = subsplashSeriesMock.createSeries('Stale Membership Series');
    const existing = subsplashSeriesMock.createMediaItem('Existing', {
      seriesId: series.id,
      position: 1,
    });
    const addA = subsplashSeriesMock.createMediaItem('Add A');
    const firestoreSeriesId = await createSeriesDocument({
      subsplashId: series.id,
      name: 'Stale Membership Series',
    });
    const patchReorderSpy = jest.spyOn(seriesHelpers, 'patchSeriesItemPositions');

    const request: TestRequest<BulkAddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: withConcurrencyEnvelope({
        firestoreSeriesId,
        seriesSubsplashId: series.id,
        operationKey: 'bulk-add-stale-op-1',
        expectedPublishedMembershipHash: `${toMembershipHash([existing.id])}-stale`,
        adds: [{ mediaItemId: addA.id, sermonId: 'sermon-a' }],
        publishedItemOrder: [addA.id, existing.id],
      }),
    };

    await expect(bulkAddToSeriesHandler(request)).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(patchReorderSpy).not.toHaveBeenCalled();
  });

  it('rejects oversized bulk requests before processing', async () => {
    const series = subsplashSeriesMock.createSeries('Oversized Request Series');
    const firestoreSeriesId = await createSeriesDocument({
      subsplashId: series.id,
      name: 'Oversized Request Series',
    });

    const adds = Array.from({ length: 201 }, (_, index) => {
      const mediaItem = subsplashSeriesMock.createMediaItem(`Bulk Add ${index + 1}`);
      return { mediaItemId: mediaItem.id, sermonId: `sermon-${index + 1}` };
    });

    const request: TestRequest<BulkAddToSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: withConcurrencyEnvelope({
        firestoreSeriesId,
        seriesSubsplashId: series.id,
        operationKey: 'bulk-add-oversized-op-1',
        expectedPublishedMembershipHash: toMembershipHash([]),
        adds,
        publishedItemOrder: adds.map((entry) => entry.mediaItemId),
      }),
    };

    await expect(bulkAddToSeriesHandler(request)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
});
