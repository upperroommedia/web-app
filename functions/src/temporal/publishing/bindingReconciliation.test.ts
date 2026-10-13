const mockReceipt = jest.fn();
const mockRelease = jest.fn().mockResolvedValue(() => undefined);
const mockAxios = jest.fn();
const mockProof = jest.fn();
const mockData: any = {
  projectId: 'test',
  jobId: 'job',
  provider: 'subsplash',
  account: 'app:9XTSHD',
  remoteId: 'audio',
  bindingId: 'a'.repeat(64),
  state: 'reserved',
  targetReceiptId: 'b'.repeat(64),
};
const row: any = {
  id: 'a'.repeat(64),
  data: () => mockData,
  get: (key: string) => mockData[key],
  ref: { path: 'binding' },
};
const query: any = {
  orderBy: () => query,
  limit: () => query,
  startAfter: () => query,
  where: () => query,
  get: async () => ({ docs: [row], size: 1 }),
};
const mockCheckpoint: any = {
  get: (key: string) =>
    ((
      {
        projectId: 'test',
        jobId: 'job',
        receiptId: 'b'.repeat(64),
        remoteId: 'media',
        providerReceiptFingerprint: 'f'.repeat(64),
        receiptRevision: 2,
        state: 'deleted',
      } as any
    )[key]),
};
const mockDb: any = {
  collection: (name: string) => ({
    doc: () => ({
      collectionName: name,
      get: async () => (name === 'temporalPublishingCancellationReceipts' ? mockCheckpoint : { get: () => undefined }),
      collection: () => query,
    }),
  }),
};
jest.mock('axios', () => ({ __esModule: true, default: (...args: unknown[]) => mockAxios(...args) }));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => mockDb },
}));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: async () => 'token',
  createAxiosConfig: (url: string, _token: string, method: string) => ({ url, method }),
}));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: async (_keys: unknown, run: () => Promise<unknown>) => run(),
}));
jest.mock('./providerReceipts', () => ({
  PROVIDER_RECEIPTS_COLLECTION: 'temporalProviderReceipts',
  readProviderReceipt: (...args: unknown[]) => mockReceipt(...args),
}));
jest.mock('./cancellationEvidence', () => ({
  PUBLISHING_CANCELLATION_RECEIPTS: 'temporalPublishingCancellationReceipts',
  verifyPublishingCancellationFetchSettled: (...args: unknown[]) => mockProof(...args),
}));
jest.mock('../../../../packages/orchestration/src/provider-usage', () => ({
  prepareProviderBindingRelease: (...args: unknown[]) => mockRelease(...args),
}));
import { releaseCancelledProviderBindings } from './bindingReconciliation';
import type { Transaction } from 'firebase-admin/firestore';
const ref = { projectId: 'test', jobId: 'job' };
let mockReceiptValue: any;
const update = jest.fn(),
  set = jest.fn();
const store = {
  commitCurrent: jest.fn(async (_ref, run: (tx: Transaction) => Promise<void>) =>
    run({
      get: async (ref: any) =>
        ref.collectionName === 'temporalProviderReceipts'
          ? { data: () => mockReceiptValue }
          : ref.collectionName === 'temporalPublishingCancellationReceipts'
          ? mockCheckpoint
          : { data: () => mockData, get: (key: string) => mockData[key] },
      update,
      set,
    } as unknown as Transaction)
  ),
};
beforeEach(() => {
  jest.clearAllMocks();
  mockRelease.mockResolvedValue(() => undefined);
  mockReceiptValue = {
    projectId: 'test',
    jobId: 'job',
    step: 'subsplash-media-item',
    state: 'confirmed',
    result: { id: 'media' },
    fingerprint: 'f'.repeat(64),
    revision: 2,
  };
  mockReceipt.mockResolvedValue(mockReceiptValue);
  mockData.remoteId = 'audio';
  mockData.targetReceiptId = 'b'.repeat(64);
  delete mockData.target;
});
it('releases an audio dependency only after the exact parent receipt has verified deletion proof', async () => {
  expect(await releaseCancelledProviderBindings(ref, store)).toBe('completed');
  expect(mockRelease).toHaveBeenCalledWith(expect.anything(), mockDb, {
    resource: { projectId: 'test', provider: 'subsplash', account: 'app:9XTSHD', remoteId: 'audio' },
    jobId: 'job',
    bindingId: 'a'.repeat(64),
  });
  expect(update).toHaveBeenCalledWith(row.ref, expect.objectContaining({ state: 'released' }));
  expect(mockAxios).not.toHaveBeenCalled();
});
it('retains dependency edges when the parent allocation is unresolved', async () => {
  mockReceipt.mockResolvedValue({ projectId: 'test', jobId: 'job', state: 'executing' });
  await releaseCancelledProviderBindings(ref, store);
  expect(mockRelease).not.toHaveBeenCalled();
});
it('releases a never-dispatched prepared parent only in the scoped cancelled job', async () => {
  mockReceiptValue = { projectId: 'test', jobId: 'job', state: 'prepared' };
  mockReceipt.mockResolvedValue(mockReceiptValue);
  await releaseCancelledProviderBindings(ref, store);
  expect(mockRelease).toHaveBeenCalledTimes(1);
});
it('keeps replacement audio protected when the exact existing media item still references it', async () => {
  delete mockData.targetReceiptId;
  mockData.target = { provider: 'subsplash', kind: 'media-item', remoteId: 'existing' };
  mockAxios.mockResolvedValue({ data: { id: 'existing', app_key: '9XTSHD', _embedded: { audio: { id: 'audio' } } } });
  await releaseCancelledProviderBindings(ref, store);
  expect(mockRelease).not.toHaveBeenCalled();
  expect(mockAxios).toHaveBeenCalledWith(
    expect.objectContaining({ method: 'GET', url: 'https://core.subsplash.com/media/v1/media-items/existing' })
  );
});
it('releases replacement audio after authenticated exact-target GET confirms another audio binding', async () => {
  delete mockData.targetReceiptId;
  mockData.target = { provider: 'subsplash', kind: 'media-item', remoteId: 'existing' };
  mockAxios.mockResolvedValue({ data: { id: 'existing', app_key: '9XTSHD', _embedded: { audio: { id: 'old' } } } });
  await releaseCancelledProviderBindings(ref, store);
  expect(mockRelease).toHaveBeenCalledTimes(1);
  expect(mockAxios.mock.calls.every(([config]) => config.method === 'GET')).toBe(true);
});

it('rejects stale absence proof if adoption changes the parent receipt before the release transaction', async () => {
  mockReceiptValue = { ...mockReceiptValue, result: { id: 'different-media' }, revision: 3 };
  await expect(releaseCancelledProviderBindings(ref, store)).rejects.toThrow('PROVIDER_BINDING_TARGET_PROOF_CHANGED');
  expect(mockRelease).not.toHaveBeenCalled();
});
