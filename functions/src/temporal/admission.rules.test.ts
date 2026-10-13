import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
let environment: RulesTestEnvironment;
const path = 'durable-upload-sources/owner/job-1/source';
beforeAll(async () => {
  const firestore = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:18081').split(':');
  const storage = (process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '127.0.0.1:19199').split(':');
  environment = await initializeTestEnvironment({
    projectId: process.env.GCLOUD_PROJECT ?? 'urm-app',
    firestore: {
      host: firestore[0],
      port: Number(firestore[1]),
      rules: readFileSync(resolve(__dirname, '../../../firestore.rules'), 'utf8'),
    },
    storage: {
      host: storage[0],
      port: Number(storage[1]),
      rules: readFileSync(resolve(__dirname, '../../../storage.rules'), 'utf8'),
    },
  });
});
beforeEach(async () => {
  await environment.clearFirestore();
  await environment.clearStorage();
  await environment.withSecurityRulesDisabled(async (context) => {
    await context
      .firestore()
      .doc('durableJobs/job-1')
      .set({ requestedBy: 'owner', state: 'awaiting_source', result: { sourceUpload: { expectedFile: { size: 4 } } } });
    await context
      .firestore()
      .doc('durableJobIntents/job-1')
      .set({ payload: { private: 'secret' } });
  });
});
afterAll(async () => environment.cleanup());
describe('durable projection and immutable source rules', () => {
  it('allows only originating caller or admin to read projection and never permits client authorship', async () => {
    const owner = environment.authenticatedContext('owner', { role: 'uploader' }),
      other = environment.authenticatedContext('other', { role: 'uploader' }),
      admin = environment.authenticatedContext('admin', { role: 'admin' });
    await assertSucceeds(owner.firestore().doc('durableJobs/job-1').get());
    await assertSucceeds(admin.firestore().doc('durableJobs/job-1').get());
    await assertFails(other.firestore().doc('durableJobs/job-1').get());
    await assertFails(owner.firestore().doc('durableJobs/job-1').update({ state: 'succeeded' }));
    await assertFails(admin.firestore().doc('durableJobIntents/job-1').get());
  });
  it('denies all new private execution and audit records even to browser admins', async () => {
    const collections = [
      'durableActivityExecutions',
      'durableJobCancellationIntents',
      'durableJobCriticalSections',
      'temporalProviderUsage',
      'temporalPublishingProviderBindings',
      'temporalPublishingAllocations',
      'temporalProviderAcknowledgements',
      'temporalPublishingDeletionReceipts',
      'temporalPublishingEffectPlans',
      'temporalPublishingAcknowledgedProjections',
      'temporalPublishingUpdateCheckpoints',
      'temporalPublishingCreateReviewCheckpoints',
      'temporalPublishingListCreationState',
      'temporalPublishingSeriesCreationState',
      'temporalLegacySoundCloudRetentions',
      'temporalLegacySoundCloudRetentionCertificates',
      'temporalLegacySoundCloudRetentionObservations',
      'temporalSermonDeletionMirrorPlans',
      'temporalProviderDesiredDeletionPlans',
      'temporalSpeakerDeletionMirrorPlans',
      'durableJobCriticalRepairGrants',
      'temporalPublishingCriticalRepairs',
      'temporalPublishingCertifiedDeletionDispositions',
      'temporalPublishingCriticalDeletionAbsences',
      'temporalPublishingZeroEffectsStops',
      'temporalSermonDeletionPartialStops',
      'temporalPublishingCriticalRepairSourceCatalogs',
      'temporalPublishingCriticalRepairCatalogs',
      'temporalPublishingAcknowledgedProjectionProgress',
      'temporalPublishingAcknowledgedRepairCandidates',
      'temporalListDeletionMirrorPlans',
      'temporalListDeletionReady',
      'temporalSeriesDeletionMirrorPlans',
      'temporalProviderAcknowledgementReviews',
      'temporalProviderRetentions',
      'temporalProviderMutationSessions',
      'temporalProviderMutationLocks',
      'temporalProviderMutationFacts',
      'temporalImageResourceRetentions',
      'temporalImageAllocationAcknowledgements',
      'temporalImageCleanupAuthorizations',
      'durableJobStepExecutions',
      'durableEmailReceipts',
      'durableJobResolutionRequests',
      'legacyAdmissionLeases',
      'legacyAdmissionLeaseReviews',
      'temporalMediaArtifacts',
      'temporalImageReceipts',
      '_durableBundlePointers',
      '_durableAccountClaimResources',
    ];
    await environment.withSecurityRulesDisabled(async (context) => {
      for (const collection of collections)
        await context.firestore().doc(`${collection}/private`).set({ private: 'never public' });
    });
    const admin = environment.authenticatedContext('admin', { role: 'admin' });
    for (const collection of collections) {
      await assertFails(admin.firestore().doc(`${collection}/private`).get());
      await assertFails(admin.firestore().doc(`${collection}/private`).set({ private: 'tampered' }));
    }
    const pagedRecords = [
      'temporalPublishingCriticalRepairCatalogs/private/pages/000001',
      'temporalPublishingCriticalRepairSourceCatalogs/private/entries/000001',
      'temporalPublishingAcknowledgedRepairCandidates/private/pages/000001',
      'temporalPublishingAcknowledgedProjections/private/fragments/000001',
      'temporalSermonDeletionMirrorPlans/private/pages/000001',
      'temporalListDeletionMirrorPlans/private/pages/000001',
      'temporalListDeletionReady/private/pages/000001',
      'temporalSermonDeletionPartialStops/private/pages/000001',
      'temporalSeriesDeletionMirrorPlans/private/pages/000001',
    ];
    await environment.withSecurityRulesDisabled(async (context) => {
      for (const record of pagedRecords) await context.firestore().doc(record).set({ private: 'fixed targets' });
    });
    for (const record of pagedRecords) {
      await assertFails(admin.firestore().doc(record).get());
      await assertFails(admin.firestore().doc(record).set({ private: 'tampered' }));
    }
  });
  it('allows a reserved upload exactly once and forbids cross-account source access', async () => {
    const owner = environment.authenticatedContext('owner', { role: 'uploader' }),
      other = environment.authenticatedContext('other', { role: 'uploader' }),
      metadata = { customMetadata: { durableJobId: 'job-1', fingerprint: 'test' } };
    await assertFails(
      Promise.resolve(
        other
          .storage()
          .ref(path)
          .put(new Uint8Array([1, 2, 3, 4]), metadata)
      )
    );
    await assertSucceeds(
      Promise.resolve(
        owner
          .storage()
          .ref(path)
          .put(new Uint8Array([1, 2, 3, 4]), metadata)
      )
    );
    await assertFails(
      Promise.resolve(
        owner
          .storage()
          .ref(path)
          .put(new Uint8Array([5, 6, 7, 8]), metadata)
      )
    );
    await assertFails(owner.storage().ref(path).delete());
    await assertFails(other.storage().ref(path).getDownloadURL());
  });
  it('preserves legacy writes before cutover and blocks stale browser mutations during pause and Temporal ownership', async () => {
    const owner = environment.authenticatedContext('owner', { role: 'uploader' });
    const sermon = {
      uploaderId: 'owner',
      title: 'Legacy',
      status: { audioStatus: 'PROCESSED', subsplash: 'NOT_UPLOADED', soundCloud: 'NOT_UPLOADED' },
    };
    await environment.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .doc('_control/temporalRelease')
        .set({
          schemaVersion: 1,
          revision: 1,
          admission: 'open',
          domains: {
            media: { owner: 'legacy', admission: 'open' },
            publishing: { owner: 'legacy', admission: 'open' },
          },
        });
    });
    await assertSucceeds(owner.firestore().doc('sermons/legacy').set(sermon));
    await assertSucceeds(owner.firestore().doc('sermons/legacy').update({ subsplashId: 'legacy-provider' }));
    await environment.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc('_control/temporalRelease').update({ admission: 'paused', revision: 2 });
    });
    await assertFails(owner.firestore().doc('sermons/new-during-pause').set(sermon));
    await assertSucceeds(owner.firestore().doc('sermons/legacy').get());
    await environment.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc('_control/temporalRelease').update({
        admission: 'open',
        revision: 3,
        'domains.media.owner': 'temporal',
        'domains.publishing.owner': 'temporal',
      });
    });
    await assertFails(owner.firestore().doc('sermons/legacy').update({ subsplashId: 'stale-provider' }));
    await assertFails(owner.firestore().doc('lists/example/listItems/legacy').set(sermon));
    await assertFails(owner.firestore().doc('_control/temporalRelease').get());
  });
  it('lets an admitted legacy owner finish bytes during pause but denies first upload after ownership changes', async () => {
    const owner = environment.authenticatedContext('owner', { role: 'uploader' });
    await environment.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .doc('_control/temporalRelease')
        .set({
          schemaVersion: 1,
          revision: 1,
          admission: 'paused',
          domains: { media: { owner: 'legacy', admission: 'paused' } },
        });
      for (const id of ['paused-source', 'unfinished-source'])
        await context
          .firestore()
          .doc(`sermons/${id}`)
          .set({ uploaderId: 'owner', status: { audioStatus: 'PENDING' } });
    });
    await assertSucceeds(
      Promise.resolve(
        owner
          .storage()
          .ref('sermons/paused-source')
          .put(new Uint8Array([1, 2, 3]))
      )
    );
    await environment.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .doc('_control/temporalRelease')
        .update({ 'domains.media.owner': 'temporal', revision: 2 });
    });
    await assertFails(
      Promise.resolve(
        owner
          .storage()
          .ref('sermons/unfinished-source')
          .put(new Uint8Array([1, 2, 3]))
      )
    );
  });
  it('rejects wrong length and unreserved source paths', async () => {
    const owner = environment.authenticatedContext('owner', { role: 'uploader' }),
      metadata = { customMetadata: { durableJobId: 'job-1' } };
    await assertFails(
      Promise.resolve(
        owner
          .storage()
          .ref(path)
          .put(new Uint8Array([1]), metadata)
      )
    );
    await assertFails(
      Promise.resolve(
        owner
          .storage()
          .ref('durable-upload-sources/owner/unreserved/source')
          .put(new Uint8Array([1, 2, 3, 4]), { customMetadata: { durableJobId: 'unreserved' } })
      )
    );
  });
});
