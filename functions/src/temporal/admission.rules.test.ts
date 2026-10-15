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
      .set({
        requestedBy: 'owner',
        kind: 'upload.create',
        state: 'awaiting_source',
        result: { sourceUpload: { storagePath: path, expectedFile: { size: 4 } } },
      });
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
  it('allows only the legacy sermon owner to create its admitted source and never replace it', async () => {
    const owner = environment.authenticatedContext('owner', { role: 'uploader' });
    const other = environment.authenticatedContext('other', { role: 'admin' });
    await environment.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .doc('sermons/owned-source')
        .set({ uploaderId: 'owner', status: { audioStatus: 'PENDING' } });
    });
    const destination = 'sermons/owned-source';
    const bytes = new Uint8Array([1, 2, 3]);
    await assertFails(Promise.resolve(other.storage().ref(destination).put(bytes)));
    await assertFails(Promise.resolve(owner.storage().ref('sermons/unadmitted').put(bytes)));
    await assertSucceeds(Promise.resolve(owner.storage().ref(destination).put(bytes)));
    await assertFails(Promise.resolve(owner.storage().ref(destination).put(bytes)));
    await assertFails(owner.storage().ref(destination).delete());
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

describe('direct browser mutation boundaries', () => {
  async function control(owner: string, admission = 'open', pausedDomain?: string) {
    await environment.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .doc('_control/temporalRelease')
        .set({
          admission,
          domains: Object.fromEntries(
            ['media', 'images', 'accounts', 'publishing', 'bundles'].map((domain) => [
              domain,
              { owner, admission: domain === pausedDomain ? 'paused' : 'open' },
            ])
          ),
        });
    });
  }
  const bytes = new Uint8Array([1, 2, 3, 4]);
  it('keeps accounts server-authored and reads private to self/admin in every release phase', async () => {
    const owner = environment.authenticatedContext('owner', { role: 'uploader' });
    const admin = environment.authenticatedContext('admin', { role: 'admin' });
    const stranger = environment.authenticatedContext('stranger', { role: 'user' });
    await environment.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc('users/owner').set({ role: 'uploader', activeDurableJobs: {} });
    });
    for (const [engine, gate] of [
      ['legacy', 'open'],
      ['legacy', 'paused'],
      ['temporal', 'open'],
    ]) {
      await control(engine, gate);
      await assertSucceeds(owner.firestore().doc('users/owner').get());
      await assertSucceeds(admin.firestore().doc('users/owner').get());
      await assertFails(stranger.firestore().doc('users/owner').get());
      await assertFails(owner.firestore().doc('users/owner').update({ role: 'admin' }));
      await assertFails(
        admin
          .firestore()
          .doc('users/owner')
          .update({ activeDurableJobs: { forged: 'job' } })
      );
      await assertFails(stranger.firestore().doc('users/forged').set({ role: 'admin' }));
      await assertFails(admin.firestore().doc('users/owner').delete());
    }
  });
  it('preserves catalog reads and protects server-authored topics, subtitles, and transcription output', async () => {
    const uploader = environment.authenticatedContext('owner', { role: 'uploader' });
    const admin = environment.authenticatedContext('admin', { role: 'admin' });
    await control('legacy');
    await environment.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc('topics/topic').set({ title: 'Topic' });
    });
    await assertFails(uploader.firestore().doc('topics/forged').set({ title: 'Topic' }));
    for (const collection of ['subtitles', 'transcriptions']) {
      await assertFails(admin.firestore().doc(`${collection}/forged`).set({ title: 'Forged' }));
      await assertSucceeds(uploader.firestore().doc(`${collection}/missing`).get());
    }
    for (const [engine, gate, domain] of [
      ['legacy', 'paused', undefined],
      ['legacy', 'open', 'bundles'],
      ['legacy', 'open', 'publishing'],
      ['temporal', 'open', undefined],
    ]) {
      await control(engine!, gate!, domain);
      await assertFails(uploader.firestore().doc('topics/topic').update({ title: 'Stale' }));
      await assertFails(uploader.firestore().doc('topics/new-topic').set({ title: 'Stale' }));
      await assertFails(uploader.firestore().doc('topics/topic').delete());
      await assertSucceeds(uploader.firestore().doc('topics/topic').get());
    }
  });
  it('denies arbitrary destinations, bundle overwrites, account assets, and workflow output to all browser roles', async () => {
    await control('legacy');
    for (const role of ['uploader', 'publisher', 'admin']) {
      const context = environment.authenticatedContext(role, { role });
      for (const destination of [
        'unknown/file',
        'bundles/topics-bundle.bin',
        'workflow-audio/private',
        'accounts/other/photo',
        'processed-sermons/output',
        'intro-outro-sermons/output',
        'intros/default.mp3',
        'outros/default.mp3',
      ]) {
        await assertFails(Promise.resolve(context.storage().ref(destination).put(bytes)));
      }
    }
    await assertFails(
      Promise.resolve(environment.unauthenticatedContext().storage().ref('speaker-images/anonymous.png').put(bytes))
    );
  });
  it('keeps provider sandbox copies private to server SDKs while public images remain readable', async () => {
    const privatePath = '_providerSandbox/urm-app-staging-publishing-v1/assets/source.png';
    const publicPath = 'speaker-images/public.png';
    await environment.withSecurityRulesDisabled(async (context) => {
      await context.storage().ref(privatePath).put(bytes, { contentType: 'image/png' });
      await context.storage().ref(publicPath).put(bytes, { contentType: 'image/png' });
    });
    const contexts = [
      environment.unauthenticatedContext(),
      ...['uploader', 'publisher', 'admin'].map((role) => environment.authenticatedContext(role, { role })),
    ];
    for (const context of contexts) {
      const copy = context.storage().ref(privatePath);
      await assertFails(copy.getMetadata());
      await assertFails(context.storage().ref('_providerSandbox').listAll());
      await assertFails(Promise.resolve(copy.put(bytes)));
      await assertFails(
        Promise.resolve(context.storage().ref('_providerSandbox/new-profile/assets/new.png').put(bytes))
      );
      await assertFails(copy.updateMetadata({ contentType: 'image/jpeg' }));
      await assertFails(copy.delete());
      await assertSucceeds(context.storage().ref(publicPath).getMetadata());
    }
  });
  it('fences speaker images by the images domain and preserves legacy authorized image writes only', async () => {
    const uploader = environment.authenticatedContext('owner', { role: 'uploader' });
    await control('legacy');
    await assertSucceeds(Promise.resolve(uploader.storage().ref('speaker-images/legacy.png').put(bytes)));
    for (const [engine, gate, domain] of [
      ['legacy', 'paused', undefined],
      ['legacy', 'open', 'images'],
      ['temporal', 'open', undefined],
    ]) {
      await control(engine!, gate!, domain);
      await assertFails(Promise.resolve(uploader.storage().ref('speaker-images/legacy.png').put(bytes)));
      await assertFails(
        uploader.storage().ref('speaker-images/legacy.png').updateMetadata({ contentType: 'image/png' })
      );
      await assertFails(uploader.storage().ref('speaker-images/legacy.png').delete());
      await assertFails(uploader.firestore().doc('images/forged').set({ subsplashId: 'forged' }));
    }
  });
  it('continues a genuinely reserved audio source during pause while rejecting unrelated or displaced job reservations', async () => {
    const uploader = environment.authenticatedContext('owner', { role: 'uploader' });
    await control('temporal', 'paused');
    const cases = [
      {
        id: 'paused-audio-valid',
        kind: 'upload.create',
        storagePath: 'durable-upload-sources/owner/paused-audio-valid/source',
        allowed: true,
      },
      {
        id: 'paused-audio-wrong-kind',
        kind: 'image.ingest',
        storagePath: 'durable-upload-sources/owner/paused-audio-wrong-kind/source',
        allowed: false,
      },
      { id: 'paused-audio-wrong-path', kind: 'upload.create', storagePath: 'different/path', allowed: false },
      {
        id: 'paused-audio-obsolete-kind',
        kind: 'upload.source.start',
        storagePath: 'durable-upload-sources/owner/paused-audio-obsolete-kind/source',
        allowed: false,
      },
    ];
    await environment.withSecurityRulesDisabled(async (context) => {
      for (const fixture of cases)
        await context
          .firestore()
          .doc(`durableJobs/${fixture.id}`)
          .set({
            requestedBy: 'owner',
            kind: fixture.kind,
            state: 'awaiting_source',
            result: { sourceUpload: { storagePath: fixture.storagePath, expectedFile: { size: 4 } } },
          });
    });
    for (const fixture of cases) {
      const source = uploader.storage().ref(`durable-upload-sources/owner/${fixture.id}/source`);
      const upload = Promise.resolve(source.put(bytes, { customMetadata: { durableJobId: fixture.id } }));
      if (fixture.allowed) {
        await assertSucceeds(upload);
        await assertFails(source.delete());
      } else await assertFails(upload);
    }
  });
  it('fences immutable speaker request sources by accounts admission while preserving the existing signed-in request flow', async () => {
    const requester = environment.authenticatedContext('requester', { role: 'user' });
    const metadata = { contentType: 'image/png' };
    await control('temporal');
    await assertSucceeds(
      Promise.resolve(requester.storage().ref('speaker-request-images/request.png').put(bytes, metadata))
    );
    await assertFails(
      Promise.resolve(requester.storage().ref('speaker-request-images/request.png').put(bytes, metadata))
    );
    await assertFails(
      Promise.resolve(
        requester
          .storage()
          .ref('speaker-request-images/executable')
          .put(bytes, { contentType: 'application/octet-stream' })
      )
    );
    await assertFails(requester.storage().ref('speaker-request-images/request.png').delete());
    await control('temporal', 'paused');
    await assertFails(
      Promise.resolve(requester.storage().ref('speaker-request-images/paused.png').put(bytes, metadata))
    );
    await control('temporal', 'open', 'accounts');
    await assertFails(
      Promise.resolve(requester.storage().ref('speaker-request-images/domain-paused.png').put(bytes, metadata))
    );
  });
});

describe('explicit immutable image source transfer', () => {
  it('requires Temporal images ownership and open global/domain admission, with actor-bound immutable image metadata', async () => {
    const uploader = environment.authenticatedContext('owner', { role: 'uploader' });
    const stranger = environment.authenticatedContext('stranger', { role: 'uploader' });
    const plainUser = environment.authenticatedContext('owner', { role: 'user' });
    const destination = 'durable-image-sources/owner/request-1/source';
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const metadata = { contentType: 'image/png', customMetadata: { ownerUID: 'owner', durableRequestId: 'request-1' } };
    await assertFails(Promise.resolve(uploader.storage().ref(destination).put(bytes, metadata)));
    for (const [engine, global, domain] of [
      ['legacy', 'open', 'open'],
      ['temporal', 'paused', 'open'],
      ['temporal', 'open', 'paused'],
    ]) {
      await environment.withSecurityRulesDisabled(async (context) => {
        await context
          .firestore()
          .doc('_control/temporalRelease')
          .set({ admission: global, domains: { images: { owner: engine, admission: domain } } });
      });
      await assertFails(Promise.resolve(uploader.storage().ref(destination).put(bytes, metadata)));
    }
    await environment.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .doc('_control/temporalRelease')
        .set({ admission: 'open', domains: { images: { owner: 'temporal', admission: 'open' } } });
    });
    await assertFails(Promise.resolve(stranger.storage().ref(destination).put(bytes, metadata)));
    await assertFails(Promise.resolve(plainUser.storage().ref(destination).put(bytes, metadata)));
    await assertFails(
      Promise.resolve(
        uploader
          .storage()
          .ref(destination)
          .put(bytes, { ...metadata, customMetadata: { ...metadata.customMetadata, durableRequestId: 'other' } })
      )
    );
    await assertFails(
      Promise.resolve(
        uploader
          .storage()
          .ref(destination)
          .put(bytes, { ...metadata, contentType: 'application/octet-stream' })
      )
    );
    await assertSucceeds(Promise.resolve(uploader.storage().ref(destination).put(bytes, metadata)));
    await assertFails(Promise.resolve(uploader.storage().ref(destination).put(bytes, metadata)));
    await assertFails(uploader.storage().ref(destination).delete());
    await assertFails(uploader.storage().ref(destination).updateMetadata({ contentType: 'image/jpeg' }));
    await assertFails(stranger.storage().ref(destination).getMetadata());
  });
});
