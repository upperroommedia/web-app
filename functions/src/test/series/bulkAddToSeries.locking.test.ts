import { HttpsError } from 'firebase-functions/v2/https';
import { buildSubsplashLockBusyError } from '../../locks/contentionError';
import { withIdempotency } from '../../locks/withIdempotency';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import bulkAddToSeries, { BulkAddToSeriesInputType, BulkAddToSeriesOutputType } from '../../bulkAddToSeries';
import { getSeriesItems, patchMediaItemSeries, patchSeriesItemPositions } from '../../helpers/seriesHelpers';
import { authenticateSubsplash } from '../../subsplashUtils';

jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: jest.fn().mockResolvedValue('fake-token'),
}));

jest.mock('../../helpers/seriesHelpers', () => ({
  getSeriesItems: jest.fn(),
  patchMediaItemSeries: jest.fn(),
  patchSeriesItemPositions: jest.fn(),
}));

jest.mock('../../locks/withIdempotency', () => ({
  withIdempotency: jest.fn(async (_operationKey: string, run: () => Promise<unknown>) => run()),
}));

jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: jest.fn(async (_lockKeys: string[], run: () => Promise<unknown>) => run()),
}));

jest.mock('firebase-functions/v2/https', () => {
  const actual = jest.requireActual('firebase-functions/v2/https');
  return {
    ...actual,
    onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
      (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
    ),
  };
});

type BulkAddHandler = (request: {
  auth?: { token?: { role?: string } };
  data: BulkAddToSeriesInputType;
}) => Promise<BulkAddToSeriesOutputType>;

const bulkAddHandler = bulkAddToSeries as unknown as BulkAddHandler;
const mockAuthenticateSubsplash = authenticateSubsplash as jest.MockedFunction<typeof authenticateSubsplash>;
const mockGetSeriesItems = getSeriesItems as jest.MockedFunction<typeof getSeriesItems>;
const mockPatchMediaItemSeries = patchMediaItemSeries as jest.MockedFunction<typeof patchMediaItemSeries>;
const mockPatchSeriesItemPositions = patchSeriesItemPositions as jest.MockedFunction<typeof patchSeriesItemPositions>;
const mockWithIdempotency = withIdempotency as jest.MockedFunction<typeof withIdempotency>;
const mockWithSubsplashLocks = withSubsplashLocks as jest.MockedFunction<typeof withSubsplashLocks>;

const makeInput = (): BulkAddToSeriesInputType => ({
  firestoreSeriesId: 'firestore-series-1',
  seriesSubsplashId: 'subsplash-series-1',
  operationKey: 'bulk-lock-op-1',
  expectedPublishedMembershipHash: 'media-existing',
  adds: [
    { mediaItemId: 'media-b', sermonId: 'sermon-b' },
    { mediaItemId: 'media-a', sermonId: 'sermon-a' },
  ],
  publishedItemOrder: ['media-existing', 'media-b', 'media-a'],
}) as BulkAddToSeriesInputType;

describe('bulkAddToSeries lock/idempotency contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthenticateSubsplash.mockResolvedValue('fake-token');
    mockWithIdempotency.mockImplementation(async (_operationKey, run) => run());
    mockWithSubsplashLocks.mockImplementation(async (_lockKeys, run) => run());

    mockGetSeriesItems.mockResolvedValue([
      {
        id: 'media-existing',
        position: 1,
      } as never,
    ]);
    mockPatchMediaItemSeries.mockImplementation(async (mediaItemId, seriesId) => ({
      id: mediaItemId,
      position: 1,
      _embedded: {
        'media-series': {
          id: seriesId,
        },
      },
    }) as never);
    mockPatchSeriesItemPositions.mockResolvedValue(undefined as never);
  });

  it('wraps bulk mutation flow with idempotency and deterministic lock scope', async () => {
    const request = {
      auth: { token: { role: 'admin' } },
      data: makeInput(),
    };

    await bulkAddHandler(request);

    expect(mockWithIdempotency).toHaveBeenCalledWith('bulk-lock-op-1', expect.any(Function));
    expect(mockWithSubsplashLocks).toHaveBeenCalledWith(
      ['series:firestore-series-1', 'media-item:media-a', 'media-item:media-b', 'media-item:media-existing'],
      expect.any(Function),
      expect.objectContaining({ operationKey: 'bulk-lock-op-1' })
    );
  });

  it('surfaces SUBSPLASH_LOCK_BUSY details when lock acquisition fails', async () => {
    const busyError = buildSubsplashLockBusyError({
      lockedKeys: ['series:firestore-series-1'],
      waitMs: 10_000,
      retryAfterMs: 250,
    });
    mockWithSubsplashLocks.mockRejectedValueOnce(busyError);

    await expect(
      bulkAddHandler({
        auth: { token: { role: 'admin' } },
        data: makeInput(),
      })
    ).rejects.toMatchObject({
      code: 'aborted',
      details: {
        code: 'SUBSPLASH_LOCK_BUSY',
        locked_keys: ['series:firestore-series-1'],
        wait_ms: 10_000,
        retry_after_ms: 250,
      },
    } satisfies Partial<HttpsError>);
  });
});
