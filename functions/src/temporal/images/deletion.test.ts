import axios from 'axios';
import { MockActivityEnvironment } from '@temporalio/testing';
import {
  createImageActivities,
  configuredImageProviderAccount,
  authorizeImageDeletionContinuation,
  imageDeletionIntentHash,
  type ImageDependencies,
} from './activities';
import type { ImageIntent } from './types';
jest.mock('axios', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: jest.fn(async () => 'private-token'),
  createAxiosConfig: jest.fn((url: string, _token: string, method: string) => ({ url, method })),
}));
jest.mock('../../computeMetadataForImage', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../storageDownloadUrl', () => ({ ensureFirebaseDownloadUrl: jest.fn() }));
const originalSubsplashEmail = process.env.SUBSPLASH_EMAIL;
afterAll(() => {
  if (originalSubsplashEmail === undefined) delete process.env.SUBSPLASH_EMAIL;
  else process.env.SUBSPLASH_EMAIL = originalSubsplashEmail;
});
const ref = { projectId: 'project', jobId: 'delete-job' };
const payload: ImageIntent = {
  operation: 'delete',
  imageId: 'image',
  remoteId: 'remote',
  name: 'Image',
  type: 'wide',
  source: { bucket: 'images', path: 'speaker-images/source', generation: '42', contentType: 'image/png' },
};
function merge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const output = { ...left };
  for (const [key, value] of Object.entries(right))
    output[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? merge((output[key] ?? {}) as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  return output;
}
function harness() {
  const records = new Map<string, Record<string, unknown>>([
    [
      'durableJobs/delete-job',
      { ...ref, kind: 'image.delete', state: 'needs_attention', generation: 3, revision: 4, steps: [] },
    ],
    ['durableJobIntents/delete-job', { ...ref, payload, generation: 3 }],
    ['images/image', { id: 'image', subsplashId: 'remote', source: payload.source }],
  ]);
  let revoked = false,
    administratorActive = true;
  function document(path: string) {
    return {
      path,
      get: async () => snapshot(path),
      set: async (value: Record<string, unknown>, options?: { merge?: boolean }) => {
        records.set(path, options?.merge ? merge(records.get(path) ?? {}, value) : value);
      },
    };
  }
  function snapshot(path: string) {
    return {
      exists: records.has(path),
      ref: document(path),
      get: (field: string) => records.get(path)?.[field],
      data: () => records.get(path),
    };
  }
  const firestore = {
    collection(name: string) {
      return {
        doc(id: string) {
          return document(`${name}/${id}`);
        },
      };
    },
    async runTransaction(handler: (tx: unknown) => Promise<unknown>) {
      let written = false;
      const writes: (() => void)[] = [];
      const result = await handler({
        get: async (doc: { path: string }) => {
          expect(written).toBe(false);
          return snapshot(doc.path);
        },
        set(doc: { path: string }, value: Record<string, unknown>, options?: { merge?: boolean }) {
          written = true;
          writes.push(() => records.set(doc.path, options?.merge ? merge(records.get(doc.path) ?? {}, value) : value));
        },
        delete(doc: { path: string }) {
          written = true;
          writes.push(() => {
            records.delete(doc.path);
          });
        },
      });
      writes.forEach((write) => write());
      return result;
    },
  };
  const removeSource = jest.fn(async () => undefined);
  const deps = {
    firestore,
    storage: { bucket: jest.fn(() => ({ file: jest.fn(() => ({ delete: removeSource })) })) },
    getActor: jest.fn(async () => ({
      disabled: false,
      customClaims: { role: administratorActive ? 'admin' : 'uploader' },
    })),
    loadIntent: async () => ({ payload }),
    loadJob: async () => records.get('durableJobs/delete-job'),
    assertCurrent: jest.fn(async () => {
      if (revoked) throw Object.assign(new Error('Permission changed'), { code: 'PERMISSION_CHANGED' });
    }),
    assertCurrentInTransaction: jest.fn(async () => undefined),
    recordStep: jest.fn(async () => undefined),
    project: jest.fn(async () => undefined),
  } as unknown as ImageDependencies;
  return {
    records,
    firestore: deps.firestore,
    deps,
    removeSource,
    setRevoked: () => {
      revoked = true;
    },
    revokeAdministrator: () => {
      administratorActive = false;
    },
    activities: createImageActivities(deps),
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUBSPLASH_EMAIL = 'images-tests@example.invalid';
  payload.providerAccount = configuredImageProviderAccount();
  jest.mocked(axios).mockResolvedValue({ status: 404 });
});
test('confirmed remote and storage deletion finalizes canonical consistency after original actor is revoked', async () => {
  const h = harness();
  h.removeSource.mockImplementation(async () => {
    h.setRevoked();
  });
  await new MockActivityEnvironment().run(h.activities.deleteImageProviders, ref);
  expect(axios).toHaveBeenCalledTimes(1);
  expect(h.removeSource).toHaveBeenCalledTimes(1);
  expect(h.records.has('images/image')).toBe(false);
  expect(h.records.get('temporalImageReceipts/delete-job')).toMatchObject({
    deletion: {
      intentHash: imageDeletionIntentHash(payload),
      remoteState: 'confirmed',
      storageState: 'confirmed',
      canonicalState: 'confirmed',
    },
  });
});
test('partial acknowledged deletion pauses on revocation; fresh admin continuation finishes without repeating confirmed remote effects', async () => {
  const h = harness();
  jest.mocked(axios).mockImplementationOnce(async () => {
    h.setRevoked();
    return { status: 404 };
  });
  await expect(new MockActivityEnvironment().run(h.activities.deleteImageProviders, ref)).rejects.toMatchObject({
    type: 'ImageCleanupPermissionChanged',
  });
  expect(h.removeSource).not.toHaveBeenCalled();
  expect(h.records.has('images/image')).toBe(true);
  await h.firestore.runTransaction(async (tx) => {
    const commit = await authorizeImageDeletionContinuation(h.firestore, tx, ref, {
      actorUid: 'admin',
      commandId: 'review',
      expectedRevision: 4,
      assertAdmin: async () => undefined,
    });
    commit();
  });
  await new MockActivityEnvironment().run(h.activities.deleteImageProviders, ref);
  expect(axios).toHaveBeenCalledTimes(1);
  expect(h.removeSource).toHaveBeenCalledTimes(1);
  expect(h.records.has('images/image')).toBe(false);
});
test('cleanup grants do not authorize a wholly unstarted deletion', async () => {
  const h = harness();
  h.records.set('temporalImageReceipts/delete-job', {
    deletion: { intentHash: imageDeletionIntentHash(payload), remoteState: 'pending', storageState: 'pending' },
  });
  await expect(
    h.firestore.runTransaction((tx) =>
      authorizeImageDeletionContinuation(h.firestore, tx, ref, {
        actorUid: 'admin',
        commandId: 'review',
        expectedRevision: 4,
        assertAdmin: async () => undefined,
      })
    )
  ).rejects.toThrow('partially confirmed');
  expect(h.records.has('temporalImageCleanupAuthorizations/delete-job')).toBe(false);
  expect(axios).not.toHaveBeenCalled();
  expect(h.removeSource).not.toHaveBeenCalled();
});
test('an administrator revoked after reviewing cannot authorize remaining provider effects', async () => {
  const h = harness();
  h.setRevoked();
  h.revokeAdministrator();
  h.records.set('temporalImageReceipts/delete-job', {
    deletion: { intentHash: imageDeletionIntentHash(payload), remoteState: 'confirmed', storageState: 'pending' },
  });
  h.records.set('temporalImageCleanupAuthorizations/delete-job', {
    actorUid: 'admin',
    intentHash: imageDeletionIntentHash(payload),
    generation: 3,
  });
  await expect(new MockActivityEnvironment().run(h.activities.deleteImageProviders, ref)).rejects.toMatchObject({
    type: 'ImageCleanupPermissionChanged',
  });
  expect(axios).not.toHaveBeenCalled();
  expect(h.removeSource).not.toHaveBeenCalled();
  expect(h.records.has('images/image')).toBe(true);
});
test('manual resume keeps business-step attempt monotonic after an exhausted activity retry budget', async () => {
  const h = harness();
  const job = h.records.get('durableJobs/delete-job')!;
  h.records.set('durableJobs/delete-job', {
    ...job,
    steps: [{ id: 'delete', label: 'Remove image destinations', state: 'running', attempt: 8 }],
  });
  await new MockActivityEnvironment().run(h.activities.deleteImageProviders, ref);
  expect(h.deps.recordStep).toHaveBeenNthCalledWith(1, ref, expect.objectContaining({ attempt: 9, state: 'running' }));
  expect(h.deps.recordStep).toHaveBeenLastCalledWith(ref, expect.objectContaining({ attempt: 9, state: 'succeeded' }));
});
test('an existing shared image pauses before local effects and never receives DELETE', async () => {
  const h = harness();
  jest.mocked(axios).mockResolvedValue({ status: 200, data: { id: 'remote', app_key: '9XTSHD' } });
  await expect(new MockActivityEnvironment().run(h.activities.deleteImageProviders, ref)).rejects.toMatchObject({
    type: 'ImageSharedReferenceReviewRequired',
  });
  expect(h.removeSource).not.toHaveBeenCalled();
  expect(h.records.has('images/image')).toBe(true);
  expect(axios).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET' }));
  expect(
    jest.mocked(axios).mock.calls.every(([config]) => (config as unknown as { method?: string }).method !== 'DELETE')
  ).toBe(true);
});
test('legacy images without an original account binding cannot infer absence from a provider404', async () => {
  const h = harness();
  delete payload.providerAccount;
  await expect(new MockActivityEnvironment().run(h.activities.deleteImageProviders, ref)).rejects.toMatchObject({
    type: 'ImageSharedReferenceReviewRequired',
  });
  expect(axios).not.toHaveBeenCalled();
  expect(h.removeSource).not.toHaveBeenCalled();
});
