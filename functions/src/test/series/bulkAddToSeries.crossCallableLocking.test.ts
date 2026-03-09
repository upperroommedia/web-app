import { clearFirestore, createSeriesDocument } from './firestoreHelpers';
import { networkFailureInjector, subsplashSeriesMock, TestRequest } from './mocks';
import bulkAddToSeries, {
  BulkAddToSeriesInputType,
  BulkAddToSeriesOutputType,
} from '../../bulkAddToSeries';
import * as lockStore from '../../locks/subsplashLockStore';

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

describe('bulkAddToSeries - Cross-callable locking', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
    jest.restoreAllMocks();
  });

  it('serializes against shared series lock keys used by other series callables', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Cross-callable Lock Series');
    const existing = subsplashSeriesMock.createMediaItem('Existing', {
      seriesId: subsplashSeries.id,
      position: 1,
    });
    const addA = subsplashSeriesMock.createMediaItem('Add A');
    const firestoreSeriesId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Cross-callable Lock Series',
      itemCount: 1,
    });

    const lockKey = `series:${subsplashSeries.id}`;
    await lockStore.acquireWithWait(lockKey, {
      ownerToken: 'cross-callable-owner-1',
      leaseTtlMs: 400,
      pollIntervalMs: 25,
    });
    const heartbeat = lockStore.startHeartbeat(lockKey, {
      ownerToken: 'cross-callable-owner-1',
      leaseTtlMs: 400,
      intervalMs: 100,
    });

    try {
      const request: TestRequest<BulkAddToSeriesInputType> = {
        auth: { token: { role: 'admin' } },
        data: withConcurrencyEnvelope({
          firestoreSeriesId,
          seriesSubsplashId: subsplashSeries.id,
          operationKey: 'bulk-cross-callable-op-1',
          expectedPublishedMembershipHash: toMembershipHash([existing.id]),
          adds: [{ mediaItemId: addA.id, sermonId: 'sermon-a' }],
          publishedItemOrder: [addA.id, existing.id],
        }),
      };

      await expect(bulkAddToSeriesHandler(request)).rejects.toMatchObject({
        code: 'aborted',
        details: {
          code: 'SUBSPLASH_LOCK_BUSY',
          locked_keys: [lockKey],
          wait_ms: 10000,
          retry_after_ms: 200,
        },
      });
    } finally {
      heartbeat.stop();
      await lockStore.releaseLock(lockKey, 'cross-callable-owner-1').catch(() => undefined);
    }
  });
});
