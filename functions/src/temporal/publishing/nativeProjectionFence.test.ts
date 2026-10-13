const mockSet = jest.fn();
const mockRef = {
  get: jest.fn(async () => ({
    exists: true,
    data: () => ({ subsplashId: 'remote', images: [], publishedItemCount: 0 }),
  })),
  withConverter() {
    return this;
  },
  set: mockSet,
};
const mockDb = { collection: jest.fn(() => ({ doc: jest.fn(() => mockRef) })) };
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => mockDb },
}));
jest.mock('../../firestoreDataConverter', () => ({ firestoreAdminSeriesConverter: {} }));
jest.mock('../../subsplashSecrets', () => ({ subsplashSecretsWithRuntimeAlerts: [] }));
jest.mock('../../subsplashUtils', () => ({ authenticateSubsplash: async () => 'token' }));
jest.mock('../../handleError', () => ({ __esModule: true, default: (error: unknown) => error }));
jest.mock('../../locks/withIdempotency', () => ({
  withIdempotency: async (_key: unknown, run: () => Promise<unknown>) => run(),
}));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: async (_keys: unknown, run: () => Promise<unknown>) => run(),
}));
jest.mock('../../helpers/subsplashImageRefs', () => ({ repairMismatchedSubsplashImageRefs: jest.fn() }));
jest.mock('../../helpers/seriesItemSubtitles', () => ({
  syncSeriesItemSubtitles: async () => ({ inspected: 0, updated: 0 }),
}));
jest.mock('../../helpers/seriesHelpers', () => ({
  getAllSeriesItemsAcrossStatuses: async () => [],
  getSeriesSubtitleFromPublishedCount: () => '0 part series',
  patchSeriesMetadata: async () => ({
    id: 'remote',
    title: 'New',
    subtitle: '0 part series',
    status: 'published',
    slug: 'new',
    short_code: 'new',
    position: 0,
  }),
}));
import { updateSeriesMetadataDomain } from '../../updateSeriesMetadata';
import { runDurablePublishingOperation } from './durableOperationContext';
import type { Transaction } from 'firebase-admin/firestore';
const request = {
  data: { firestoreId: 'series', title: 'New' },
  auth: { uid: 'actor', rawToken: '', token: { role: 'publisher' } as never },
};
const mockBeginPlan = jest.fn(async () => undefined);
const mockSettlementCommit = jest.fn();
const mockPrepareSettlement = jest.fn(async () => ({ alreadyCommitted: false, commit: mockSettlementCommit }));
const mutationContext = {
  beginProviderMutationPlan: mockBeginPlan,
  prepareProviderMutationPlanCommit: mockPrepareSettlement,
};
beforeEach(() => jest.clearAllMocks());
it('native domain metadata projection shares the worker generation transaction', async () => {
  const txSet = jest.fn();
  const commit = jest.fn(async (write: (tx: Transaction) => Promise<void>) =>
    write({ set: txSet } as unknown as Transaction)
  );
  await expect(
    runDurablePublishingOperation('job', () => updateSeriesMetadataDomain(request), commit, mutationContext)
  ).resolves.toMatchObject({ status: 'success', firestoreId: 'series' });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(txSet).toHaveBeenCalledWith(mockRef, expect.objectContaining({ name: 'New' }), { merge: true });
  expect(mockSet).not.toHaveBeenCalled();
  expect(mockBeginPlan).toHaveBeenCalledWith(
    expect.objectContaining({
      resources: [{ provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'series', resourceId: 'remote' }],
    })
  );
  expect(mockPrepareSettlement).toHaveBeenCalledTimes(1);
  expect(mockSettlementCommit).toHaveBeenCalledTimes(1);
});
it('a cancelled generation cannot commit a native domain projection after its provider response', async () => {
  await expect(
    runDurablePublishingOperation(
      'job',
      () => updateSeriesMetadataDomain(request),
      async () => {
        throw new Error('superseded');
      },
      mutationContext
    )
  ).rejects.toThrow('superseded');
  expect(mockSet).not.toHaveBeenCalled();
  expect(mockPrepareSettlement).not.toHaveBeenCalled();
  expect(mockSettlementCommit).not.toHaveBeenCalled();
});
