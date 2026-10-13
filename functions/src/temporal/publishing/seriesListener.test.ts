let mockState: Record<string, unknown> | undefined;
let mockRows: Array<{ publishedToSubsplash: boolean }> = [];
let mockTemporal = true;
const mockEnqueue = jest.fn();
const mockPatch = jest.fn();
const mockUpdate = jest.fn((ref: { path: string }, patch: Record<string, unknown>) => {
  if (!mockState) throw new Error('Missing series');
  Object.assign(mockState, patch);
  if (patch._durableMetadataPendingEventId !== undefined && typeof patch._durableMetadataPendingEventId !== 'string')
    delete mockState._durableMetadataPendingEventId;
});
const ref = (path: string, published = false): any => ({
  path,
  where: () => ref(path, true),
  count: () => ({ path, aggregate: true, published }),
  doc: (id: string) => ref(`${path}/${id}`),
  collection: (id: string) => ref(`${path}/${id}`),
});
const mockDb = {
  collection: (path: string) => ref(path),
  runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      get: async (reference: { path: string; aggregate?: boolean; published?: boolean }) =>
        reference.aggregate
          ? {
              data: () => ({
                count: reference.published
                  ? mockRows.filter((row) => row.publishedToSubsplash).length
                  : mockRows.length,
              }),
            }
          : reference.path.endsWith('/seriesItems')
          ? { docs: mockRows.map((row) => ({ data: () => row })) }
          : { exists: Boolean(mockState), data: () => mockState, get: (key: string) => mockState?.[key] },
      update: mockUpdate,
    }),
};
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => mockDb },
}));
jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (_options: unknown, handler: unknown) => handler,
}));
jest.mock('firebase-functions/v2', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.mock('../../subsplashSecrets', () => ({ subsplashSecretsWithRuntimeAlerts: [] }));
jest.mock('../../subsplashUtils', () => ({ authenticateSubsplash: async () => 'token' }));
jest.mock('../../handleError', () => ({ __esModule: true, default: (error: unknown) => error }));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: async (_keys: unknown, run: () => Promise<unknown>) => run(),
}));
jest.mock('../ownership', () => ({ isDomainTemporalEnabled: () => mockTemporal }));
jest.mock('../bridge', () => ({ enqueueSystemJob: (...args: unknown[]) => mockEnqueue(...args) }));
jest.mock('../../helpers/seriesHelpers', () => ({
  ...jest.requireActual('../../helpers/seriesHelpers'),
  patchSeriesMetadata: (...args: unknown[]) => mockPatch(...args),
}));
import { deriveCurrentSeriesMetadata, handleSeriesItemWrite } from '../../DocumentListeners/Series/seriesItemOnWrite';
beforeEach(() => {
  jest.clearAllMocks();
  mockTemporal = true;
  mockState = { subsplashId: 'remote', subtitle: '0 part series', itemCount: 0, publishedItemCount: 0 };
  mockRows = [{ publishedToSubsplash: true }, { publishedToSubsplash: false }];
  mockEnqueue.mockResolvedValue({ jobId: 'queued' });
});
it('derives current rows and skips redundant duplicate metadata writes', async () => {
  await deriveCurrentSeriesMetadata('series');
  await deriveCurrentSeriesMetadata('series');
  expect(mockState).toMatchObject({ itemCount: 2, publishedItemCount: 1, subtitle: '1 part series' });
  expect(mockUpdate).toHaveBeenCalledTimes(1);
});
it('does not recreate metadata after the series was deleted', async () => {
  mockState = undefined;
  await expect(deriveCurrentSeriesMetadata('series')).resolves.toBeUndefined();
  expect(mockUpdate).not.toHaveBeenCalled();
});
it('durable listener admits subtitle sync without performing provider work', async () => {
  await handleSeriesItemWrite({ id: 'event-1', params: { seriesId: 'series' } });
  expect(mockEnqueue).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'series.sync_metadata', payload: {}, eventId: 'event-1' })
  );
  expect(mockPatch).not.toHaveBeenCalled();
  expect(mockState?._durableMetadataPendingEventId).toBeUndefined();
});
it('preserves the pending event across a failed admission, then retries it after counts were written', async () => {
  mockEnqueue.mockRejectedValueOnce(new Error('bridge unavailable'));
  await expect(handleSeriesItemWrite({ id: 'event-1', params: { seriesId: 'series' } })).rejects.toThrow(
    'bridge unavailable'
  );
  expect(mockState?._durableMetadataPendingEventId).toBe('event-1');
  await handleSeriesItemWrite({ id: 'event-1', params: { seriesId: 'series' } });
  expect(mockEnqueue).toHaveBeenCalledTimes(2);
  expect(mockState?._durableMetadataPendingEventId).toBeUndefined();
  expect(mockPatch).not.toHaveBeenCalled();
});
it('keeps legacy provider sync using fresh current derived metadata', async () => {
  mockTemporal = false;
  await handleSeriesItemWrite({ id: 'event-1', params: { seriesId: 'series' } });
  expect(mockPatch).toHaveBeenCalledWith('remote', { subtitle: '1 part series' }, 'token');
  expect(mockEnqueue).not.toHaveBeenCalled();
});
