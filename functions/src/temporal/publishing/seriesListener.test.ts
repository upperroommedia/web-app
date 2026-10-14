let mockState: Record<string, unknown> | undefined;
let mockContinuation: Record<string, unknown> | undefined;
let mockRows: Array<{ publishedToSubsplash: boolean }> = [];
let mockTemporal = true;
let mockRevision = 0;
const mockEnqueue = jest.fn();
const mockPatch = jest.fn();
const mockLifetimeLease = {
  leaseId: 'unit-series-lease',
  markEffectsStarted: jest.fn(async () => undefined),
  heartbeat: jest.fn(async () => undefined),
};
jest.mock('../legacyAdmissionLease', () => ({
  withLegacyAdmissionLease: async (
    _db: unknown,
    _options: unknown,
    run: (lease: typeof mockLifetimeLease) => Promise<unknown>
  ) => run(mockLifetimeLease),
}));
const mockLegacy = jest.fn(async (input: { effect(): Promise<void> }) => input.effect());
const providerEvent = {
  id: 'event-1',
  time: '2026-01-01T00:00:00.000000001Z',
  sourceCreatedAt: { seconds: 2, nanoseconds: 0 },
  params: { seriesId: 'series' },
};
const mockSnapshot = (path = 'series/series') =>
  path.startsWith('seriesMetadataContinuations/')
    ? { exists: Boolean(mockContinuation), data: () => mockContinuation }
    : {
        exists: Boolean(mockState),
        createTime: { seconds: 1, nanoseconds: 0 },
        updateTime: { seconds: 3, nanoseconds: mockRevision },
        data: () => mockState,
        get: (key: string) => mockState?.[key],
      };
const mockUpdate = jest.fn((ref: { path: string }, patch: Record<string, unknown>) => {
  if (ref.path.startsWith('seriesMetadataContinuations/')) {
    Object.assign(mockContinuation!, patch);
    return;
  }
  if (!mockState) throw new Error('Missing series');
  Object.assign(mockState, patch);
  mockRevision++;
  if (patch._durableMetadataPendingEvent !== undefined && !(patch._durableMetadataPendingEvent as { id?: string }).id)
    delete mockState._durableMetadataPendingEvent;
  if (patch._durableMetadataPendingEventId !== undefined && typeof patch._durableMetadataPendingEventId !== 'string')
    delete mockState._durableMetadataPendingEventId;
});
const ref = (path: string, published = false): any => ({
  path,
  get: async () => mockSnapshot(path),
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
          : mockSnapshot(reference.path),
      update: mockUpdate,
      set: (reference: { path: string }, data: Record<string, unknown>) => {
        if (reference.path.startsWith('seriesMetadataContinuations/')) mockContinuation = data;
        else throw new Error('Unexpected set');
      },
    }),
};
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => mockDb, app: () => ({ options: { projectId: 'urm-app' } }) },
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
jest.mock('../../DocumentListeners/providerListenerContinuation', () => ({
  ...jest.requireActual('../../DocumentListeners/providerListenerContinuation'),
  assertProviderListenerEventInTransaction: async () => undefined,
  runLegacyProviderListener: (input: { effect(): Promise<void> }) => mockLegacy(input),
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
  mockRevision = 0;
  mockContinuation = undefined;
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
  await handleSeriesItemWrite(providerEvent);
  expect(mockEnqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'series.sync_metadata',
      payload: {},
      eventId: expect.stringMatching(/^series-metadata-[a-f0-9]{64}$/),
    })
  );
  expect(mockPatch).not.toHaveBeenCalled();
  expect(mockState?._durableMetadataPendingEventId).toBeUndefined();
});
it('preserves the pending event across a failed admission, then retries it after counts were written', async () => {
  mockEnqueue.mockRejectedValueOnce(new Error('bridge unavailable'));
  await expect(handleSeriesItemWrite(providerEvent)).rejects.toThrow('bridge unavailable');
  const pendingId = mockState?._durableMetadataPendingEventId;
  expect(pendingId).toMatch(/^series-metadata-[a-f0-9]{64}$/);
  await handleSeriesItemWrite(providerEvent);
  expect(mockEnqueue).toHaveBeenCalledTimes(2);
  expect(mockEnqueue.mock.calls[1][0].eventId).toBe(pendingId);
  expect(mockState?._durableMetadataPendingEventId).toBeUndefined();
  expect(mockPatch).not.toHaveBeenCalled();
});
it('keeps legacy provider sync using fresh current derived metadata', async () => {
  mockTemporal = false;
  await handleSeriesItemWrite(providerEvent);
  expect(mockPatch).toHaveBeenCalledWith('remote', { subtitle: '1 part series' }, 'token');
  expect(mockEnqueue).not.toHaveBeenCalled();
});

it('a duplicate old event observing a new projection gets a new durable job identity, including A -> B -> A', async () => {
  await handleSeriesItemWrite(providerEvent);
  const first = mockEnqueue.mock.calls[0][0].eventId;
  mockRows.push({ publishedToSubsplash: true });
  await handleSeriesItemWrite(providerEvent);
  const second = mockEnqueue.mock.calls[1][0].eventId;
  mockRows.pop();
  await handleSeriesItemWrite(providerEvent);
  const third = mockEnqueue.mock.calls[2][0].eventId;
  expect(new Set([first, second, third]).size).toBe(3);
  await handleSeriesItemWrite({ ...providerEvent, id: 'actual-newer-event' });
  expect(mockEnqueue).toHaveBeenCalledTimes(3);
  expect(mockState?._durableMetadataPendingEventId).toBeUndefined();
});
