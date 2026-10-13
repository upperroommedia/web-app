jest.mock('axios', () => ({ __esModule: true, default: (...args: unknown[]) => mockHttp(...args) }));
jest.mock('./durableOperationContext', () => ({
  ...jest.requireActual('./durableOperationContext'),
  releaseCanonicalProviderBindingsForCurrentJob: async () => undefined,
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { auth: () => ({ getUser: mockGetUser }), firestore: () => mockDb },
}));
jest.mock('../../createNewSubsplashList', () => ({
  createNewSubsplashListDomain: (...args: unknown[]) => mockCreateList(...args),
}));
jest.mock('../../editSubsplashList', () => ({
  editSubsplashListDomain: (...args: unknown[]) => mockEditList(...args),
}));
jest.mock('../../deleteSubsplashList', () => ({ deleteSubsplashListDomain: jest.fn() }));
jest.mock('../../markListOverflowLink', () => ({ markListOverflowLinkDomain: jest.fn() }));
jest.mock('../../addToList', () => ({ addToListDomain: jest.fn() }));
jest.mock('../../removeFromList', () => ({ removeFromListDomain: jest.fn() }));
jest.mock('../../reorderListItems', () => ({ reorderListItemsDomain: jest.fn() }));
jest.mock('../../createSeries', () => ({ createSeriesDomain: jest.fn() }));
jest.mock('../../updateSeriesMetadata', () => ({ updateSeriesMetadataDomain: jest.fn() }));
jest.mock('../../deleteSeries', () => ({ deleteSeriesDomain: jest.fn() }));
jest.mock('../../bulkAddToSeries', () => ({ bulkAddToSeriesDomain: jest.fn() }));
jest.mock('../../removeFromSeries', () => ({ removeFromSeriesDomain: jest.fn() }));
jest.mock('../../reorderSeriesItems', () => ({ reorderSeriesItemsDomain: jest.fn() }));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: async () => 'token',
  createAxiosConfig: (url: string, _token: string, method: string) => ({ url, method }),
}));
jest.mock('../../helpers/publishedListDrift', () => ({
  auditPublishedListDrift: jest.fn(),
  resolvePublishedListDrift: jest.fn(),
}));
jest.mock('../../helpers/seriesHelpers', () => ({
  getSeriesItems: jest.fn(),
  getAllSeriesItemsAcrossStatuses: (...args: unknown[]) => mockGetRemote(...args),
}));
jest.mock('../../helpers/seriesRemoteState', () => ({ createSeriesMediaItemMembershipHash: jest.fn() }));
jest.mock('../../speakers/speakerMutations', () => ({
  parseCreateSpeakerInput: (value: unknown) => value,
  parseUpdateSpeakerInput: (value: unknown) => value,
  parseDeleteSpeakerInput: (value: unknown) => value,
}));
jest.mock('./firebaseDependencies', () => ({ createFirebasePublishingDependencies: jest.fn() }));
jest.mock('./providerReceipts', () => ({
  executeProviderCreate: jest.fn(),
  providerPayloadFingerprint: (value: unknown) => JSON.stringify(value),
  providerReceiptId: (key: string, step: string) => JSON.stringify([key, step]),
  readProviderReceipt: (...args: unknown[]) => mockReadReceipt(...args),
}));
jest.mock('./maintenance', () => ({ normalizeMaintenanceInput: jest.fn(), executeMaintenancePage: jest.fn() }));
import {
  completeReviewedListCreate,
  executePublishingEntityOperation,
  normalizePublishingEntityPayload,
  normalizePublishingEntityAdmission,
} from './entityMutations';
const mockHttp = jest.fn(),
  mockReadReceipt = jest.fn();
const checkpointRecords = new Map<string, Record<string, unknown>>();
const sourceRef = (path: string) => ({
  path,
  get: async () => ({
    exists: checkpointRecords.has(path),
    data: () => checkpointRecords.get(path),
    get: (key: string) => checkpointRecords.get(path)?.[key],
  }),
  set: (data: Record<string, unknown>) => checkpointRecords.set(path, data),
  update: (data: Record<string, unknown>) => checkpointRecords.set(path, { ...checkpointRecords.get(path), ...data }),
});
const mockGetUser = jest.fn();
const mockCreateList = jest.fn();
const mockEditList = jest.fn();
const mockSet = jest.fn();
const mockUpdate = jest.fn();
const mockGet = jest.fn();
const mockGetAll = jest.fn();
const mockGetRemote = jest.fn();
const mockDb = {
  doc: (path: string) =>
    path.startsWith('temporalPublishingListCreationState/')
      ? sourceRef(path)
      : { path, set: mockSet, update: mockUpdate, get: mockGet },
  getAll: mockGetAll,
  runTransaction: async (fn: (tx: unknown) => Promise<void>) =>
    fn({
      create: (ref: { set: (...args: unknown[]) => unknown }, ...args: unknown[]) => ref.set(...args),
      get: (ref: { get: () => unknown }) => ref.get(),
      set: (ref: { set: (...args: unknown[]) => unknown }, ...args: unknown[]) => ref.set(...args),
      update: (ref: { update: (...args: unknown[]) => unknown }, ...args: unknown[]) => ref.update(...args),
    }),
  collection: jest.fn(() => ({ doc: jest.fn(() => ({ set: mockSet, update: mockUpdate, get: mockGet })) })),
};
const ref = { projectId: 'urm-app-staging', jobId: 'job-1' };
beforeEach(() => {
  checkpointRecords.clear();
  jest.clearAllMocks();
  mockGetUser.mockResolvedValue({ uid: 'admin-1', customClaims: { role: 'admin' }, disabled: false });
  mockCreateList.mockResolvedValue({ listId: 'remote-id' });
  mockGet.mockResolvedValue({ exists: true, data: () => ({ name: 'Draft' }) });
});
describe('immutable entity intent normalization', () => {
  it('preserves local list drafts and ignores client operation keys', () => {
    const out = normalizePublishingEntityPayload('list.create', {
      input: {
        localList: { name: 'Draft', type: 'series', overflowBehavior: 'CREATENEWLIST', images: [] },
        skipSubsplash: true,
        operationKey: 'client-key',
      },
    });
    expect(out.operation).toBe('create');
    expect(out.input.title).toBe('Draft');
    expect(out.input.operationKey).toBeUndefined();
    expect(Object.isFrozen(out.input)).toBe(true);
  });
  it.each([
    ['list.delete', { operation: 'arbitrary', input: {} }],
    ['list.create', { input: { title: 'List', admin: true } }],
    ['list.create', { input: { title: 'List', localList: { subsplashId: 'hijacked' } } }],
    ['series.publish', { input: { sermonIds: ['same', 'same'] } }],
    ['series.publish', { input: { sermonIds: ['../escape'] } }],
    ['series.membership', { operation: 'add', input: { sermonIds: ['s'], publishEligible: 'yes' } }],
    ['list.reconcile', { operation: 'resolve', input: { strategy: 'DELETE' } }],
    ['series.create', { input: { title: '', ownerId: 'other' } }],
  ])('rejects invalid or privileged input %s', (kind, payload) =>
    expect(() =>
      normalizePublishingEntityPayload(kind as Parameters<typeof normalizePublishingEntityPayload>[0], payload)
    ).toThrow()
  );
  it('deep clones nested arrays so caller mutation cannot change intent', () => {
    const images = [{ id: 'image', type: 'square' }];
    const out = normalizePublishingEntityPayload('list.create', { input: { title: 'Title', images } });
    images[0].id = 'changed';
    expect((out.input.images as typeof images)[0].id).toBe('image');
  });
});
describe('concrete entity execution', () => {
  it('creates a local draft without a provider operation', async () => {
    const out = await executePublishingEntityOperation(ref, {
      actorUid: 'admin-1',
      kind: 'list.create',
      entity: { type: 'list', id: 'canonical-id' },
      payload: {
        input: {
          localList: { name: 'Draft', type: 'series', overflowBehavior: 'ERROR', images: [] },
          skipSubsplash: true,
        },
      },
    });
    expect(mockCreateList).not.toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'canonical-id', name: 'Draft', overflowBehavior: 'ERROR' }),
      { merge: true }
    );
    expect(out).toEqual({ listId: 'canonical-id' });
  });
  it('creates remote lists with a server key and returns safe IDs only', async () => {
    const out = await executePublishingEntityOperation(ref, {
      actorUid: 'admin-1',
      kind: 'list.create',
      entity: { type: 'list', id: 'canonical-id' },
      payload: { input: { title: 'Title', operationKey: 'client-key' } },
    });
    expect(mockCreateList).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ operationKey: 'durable:urm-app-staging:job-1:list.create:create' }),
      })
    );
    expect(out).toEqual({ listId: 'canonical-id', subsplashId: 'remote-id' });
  });
  it('checks generation before any side effect', async () => {
    await expect(
      executePublishingEntityOperation(
        ref,
        {
          actorUid: 'admin-1',
          kind: 'list.create',
          entity: { type: 'list', id: 'l' },
          payload: { input: { title: 'Title' } },
        },
        {
          assertCurrent: async () => {
            throw new Error('superseded');
          },
        }
      )
    ).rejects.toThrow('superseded');
    expect(mockCreateList).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });
  it('does not perform provider writes when permission was revoked', async () => {
    mockGetUser.mockResolvedValue({ uid: 'admin-1', customClaims: { role: 'user' } });
    await expect(
      executePublishingEntityOperation(ref, {
        actorUid: 'admin-1',
        kind: 'list.create',
        entity: { type: 'list', id: 'l' },
        payload: { input: { title: 'Title' } },
      })
    ).rejects.toThrow('permission');
    expect(mockCreateList).not.toHaveBeenCalled();
  });
  it('updates unlinked draft metadata without a provider call', async () => {
    await executePublishingEntityOperation(ref, {
      actorUid: 'admin-1',
      kind: 'list.update',
      entity: { type: 'list', id: 'l' },
      payload: { input: { title: 'New', localList: { overflowBehavior: 'REMOVEOLDEST' } } },
    });
    expect(mockEditList).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ name: 'New', overflowBehavior: 'REMOVEOLDEST' }));
  });
});

describe('canonical admission authority', () => {
  it('strips provider identities and operation keys from client intent', async () => {
    const out = await normalizePublishingEntityAdmission({
      kind: 'list.publish',
      entity: { type: 'list', id: 'l' },
      actorUid: 'admin-1',
      role: 'admin',
      payload: {
        input: { sermonIds: ['s'], mediaItem: { id: 'untrusted' }, itemIds: ['untrusted'], operationKey: 'untrusted' },
      },
    });
    expect(out).toEqual({ operation: 'publish', input: { sermonIds: ['s'] } });
  });
  it('requires canonical selections rather than a raw remote ID', async () => {
    await expect(
      normalizePublishingEntityAdmission({
        kind: 'list.membership',
        entity: { type: 'list', id: 'l' },
        actorUid: 'admin-1',
        role: 'admin',
        payload: { operation: 'add', input: { mediaItem: { id: 'untrusted' } } },
      })
    ).rejects.toThrow('canonical sermon');
  });
  it('rejects a different series owner', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ ownerId: 'other' }) });
    await expect(
      normalizePublishingEntityAdmission({
        kind: 'series.update',
        entity: { type: 'series', id: 'series' },
        actorUid: 'publisher',
        role: 'publisher',
        payload: { input: { title: 'Title' } },
      })
    ).rejects.toThrow('own this series');
  });
  it('rejects entity type confusion', async () => {
    await expect(
      normalizePublishingEntityAdmission({
        kind: 'series.delete',
        entity: { type: 'list', id: 'l' },
        actorUid: 'admin-1',
        role: 'admin',
        payload: { input: {} },
      })
    ).rejects.toThrow('Entity type');
  });
});

describe('canonical image hydration', () => {
  it('replaces client image URLs and provider IDs with the authorized document', async () => {
    mockGetAll.mockResolvedValue([
      {
        exists: true,
        id: 'canonical-image',
        data: () => ({
          type: 'square',
          downloadLink: 'https://storage.googleapis.com/canonical',
          subsplashId: 'remote-canonical',
        }),
      },
    ]);
    const out = await normalizePublishingEntityAdmission({
      kind: 'list.create',
      entity: { type: 'list', id: 'l' },
      actorUid: 'admin-1',
      role: 'admin',
      payload: {
        input: {
          title: 'Title',
          images: [{ id: 'canonical-image', downloadLink: 'https://evil.invalid', subsplashId: 'forged' }],
        },
      },
    });
    expect(out.input.images).toEqual([
      {
        id: 'canonical-image',
        type: 'square',
        downloadLink: 'https://storage.googleapis.com/canonical',
        subsplashId: 'remote-canonical',
      },
    ]);
  });
});

describe('remote-only series removal admission', () => {
  it('admits only selected IDs that the authoritative owned series currently contains', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ subsplashId: 'owned-remote', ownerId: 'admin-1' }) });
    mockGetRemote.mockResolvedValue([{ id: 'remove' }, { id: 'keep' }]);
    const out = await normalizePublishingEntityAdmission({
      kind: 'series.membership',
      entity: { type: 'series', id: 'series' },
      actorUid: 'admin-1',
      role: 'admin',
      payload: {
        operation: 'remove',
        input: { sermonIds: [], mediaItemIds: ['remove'], expectedRetainedMembershipHash: 'forged' },
      },
    });
    expect(out.input.mediaItemIds).toEqual(['remove']);
    expect(out.input.expectedRetainedMembershipHash).toEqual(JSON.stringify(['keep']));
  });
  it('rejects a raw provider selector outside the owned series', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ subsplashId: 'owned-remote', ownerId: 'admin-1' }) });
    mockGetRemote.mockResolvedValue([{ id: 'keep' }]);
    await expect(
      normalizePublishingEntityAdmission({
        kind: 'series.membership',
        entity: { type: 'series', id: 'series' },
        actorUid: 'admin-1',
        role: 'admin',
        payload: { operation: 'remove', input: { mediaItemIds: ['foreign'] } },
      })
    ).rejects.toThrow('no longer belong');
  });
});

describe('reviewed list creation projection', () => {
  const intent = {
    actorUid: 'admin-1',
    kind: 'list.create' as const,
    entity: { type: 'list' as const, id: 'canonical-id' },
    generation: 1,
    payload: { input: { title: 'Title' } },
  };
  const plan = {
    kind: 'list.create',
    entity: intent.entity,
    generation: 1,
    continuation: 'reviewed-create' as const,
    receiptId: JSON.stringify(['durable:urm-app-staging:job-1:list.create:create', 'list-create']),
    receiptStep: 'list-create',
  };
  it('continues the frozen projection after a confirmed allocation without repeating create', async () => {
    mockCreateList.mockRejectedValueOnce(new Error('review required'));
    await expect(executePublishingEntityOperation(ref, intent)).rejects.toThrow('review required');
    mockReadReceipt.mockResolvedValue({
      state: 'confirmed',
      projectId: ref.projectId,
      jobId: ref.jobId,
      operationKey: 'durable:urm-app-staging:job-1:list.create:create',
      providerAccount: { provider: 'subsplash', account: 'app:9XTSHD' },
      result: { listId: 'remote-id' },
    });
    mockHttp.mockResolvedValue({ status: 200, data: { id: 'remote-id', app_key: '9XTSHD' } });
    expect(await completeReviewedListCreate(ref, intent, plan, {})).toEqual({
      listId: 'canonical-id',
      subsplashId: 'remote-id',
    });
    expect(mockCreateList).toHaveBeenCalledTimes(1);
    expect(mockHttp).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET' }));
  });
  it('refuses a changed local document after allocation was reviewed', async () => {
    mockCreateList.mockRejectedValueOnce(new Error('review required'));
    await expect(executePublishingEntityOperation(ref, intent)).rejects.toThrow();
    mockReadReceipt.mockResolvedValue({
      state: 'confirmed',
      projectId: ref.projectId,
      jobId: ref.jobId,
      operationKey: 'durable:urm-app-staging:job-1:list.create:create',
      providerAccount: { provider: 'subsplash', account: 'app:9XTSHD' },
      result: { listId: 'remote-id' },
    });
    mockHttp.mockResolvedValue({ status: 200, data: { id: 'remote-id', app_key: '9XTSHD' } });
    mockGet.mockResolvedValue({ exists: true, data: () => ({ name: 'Changed' }) });
    await expect(completeReviewedListCreate(ref, intent, plan, {})).rejects.toThrow('list changed');
    expect(mockSet).not.toHaveBeenCalled();
  });
});
