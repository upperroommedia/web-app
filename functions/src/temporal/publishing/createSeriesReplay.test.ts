const mockData = {
  subsplashId: '',
  itemCount: 9,
  publishedItemCount: 3,
  subtitle: '3 part series',
  status: 'published',
  createdAt: 123,
};
const mockRef = { id: 'stable', get: jest.fn(async () => ({ exists: true, data: () => mockData })) };
const mockDb = { collection: () => ({ doc: () => mockRef }) };
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => mockDb },
}));
jest.mock('../../subsplashSecrets', () => ({ subsplashSecretsWithRuntimeAlerts: [] }));
jest.mock('../../subsplashUtils', () => ({ authenticateSubsplash: jest.fn() }));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: async (_keys: unknown, run: () => Promise<unknown>) => run(),
}));
jest.mock('../../helpers/subsplashImageRefs', () => ({ repairMismatchedSubsplashImageRefs: jest.fn() }));
jest.mock('../../helpers/seriesHelpers', () => ({
  getSeriesSubtitleFromPublishedCount: () => '0 part series',
  patchSeriesMetadata: jest.fn(),
  createSubsplashSeries: jest.fn(),
}));
jest.mock('./providerReceipts', () => ({
  readProviderReceipt: async () => undefined,
  providerReceiptId: () => 'id',
  providerPayloadFingerprint: () => 'hash',
}));
import { createSeriesDomain } from '../../createSeries';
import type { Transaction } from 'firebase-admin/firestore';
it('does not reset derived membership fields or creation time when replaying an existing draft create', async () => {
  const set = jest.fn();
  const result = await createSeriesDomain(
    { title: 'Series', ownerId: 'owner', firestoreId: 'stable', skipSubsplash: true },
    'publisher',
    { commitCurrent: async (write) => write({ set } as unknown as Transaction) }
  );
  expect(result).toMatchObject({ status: 'success', firestoreId: 'stable' });
  const patch = set.mock.calls[0][1];
  for (const field of ['itemCount', 'publishedItemCount', 'subtitle', 'status', 'createdAt'])
    expect(patch).not.toHaveProperty(field);
  expect(set).toHaveBeenCalledWith(mockRef, expect.objectContaining({ name: 'Series', ownerId: 'owner' }), {
    merge: true,
  });
});
