import type { Transaction } from 'firebase-admin/firestore';
import type { PrivatePublishingIntent, PublishingJobRef } from './types';

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
}));
jest.mock('../../soundcloudSecrets', () => ({
  runWithSoundCloudAccessToken: jest.fn((run: (token: string) => unknown) => run('synthetic-token')),
}));
jest.mock('../../helpers/seriesHelpers', () => ({ getSeriesItems: jest.fn() }));
jest.mock('../../helpers/seriesRemoteState', () => ({ createSeriesMediaItemMembershipHash: jest.fn() }));
jest.mock('../../helpers/publishedListDrift', () => ({ auditPublishedListDrift: jest.fn() }));
jest.mock('../../locks/withSubsplashLocks', () => ({ withSubsplashLocks: jest.fn() }));
jest.mock('./allocationBarrier', () => ({
  preparePublishingAllocationRetirement: jest.fn(async (_tx, _db, input) => () => {
    mockEvents.push(`retire-${input.provider}`);
  }),
}));
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
// This suite isolates factory ordering. Destination capture/transport has its
// own real graph and original-acknowledgement coverage; these fixtures have no
// remote destination rows, so its captured immutable program is empty.
jest.mock('../../helpers/sermonDeletionDestinations', () => ({
  captureSermonDeletionDestinations: jest.fn(async (_db, input) => ({
    ref: { ...input, planId: 'd'.repeat(64), digest: 'e'.repeat(64) },
    operation: `durable:${input.projectId}:${input.jobId}:${input.sermonId}:provider-delete:delete`,
    mediaId: input.mediaId,
    resources: [],
    requests: [],
    verifications: [],
  })),
  revalidateSermonDeletionDestinationSources: jest.fn(async () => {}),
  executeSermonDeletionDestinations: jest.fn(async () => {}),
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

import { deletePublishingSubsplashMedia, deletePublishingSoundCloudTrack } from './providerDeletion';
import { createFirebasePublishingDependencies } from './firebaseDependencies';
import { addToListDomain } from '../../addToList';
import { removeFromListDomain } from '../../removeFromList';
import {
  abortProviderMutationPlan,
  beginProviderMutationPlan,
  prepareProviderMutationPlanCommit,
  prepareProviderMutationEffectsClosed,
} from './durableOperationContext';
import { assertMutationResourcePlanCurrent } from './mutationResourcePlan';
import { prepareSermonDeletionMirrors, removeSermonDeletionMirrors } from '../../helpers/sermonDeletionMirrors';
import { reconcilePublishingUpdateMemberships, commitPublishingUpdateMemberships } from './updateMembership';
const ref: PublishingJobRef = { projectId: 'project', jobId: 'job' };
const intent = (): PrivatePublishingIntent => ({
  sermonId: 'sermon',
  actorUid: 'actor',
  generation: 1,
  action: 'publish',
  destinations: { listIds: ['new'], soundcloud: false },
  payload: { removals: { listIds: ['old'], soundcloud: false } },
});
function dependencies() {
  const tx = {
    get: jest.fn(async (query: any) => query.get()),
    set: jest.fn(() => mockEvents.push('canonical')),
    update: jest.fn(() => mockEvents.push('canonical')),
  } as unknown as Transaction;
  const store = {
    loadIntent: jest.fn(),
    assertCurrent: jest.fn(),
    recordStep: jest.fn(),
    commitCurrent: jest.fn(async (_ref: PublishingJobRef, write: (tx: Transaction) => Promise<void>) => {
      await write(tx);
    }),
    leaseAudio: jest.fn(),
    releaseAudio: jest.fn(),
  };
  return { store, tx, deps: createFirebasePublishingDependencies(store) };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockEvents.length = 0;
  mockRecords.clear();
  mockDeletionPlan = undefined;
  mockRecords.set('sermons/sermon', { subsplashId: 'media' });
  mockRecords.set('lists/new', { name: 'New', subsplashId: 'new-remote' });
  mockRecords.set('sermons/sermon/sermonLists/old', {
    subsplashId: 'old-remote',
    uploadStatus: { status: 'UPLOADED', listItemId: 'old-row' },
  });
  jest.mocked(removeFromListDomain).mockImplementation(async () => {
    mockEvents.push('remove');
    return [{ status: 'success' }] as any;
  });
  jest.mocked(addToListDomain).mockImplementation(async () => {
    mockEvents.push('add');
    return [{ status: 'success', listId: 'new-remote', listItemId: 'new-row' }] as any;
  });
});
test('removal and addition retain one complete plan until all outer canonical projections settle', async () => {
  const f = dependencies();
  await f.deps.mutateLists(ref, intent());
  expect(beginProviderMutationPlan).toHaveBeenCalledTimes(1);
  expect(prepareProviderMutationPlanCommit).toHaveBeenCalledTimes(1);
  expect(mockEvents).toEqual([
    'acquire',
    'revalidate',
    'remove',
    'add',
    'proof-read',
    'canonical',
    'canonical',
    'settle',
  ]);
  expect(f.store.commitCurrent).toHaveBeenCalledTimes(1);
});
test('an uncertain addition retains ownership without publishing a partial outer projection', async () => {
  jest
    .mocked(addToListDomain)
    .mockRejectedValueOnce(Object.assign(new Error('uncertain'), { code: 'PROVIDER_MUTATION_UNRESOLVED' }));
  const f = dependencies();
  await expect(f.deps.mutateLists(ref, intent())).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
  expect(prepareProviderMutationPlanCommit).not.toHaveBeenCalled();
  expect(f.tx.set).not.toHaveBeenCalled();
  expect(f.tx.update).not.toHaveBeenCalled();
});
test('canonical graph drift stops all provider requests after acquisition', async () => {
  jest.mocked(assertMutationResourcePlanCurrent).mockRejectedValueOnce(Error('PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT'));
  await expect(dependencies().deps.mutateLists(ref, intent())).rejects.toMatchObject({
    code: 'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT',
  });
  expect(abortProviderMutationPlan).toHaveBeenCalledTimes(1);
  expect(addToListDomain).not.toHaveBeenCalled();
  expect(removeFromListDomain).not.toHaveBeenCalled();
  expect(prepareProviderMutationPlanCommit).not.toHaveBeenCalled();
});
test('an edit reuses its whole graph and commits the final selection with ownership settlement', async () => {
  const edit = {
    ...intent(),
    action: 'update' as const,
    payload: { ...intent().payload, hasMembershipSelection: true },
  };
  jest.mocked(reconcilePublishingUpdateMemberships).mockImplementationOnce(async (job, value, store) => {
    await store.mutateLists(job, {
      ...value,
      action: 'unpublish',
      destinations: { listIds: ['old'], soundcloud: false },
    });
  });
  jest.mocked(commitPublishingUpdateMemberships).mockImplementationOnce(async () => {
    mockEvents.push('selection');
  });
  const f = dependencies();
  await f.deps.updateMemberships(ref, edit);
  expect(beginProviderMutationPlan).toHaveBeenCalledTimes(1);
  expect(prepareProviderMutationPlanCommit).toHaveBeenCalledTimes(1);
  expect(commitPublishingUpdateMemberships).toHaveBeenCalledWith(ref, edit, f.tx, true);
  expect(mockEvents).toEqual(['acquire', 'revalidate', 'remove', 'canonical', 'proof-read', 'selection', 'settle']);
});

test('a resumed acknowledged or unknown plan cannot be released after graph drift', async () => {
  jest.mocked(assertMutationResourcePlanCurrent).mockRejectedValueOnce(Error('PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT'));
  jest.mocked(abortProviderMutationPlan).mockRejectedValueOnce(
    Object.assign(Error('PROVIDER_MUTATION_UNRESOLVED'), {
      code: 'PROVIDER_MUTATION_UNRESOLVED',
      mutationSessionId: 'a'.repeat(64),
    })
  );
  await expect(dependencies().deps.mutateLists(ref, intent())).rejects.toMatchObject({
    code: 'PROVIDER_MUTATION_UNRESOLVED',
  });
  expect(addToListDomain).not.toHaveBeenCalled();
  expect(removeFromListDomain).not.toHaveBeenCalled();
  expect(prepareProviderMutationPlanCommit).not.toHaveBeenCalled();
});
test('both fixed targets are captured before HTTP and stay owned through pointer clearing', async () => {
  mockRecords.set('sermons/sermon', { subsplashId: 'media', soundCloudTrackId: 'track' });
  const f = dependencies(),
    deletion = { ...intent(), action: 'delete' as const };
  await f.deps.prepareDeletePlan(ref, deletion);
  await f.deps.deleteProviders(ref, deletion);
  expect(beginProviderMutationPlan).toHaveBeenCalledWith(
    expect.objectContaining({
      resources: [
        { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: 'media' },
        { provider: 'soundcloud', account: 'soundcloud:users:42', resourceType: 'track', resourceId: 'track' },
      ],
    })
  );
  expect(prepareSermonDeletionMirrors).toHaveBeenCalledWith(
    mockDb,
    expect.objectContaining({
      requests: [
        expect.objectContaining({
          step: 'delete:subsplash:media',
          method: 'DELETE',
          target: expect.objectContaining({ resourceId: 'media' }),
        }),
        expect.objectContaining({
          step: 'delete:soundcloud:track',
          method: 'DELETE',
          target: expect.objectContaining({ resourceId: 'track' }),
        }),
      ],
      verifications: [
        expect.objectContaining({ expectedState: 'absent', requiredSteps: ['delete:subsplash:media'] }),
        expect.objectContaining({ expectedState: 'absent', requiredSteps: ['delete:soundcloud:track'] }),
      ],
    })
  );
  expect(mockEvents).toEqual([
    'acquire',
    'capture',
    'critical',
    'acquire',
    'critical',
    'delete-media',
    'delete-track',
    'effects-proof',
    'source-closure-proof',
    'canonical',
    'retire-subsplash',
    'retire-soundcloud',
    'effects-closed',
  ]);
  expect(prepareProviderMutationEffectsClosed).toHaveBeenCalledTimes(1);
  expect(prepareProviderMutationPlanCommit).not.toHaveBeenCalled();
  expect(removeSermonDeletionMirrors).not.toHaveBeenCalled();
  expect(f.tx.update).toHaveBeenCalledWith(
    expect.objectContaining({ path: 'sermons/sermon' }),
    expect.objectContaining({ 'status.subsplash': 'NOT_UPLOADED', 'status.soundCloud': 'NOT_UPLOADED' })
  );
  await f.deps.commitProjection(ref, deletion);
  expect(mockEvents.slice(-5)).toEqual([
    'proof-read',
    'index-settle-subsplash',
    'index-settle-soundcloud',
    'settle',
    'release-bindings',
  ]);
  expect(mockEvents.indexOf('mirrors-completed')).toBeLessThan(mockEvents.indexOf('settle'));
  expect(prepareProviderMutationPlanCommit).toHaveBeenCalledTimes(1);
});
test('local-only deletion captures its plan and enters critical review before cleanup', async () => {
  mockRecords.set('sermons/sermon', { title: 'Local recording' });
  const f = dependencies(),
    deletion = { ...intent(), action: 'delete' as const };
  await f.deps.prepareDeletePlan(ref, deletion);
  expect(mockEvents).toEqual(['capture', 'critical']);
  expect(prepareSermonDeletionMirrors).toHaveBeenCalledWith(
    mockDb,
    expect.objectContaining({ operation: undefined, requests: [], verifications: [] })
  );
  expect(beginProviderMutationPlan).not.toHaveBeenCalled();
  await f.deps.deleteProviders(ref, deletion);
  expect(deletePublishingSubsplashMedia).not.toHaveBeenCalled();
  expect(deletePublishingSoundCloudTrack).not.toHaveBeenCalled();
  await f.deps.commitProjection(ref, deletion);
  expect(mockEvents).toEqual(['capture', 'critical', 'mirrors-completed', 'release-bindings']);
  expect(prepareProviderMutationPlanCommit).not.toHaveBeenCalled();
});
test('unfinished mirror cleanup cannot release a closed provider session', async () => {
  mockRecords.set('sermons/sermon', { subsplashId: 'media', soundCloudTrackId: 'track' });
  const f = dependencies(),
    deletion = { ...intent(), action: 'delete' as const };
  await f.deps.prepareDeletePlan(ref, deletion);
  await f.deps.deleteProviders(ref, deletion);
  jest.mocked(removeSermonDeletionMirrors).mockRejectedValueOnce(Error('mirror cleanup interrupted'));
  await expect(f.deps.commitProjection(ref, deletion)).rejects.toThrow('mirror cleanup interrupted');
  expect(prepareProviderMutationPlanCommit).not.toHaveBeenCalled();
  expect(mockEvents).not.toContain('settle');
  expect(mockEvents).not.toContain('release-bindings');
});
test('an uncertain first deletion prevents the second deletion and canonical ownership release', async () => {
  mockRecords.set('sermons/sermon', { subsplashId: 'media', soundCloudTrackId: 'track' });
  jest
    .mocked(deletePublishingSubsplashMedia)
    .mockRejectedValueOnce(
      Object.assign(Error('PROVIDER_MUTATION_UNRESOLVED'), { code: 'PROVIDER_MUTATION_UNRESOLVED' })
    );
  const f = dependencies();
  await expect(f.deps.deleteProviders(ref, { ...intent(), action: 'delete' })).rejects.toMatchObject({
    code: 'PROVIDER_MUTATION_UNRESOLVED',
  });
  expect(deletePublishingSoundCloudTrack).not.toHaveBeenCalled();
  expect(f.tx.update).not.toHaveBeenCalled();
  expect(prepareProviderMutationPlanCommit).not.toHaveBeenCalled();
});
