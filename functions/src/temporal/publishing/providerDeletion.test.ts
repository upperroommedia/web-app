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
  mockAuth = jest.fn(),
  mockSubsplashDelete = jest.fn(),
  mockTrackDelete = jest.fn();
let mockCheckpoint: Record<string, unknown> = {};
const checkpoint = {
  get: async () => ({ status: 200, data: () => mockCheckpoint }),
  collection: () => ({ doc: () => checkpoint }),
};
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    app: () => ({ options: { projectId: 'project' } }),
    firestore: () => ({ collection: () => ({ doc: () => checkpoint }) }),
  },
}));
jest.mock('axios', () => ({
  __esModule: true,
  default: Object.assign((...args: unknown[]) => mockHttp(...args), { get: (...args: unknown[]) => mockHttp(...args) }),
}));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: () => mockAuth(),
  createAxiosConfig: (url: string, _token: string, method: string) => ({ url, method }),
}));
jest.mock('../../deleteFromSubsplash', () => ({
  deleteFromSubsplashDomain: (...args: unknown[]) => mockSubsplashDelete(...args),
}));
jest.mock('../../soundcloudSecrets', () => ({
  runWithSoundCloudAccessToken: async (run: (token: string) => Promise<unknown>) => run('same-access-token'),
}));
jest.mock('../../soundcloudClient', () => ({
  deleteTrack: (...args: unknown[]) => mockTrackDelete(...args),
  normalizeSoundCloudAccountId: jest.requireActual('../../soundcloudClient').normalizeSoundCloudAccountId,
}));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: async (_keys: unknown, run: () => Promise<unknown>) => run(),
}));
import { deletePublishingSoundCloudTrack, deletePublishingSubsplashMedia } from './providerDeletion';
import type { PrivatePublishingIntent, PublishingJobRef } from './types';
import type { Transaction } from 'firebase-admin/firestore';
const ref = { projectId: 'project', jobId: 'deletion-job' } as PublishingJobRef;
const intent = { sermonId: 'sermon', actorUid: 'admin', action: 'delete' } as PrivatePublishingIntent;
const store = () => ({
  assertCurrent: jest.fn(),
  commitCurrent: jest.fn(async (_ref, run: (tx: Transaction) => Promise<void>) =>
    run({
      get: async () => ({ exists: Object.keys(mockCheckpoint).length > 0, data: () => mockCheckpoint }),
      create: jest.fn(),
      update: (_ref: unknown, data: Record<string, unknown>) => {
        mockCheckpoint = { ...mockCheckpoint, ...data };
      },
      set: (_ref: unknown, data: Record<string, unknown>) => {
        mockCheckpoint = { ...mockCheckpoint, ...data };
      },
    } as unknown as Transaction)
  ),
});
const request = { status: 200, data: { subsplashId: 'media', operationKey: 'stable-delete-key' } };
const missing = { response: { status: 404 } };
beforeEach(() => {
  jest.clearAllMocks();
  mockHttp.mockReset();
  mockCheckpoint = {};
  mockAuth.mockResolvedValue('service-token');
  mockSubsplashDelete.mockImplementation(
    async (_request: unknown, options: { onResponse: (response: { status: number }) => void }) =>
      options.onResponse({ status: 204 })
  );
  mockTrackDelete.mockResolvedValue(undefined);
});
it('requires fresh fixed-ID absence after the existing Subsplash deletion domain returns', async () => {
  mockHttp.mockResolvedValueOnce({ status: 200, data: { id: 'media', app_key: '9XTSHD' } }).mockRejectedValue(missing);
  const deps = store();
  expect(await deletePublishingSubsplashMedia(ref, intent, deps, request)).toEqual({
    provider: 'subsplash',
    remoteId: 'media',
    absenceConfirmed: true,
  });
  expect(mockSubsplashDelete).toHaveBeenCalledWith(
    request,
    expect.objectContaining({ onResponse: expect.any(Function) })
  );
  expect(mockHttp).toHaveBeenCalledWith(
    expect.objectContaining({ method: 'GET', url: 'https://core.subsplash.com/media/v1/media-items/media' })
  );
  mockHttp.mockResolvedValue({ status: 200, data: { id: 'media', app_key: '9XTSHD' } });
  await expect(deletePublishingSubsplashMedia(ref, intent, deps, request)).rejects.toMatchObject({
    code: 'PUBLISHING_PROVIDER_REPAIR_REQUIRED',
  });
});
it('does not treat a Subsplash authentication404 as fixed media absence', async () => {
  mockAuth.mockRejectedValueOnce(missing);
  await expect(deletePublishingSubsplashMedia(ref, intent, store(), request)).rejects.toEqual(missing);
  expect(mockHttp).not.toHaveBeenCalled();
});
it('binds positive SoundCloud account/track ownership before same-token deletion and confirms absence', async () => {
  const deps = store();
  mockHttp
    .mockResolvedValueOnce({ status: 200, data: { id: 1 } })
    .mockResolvedValueOnce({ status: 200, data: { id: 123, user: { id: 1 } } })
    .mockRejectedValueOnce(missing);
  mockTrackDelete.mockImplementation(async () => {
    expect(mockCheckpoint).toMatchObject({
      projectId: 'project',
      jobId: 'deletion-job',
      remoteId: '123',
      originalAccount: 'soundcloud:users:1',
      state: 'authorized',
    });
  });
  expect(await deletePublishingSoundCloudTrack(ref, intent, deps, '123')).toEqual({
    provider: 'soundcloud',
    remoteId: '123',
    absenceConfirmed: true,
  });
  expect(mockTrackDelete).toHaveBeenCalledWith('same-access-token', '123');
  expect(mockHttp.mock.calls.every(([, config]) => config.headers.Authorization === 'OAuth same-access-token')).toBe(
    true
  );
});
it('fails closed when an original uncheckpointed track is missing, rather than guessing which account owned it', async () => {
  mockHttp.mockResolvedValueOnce({ status: 200, data: { id: 1 } }).mockRejectedValueOnce(missing);
  await expect(deletePublishingSoundCloudTrack(ref, intent, store(), '123')).rejects.toMatchObject({
    code: 'PUBLISHING_LEGACY_SOUNDCLOUD_RETENTION_REQUIRED',
  });
  expect(mockTrackDelete).not.toHaveBeenCalled();
});
it('replays a lost DELETE response using the same bound owner and fixed-ID absence without another DELETE', async () => {
  const deps = store();
  mockHttp
    .mockResolvedValueOnce({ status: 200, data: { id: 1 } })
    .mockResolvedValueOnce({ status: 200, data: { id: 123, user: { id: 1 } } });
  mockTrackDelete.mockRejectedValueOnce({ code: 'ECONNRESET' });
  await expect(deletePublishingSoundCloudTrack(ref, intent, deps, '123')).rejects.toMatchObject({ code: 'ECONNRESET' });
  mockHttp.mockResolvedValueOnce({ status: 200, data: { id: 1 } }).mockRejectedValueOnce(missing);
  expect(await deletePublishingSoundCloudTrack(ref, intent, deps, '123')).toEqual({
    provider: 'soundcloud',
    remoteId: '123',
    absenceConfirmed: true,
  });
  expect(mockTrackDelete).toHaveBeenCalledTimes(1);
});
it('rejects changed account after checkpoint and does not mistake /me404 plus existing track for track absence', async () => {
  mockCheckpoint = {
    projectId: 'project',
    jobId: 'deletion-job',
    sermonId: 'sermon',
    provider: 'soundcloud',
    remoteId: '123',
    originalAccount: 'soundcloud:users:1',
    state: 'authorized',
  };
  mockHttp.mockResolvedValueOnce({ status: 200, data: { id: 2 } });
  await expect(deletePublishingSoundCloudTrack(ref, intent, store(), '123')).rejects.toMatchObject({
    code: 'PUBLISHING_PROVIDER_REPAIR_REQUIRED',
  });
  expect(mockTrackDelete).not.toHaveBeenCalled();
  mockHttp.mockImplementation(async (url) => {
    if (url === 'https://api.soundcloud.com/me') throw missing;
    return { status: 200, data: { id: 123, user: { id: 1 } } };
  });
  await expect(deletePublishingSoundCloudTrack(ref, intent, store(), '123')).rejects.toEqual(missing);
  expect(mockTrackDelete).not.toHaveBeenCalled();
});
it('rejects a track belonging to another user even when the current account request succeeds', async () => {
  mockHttp
    .mockResolvedValueOnce({ status: 200, data: { id: 1 } })
    .mockResolvedValueOnce({ status: 200, data: { id: 123, user: { id: 2 } } });
  await expect(deletePublishingSoundCloudTrack(ref, intent, store(), '123')).rejects.toMatchObject({
    code: 'PUBLISHING_PROVIDER_REPAIR_REQUIRED',
  });
  expect(mockTrackDelete).not.toHaveBeenCalled();
  expect(mockCheckpoint).toEqual({});
});
it('rechecks current actor/generation before effects and stops before provider calls on revocation', async () => {
  const deps = store();
  deps.assertCurrent.mockRejectedValue({ code: 'PERMISSION_CHANGED' });
  await expect(deletePublishingSoundCloudTrack(ref, intent, deps, '123')).rejects.toMatchObject({
    code: 'PERMISSION_CHANGED',
  });
  expect(mockHttp).not.toHaveBeenCalled();
  expect(mockTrackDelete).not.toHaveBeenCalled();
});
it('stops before deletion reservations and provider effects if cancellation wins the critical-phase fence', async () => {
  mockHttp.mockResolvedValueOnce({ status: 200, data: { id: 'media', app_key: '9XTSHD' } });
  const { runDurablePublishingOperation } = jest.requireActual('./durableOperationContext');
  const deps = store(),
    critical = jest.fn().mockRejectedValue({ code: 'CANCEL_REQUESTED' });
  await expect(
    runDurablePublishingOperation(
      ref.jobId,
      () => deletePublishingSubsplashMedia(ref, intent, deps, request),
      (run: (tx: Transaction) => Promise<void>) => deps.commitCurrent(ref, run),
      { markCritical: critical, getSourceStepIds: () => ['cleanup'] }
    )
  ).rejects.toMatchObject({ code: 'CANCEL_REQUESTED' });
  expect(critical).toHaveBeenCalledWith('PUBLISHING_DELETE_CRITICAL', undefined);
  expect(deps.commitCurrent).toHaveBeenCalledTimes(1);
  expect(mockSubsplashDelete).not.toHaveBeenCalled();
  expect(mockHttp).toHaveBeenCalledTimes(1);
});
it('records original Subsplash DELETE404 as a sealed no-effect response, then verifies fixed-ID absence', async () => {
  const context = jest.requireActual('./durableOperationContext');
  let completion: unknown;
  const execute = jest.spyOn(context, 'runPublishingProviderMutation').mockImplementation(async (request: unknown) => {
    completion = await (request as { send: () => Promise<unknown> }).send();
    throw Object.assign(new Error('sealed'), { code: 'PROVIDER_MUTATION_REJECTED_NO_EFFECT' });
  });
  mockSubsplashDelete.mockImplementationOnce(
    async (_request: unknown, options: { onResponse: (response: { status: number }) => void }) =>
      options.onResponse({ status: 404 })
  );
  mockHttp.mockResolvedValueOnce({ status: 200, data: { id: 'media', app_key: '9XTSHD' } }).mockRejectedValue(missing);
  try {
    expect(await deletePublishingSubsplashMedia(ref, intent, store(), request)).toMatchObject({
      absenceConfirmed: true,
    });
    expect(completion).toEqual({
      completion: 'rejected_no_effect',
      evidence: { transport: 'original_http_response', status: 404, providerCode: 'resource_not_found' },
    });
  } finally {
    execute.mockRestore();
  }
});
it('does not invent original SoundCloud ownership from an immutable ID and the currently connected account', async () => {
  mockHttp.mockResolvedValueOnce({ status: 200, data: { id: 1 } }).mockRejectedValueOnce(missing);
  const admitted = { ...intent, payload: { sermon: { soundCloudTrackId: 'track' } } };
  await expect(deletePublishingSoundCloudTrack(ref, admitted, store(), 'track')).rejects.toMatchObject({
    code: 'PUBLISHING_LEGACY_SOUNDCLOUD_RETENTION_REQUIRED',
  });
  expect(mockTrackDelete).not.toHaveBeenCalled();
  expect(mockCheckpoint).toEqual({});
});
