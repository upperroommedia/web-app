jest.mock('./bindingReconciliation', () => ({ releaseCancelledProviderBindings: async () => 'completed' }));
const mockUsageClaim = jest.fn().mockResolvedValue({ state: 'reserved', commit: () => undefined });
const mockUsageSettle = jest.fn().mockResolvedValue(() => undefined);
jest.mock('../../../../packages/orchestration/src/provider-usage', () => ({
  prepareProviderCleanupClaim: (...args: unknown[]) => mockUsageClaim(...args),
  prepareProviderCleanupSettlement: (...args: unknown[]) => mockUsageSettle(...args),
}));
const mockAuth = jest.fn().mockResolvedValue('service-token');
const mockHttp = jest.fn();
const mockActor = jest.fn();
const mockCheckpointGet = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: Object.assign((...args: unknown[]) => mockHttp(...args), { get: (...args: unknown[]) => mockHttp(...args) }),
}));
const mockQuery = {
  where: () => mockQuery,
  limit: () => mockQuery,
  get: async () => ({ empty: true, docs: [], size: 0 }),
};
const mockDb = { collection: () => ({ ...mockQuery, doc: (id: string) => ({ id, get: mockCheckpointGet }) }) };
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => mockDb, auth: () => ({ getUser: mockActor }) },
}));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: (...args: unknown[]) => mockAuth(...args),
  createAxiosConfig: (url: string, _token: string, method: string) => ({ url, method }),
}));
jest.mock('../../soundcloudSecrets', () => ({ runWithSoundCloudAccessToken: jest.fn(async (run) => run('token')) }));
jest.mock('../../soundcloudClient', () => ({
  deleteTrack: jest.fn(),
  normalizeSoundCloudAccountId: jest.requireActual('../../soundcloudClient').normalizeSoundCloudAccountId,
}));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: async (_keys: unknown, run: () => Promise<unknown>) => run(),
}));
jest.mock('./providerReceipts', () => ({
  listProviderReceiptsForJob: jest.fn(),
  listProviderAcknowledgementsForJob: jest.fn().mockResolvedValue([]),
  acknowledgementHasReviewedDisposition: jest.requireActual('./providerReceipts').acknowledgementHasReviewedDisposition,
  isProviderReceiptExplicitlyRetained: jest.requireActual('./providerReceipts').isProviderReceiptExplicitlyRetained,
}));
import {
  cancelPublishingEffects,
  type PublishingCancellationDependencies,
  createFirebasePublishingCancellationDependencies,
  verifyPublishingCancellationFetchSettled,
} from './cancellation';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { PrivatePublishingIntent } from './types';
import type { ProviderReceipt } from './providerReceipts';
import type { Transaction } from 'firebase-admin/firestore';
const ref = { projectId: 'test', jobId: 'job' } as DurableJobRef;
const intent = { sermonId: 'sermon' } as PrivatePublishingIntent;
const receipt = (step: string, state: ProviderReceipt['state'] = 'confirmed', id = step) => ({
  receiptId: 'a'.repeat(64),
  receipt: {
    projectId: 'test',
    jobId: 'job',
    step,
    state,
    result: { id },
    fingerprint: 'f'.repeat(64),
    revision: 2,
    updatedAtMillis: 1,
  } as ProviderReceipt,
});
function fixture(rows: ReturnType<typeof receipt>[]) {
  const set = jest.fn();
  const store = {
    assertCurrent: jest.fn(),
    commitCurrent: jest.fn(async (_ref, run: (tx: Transaction) => Promise<void>) =>
      run({ set } as unknown as Transaction)
    ),
  };
  const deps: PublishingCancellationDependencies = {
    listReceipts: jest.fn().mockResolvedValue(rows),
    listAcknowledgements: jest.fn().mockResolvedValue([]),
    inspect: jest.fn(),
    releaseBindings: jest.fn().mockResolvedValue('completed'),
    claim: jest.fn().mockResolvedValue('reserved'),
    settle: jest.fn(),
    delete: jest.fn(),
    withLock: async (_allocation, run) => run(),
  };
  return { set, store, deps };
}
it.each(['executing', 'needs_review'] as const)(
  'keeps cancellation live for an unresolved %s allocation without dispatching cleanup',
  async (state) => {
    const { store, deps } = fixture([receipt('subsplash-media-item', state)]);
    expect(await cancelPublishingEffects(ref, intent, store, deps)).toEqual({
      state: 'needs_review',
      code: 'PROVIDER_CREATE_AMBIGUOUS',
      receiptId: 'a'.repeat(64),
    });
    expect(deps.inspect).not.toHaveBeenCalled();
    expect(deps.delete).not.toHaveBeenCalled();
  }
);
it('deletes only proven unreferenced fixed IDs in dependency order and verifies absence', async () => {
  const { store, deps, set } = fixture([receipt('subsplash-audio'), receipt('subsplash-media-item')]);
  const gone = new Set<string>();
  (deps.inspect as jest.Mock).mockImplementation(async (allocation) =>
    gone.has(allocation.remoteId) ? 'absent' : 'unreferenced'
  );
  (deps.delete as jest.Mock).mockImplementation(async (allocation) => {
    gone.add(allocation.remoteId);
  });
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toEqual({ state: 'completed' });
  expect((deps.delete as jest.Mock).mock.calls.map(([allocation]) => allocation.receipt.step)).toEqual([
    'subsplash-media-item',
    'subsplash-audio',
  ]);
  expect(set.mock.calls.filter(([, data]) => data.state === 'deleted')).toHaveLength(2);
});
it('retains confirmed canonical resources without deleting the existing publication', async () => {
  const { store, deps, set } = fixture([receipt('subsplash-media-item')]);
  (deps.inspect as jest.Mock).mockResolvedValue('referenced');
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toEqual({ state: 'completed' });
  expect(deps.delete).not.toHaveBeenCalled();
  expect(set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: 'retained' }), { merge: true });
});
it('replays a fixed-ID cleanup safely after a lost delete response by proving current absence', async () => {
  const { store, deps } = fixture([receipt('subsplash-media-item')]);
  (deps.inspect as jest.Mock).mockResolvedValue('absent');
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toEqual({ state: 'completed' });
  expect(deps.delete).not.toHaveBeenCalled();
});
it('does not declare cleanup drained when deletion or reference proof is unavailable', async () => {
  const { store, deps, set } = fixture([receipt('subsplash-media-item')]);
  (deps.inspect as jest.Mock).mockResolvedValue('unreferenced');
  (deps.delete as jest.Mock).mockRejectedValue(new Error('private provider URL'));
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toEqual({
    state: 'blocked',
    code: 'PUBLISHING_CANCEL_CLEANUP_REQUIRED',
    receiptId: 'a'.repeat(64),
  });
  expect(set.mock.calls.some(([, data]) => data.state === 'deleted')).toBe(false);
});

it('uses service cleanup authority to delete a confirmed orphan audio after the original actor loses permission', async () => {
  const { store } = fixture([]);
  mockActor.mockResolvedValue({ disabled: true, customClaims: { role: 'user' } });
  const entry = receipt('subsplash-audio', 'confirmed', 'orphan-audio');
  const deps = createFirebasePublishingCancellationDependencies();
  deps.listReceipts = jest.fn().mockResolvedValue([entry]);
  let deleted = false;
  mockHttp.mockImplementation(async (config) => {
    if (config.method === 'DELETE') {
      deleted = true;
      return { status: 204 };
    }
    if (config.url.includes('media-items?')) return { data: { _embedded: { 'media-items': [] } } };
    if (deleted) throw { response: { status: 404 } };
    return { data: { id: 'orphan-audio', app_key: '9XTSHD' } };
  });
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toEqual({ state: 'completed' });
  expect(mockHttp.mock.calls.map(([config]) => config.method)).toEqual(['GET', 'GET', 'DELETE', 'GET']);
  expect(mockActor).not.toHaveBeenCalled();
  expect(mockHttp.mock.calls.some(([config]) => config.method === 'POST')).toBe(false);
});

it('does not reuse a terminal-fetch proof after adoption changes a receipt ID, fingerprint or revision', async () => {
  const entry = receipt('subsplash-transcode');
  const checkpoint = {
    projectId: 'test',
    jobId: 'job',
    receiptId: entry.receiptId,
    remoteId: 'subsplash-transcode',
    providerReceiptFingerprint: entry.receipt.fingerprint,
    receiptRevision: 2,
    state: 'retained',
    fetchSettled: true,
  };
  mockCheckpointGet.mockResolvedValue({ get: (key: string) => checkpoint[key as keyof typeof checkpoint] });
  expect(await verifyPublishingCancellationFetchSettled(ref, entry.receiptId, entry.receipt)).toBe(true);
  expect(
    await verifyPublishingCancellationFetchSettled(ref, entry.receiptId, {
      ...entry.receipt,
      result: { id: 'adopted-other' },
    })
  ).toBe(false);
  expect(await verifyPublishingCancellationFetchSettled(ref, entry.receiptId, { ...entry.receipt, revision: 3 })).toBe(
    false
  );
  expect(
    await verifyPublishingCancellationFetchSettled(ref, entry.receiptId, {
      ...entry.receipt,
      fingerprint: 'c'.repeat(64),
    })
  ).toBe(false);
});

it('waits for the authoritative index backfill without scanning or deleting while readiness is pending', async () => {
  const { store } = fixture([]);
  const deps = createFirebasePublishingCancellationDependencies();
  deps.listReceipts = jest.fn().mockResolvedValue([receipt('subsplash-media-item')]);
  mockUsageClaim.mockRejectedValueOnce(new Error('PROVIDER_USAGE_INDEX_NOT_READY'));
  const calls = mockHttp.mock.calls.length;
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toEqual({
    state: 'blocked',
    code: 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING',
    receiptId: 'a'.repeat(64),
  });
  expect(mockHttp.mock.calls).toHaveLength(calls);
});
it('obtains a retirement reservation before provider inspection and settles only after absence proof', async () => {
  const { store, deps } = fixture([receipt('subsplash-media-item')]);
  const trace: string[] = [];
  (deps.claim as jest.Mock).mockImplementation(async () => {
    trace.push('claim');
    return 'reserved';
  });
  let gone = false;
  (deps.inspect as jest.Mock).mockImplementation(async () => {
    trace.push('inspect');
    return gone ? 'absent' : 'unreferenced';
  });
  (deps.delete as jest.Mock).mockImplementation(async () => {
    trace.push('delete');
    gone = true;
  });
  (deps.settle as jest.Mock).mockImplementation(async () => {
    trace.push('settle');
  });
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toEqual({ state: 'completed' });
  expect(trace).toEqual(['claim', 'inspect', 'delete', 'inspect', 'settle']);
});

it('blocks unresolved acknowledged orphans before cleanup and proceeds only after fingerprint-bound review', async () => {
  const { store, deps } = fixture([]);
  const { providerAcknowledgementFingerprint } = jest.requireActual('./providerReceipts');
  const acknowledgement = {
    schemaVersion: 1,
    receiptId: 'a'.repeat(64),
    projectId: 'test',
    jobId: 'job',
    step: 'subsplash-media-item',
    attemptOwner: 'attempt',
    claimRevision: 1,
    payloadFingerprint: 'f'.repeat(64),
    remoteId: 'old-ack',
    disposition: 'orphaned',
    acknowledgedAtMillis: 1,
  };
  (deps.listAcknowledgements as jest.Mock).mockResolvedValue([{ acknowledgementId: 'b'.repeat(64), acknowledgement }]);
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toEqual({
    state: 'blocked',
    code: 'PUBLISHING_CANCEL_ORPHAN_REVIEW_REQUIRED',
    acknowledgementId: 'b'.repeat(64),
    receiptId: 'a'.repeat(64),
  });
  expect(deps.releaseBindings).not.toHaveBeenCalled();
  expect(deps.delete).not.toHaveBeenCalled();
  const review = {
    decision: 'retain_after_review',
    actorUid: 'admin',
    commandId: 'command',
    acknowledgementFingerprint: providerAcknowledgementFingerprint(acknowledgement),
    evidenceReference: 'audit',
    reason: 'Retain reviewed allocation',
    duplicateRiskAcknowledged: true,
    reviewedAtMillis: 2,
  };
  (deps.listAcknowledgements as jest.Mock).mockResolvedValue([
    { acknowledgementId: 'b'.repeat(64), acknowledgement: { ...acknowledgement, review } },
  ]);
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toEqual({ state: 'completed' });
  expect(deps.delete).not.toHaveBeenCalled();
  (deps.listAcknowledgements as jest.Mock).mockResolvedValue([
    { acknowledgementId: 'b'.repeat(64), acknowledgement: { ...acknowledgement, remoteId: 'changed', review } },
  ]);
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toMatchObject({
    code: 'PUBLISHING_CANCEL_ORPHAN_REVIEW_REQUIRED',
  });
});

it('retains an image that might be associated manually or from another Firebase project despite an empty local usage index', async () => {
  const { store } = fixture([]),
    entry = receipt('image-create', 'confirmed', 'shared-app-image');
  entry.receipt.intentPayload = { image: { type: 'square' }, contentType: 'image/jpeg' };
  const deps = createFirebasePublishingCancellationDependencies();
  deps.listReceipts = jest.fn().mockResolvedValue([entry]);
  mockHttp.mockClear();
  mockHttp.mockResolvedValue({
    data: { id: 'shared-app-image', app_key: '9XTSHD', type: 'square', content_type: 'image/jpeg' },
  });
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toEqual({
    state: 'blocked',
    code: 'PUBLISHING_CANCEL_EXTERNAL_REFERENCE_REVIEW_REQUIRED',
    receiptId: entry.receiptId,
  });
  expect(mockHttp.mock.calls.map(([config]) => config.method)).toEqual(['GET']);
});
it('does not treat a changed SoundCloud account or an account GET failure as original track absence', async () => {
  const { store } = fixture([]),
    entry = receipt('soundcloud-track', 'confirmed', 'track');
  entry.receipt.providerAccount = { provider: 'soundcloud', account: 'soundcloud:users:1' };
  const deps = createFirebasePublishingCancellationDependencies();
  deps.listReceipts = jest.fn().mockResolvedValue([entry]);
  mockHttp.mockClear();
  mockHttp.mockResolvedValue({ data: { id: 2 } });
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toMatchObject({
    state: 'blocked',
    code: 'PUBLISHING_CANCEL_CLEANUP_REQUIRED',
  });
  expect(mockHttp).toHaveBeenCalledTimes(1);
  expect(mockHttp).toHaveBeenCalledWith('https://api.soundcloud.com/me', expect.anything());
  mockHttp.mockClear();
  mockHttp.mockImplementation(async (url) => {
    if (url === 'https://api.soundcloud.com/me') throw { response: { status: 404 } };
    return { data: { id: 'track', user: { id: 1 } } };
  });
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toMatchObject({
    state: 'blocked',
    code: 'PUBLISHING_CANCEL_CLEANUP_REQUIRED',
  });
});

it.each(['subsplash-media-item', 'list-create', 'subsplash-series'])(
  'does not delete an empty %s that could have shared-app parent references',
  async (step) => {
    const { store } = fixture([]),
      entry = receipt(step, 'confirmed', 'externally-referenced');
    entry.receipt.intentPayload = { title: 'Draft' };
    const deps = createFirebasePublishingCancellationDependencies();
    deps.listReceipts = jest.fn().mockResolvedValue([entry]);
    mockHttp.mockClear();
    mockHttp.mockResolvedValue({
      data: {
        id: 'externally-referenced',
        app_key: '9XTSHD',
        title: 'Draft',
        status: 'draft',
        auto_publish: false,
        _embedded: {},
        media_items_count: 0,
        list_rows_count: 0,
      },
    });
    expect(await cancelPublishingEffects(ref, intent, store, deps)).toMatchObject({
      state: 'blocked',
      code: 'PUBLISHING_CANCEL_EXTERNAL_REFERENCE_REVIEW_REQUIRED',
    });
    expect(mockHttp.mock.calls.every(([config]) => config.method === 'GET')).toBe(true);
  }
);

it('accepts only the audited same-allocation retention seal, leaving the provider resource intact', async () => {
  const { store } = fixture([]),
    entry = receipt('image-create', 'confirmed', 'retained-image');
  entry.receipt.intentPayload = { image: { type: 'square' }, contentType: 'image/jpeg' };
  entry.receipt.cleanupReview = {
    actorUid: 'admin',
    commandId: 'retain-command',
    resolutionFingerprint: 'e'.repeat(64),
    verifiedAtMillis: 2,
    retainedResourceId: 'retained-image',
    providerReceiptFingerprint: entry.receipt.fingerprint,
    currentReceiptRevision: entry.receipt.revision,
    audit: {
      decision: 'retain_existing_resource',
      duplicateRiskAcknowledged: true,
      evidenceReference: 'audit',
      reason: 'Preserve shared image',
    },
  };
  const deps = createFirebasePublishingCancellationDependencies();
  deps.listReceipts = jest.fn().mockResolvedValue([entry]);
  mockHttp.mockClear();
  mockHttp.mockResolvedValue({
    data: { id: 'retained-image', app_key: '9XTSHD', type: 'square', content_type: 'image/jpeg' },
  });
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toEqual({ state: 'completed' });
  expect(mockHttp.mock.calls.every(([config]) => config.method === 'GET')).toBe(true);
  entry.receipt = { ...entry.receipt, revision: 3 };
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toMatchObject({
    state: 'blocked',
    code: 'PUBLISHING_CANCEL_EXTERNAL_REFERENCE_REVIEW_REQUIRED',
  });
});

it('does not mistake a Subsplash authentication endpoint 404 for absence of the confirmed resource', async () => {
  const { store } = fixture([]),
    deps = createFirebasePublishingCancellationDependencies();
  deps.listReceipts = jest.fn().mockResolvedValue([receipt('subsplash-media-item')]);
  mockHttp.mockClear();
  mockAuth.mockRejectedValueOnce({ response: { status: 404 } });
  expect(await cancelPublishingEffects(ref, intent, store, deps)).toMatchObject({
    state: 'blocked',
    code: 'PUBLISHING_CANCEL_CLEANUP_REQUIRED',
  });
  expect(mockHttp).not.toHaveBeenCalled();
});
