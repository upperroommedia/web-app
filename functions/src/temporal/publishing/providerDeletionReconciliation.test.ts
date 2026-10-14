jest.mock('./criticalRepairCatalog', () => ({
  prepareCriticalRepairCatalogSourceAppend: jest.fn(async () => ({ commit: jest.fn() })),
}));
jest.mock('./legacySoundCloudRetention', () => ({
  prepareLegacySoundCloudInitialMissingObservation: jest.fn(async () => ({ commit: jest.fn() })),
}));
jest.mock('firebase-functions/v2/https', () => ({
  HttpsError: class extends Error {
    constructor(public code: string, message: string, public details?: unknown) {
      super(message);
    }
  },
}));
const mockHttp = jest.fn(),
  mockRetire = jest.fn(),
  mockRetirementCommit = jest.fn(),
  mockAuth = jest.fn();
let mockJournal: Record<string, unknown>, mockCanonical: Record<string, unknown>, mockRows: any[];
const journalRef = { path: 'journal' },
  sermonRef = { path: 'sermon' };
const query: any = {
  where: () => query,
  limit: () => query,
  get: async () => ({ docs: mockRows, size: mockRows.length }),
  doc: () => sermonRef,
};
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: 'urm-app' } }), firestore: () => ({ collection: () => query }) },
}));
jest.mock('axios', () => ({
  __esModule: true,
  default: Object.assign((...args: unknown[]) => mockHttp(...args), { get: (...args: unknown[]) => mockHttp(...args) }),
}));
jest.mock('../../deleteFromSubsplash', () => ({ deleteFromSubsplashDomain: jest.fn() }));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: () => mockAuth(),
  createAxiosConfig: (url: string, _token: string, method: string) => ({ url, method }),
}));
jest.mock('../../soundcloudSecrets', () => ({
  runWithSoundCloudAccessToken: async (run: (token: string) => Promise<unknown>) => run('same-token'),
}));
jest.mock('../../soundcloudClient', () => ({
  deleteTrack: jest.fn(),
  normalizeSoundCloudAccountId: jest.requireActual('../../soundcloudClient').normalizeSoundCloudAccountId,
}));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: async (_keys: unknown, run: () => Promise<unknown>) => run(),
}));
jest.mock('./allocationBarrier', () => ({
  preparePublishingAllocationRetirement: (...args: unknown[]) => mockRetire(...args),
}));
import { reconcilePublishingDeletionCheckpoints } from './providerDeletion';
import type { PrivatePublishingIntent, PublishingJobRef } from './types';
import type { Transaction } from 'firebase-admin/firestore';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
const ref = { projectId: 'urm-app', jobId: 'job' } as PublishingJobRef,
  intent = { sermonId: 'sermon' } as PrivatePublishingIntent;
const update = jest.fn();
const store = {
  assertCurrent: jest.fn(),
  commitCurrent: jest.fn(async (_ref: unknown, run: (tx: Transaction) => Promise<void>) =>
    run({
      get: async (ref: { path: string }) => ({
        exists: true,
        data: () => (ref.path === 'journal' ? mockJournal : mockCanonical),
        get: (field: string) => (ref.path === 'journal' ? mockJournal : mockCanonical)[field],
      }),
      update,
    } as unknown as Transaction)
  ),
};
beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue('token');
  mockRetire.mockResolvedValue(mockRetirementCommit);
  mockJournal = {
    projectId: 'urm-app',
    jobId: 'job',
    sermonId: 'sermon',
    provider: 'subsplash',
    remoteId: 'original',
    originalAccount: 'app:9XTSHD',
    state: 'authorized',
    authorizedAtMillis: 1,
    ownershipConfirmedBeforeDelete: true,
  };
  mockCanonical = { subsplashId: 'original' };
  mockRows = [{ data: () => mockJournal, ref: journalRef }];
});
it('repairs only the original deleted binding and retires its owner in the same fenced transaction without DELETE', async () => {
  mockHttp.mockRejectedValue({ response: { status: 404 } });
  expect(await reconcilePublishingDeletionCheckpoints(ref, intent, store)).toEqual({ state: 'completed' });
  expect(update).toHaveBeenCalledWith(
    sermonRef,
    expect.objectContaining({ 'status.subsplash': uploadStatus.NOT_UPLOADED })
  );
  expect(mockRetire).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    { ref, sermonId: 'sermon', provider: 'subsplash' },
    'original'
  );
  expect(mockRetirementCommit).toHaveBeenCalledTimes(1);
  expect(mockHttp.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
});
it('preserves a newer different canonical provider ID and allocation owner', async () => {
  mockCanonical.subsplashId = 'newer';
  mockHttp.mockRejectedValue({ response: { status: 410 } });
  expect(await reconcilePublishingDeletionCheckpoints(ref, intent, store)).toEqual({ state: 'completed' });
  expect(update).not.toHaveBeenCalledWith(sermonRef, expect.anything());
  expect(mockRetire).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith(
    journalRef,
    expect.objectContaining({ state: 'reconciled', canonicalBindingCleared: false })
  );
});
it('keeps cancellation live if a prior DELETE target still exists instead of treating it as retained', async () => {
  mockHttp.mockResolvedValue({ data: { id: 'original' } });
  expect(await reconcilePublishingDeletionCheckpoints(ref, intent, store)).toEqual({
    state: 'blocked',
    code: 'PUBLISHING_CANCEL_DELETE_REPAIR_REQUIRED',
  });
  expect(update).not.toHaveBeenCalled();
  expect(mockRetire).not.toHaveBeenCalled();
});
it('requires the original SoundCloud account before interpreting fixed-track absence', async () => {
  mockJournal = { ...mockJournal, provider: 'soundcloud', originalAccount: 'soundcloud:users:1' };
  mockCanonical = { soundCloudTrackId: 'original' };
  mockHttp.mockResolvedValueOnce({ data: { id: 1 } }).mockRejectedValueOnce({ response: { status: 404 } });
  expect(await reconcilePublishingDeletionCheckpoints(ref, intent, store)).toEqual({ state: 'completed' });
  expect(update).toHaveBeenCalledWith(
    sermonRef,
    expect.objectContaining({ 'status.soundCloud': uploadStatus.NOT_UPLOADED })
  );
  mockHttp.mockResolvedValueOnce({ data: { id: 2 } });
  await expect(reconcilePublishingDeletionCheckpoints(ref, intent, store)).rejects.toMatchObject({
    code: 'PUBLISHING_PROVIDER_REPAIR_REQUIRED',
  });
});
it('rejects an authentication404 without repairing any canonical fields', async () => {
  mockAuth.mockRejectedValueOnce({ response: { status: 404 } });
  await expect(reconcilePublishingDeletionCheckpoints(ref, intent, store)).rejects.toMatchObject({
    response: { status: 404 },
  });
  expect(update).not.toHaveBeenCalled();
});
it('rechecks immutable deletion proof inside the projection transaction', async () => {
  const snapshot = { ...mockJournal };
  mockRows = [{ data: () => snapshot, ref: journalRef }];
  mockJournal = { ...mockJournal, remoteId: 'changed' };
  mockHttp.mockRejectedValue({ response: { status: 404 } });
  await expect(reconcilePublishingDeletionCheckpoints(ref, intent, store)).rejects.toMatchObject({
    code: 'PUBLISHING_PROVIDER_REPAIR_REQUIRED',
  });
  expect(update).not.toHaveBeenCalled();
  expect(mockRetire).not.toHaveBeenCalled();
});
