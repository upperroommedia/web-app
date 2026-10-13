jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: jest.fn(), database: jest.fn() },
}));
jest.mock('../../utils/bundleCreationUtils', () => ({ generateAndStoreBundle: jest.fn() }));
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { generateAndStoreBundle } from '../../utils/bundleCreationUtils';
import { createBundleActivities } from './activities';
import type { BundleStore } from './activities';

describe('bundle artifact generation fencing', () => {
  const ref = { jobId: 'bundle-job', projectId: 'urm-app-staging' };
  let writes: Map<string, Record<string, unknown>>;
  let metadataTransaction: jest.Mock;
  let store: BundleStore;
  beforeEach(() => {
    (generateAndStoreBundle as jest.Mock).mockClear();
    writes = new Map();
    metadataTransaction = jest
      .fn()
      .mockImplementation(async (update: (current: unknown) => unknown) => update({ generation: 1 }));
    (firebaseAdmin.firestore as unknown as jest.Mock).mockReturnValue({
      collection: (name: string) => ({ doc: (id: string) => ({ path: `${name}/${id}` }) }),
      runTransaction: async (run: (tx: unknown) => Promise<unknown>) =>
        run({
          get: async (target: { path: string }) => ({ get: (field: string) => writes.get(target.path)?.[field] }),
          set: (target: { path: string }, value: Record<string, unknown>) => writes.set(target.path, value),
        }),
    });
    (firebaseAdmin.database as unknown as jest.Mock).mockReturnValue({
      ref: () => ({ transaction: metadataTransaction }),
    });
    (generateAndStoreBundle as jest.Mock).mockResolvedValue(20);
    store = {
      loadIntent: jest.fn().mockResolvedValue({ payload: { bundleType: 'topics' } }),
      assertCurrent: jest.fn().mockResolvedValue(undefined),
      assertCurrentInTransaction: jest.fn().mockResolvedValue({ generation: 2 }),
      recordStep: jest.fn().mockResolvedValue(undefined),
    };
  });
  it('resolves delayed old signals to the authoritative newest queued job', async () => {
    (firebaseAdmin.firestore as unknown as jest.Mock).mockReturnValue({
      collection: (name: string) => ({
        doc: () => ({
          get: async () => ({
            data: () =>
              name === 'durableJobEntities'
                ? { projectId: ref.projectId, activeJobId: 'newest-job' }
                : { projectId: ref.projectId, kind: 'bundle.regenerate', entity: { id: 'topics' }, state: 'queued' },
          }),
        }),
      }),
    });
    expect(await createBundleActivities(store).resolveLatestBundleJob(ref)).toEqual({
      projectId: ref.projectId,
      jobId: 'newest-job',
    });
  });
  it('duplicate old signals do not regenerate an already completed desired job', async () => {
    (firebaseAdmin.firestore as unknown as jest.Mock).mockReturnValue({
      collection: (name: string) => ({
        doc: () => ({
          get: async () => ({
            data: () =>
              name === 'durableJobEntities'
                ? { projectId: ref.projectId, activeJobId: 'newest-job' }
                : { projectId: ref.projectId, kind: 'bundle.regenerate', entity: { id: 'topics' }, state: 'succeeded' },
          }),
        }),
      }),
    });
    expect(await createBundleActivities(store).resolveLatestBundleJob(ref)).toBeNull();
    expect(generateAndStoreBundle).not.toHaveBeenCalled();
  });

  it('writes an immutable artifact and publishes its transaction-fenced pointer', async () => {
    await createBundleActivities(store).regenerateBundle(ref);
    expect(generateAndStoreBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        bundlePath: expect.stringMatching(/^bundles\/durable\/topics\/bundle-job\/[a-f0-9-]+\.bin$/),
      }),
      undefined,
      { publishMetadata: false }
    );
    expect(writes.get('_durableBundlePointers/topics')).toMatchObject({
      jobId: 'bundle-job',
      generation: 2,
      count: 20,
    });
    expect(metadataTransaction).toHaveBeenCalledTimes(1);
  });
  it('a newer entity generation prevents stale pointer and metadata writes', async () => {
    (store.assertCurrentInTransaction as jest.Mock)
      .mockResolvedValueOnce({ generation: 2 })
      .mockRejectedValueOnce(Object.assign(new Error('old generation'), { code: 'STALE_GENERATION' }));
    await createBundleActivities(store).regenerateBundle(ref);
    expect(writes.has('_durableBundlePointers/topics')).toBe(false);
    expect(metadataTransaction).not.toHaveBeenCalled();
    expect(store.recordStep).not.toHaveBeenCalled();
  });
  it('does not regress newer RTDB metadata when projection is delayed', async () => {
    let projection: unknown;
    metadataTransaction.mockImplementation(async (update: (current: unknown) => unknown) => {
      projection = update({ generation: 3, storagePath: 'newer' });
    });
    await createBundleActivities(store).regenerateBundle(ref);
    expect(projection).toBeUndefined();
  });
});
