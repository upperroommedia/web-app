jest.mock('axios', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../subsplashUtils', () => ({ createAxiosConfig: jest.fn() }));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    app: () => ({ options: { projectId: 'project' } }),
    firestore: () => {
      throw new Error('Unexpected native datastore access');
    },
    auth: () => {
      throw new Error('Unexpected native auth access');
    },
    storage: () => {
      throw new Error('Unexpected native storage access');
    },
  },
}));

test('cold projection-first module loading retains the live destination digest function', async () => {
  let rejected: Promise<unknown> | undefined;
  jest.isolateModules(() => {
    // This is the production worker import order which previously captured the
    // not-yet-initialized digest export in the circular deletion helper.
    const projection = require('../temporal/publishing/criticalAcknowledgedRepair');
    const destinations = require('./sermonDeletionDestinations');
    const context = require('../temporal/publishing/durableOperationContext');
    expect(typeof projection.acknowledgedProjectionDigest).toBe('function');
    const intent = {
      projectId: 'project',
      kind: 'sermon.delete',
      generation: 1,
      entity: { type: 'sermon', id: 'sermon' },
      payload: { sermonId: 'sermon', action: 'delete' },
    };
    const snapshot = (path: string) => ({
      exists: path === 'durableJobIntents/job',
      data: () => (path === 'durableJobIntents/job' ? intent : undefined),
      get: (field: string) => (field === 'projectId' ? 'project' : undefined),
    });
    const db = { doc: (path: string) => ({ path, get: async () => snapshot(path) }) };
    const tx = { get: async (ref: { path: string }) => snapshot(ref.path) };
    rejected = context.runDurablePublishingOperation(
      'job',
      () =>
        destinations.captureSermonDeletionDestinations(
          db,
          { projectId: 'project', jobId: 'job', sermonId: 'sermon', mediaId: 'media' },
          'synthetic-token'
        ),
      (mutate: (transaction: typeof tx) => Promise<unknown>) => mutate(tx)
    );
  });
  // Authority must hash the valid private intent, then reject the absent root;
  // it must not fail with a captured undefined digest or perform provider work.
  await expect(rejected).rejects.toThrow('SERMON_DELETION_DESTINATION_PROOF_INVALID');
  expect(jest.requireMock('axios').default).not.toHaveBeenCalled();
});
