import type { Firestore, Transaction } from 'firebase-admin/firestore';
const mockRows = new Map<string, any>();
function mockDoc(path: string): any {
  return {
    path,
    id: path.split('/').pop(),
    collection: (name: string) => mockDoc(`${path}/${name}`),
    doc: (id: string) => mockDoc(`${path}/${id}`),
    get: async () => ({
      exists: mockRows.has(path),
      data: () => mockRows.get(path),
      get: (field: string) => field.split('.').reduce((value, key) => value?.[key], mockRows.get(path)),
    }),
  };
}
const mockDb = { doc: mockDoc, collection: mockDoc };
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => mockDb, app: () => ({ options: { projectId: 'project' } }) },
}));
jest.mock('../../helpers/seriesHelpers', () => ({
  getSeriesDetails: jest.fn(),
  getSeriesSubtitleFromPublishedCount: () => '0 sermons',
  createSubsplashSeries: jest.fn(),
  patchSeriesMetadata: jest.fn(),
}));
jest.mock('../../helpers/subsplashImageRefs', () => ({ repairMismatchedSubsplashImageRefs: jest.fn() }));
jest.mock('../../subsplashUtils', () => ({ authenticateSubsplash: jest.fn(async () => 'private-token') }));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: jest.fn(async (_keys: any, run: any) => run()),
}));
jest.mock('../../handleError', () => ({ __esModule: true, default: (error: unknown) => error }));
jest.mock('./durableOperationContext', () => ({
  getDurablePublishingJobId: () => 'job-1',
  isDurablePublishingOperation: () => true,
  getPublishingMutationOperation: () => 'original-tail',
  beginProviderMutationPlan: jest.fn(),
  prepareProviderMutationPlanCommit: jest.fn(async () => ({ alreadyCommitted: false, commit: jest.fn() })),
}));
jest.mock('./providerReceipts', () => {
  const actual = jest.requireActual('./providerReceipts');
  return {
    ...actual,
    readProviderReceipt: jest.fn(async (id: string) => mockRows.get(`temporalProviderReceipts/${id}`)),
    executeProviderCreate: jest.fn(),
  };
});
jest.mock('./reviewedCreateContinuation', () => ({ loadPublishingCreateReviewContinuation: jest.fn() }));
jest.mock('./entityMutations', () => ({ completeReviewedListCreate: jest.fn() }));
jest.mock('../../speakers/speakerMutations', () => ({
  parseCreateSpeakerInput: jest.fn((value) => value),
  validateSpeakerCreateTailCheckpoint: jest.fn(),
  completeConfirmedSpeakerCreate: jest.fn(),
  createSpeakerMutation: jest.fn(),
}));
import { createSeriesDomain, completeConfirmedSeriesCreate, type SeriesCreateTailCheckpoint } from '../../createSeries';
import { getSeriesDetails, createSubsplashSeries, patchSeriesMetadata } from '../../helpers/seriesHelpers';
import { repairMismatchedSubsplashImageRefs } from '../../helpers/subsplashImageRefs';
import { providerReceiptId, providerPayloadFingerprint, executeProviderCreate } from './providerReceipts';
import { acknowledgedProjectionDigest as digest } from './criticalAcknowledgedRepair';
import { loadPublishingCreateReviewContinuation } from './reviewedCreateContinuation';
import { completeReviewedListCreate, type PublishingEntityIntent } from './entityMutations';
import { executeReviewedPublishingEntityCreateContinuation } from './reviewedEntityCreateContinuation';
import {
  completeConfirmedSpeakerCreate,
  validateSpeakerCreateTailCheckpoint,
  createSpeakerMutation,
} from '../../speakers/speakerMutations';
const ref = { projectId: 'project', jobId: 'job-1' },
  operationKey = 'durable:project:job-1:series.create:create';
const data = {
  title: 'Original series',
  summary: 'Original summary',
  ownerId: 'actor',
  firestoreId: 'series-1',
  operationKey,
  images: [{ id: 'image-1', type: 'square', downloadLink: 'https://synthetic.invalid/image' }],
};
const remote = {
  id: 'remote-1',
  app_key: '9XTSHD',
  title: data.title,
  summary: data.summary,
  subtitle: '0 sermons',
  media_items_count: 0,
  published_media_items_count: 0,
  status: 'published',
  slug: 'original-series',
  short_code: 'original',
  position: 0,
} as any;
const receiptId = providerReceiptId(operationKey, 'subsplash-series'),
  statePath = `temporalPublishingSeriesCreationState/${providerReceiptId(ref.jobId, 'series-1')}`;
function fixture() {
  const intent: PublishingEntityIntent = {
    kind: 'series.create',
    entity: { type: 'series', id: 'series-1' },
    actorUid: 'actor',
    generation: 1,
    payload: { operation: 'create', input: { title: data.title, summary: data.summary, images: data.images } },
  };
  const raw = {
    schemaVersion: 2 as const,
    ...ref,
    seriesId: 'series-1',
    operationKey,
    payloadFingerprint: providerPayloadFingerprint(data),
    images: [{ ...data.images[0], subsplashId: 'repaired-image' }],
    originalExists: false,
    originalDocumentDigest: digest(null),
    publishedAt: new Date(1000).toISOString(),
  };
  const checkpoint: SeriesCreateTailCheckpoint = { ...raw, checkpointDigest: digest(raw) };
  mockRows.set(statePath, { ...checkpoint, state: 'captured' });
  mockRows.set(`temporalProviderReceipts/${receiptId}`, {
    ...ref,
    operationKey,
    step: 'subsplash-series',
    providerAccount: { provider: 'subsplash', account: 'app:9XTSHD' },
    state: 'confirmed',
    fingerprint: providerPayloadFingerprint(data),
    result: { id: remote.id },
  });
  const writes: Array<() => void> = [];
  const tx = {
    get: async (doc: any) => doc.get(),
    set: (doc: any, value: any, options?: any) =>
      writes.push(() => mockRows.set(doc.path, { ...(options?.merge ? mockRows.get(doc.path) : {}), ...value })),
    update: (doc: any, value: any) => writes.push(() => Object.assign(mockRows.get(doc.path), value)),
    create: (doc: any, value: any) => writes.push(() => mockRows.set(doc.path, value)),
  } as unknown as Transaction;
  const assertCurrent = jest.fn(async () => {}),
    commit = async (fn: (tx: Transaction) => Promise<void>) => {
      writes.length = 0;
      try {
        await fn(tx);
        for (const write of writes) write();
      } finally {
        writes.length = 0;
      }
    };
  const options = {
    firestore: mockDb as unknown as Firestore,
    loadIntent: jest.fn(async () => intent),
    assertCurrent,
    commitCurrent: async (_ref: any, fn: (tx: Transaction) => Promise<void>) => commit(fn),
    getSourceStepIds: () => ['entity'],
  };
  jest.mocked(loadPublishingCreateReviewContinuation).mockResolvedValue({
    workflow: 'publishingEntity',
    waitingStep: 'entity',
    completedStages: [],
    plan: {
      kind: intent.kind,
      entity: intent.entity,
      generation: 1,
      continuation: 'reviewed-create',
      receiptId,
      receiptStep: 'subsplash-series',
    },
  });
  jest.mocked(getSeriesDetails).mockResolvedValue(remote);
  jest.mocked(patchSeriesMetadata).mockResolvedValue(remote);
  return { intent, checkpoint, options, commit };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockRows.clear();
  mockRows.set('durableJobs/job-1', { createdAt: 1000 });
});
test('reviewed series executes only captured fixed tail, without allocating or repairing images', async () => {
  const f = fixture();
  expect(await executeReviewedPublishingEntityCreateContinuation(ref, 'private-checkpoint', f.options)).toEqual({
    firestoreId: 'series-1',
    subsplashId: 'remote-1',
    slug: 'original-series',
  });
  expect(getSeriesDetails).toHaveBeenCalledWith('remote-1', 'private-token');
  expect(patchSeriesMetadata).toHaveBeenNthCalledWith(
    1,
    'remote-1',
    { images: [{ id: 'repaired-image', type: 'square' }] },
    'private-token',
    { canonicalPatch: { images: f.checkpoint.images } }
  );
  expect(patchSeriesMetadata).toHaveBeenNthCalledWith(
    2,
    'remote-1',
    { publishedAt: f.checkpoint.publishedAt },
    'private-token'
  );
  expect(executeProviderCreate).not.toHaveBeenCalled();
  expect(createSubsplashSeries).not.toHaveBeenCalled();
  expect(repairMismatchedSubsplashImageRefs).not.toHaveBeenCalled();
  expect(mockRows.get(statePath)).toMatchObject({
    state: 'completed',
    imagesConfirmed: true,
    publicationConfirmed: true,
  });
});
test('confirmed original image stage is skipped; only publication remains', async () => {
  const f = fixture();
  Object.assign(mockRows.get(statePath), {
    state: 'preparing',
    remoteId: 'remote-1',
    imagesConfirmed: true,
    imagesResult: remote,
  });
  mockRows.set('series/series-1', { subsplashId: 'remote-1' });
  await executeReviewedPublishingEntityCreateContinuation(ref, 'private-checkpoint', f.options);
  expect(patchSeriesMetadata).toHaveBeenCalledTimes(1);
  expect(patchSeriesMetadata).toHaveBeenCalledWith(
    'remote-1',
    { publishedAt: f.checkpoint.publishedAt },
    'private-token'
  );
});
test('completed tail is idempotent and performs no provider mutation', async () => {
  const f = fixture();
  Object.assign(mockRows.get(statePath), {
    state: 'completed',
    remoteId: 'remote-1',
    imagesConfirmed: true,
    publicationConfirmed: true,
    publicationResult: remote,
  });
  mockRows.set('series/series-1', { subsplashId: 'remote-1' });
  await executeReviewedPublishingEntityCreateContinuation(ref, 'private-checkpoint', f.options);
  expect(patchSeriesMetadata).not.toHaveBeenCalled();
  expect(executeProviderCreate).not.toHaveBeenCalled();
});
test.each(['foreign-account', 'wrong-title', 'wrong-summary'])(
  'fixed GET rejects %s before remaining mutations',
  async (kind) => {
    const f = fixture();
    jest.mocked(getSeriesDetails).mockResolvedValue({
      ...remote,
      ...(kind === 'foreign-account'
        ? { app_key: 'other' }
        : kind === 'wrong-title'
        ? { title: 'Other title' }
        : { summary: 'Other summary' }),
    });
    await expect(
      executeReviewedPublishingEntityCreateContinuation(ref, 'private-checkpoint', f.options)
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(patchSeriesMetadata).not.toHaveBeenCalled();
    expect(mockRows.has('series/series-1')).toBe(false);
  }
);
test('changed local source rejects association before any remaining PATCH', async () => {
  const f = fixture();
  mockRows.set('series/series-1', { name: 'Concurrent local edit' });
  await expect(
    executeReviewedPublishingEntityCreateContinuation(ref, 'private-checkpoint', f.options)
  ).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(patchSeriesMetadata).not.toHaveBeenCalled();
  expect(mockRows.get('series/series-1')).toEqual({ name: 'Concurrent local edit' });
});
test('rejected checkpoint source dispatches no GET or create tail', async () => {
  const f = fixture();
  jest.mocked(loadPublishingCreateReviewContinuation).mockResolvedValue(undefined);
  await expect(
    executeReviewedPublishingEntityCreateContinuation(ref, 'private-checkpoint', f.options)
  ).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(getSeriesDetails).not.toHaveBeenCalled();
  expect(patchSeriesMetadata).not.toHaveBeenCalled();
});
test('actor revocation stops approved remaining stages', async () => {
  const f = fixture();
  f.options.assertCurrent.mockRejectedValue(Error('actor revoked'));
  await expect(executeReviewedPublishingEntityCreateContinuation(ref, 'private-checkpoint', f.options)).rejects.toThrow(
    'actor revoked'
  );
  expect(getSeriesDetails).not.toHaveBeenCalled();
});
test('tampered captured image program is rejected', async () => {
  const f = fixture();
  mockRows.get(statePath).images = [{ id: 'injected-image', type: 'square' }];
  await expect(
    executeReviewedPublishingEntityCreateContinuation(ref, 'private-checkpoint', f.options)
  ).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(getSeriesDetails).not.toHaveBeenCalled();
});
test('normal domain captures original repaired image program before original POST and shares fixed tail', async () => {
  const f = fixture();
  mockRows.delete(statePath);
  mockRows.delete(`temporalProviderReceipts/${receiptId}`);
  jest.mocked(repairMismatchedSubsplashImageRefs).mockResolvedValue(f.checkpoint.images);
  jest.mocked(createSubsplashSeries).mockResolvedValue(remote);
  jest.mocked(executeProviderCreate).mockImplementation(async (input: any) => {
    expect(mockRows.get(statePath)).toMatchObject({
      state: 'captured',
      images: f.checkpoint.images,
      publishedAt: f.checkpoint.publishedAt,
    });
    const result = await input.execute();
    mockRows.set(`temporalProviderReceipts/${receiptId}`, {
      ...ref,
      operationKey,
      state: 'confirmed',
      fingerprint: providerPayloadFingerprint(input.payload),
      result,
    });
    return result;
  });
  expect(await createSeriesDomain(data, 'admin', { commitCurrent: f.commit })).toMatchObject({
    status: 'success',
    subsplashId: 'remote-1',
  });
  expect(createSubsplashSeries).toHaveBeenCalledTimes(1);
  expect(patchSeriesMetadata).toHaveBeenCalledTimes(2);
});
test('exported fixed tail rejects different confirmed allocation even with same captured input', async () => {
  const f = fixture();
  await expect(
    completeConfirmedSeriesCreate(
      data,
      { ...remote, id: 'injected-remote' },
      { token: 'token', checkpoint: f.checkpoint, firestore: f.options.firestore, commitCurrent: f.commit }
    )
  ).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(patchSeriesMetadata).not.toHaveBeenCalled();
});
test('uncertain remaining image mutation keeps original allocation and stops publication', async () => {
  const f = fixture();
  jest
    .mocked(patchSeriesMetadata)
    .mockRejectedValueOnce(Object.assign(Error('uncertain'), { code: 'PROVIDER_MUTATION_UNRESOLVED' }));
  await expect(
    executeReviewedPublishingEntityCreateContinuation(ref, 'private-checkpoint', f.options)
  ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
  expect(patchSeriesMetadata).toHaveBeenCalledTimes(1);
  expect(mockRows.get(statePath)).toMatchObject({ state: 'preparing', remoteId: 'remote-1' });
  expect(mockRows.get(statePath)).not.toHaveProperty('publicationConfirmed');
  expect(mockRows.get(`temporalProviderReceipts/${receiptId}`)).toMatchObject({
    state: 'confirmed',
    result: { id: 'remote-1' },
  });
});
test('list dispatcher delegates only the dedicated source factual tail', async () => {
  const f = fixture();
  f.intent.kind = 'list.create';
  f.intent.entity = { type: 'list', id: 'list-1' };
  jest.mocked(loadPublishingCreateReviewContinuation).mockResolvedValue({
    workflow: 'publishingEntity',
    waitingStep: 'entity',
    completedStages: [],
    plan: {
      kind: 'list.create',
      entity: f.intent.entity,
      generation: 1,
      continuation: 'reviewed-create',
      receiptId: 'list-receipt',
      receiptStep: 'list-create',
    },
  });
  jest.mocked(completeReviewedListCreate).mockResolvedValue({ listId: 'list-1', subsplashId: 'remote-list' });
  expect(await executeReviewedPublishingEntityCreateContinuation(ref, 'private-checkpoint', f.options)).toEqual({
    listId: 'list-1',
    subsplashId: 'remote-list',
  });
  expect(getSeriesDetails).not.toHaveBeenCalled();
  expect(executeProviderCreate).not.toHaveBeenCalled();
});

function speakerFixture(selected: 'speaker-tag-create' | 'list-create' = 'speaker-tag-create') {
  const f = fixture(),
    key = `durable:${ref.projectId}:${ref.jobId}:speaker.mutate:create`,
    tagKey = `${key}:create-speaker-tag`,
    listKey = `${key}:create-speaker-list`,
    tagReceiptId = providerReceiptId(tagKey, 'speaker-tag-create'),
    listReceiptId = providerReceiptId(listKey, 'list-create');
  f.intent.kind = 'speaker.mutate';
  f.intent.entity = { type: 'speaker', id: 'speaker-1' };
  f.intent.payload = {
    operation: 'create',
    input: { speaker: { name: 'Original speaker', images: [] }, createSpeakerList: true },
  };
  const checkpoint = {
    schemaVersion: 1,
    ...ref,
    generation: 1,
    workflowId: 'workflow',
    speakerId: 'speaker-1',
    operationKey: key,
    images: [],
    tagPayload: { title: 'Original speaker' },
    listPayload: { title: 'Original speaker' },
    checkpointDigest: 'a'.repeat(64),
  };
  mockRows.set(`temporalPublishingSpeakerCreationState/${providerReceiptId(ref.jobId, 'speaker-1')}`, checkpoint);
  const tagReceipt = {
      ...ref,
      operationKey: tagKey,
      step: 'speaker-tag-create',
      state: 'confirmed',
      providerAccount: { provider: 'subsplash', account: 'app:9XTSHD' },
      fingerprint: providerPayloadFingerprint(checkpoint.tagPayload),
      result: { tagId: 'original-tag' },
    },
    listReceipt = {
      ...ref,
      operationKey: listKey,
      step: 'list-create',
      state: 'confirmed',
      providerAccount: { provider: 'subsplash', account: 'app:9XTSHD' },
      fingerprint: providerPayloadFingerprint(checkpoint.listPayload),
      result: { listId: 'original-list' },
    };
  mockRows.set(`temporalProviderReceipts/${tagReceiptId}`, tagReceipt);
  mockRows.set(`temporalProviderReceipts/${listReceiptId}`, listReceipt);
  jest.mocked(loadPublishingCreateReviewContinuation).mockResolvedValue({
    workflow: 'publishingEntity',
    waitingStep: 'entity',
    completedStages: [],
    plan: {
      kind: 'speaker.mutate',
      entity: f.intent.entity,
      generation: 1,
      continuation: 'reviewed-create',
      receiptId: selected === 'speaker-tag-create' ? tagReceiptId : listReceiptId,
      receiptStep: selected,
    },
  });
  jest.mocked(completeConfirmedSpeakerCreate).mockResolvedValue({
    status: 'success',
    speakerId: 'speaker-1',
    speaker: { id: 'speaker-1', name: 'Private speaker details' } as any,
    speakerListCreated: true,
    listId: 'list-1',
    listSubsplashId: 'original-list',
  });
  return { ...f, checkpoint, tagReceipt, listReceipt };
}
test.each(['speaker-tag-create', 'list-create'] as const)(
  'reviewed speaker %s dispatches exact confirmed-tag tail only',
  async (selected) => {
    const f = speakerFixture(selected);
    expect(await executeReviewedPublishingEntityCreateContinuation(ref, 'private-checkpoint', f.options)).toEqual({
      speakerId: 'speaker-1',
      listId: 'list-1',
      listSubsplashId: 'original-list',
    });
    expect(validateSpeakerCreateTailCheckpoint).toHaveBeenCalledWith(
      f.checkpoint,
      expect.objectContaining({
        operationKey: f.checkpoint.operationKey,
        speaker: { name: 'Original speaker', images: [] },
      }),
      'speaker-1'
    );
    expect(completeConfirmedSpeakerCreate).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: f.checkpoint.operationKey }),
      { tagId: 'original-tag' },
      expect.objectContaining({ checkpoint: f.checkpoint, speakerId: 'speaker-1' })
    );
    expect(createSpeakerMutation).not.toHaveBeenCalled();
    expect(executeProviderCreate).not.toHaveBeenCalled();
    expect(repairMismatchedSubsplashImageRefs).not.toHaveBeenCalled();
  }
);
test('reviewed speaker list cannot substitute for unresolved original tag allocation', async () => {
  const f = speakerFixture('list-create');
  f.tagReceipt.state = 'needs_review';
  await expect(
    executeReviewedPublishingEntityCreateContinuation(ref, 'private-checkpoint', f.options)
  ).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(completeConfirmedSpeakerCreate).not.toHaveBeenCalled();
});
test('speaker original tag payload and account must still match captured source', async () => {
  const f = speakerFixture();
  f.tagReceipt.fingerprint = 'b'.repeat(64);
  await expect(
    executeReviewedPublishingEntityCreateContinuation(ref, 'private-checkpoint', f.options)
  ).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(completeConfirmedSpeakerCreate).not.toHaveBeenCalled();
});
test('reviewed speaker list receipt cannot be from a foreign account', async () => {
  const f = speakerFixture('list-create');
  f.listReceipt.providerAccount.account = 'app:other';
  await expect(
    executeReviewedPublishingEntityCreateContinuation(ref, 'private-checkpoint', f.options)
  ).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(completeConfirmedSpeakerCreate).not.toHaveBeenCalled();
});
