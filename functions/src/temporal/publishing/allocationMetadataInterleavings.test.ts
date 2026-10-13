import type { Transaction } from 'firebase-admin/firestore';
import type { PrivatePublishingIntent } from './types';

const mockEvents: string[] = [];
const mockRecords = new Map<string, Record<string, unknown>>();
let mockDeletionPlan: any;
function mockReference(path: string): any {
  return {
    path,
    id: path.split('/').pop(),
    collection: (name: string) => mockReference(`${path}/${name}`),
    doc: (id: string) => mockReference(`${path}/${id}`),
    get: async () =>
      path.endsWith('/sermonLists')
        ? {
            docs: [...mockRecords]
              .filter(([key]) => key.startsWith(`${path}/`))
              .map(([key, data]) => ({ id: key.split('/').pop(), ref: mockReference(key), data: () => data })),
          }
        : {
            exists: mockRecords.has(path),
            data: () => mockRecords.get(path),
            get: (key: string) => mockRecords.get(path)?.[key],
          },
  };
}
const mockDb = { doc: mockReference, collection: mockReference };
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    firestore: () => mockDb,
    storage: () => ({ bucket: () => ({ file: () => ({}) }) }),
    auth: () => ({ getUser: async () => ({ uid: 'actor', customClaims: { role: 'admin' } }) }),
  },
}));
jest.mock('../../uploadToSubsplash', () => ({ uploadToSubsplashDomain: jest.fn() }));
jest.mock('../../uploadToSoundCloud', () => ({ uploadToSoundCloudDomain: jest.fn() }));
jest.mock('../../createNewSubsplashList', () => ({ createNewSubsplashList: jest.fn() }));
jest.mock('../../createSeries', () => ({ createSeriesDomain: jest.fn() }));
jest.mock('../../addToList', () => ({ addToListDomain: jest.fn() }));
jest.mock('../../removeFromList', () => ({ removeFromListDomain: jest.fn() }));
jest.mock('../../bulkAddToSeries', () => ({ bulkAddToSeriesDomain: jest.fn() }));
jest.mock('../../removeFromSeries', () => ({ removeFromSeriesDomain: jest.fn() }));
jest.mock('../../editSubsplashSermon', () => ({ editSubsplashSermonDomain: jest.fn() }));
jest.mock('../../editSoundCloudSermon', () => ({ editSoundCloudSermonDomain: jest.fn() }));
jest.mock('../../subsplashUtils', () => ({ authenticateSubsplash: jest.fn(), createAxiosConfig: jest.fn() }));
jest.mock('../../soundcloudClient', () => ({
  getAuthenticatedSoundCloudAccountId: jest.fn(async () => 'soundcloud:users:42'),
  formatTagList: jest.fn(() => 'synthetic-tags'),
}));
jest.mock('../../soundcloudSecrets', () => ({
  runWithSoundCloudAccessToken: jest.fn((run: (token: string) => unknown) => run('synthetic-token')),
}));
jest.mock('../../helpers/seriesHelpers', () => ({ getSeriesItems: jest.fn() }));
jest.mock('../../helpers/seriesRemoteState', () => ({ createSeriesMediaItemMembershipHash: jest.fn() }));
jest.mock('../../helpers/publishedListDrift', () => ({ auditPublishedListDrift: jest.fn() }));
jest.mock('../../locks/withSubsplashLocks', () => ({ withSubsplashLocks: jest.fn() }));
jest.mock('./providerDeletion', () => ({
  deletePublishingSubsplashMedia: jest.fn(async () => {
    mockEvents.push('delete-media');
    return { provider: 'subsplash', remoteId: 'media', absenceConfirmed: true };
  }),
  deletePublishingSoundCloudTrack: jest.fn(async () => {
    mockEvents.push('delete-track');
    return { provider: 'soundcloud', remoteId: 'track', absenceConfirmed: true };
  }),
}));
jest.mock('../../helpers/sermonDeletionMirrors', () => ({
  SERMON_DELETION_MIRROR_PLANS: 'temporalSermonDeletionMirrorPlans',
  prepareSermonDeletionMirrors: jest.fn(async (_db, input) => {
    mockEvents.push('capture');
    mockDeletionPlan = { ...input.ref, sermonId: input.sermonId, operation: input.operation, planId: 'plan' };
    mockRecords.set('temporalSermonDeletionMirrorPlans/plan', {
      state: 'captured',
      verifications: input.verifications,
    });
  }),
  loadSermonDeletionMirrorPlan: jest.fn(async () => mockDeletionPlan),
  validateSermonDeletionEffectsForClosing: jest.fn(async () => {
    mockEvents.push('source-closure-proof');
  }),
  removeSermonDeletionMirrors: jest.fn(async () => {
    mockEvents.push('mirrors-completed');
    mockRecords.delete('sermons/sermon');
    mockRecords.set('temporalSermonDeletionMirrorPlans/plan', {
      ...mockRecords.get('temporalSermonDeletionMirrorPlans/plan'),
      state: 'completed',
    });
  }),
}));
jest.mock('../../../../packages/orchestration/src/provider-usage', () => ({
  prepareDesiredProviderDeletions: jest.fn(),
  prepareDesiredProviderDeletionSettlement: jest.fn(
    async (_tx, _db, input) => () => mockEvents.push(`index-settle-${input.resource.provider}`)
  ),
}));
jest.mock('./providerReadiness', () => ({}));
jest.mock('./cancellation', () => ({}));
jest.mock('./audioReplacement', () => ({}));
jest.mock('./providerMutationGuard', () => ({ listProviderMutationSessionsForJob: jest.fn() }));
jest.mock('./durableOperationContext', () => ({
  beginProviderMutationPlan: jest.fn(async () => {
    mockEvents.push('acquire');
  }),
  publishingMutationRequestFingerprint: jest.fn(() => 'f'.repeat(64)),
  releaseCanonicalProviderBindingsForCurrentJob: jest.fn(async () => mockEvents.push('release-bindings')),
  prepareProviderMutationEffectsClosed: jest.fn(async (tx, input) => {
    mockEvents.push('effects-proof');
    await input.validateSourceEffects(tx);
    return { commit: () => mockEvents.push('effects-closed') };
  }),
  markPublishingCritical: jest.fn(async () => mockEvents.push('critical')),
  prepareAcknowledgedProjectionPlan: jest.fn(async () => ({
    projectionDigest: 'f'.repeat(64),
    commit: () => mockEvents.push('freeze'),
  })),
  abortProviderMutationPlan: jest.fn(async () => {
    mockEvents.push('abort');
  }),
  prepareProviderMutationPlanCommit: jest.fn(async () => {
    mockEvents.push('proof-read');
    return {
      alreadyCommitted: false,
      commit: () => {
        mockEvents.push('settle');
      },
    };
  }),
}));
jest.mock('./mutationResourcePlan', () => ({
  buildPublishingMutationResourcePlan: jest.fn(async ({ logicalStep }) => ({
    operation: `job:${logicalStep}`,
    resources: [{ provider: 'subsplash', account: 'account', resourceType: 'media', resourceId: 'media' }],
    graphFingerprint: 'graph',
    canonicalPaths: [],
  })),
  assertMutationResourcePlanCurrent: jest.fn(async () => {
    mockEvents.push('revalidate');
  }),
}));
jest.mock('./updateMembership', () => ({
  reconcilePublishingUpdateMemberships: jest.fn(),
  commitPublishingUpdateMemberships: jest.fn(),
}));

import { createFirebasePublishingDependencies } from './firebaseDependencies';
import { capturePublishingAllocationSource } from './allocationBarrier';
import { uploadToSubsplashDomain } from '../../uploadToSubsplash';
import { editSubsplashSermonDomain } from '../../editSubsplashSermon';
import { editSoundCloudSermonDomain } from '../../editSoundCloudSermon';
import { beginProviderMutationPlan, prepareAcknowledgedProjectionPlan } from './durableOperationContext';
import { providerReceiptId } from './providerReceipts';
jest.mock('firebase-admin/storage', () => ({ getDownloadURL: jest.fn(async () => 'https://synthetic.invalid/audio') }));
const ref = { projectId: 'project', jobId: 'list-job' },
  editRef = { projectId: 'project', jobId: 'edit-job' };
function source() {
  return {
    title: 'Original title',
    subtitle: 'Original subtitle',
    description: 'Original description',
    dateMillis: 1,
    speakers: [],
    topics: [],
    images: [],
    editedAtMillis: 1,
    audioArtifacts: { finalPath: 'audio/original' },
  };
}
function intent(action: 'publish' | 'update' = 'publish'): PrivatePublishingIntent {
  const sermon = source();
  return {
    sermonId: 'sermon',
    actorUid: 'actor',
    generation: 1,
    action,
    destinations: { listIds: ['list'], soundcloud: false },
    payload: {
      sermon,
      allocationSource: capturePublishingAllocationSource(sermon),
      audioStoragePath: 'audio/original',
      processAudio: false,
      ...(action === 'update' ? { patch: { title: 'Edited title' }, hasMembershipSelection: false } : {}),
    },
  };
}
function factory() {
  const writes: Array<() => void> = [];
  const tx = {
    get: async (target: any) => target.get(),
    set: (target: any, value: any) => writes.push(() => mockRecords.set(target.path, { ...value })),
    create: (target: any, value: any) =>
      writes.push(() => {
        if (mockRecords.has(target.path)) throw Error('exists');
        mockRecords.set(target.path, { ...value });
      }),
    update: (target: any, patch: any) => writes.push(() => Object.assign(mockRecords.get(target.path)!, patch)),
  } as unknown as Transaction;
  const store = {
    getSourceStepIds: () => ['subsplash-media'],
    loadIntent: jest.fn(),
    assertCurrent: jest.fn(),
    recordStep: jest.fn(),
    markCritical: jest.fn(),
    beginProviderMutationPlan: jest.fn(),
    runPublishingProviderMutation: jest.fn(),
    prepareProviderMutationPlanCommit: jest.fn(),
    prepareAcknowledgedProjectionPlan: jest.fn(),
    abortProviderMutationPlan: jest.fn(),
    prepareProviderMutationEffectsClosed: jest.fn(),
    commitCurrent: async (_ref: any, mutate: (tx: Transaction) => Promise<void>) => {
      writes.length = 0;
      try {
        await mutate(tx);
        for (const write of writes) write();
      } finally {
        writes.length = 0;
      }
    },
    leaseAudio: jest.fn(),
    releaseAudio: jest.fn(async () => ({ released: true })),
  };
  return { store, deps: createFirebasePublishingDependencies(store) };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockRecords.clear();
  mockRecords.set('sermons/sermon', source());
});
function originalAck(operationKey: string) {
  const receiptId = providerReceiptId(operationKey, 'subsplash-media-item'),
    head = {
      operationKey,
      receiptId,
      executionId: 'original-sdk-execution',
      state: 'confirmed',
      result: { id: 'original-media' },
    };
  mockRecords.set(`temporalProviderReceipts/${receiptId}`, head);
  mockRecords.set('durableActivityExecutions/original-create', head);
  return { receiptId, head };
}
test('factory cannot bind an original positive create result after the captured sermon source changes', async () => {
  const f = factory(),
    originalIntent = intent();
  let evidence: ReturnType<typeof originalAck> | undefined;
  jest.mocked(uploadToSubsplashDomain).mockImplementationOnce(async (input: any, adapter: any) => {
    await adapter.beforeCreateMedia();
    evidence = originalAck(input.operationKey);
    mockRecords.set('sermons/sermon', { ...source(), title: 'Concurrent edit without timestamp change' });
    await adapter.commitCreatedMedia({ id: 'original-media' });
    return { id: 'original-media' };
  });
  await expect(f.deps.ensureSubsplashMedia(ref, originalIntent)).rejects.toMatchObject({
    code: 'PUBLISHING_ALLOCATION_SOURCE_CHANGED',
  });
  expect(mockRecords.get('sermons/sermon')).toMatchObject({ title: 'Concurrent edit without timestamp change' });
  expect(mockRecords.get('sermons/sermon')).not.toHaveProperty('subsplashId');
  const marker = [...mockRecords].find(([path]) => path.startsWith('temporalPublishingAllocations/'))?.[1];
  expect(marker).toMatchObject({
    state: 'allocating',
    ownerJobId: ref.jobId,
    source: originalIntent.payload.allocationSource,
  });
  expect(mockRecords.get(`temporalProviderReceipts/${evidence!.receiptId}`)).toEqual(evidence!.head);
  expect(mockRecords.get('durableActivityExecutions/original-create')).toEqual(evidence!.head);
  expect(uploadToSubsplashDomain).toHaveBeenCalledTimes(1);
  expect(f.store.releaseAudio).not.toHaveBeenCalled();
});
test('factory final edit rejects a new bound provider after its metadata checkpoint proved provider absence', async () => {
  const f = factory(),
    edit = intent('update');
  await f.deps.updateMetadata(editRef, edit);
  const checkpoint = mockRecords.get(`durableJobIntents/${editRef.jobId}/publishingCheckpoints/metadata`);
  expect(checkpoint).toMatchObject({ state: 'completed', subsplashId: null, soundCloudTrackId: null });
  expect(beginProviderMutationPlan).not.toHaveBeenCalled();
  expect(editSubsplashSermonDomain).not.toHaveBeenCalled();
  expect(editSoundCloudSermonDomain).not.toHaveBeenCalled();
  expect(mockRecords.get('sermons/sermon')?.title).toBe('Original title');
  jest.mocked(uploadToSubsplashDomain).mockImplementationOnce(async (input: any, adapter: any) => {
    await adapter.beforeCreateMedia();
    originalAck(input.operationKey);
    await adapter.commitCreatedMedia({ id: 'original-media' });
    return { id: 'original-media' };
  });
  await f.deps.ensureSubsplashMedia(ref, intent());
  expect(mockRecords.get('sermons/sermon')?.subsplashId).toBe('original-media');
  expect([...mockRecords.values()].find((record) => record.ownerJobId === ref.jobId)).toMatchObject({
    state: 'bound',
    remoteId: 'original-media',
  });
  await expect(f.deps.commitProjection(editRef, edit)).rejects.toMatchObject({
    code: 'PUBLISHING_METADATA_DESTINATIONS_CHANGED',
  });
  expect(mockRecords.get('sermons/sermon')).toMatchObject({ title: 'Original title', subsplashId: 'original-media' });
  expect(mockRecords.get(`durableJobIntents/${editRef.jobId}/publishingCheckpoints/metadata`)).toEqual(checkpoint);
  expect(editSubsplashSermonDomain).not.toHaveBeenCalled();
  expect(editSoundCloudSermonDomain).not.toHaveBeenCalled();
  expect(f.store.releaseAudio).not.toHaveBeenCalled();
});

test('metadata without an image freezes the exact optional-field-free SoundCloud request', async () => {
  mockRecords.set('sermons/sermon', { ...source(), soundCloudTrackId: '123' });
  mockRecords.set(`durableJobs/${editRef.jobId}`, { createdAt: 1000 });
  jest.mocked(editSoundCloudSermonDomain).mockResolvedValueOnce({ soundCloudTrackMissing: false });
  const f = factory();
  const update = intent('update');
  update.payload.sermon = { ...source(), title: 'Edited title' };
  await f.deps.updateMetadata(editRef, update);
  const plan = jest.mocked(prepareAcknowledgedProjectionPlan).mock.calls[0][1];
  const request = plan.requests.find((value) => value.step === 'soundcloud-metadata')!;
  expect(request.target).toEqual({
    provider: 'soundcloud',
    account: 'soundcloud:users:42',
    resourceType: 'track',
    resourceId: '123',
  });
  expect(request.payload).toEqual(jest.mocked(editSoundCloudSermonDomain).mock.calls[0][0].data);
  expect(Object.prototype.hasOwnProperty.call(request.payload, 'imageSource')).toBe(false);
  expect(Object.values(request.payload as Record<string, unknown>).some((value) => value === undefined)).toBe(false);
});
