import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { submitServerDurableJob, getServerDurableJobReceipt, temporalProjectId, confirmUploadSource } from './bridge';
import { commandServerDurableJob } from './admission';
import { normalizeUploadSource } from './sourceSessions';
import { withLegacyAdmissionLease } from './legacyAdmissionLease';
import { createDurableJobStore, durableEntityKey } from '@upperroom/orchestration/job-store';
import { withProviderIndexedTransaction } from '@upperroom/orchestration/provider-transaction';
import { providerResourceKey } from '@upperroom/orchestration/provider-usage';
import * as domainResolution from './domainResolver';
import { createHash } from 'node:crypto';

const db = firebaseAdmin.firestore();
const fingerprint = { algorithm: 'sha256-chunks-v1', chunkBytes: 4194304, value: 'a'.repeat(64) };
const payload = {
  sermon: { title: 'Durable admission test', subsplashId: 'untrusted-provider-id' },
  source: { type: 'file', name: 'audio.mp3', size: 4, lastModified: 1000, fingerprint },
  trimStart: 0,
  duration: 60,
};
const makeRequest = (actorUid: string, requestId: string) => ({
  actorUid,
  requestId,
  kind: 'upload.create' as const,
  entity: { type: 'sermon' as const, id: 'client-placeholder' },
  payload,
});
const collections = [
  'legacyAdmissionLeases',
  'durableJobs',
  'durableJobIntents',
  'durableJobEntities',
  'durableAdmissionReceipts',
  'durableUploadSessions',
  'durableJobCommands',
  'durableJobCancellationIntents',
  'durableJobCriticalSections',
  'temporalProviderReceipts',
  'temporalProviderAcknowledgements',
  'temporalPublishingAllocations',
  'temporalProviderUsage',
  'durableJobOutbox',
  'temporalMediaAdmissions',
  'temporalMediaRequests',
  'temporalMediaState',
  'sermons',
  'lists',
  'series',
];
beforeAll(async () => {
  process.env.TASK_ORCHESTRATOR_MEDIA = 'temporal';
  for (const uid of ['durable-owner', 'durable-other', 'durable-disabled', 'durable-admin']) {
    try {
      await firebaseAdmin.auth().deleteUser(uid);
    } catch {}
    await firebaseAdmin.auth().createUser({ uid, disabled: uid === 'durable-disabled' });
    await firebaseAdmin.auth().setCustomUserClaims(uid, { role: uid === 'durable-admin' ? 'admin' : 'uploader' });
  }
  for (const path of ['intros/default_intro.mp3', 'outros/default_outro.mp3'])
    await firebaseAdmin.storage().bucket().file(path).save(Buffer.from('test'));
});
beforeEach(async () => {
  await db.doc('_control/temporalRelease').set({
    schemaVersion: 1,
    revision: 1,
    admission: 'open',
    domains: { media: { owner: 'temporal', admission: 'open' } },
    updatedAt: Date.now(),
    releaseId: 'test',
  });
  for (const name of collections) await db.recursiveDelete(db.collection(name));
  await db.doc('_control/temporalProviderUsage').set({
    schemaVersion: 1,
    projectId: temporalProjectId(),
    epoch: 'admission-test-epoch',
    status: 'ready',
    releaseId: 'test',
    controlRevision: 1,
  });
  await firebaseAdmin.database().ref('processAudioRequests').remove();
  await firebaseAdmin.database().ref('processAudioLocks').remove();
});
afterAll(async () => {
  delete process.env.TASK_ORCHESTRATOR_MEDIA;
  await db.doc('_control/temporalRelease').delete();
  await db.doc('_control/temporalProviderUsage').delete();
});

describe('authenticated durable admission transaction', () => {
  it('admits deletion of a large managed membership catalog without eagerly changing its mirrors', async () => {
    process.env.TASK_ORCHESTRATOR_PUBLISHING = 'temporal';
    try {
      await db
        .doc('_control/temporalRelease')
        .update({ 'domains.publishing': { owner: 'temporal', admission: 'open' } });
      const canonical = db.doc('sermons/large-delete-catalog');
      await canonical.set({ id: canonical.id, title: 'Large catalog', uploaderId: 'durable-owner', editedAtMillis: 0 });
      for (let offset = 0; offset < 600; offset += 200) {
        const batch = db.batch();
        for (let row = offset; row < offset + 200; row++) {
          const id = `managed-list-${row}`;
          batch.create(canonical.collection('sermonLists').doc(id), {
            id,
            uploadStatus: { status: 'NOT_UPLOADED' },
            publishGeneration: 0,
          });
        }
        await batch.commit();
      }
      const receipt = await submitServerDurableJob({
        actorUid: 'durable-admin',
        kind: 'sermon.delete',
        entity: { type: 'sermon', id: canonical.id },
        requestId: 'large-delete-catalog',
        payload: {},
      });
      expect((await db.doc(`durableJobs/${receipt.jobId}`).get()).data()).toMatchObject({
        kind: 'sermon.delete',
        state: 'queued',
      });
      expect((await canonical.collection('sermonLists').get()).size).toBe(600);
      expect((await canonical.get()).exists).toBe(true);
      expect(
        Buffer.byteLength(JSON.stringify((await db.doc(`durableJobIntents/${receipt.jobId}`).get()).data()))
      ).toBeLessThan(10000);
    } finally {
      delete process.env.TASK_ORCHESTRATOR_PUBLISHING;
    }
  });
  it.each(['subsplash', 'soundcloud'] as const)(
    'fences sermon edits against independent %s allocations until canonical binding',
    async (provider) => {
      process.env.TASK_ORCHESTRATOR_PUBLISHING = 'temporal';
      try {
        const projectId = temporalProjectId(),
          sermonId = `allocation-edit-${provider}`;
        await db
          .doc('_control/temporalRelease')
          .update({ 'domains.publishing': { owner: 'temporal', admission: 'open' } });
        const canonical = db.doc(`sermons/${sermonId}`);
        await canonical.set({
          id: sermonId,
          title: 'Captured content',
          uploaderId: 'durable-owner',
          editedAtMillis: 0,
        });
        const headId = createHash('sha256')
          .update(JSON.stringify([projectId, sermonId, provider]))
          .digest('hex');
        const head = db.doc(`temporalPublishingAllocations/${headId}`);
        const ownerJobId = 'independent-list-allocation';
        await db
          .doc('temporalProviderReceipts/allocation-confirmed')
          .set({ projectId, jobId: ownerJobId, state: 'confirmed', result: { id: 'confirmed-provider-id' } });
        const request = {
          actorUid: 'durable-admin',
          kind: 'sermon.update' as const,
          entity: { type: 'sermon' as const, id: sermonId },
          requestId: `allocation-edit-${provider}`,
          payload: { patch: { title: 'Edited content' } },
        };
        for (const state of ['allocating', 'unknown', 'bound']) {
          await head.set({
            schemaVersion: 1,
            projectId,
            sermonId,
            provider,
            ownerJobId,
            state,
            remoteId: 'confirmed-provider-id',
          });
          await expect(submitServerDurableJob(request)).rejects.toMatchObject({ code: 'aborted' });
          expect((await db.collection('durableJobIntents').get()).size).toBe(0);
          expect((await canonical.get()).get('title')).toBe('Captured content');
        }
        const field = provider === 'subsplash' ? 'subsplashId' : 'soundCloudTrackId';
        await db.runTransaction((tx) =>
          withProviderIndexedTransaction(tx, db, projectId, async (recording) => {
            recording.update(canonical, { [field]: 'confirmed-provider-id' });
          })
        );
        const accepted = await submitServerDurableJob(request);
        expect(accepted.generation).toBe(1);
        expect((await db.doc(`durableJobs/${accepted.jobId}`).get()).get('state')).toBe('queued');
      } finally {
        delete process.env.TASK_ORCHESTRATOR_PUBLISHING;
      }
    }
  );
  it('deduplicates a fresh source retry without duplicating canonical metadata or memberships', async () => {
    await db.doc('lists/retry-membership').set({ name: 'Retained selection', count: 0 });
    const original = await submitServerDurableJob({
      ...makeRequest('durable-owner', 'retry-original'),
      payload: { ...payload, listIds: ['retry-membership'] },
    });
    await commandServerDurableJob('durable-owner', {
      jobId: original.jobId,
      requestId: 'retry-original-cancel',
      expectedRevision: 1,
      action: 'cancel',
    });
    const prior = (await db.doc(`durableJobs/${original.jobId}`).get()).data();
    const sermonId = prior!.entity.id;
    const request = {
      ...makeRequest('durable-owner', 'fresh-source-retry'),
      payload: {
        ...payload,
        sermon: { title: 'Ignored metadata edit', subsplashId: 'forged-provider' },
        retryOfJobId: original.jobId,
      },
    };
    const [a, b] = await Promise.all([submitServerDurableJob(request), submitServerDurableJob(request)]);
    expect(a.jobId).toBe(b.jobId);
    expect(a.jobId).not.toBe(original.jobId);
    expect(a.generation).toBe(2);
    expect(a.sourceUpload?.storagePath).not.toBe(original.sourceUpload?.storagePath);
    expect((await db.collection('sermons').get()).size).toBe(1);
    expect((await db.doc(`sermons/${sermonId}`).get()).get('title')).toBe(payload.sermon.title);
    expect((await db.doc(`sermons/${sermonId}`).get()).get('subsplashId')).toBeUndefined();
    expect((await db.doc('lists/retry-membership').get()).get('count')).toBe(1);
    expect((await db.collection(`sermons/${sermonId}/sermonLists`).get()).size).toBe(1);
    expect((await db.doc(`durableJobs/${original.jobId}`).get()).data()).toEqual(prior);
    expect((await db.doc(`durableJobs/${a.jobId}`).get()).get('entity.id')).toBe(sermonId);
    await expect(
      submitServerDurableJob({
        ...makeRequest('durable-owner', 'stale-source-retry'),
        payload: { ...payload, retryOfJobId: original.jobId },
      })
    ).rejects.toMatchObject({ code: 'aborted' });
  });
  it('rejects a foreign, changed-file or published source retry', async () => {
    const original = await submitServerDurableJob(makeRequest('durable-owner', 'retry-security'));
    await commandServerDurableJob('durable-owner', {
      jobId: original.jobId,
      requestId: 'retry-security-cancel',
      expectedRevision: 1,
      action: 'cancel',
    });
    const retry = {
      ...makeRequest('durable-owner', 'retry-security-new'),
      payload: { ...payload, retryOfJobId: original.jobId },
    };
    await expect(submitServerDurableJob({ ...retry, actorUid: 'durable-other' })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(
      submitServerDurableJob({
        ...retry,
        payload: {
          ...retry.payload,
          source: { ...payload.source, fingerprint: { ...fingerprint, value: 'b'.repeat(64) } },
        },
      })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    const sermonId = (await db.doc(`durableJobs/${original.jobId}`).get()).get('entity.id');
    await db.doc(`sermons/${sermonId}`).update({ subsplashId: 'already-published' });
    await expect(submitServerDurableJob(retry)).rejects.toMatchObject({ code: 'failed-precondition' });
    await db
      .doc(`sermons/${sermonId}`)
      .set({ ...(await db.doc(`sermons/${sermonId}`).get()).data(), subsplashId: null });
    await db.doc(`temporalMediaState/${sermonId}`).set({ owner: 'temporal', ref: { jobId: 'possibly-active-audio' } });
    await expect(submitServerDurableJob(retry)).rejects.toMatchObject({ code: 'failed-precondition' });
    await db.doc(`sermons/${sermonId}`).delete();
    await expect(submitServerDurableJob(retry)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect((await db.collection('durableUploadSessions').get()).size).toBe(1);
  });
  it('returns already-complete navigation for confirmed audio without admitting another source', async () => {
    const original = await submitServerDurableJob(makeRequest('durable-owner', 'retry-complete'));
    const sermonId = (await db.doc(`durableJobs/${original.jobId}`).get()).get('entity.id');
    const projectId = temporalProjectId(),
      ref = { projectId, jobId: 'already-complete-audio' };
    const store = createDurableJobStore({ firestore: db, projectId });
    await db.runTransaction(async (tx) =>
      store.createInTransaction(tx, {
        ref,
        kind: 'audio.process',
        entity: { type: 'sermon', id: sermonId },
        actorUid: 'durable-owner',
        payload: {},
        requestId: 'completed-media',
        generation: 1,
        dispatch: {
          ref,
          workflowType: 'MediaCoordinator',
          workflowId: 'already-complete-workflow',
          taskQueue: 'urm-media',
        },
        createdAt: Date.now(),
      })
    );
    await db.doc(`durableJobs/${ref.jobId}`).update({ state: 'succeeded', actions: [] });
    await db
      .doc(`durableJobs/${original.jobId}`)
      .update({ state: 'succeeded', actions: [], result: { mediaJobId: ref.jobId }, revision: 2 });
    await db.doc(`durableUploadSessions/${original.jobId}`).update({ state: 'confirmed', mediaJobRef: ref });
    await db
      .doc(`sermons/${sermonId}`)
      .update({ 'status.audioStatus': 'PROCESSED', audioArtifacts: { processedPath: 'workflow-audio/completed.mp3' } });
    const request = {
      ...makeRequest('durable-owner', 'complete-navigation'),
      payload: { ...payload, retryOfJobId: original.jobId },
    };
    const receipt = await submitServerDurableJob(request);
    expect(receipt.clientResult).toEqual({ alreadyComplete: true, sermonId });
    expect((await submitServerDurableJob(request)).jobId).toBe(original.jobId);
    expect((await db.collection('durableUploadSessions').get()).size).toBe(1);
  });
  it('atomically grants certificate-scoped critical cleanup without accepting an ordinary cancellation', async () => {
    process.env.TASK_ORCHESTRATOR_PUBLISHING = 'temporal';
    const certificateId = 'c'.repeat(64);
    const resolver = jest.spyOn(domainResolution, 'resolveDurableDomain');
    try {
      const projectId = temporalProjectId(),
        ref = { projectId, jobId: 'critical-reviewed-command' };
      const store = createDurableJobStore({ firestore: db, projectId });
      await db.runTransaction(async (tx) =>
        store.createInTransaction(tx, {
          ref,
          kind: 'sermon.delete',
          entity: { type: 'sermon', id: 'critical-review-sermon' },
          actorUid: 'durable-owner',
          payload: {},
          requestId: 'critical-review-create',
          generation: 1,
          dispatch: {
            ref,
            workflowType: 'publishingWorkflow',
            workflowId: 'critical-review-workflow',
            taskQueue: 'urm-orchestration',
          },
          createdAt: Date.now(),
        })
      );
      await store.markCritical(ref, { reasonCode: 'DESIRED_PROVIDER_DELETE' });
      await db.doc(`durableJobs/${ref.jobId}`).update({ state: 'needs_attention', actions: ['resolve'] });
      // The domain verifier owns certificate validation; this boundary tests its atomic command commit.
      resolver.mockImplementation(async (_input, hooks) =>
        db.runTransaction(async (tx) => {
          const result = {
            cleanupOnly: true as const,
            criticalRepairCertificateId: certificateId,
            signal: { name: 'publishingCriticalRepair', args: [{ certificateId }] },
          };
          const write = await hooks.prepareCommand(tx, result);
          return { ...result, commandReceipt: write() };
        })
      );
      await commandServerDurableJob('durable-admin', {
        jobId: ref.jobId,
        requestId: 'critical-reviewed-resolve',
        expectedRevision: 2,
        action: 'resolve',
        resolution: { decision: 'repair_critical' },
      });
      expect((await db.doc(`durableJobs/${ref.jobId}`).get()).data()).toMatchObject({
        state: 'cancel_requested',
        actions: [],
        result: { resolutionPurpose: 'cleanup' },
      });
      expect((await db.doc(`durableJobCancellationIntents/${ref.jobId}`).get()).data()).toMatchObject({
        purpose: 'critical_repair_cleanup',
        certificateId,
        actorUid: 'durable-admin',
        originalActorUid: 'durable-owner',
        acceptedUserCancellation: false,
      });
      expect((await db.collection('durableJobCommands').get()).docs[0].get('signal')).toEqual({
        name: 'publishingCriticalRepair',
        args: [{ certificateId }],
      });
    } finally {
      resolver.mockRestore();
      delete process.env.TASK_ORCHESTRATOR_PUBLISHING;
    }
  });
  it('rejects cancellation after irreversible entry and does not restore it during reviewed resume', async () => {
    process.env.TASK_ORCHESTRATOR_PUBLISHING = 'temporal';
    try {
      await db
        .doc('_control/temporalRelease')
        .update({ 'domains.publishing': { owner: 'temporal', admission: 'open' } });
      const projectId = temporalProjectId(),
        ref = { projectId, jobId: 'critical-command' };
      const store = createDurableJobStore({ firestore: db, projectId });
      await db.runTransaction(async (tx) =>
        store.createInTransaction(tx, {
          ref,
          kind: 'sermon.delete',
          entity: { type: 'sermon', id: 'critical-sermon' },
          actorUid: 'durable-owner',
          payload: {},
          requestId: 'critical-create',
          generation: 1,
          dispatch: {
            ref,
            workflowType: 'publishingWorkflow',
            workflowId: 'critical-workflow',
            taskQueue: 'urm-orchestration',
          },
          createdAt: Date.now(),
        })
      );
      await store.markCritical(ref, { reasonCode: 'DESIRED_PROVIDER_DELETE' });
      const head = await db
        .doc(
          `durableJobEntities/${durableEntityKey(
            projectId,
            { type: 'sermon', id: 'critical-sermon' },
            'sermon.update'
          )}`
        )
        .get();
      expect(head.data()).toMatchObject({ activeJobId: ref.jobId, generation: 1, scope: 'publishing' });
      expect((await db.doc(`durableJobCriticalSections/${ref.jobId}`).get()).data()).toMatchObject({
        projectId,
        jobId: ref.jobId,
        generation: 1,
        workflowId: 'critical-workflow',
      });
      await db
        .doc('sermons/critical-sermon')
        .set({ title: 'Pointers already cleared', uploaderId: 'durable-owner', editedAtMillis: 0 }, { merge: true });
      await expect(
        submitServerDurableJob({
          actorUid: 'durable-admin',
          kind: 'sermon.update',
          entity: { type: 'sermon', id: 'critical-sermon' },
          requestId: 'overwrite-active-critical',
          payload: { patch: { title: 'New edit' } },
        })
      ).rejects.toMatchObject({ code: 'aborted', message: 'An operation is already active for this entity.' });
      expect((await db.collection('durableJobIntents').get()).size).toBe(1);
      expect((await head.ref.get()).get('generation')).toBe(1);
      expect((await db.doc('sermons/critical-sermon').get()).get('title')).toBe('Pointers already cleared');
      // Even an older projection which advertises cancel cannot bypass the private fence.
      await db.doc(`durableJobs/${ref.jobId}`).update({ actions: ['cancel', 'resume'] });
      await expect(
        commandServerDurableJob('durable-owner', {
          jobId: ref.jobId,
          requestId: 'critical-cancel',
          expectedRevision: 2,
          action: 'cancel',
        })
      ).rejects.toMatchObject({ code: 'failed-precondition' });
      await commandServerDurableJob('durable-owner', {
        jobId: ref.jobId,
        requestId: 'critical-resume',
        expectedRevision: 2,
        action: 'resume',
      });
      expect((await db.doc(`durableJobs/${ref.jobId}`).get()).get('actions')).toEqual([]);
      expect((await db.doc(`durableJobCancellationIntents/${ref.jobId}`).get()).exists).toBe(false);
    } finally {
      delete process.env.TASK_ORCHESTRATOR_PUBLISHING;
    }
  });
  it('rejects browser-created orphan review cases even for an administrator', async () => {
    await expect(
      submitServerDurableJob({
        actorUid: 'durable-admin',
        kind: 'provider.orphan_review',
        entity: { type: 'maintenance', id: 'arbitrary-review' },
        requestId: 'browser-orphan-review',
        payload: {},
      })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('atomically indexes canonical provider references copied into upload membership mirrors', async () => {
    const projectId = temporalProjectId(),
      list = db.doc('lists/provider-list');
    await db.runTransaction((tx) =>
      withProviderIndexedTransaction(tx, db, projectId, async (recording) => {
        recording.create(list, { name: 'Provider list', subsplashId: 'canonical-list-provider', count: 0 });
      })
    );
    const receipt = await submitServerDurableJob({
      ...makeRequest('durable-owner', 'indexed-membership'),
      payload: { ...payload, listIds: [list.id] },
    });
    const sermonId = (await db.doc(`durableJobs/${receipt.jobId}`).get()).get('entity.id');
    const resource = {
      projectId,
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      remoteId: 'canonical-list-provider',
    };
    const aggregate = db.doc(`temporalProviderUsage/${providerResourceKey(resource)}/epochs/admission-test-epoch`);
    expect((await aggregate.get()).get('referenceCount')).toBe(2);
    expect((await db.doc(`sermons/${sermonId}/sermonLists/${list.id}`).get()).get('subsplashId')).toBe(
      resource.remoteId
    );
    expect((await list.get()).get('count')).toBe(1);
  });
  it('indexes a frozen publishing intent exactly once alongside its canonical provider reference', async () => {
    process.env.TASK_ORCHESTRATOR_PUBLISHING = 'temporal';
    try {
      const projectId = temporalProjectId(),
        sermon = db.doc('sermons/indexed-publishing');
      await db
        .doc('_control/temporalRelease')
        .update({ 'domains.publishing': { owner: 'temporal', admission: 'open' } });
      await db.runTransaction((tx) =>
        withProviderIndexedTransaction(tx, db, projectId, async (recording) => {
          recording.create(sermon, {
            id: sermon.id,
            title: 'Canonical title',
            uploaderId: 'durable-owner',
            editedAtMillis: 0,
            subsplashId: 'canonical-media-provider',
          });
        })
      );
      const request = {
        actorUid: 'durable-admin',
        kind: 'sermon.update' as const,
        entity: { type: 'sermon' as const, id: sermon.id },
        requestId: 'indexed-publishing-edit',
        payload: { patch: { title: 'Edited title' } },
      };
      const receipt = await submitServerDurableJob(request);
      expect((await submitServerDurableJob(request)).jobId).toBe(receipt.jobId);
      const resource = {
        projectId,
        provider: 'subsplash' as const,
        account: 'app:9XTSHD',
        remoteId: 'canonical-media-provider',
      };
      const aggregate = db.doc(`temporalProviderUsage/${providerResourceKey(resource)}/epochs/admission-test-epoch`);
      expect((await aggregate.get()).get('referenceCount')).toBe(2);
      expect((await db.doc(`durableJobIntents/${receipt.jobId}`).get()).get('payload.payload.sermon.subsplashId')).toBe(
        resource.remoteId
      );
    } finally {
      delete process.env.TASK_ORCHESTRATOR_PUBLISHING;
    }
  });
  it('retains the publishing barrier for confirmed provider effects awaiting canonical reconciliation', async () => {
    process.env.TASK_ORCHESTRATOR_PUBLISHING = 'temporal';
    try {
      await db
        .doc('_control/temporalRelease')
        .update({ 'domains.publishing': { owner: 'temporal', admission: 'open' } });
      await db.doc('sermons/confirmed-uncommitted').set({
        id: 'confirmed-uncommitted',
        title: 'Pending confirmation',
        uploaderId: 'durable-owner',
        editedAtMillis: 0,
      });
      const projectId = temporalProjectId(),
        ref = { projectId, jobId: 'confirmed-uncommitted-job' };
      const store = createDurableJobStore({ firestore: db, projectId });
      await db.runTransaction(async (tx) =>
        store.createInTransaction(tx, {
          ref,
          kind: 'sermon.publish',
          entity: { type: 'sermon', id: 'confirmed-uncommitted' },
          actorUid: 'durable-owner',
          payload: {},
          requestId: 'confirmed-create',
          generation: 1,
          dispatch: {
            ref,
            workflowType: 'publishingWorkflow',
            workflowId: 'confirmed-workflow',
            taskQueue: 'urm-orchestration',
          },
          createdAt: Date.now(),
        })
      );
      await db.doc(`durableJobs/${ref.jobId}`).update({ state: 'needs_attention', actions: ['resolve'] });
      const providerReceipt = db.doc('temporalProviderReceipts/confirmed-uncommitted');
      await providerReceipt.set({
        operationKey: `durable:${projectId}:${ref.jobId}:media-create`,
        state: 'confirmed',
        remoteId: 'provider-confirmed',
      });
      await expect(
        submitServerDurableJob({
          actorUid: 'durable-admin',
          kind: 'sermon.publish',
          entity: { type: 'sermon', id: 'confirmed-uncommitted' },
          requestId: 'other-admin-new-publish',
          payload: {},
        })
      ).rejects.toMatchObject({ code: 'aborted' });
      expect((await db.doc('sermons/confirmed-uncommitted').get()).get('subsplashId')).toBeUndefined();
      expect((await db.doc(`durableJobs/${ref.jobId}`).get()).get('generation')).toBe(1);
      await providerReceipt.delete();
    } finally {
      delete process.env.TASK_ORCHESTRATOR_PUBLISHING;
    }
  });
  it('commits narrowly scoped publishing cleanup authority with cancellation and preserves it on resume', async () => {
    process.env.TASK_ORCHESTRATOR_PUBLISHING = 'temporal';
    try {
      const projectId = temporalProjectId(),
        ref = { projectId, jobId: 'cleanup-authority' };
      const store = createDurableJobStore({ firestore: db, projectId });
      await db.runTransaction(async (tx) =>
        store.createInTransaction(tx, {
          ref,
          kind: 'sermon.delete',
          entity: { type: 'sermon', id: 'cleanup-sermon' },
          actorUid: 'durable-owner',
          payload: {},
          requestId: 'cleanup-create',
          generation: 1,
          dispatch: {
            ref,
            workflowType: 'publishingWorkflow',
            workflowId: 'cleanup-workflow',
            taskQueue: 'urm-orchestration',
          },
          createdAt: Date.now(),
        })
      );
      await commandServerDurableJob('durable-owner', {
        jobId: ref.jobId,
        requestId: 'cleanup-cancel',
        expectedRevision: 1,
        action: 'cancel',
      });
      const marker = (await db.doc(`durableJobCancellationIntents/${ref.jobId}`).get()).data();
      expect(marker).toMatchObject({
        schemaVersion: 1,
        ...ref,
        generation: 1,
        actorUid: 'durable-owner',
        workflowId: 'cleanup-workflow',
      });
      expect(marker?.authorizedAt).toBeGreaterThan(0);
      await db.doc(`durableJobs/${ref.jobId}`).update({ actions: ['resume'] });
      await commandServerDurableJob('durable-owner', {
        jobId: ref.jobId,
        requestId: 'cleanup-resume',
        expectedRevision: 2,
        action: 'resume',
      });
      const job = await db.doc(`durableJobs/${ref.jobId}`).get();
      expect(job.get('state')).toBe('cancel_requested');
      expect(job.get('result.resolutionPurpose')).toBe('cleanup');
      expect((await db.doc(`durableJobCancellationIntents/${ref.jobId}`).get()).data()).toEqual(marker);
    } finally {
      delete process.env.TASK_ORCHESTRATOR_PUBLISHING;
    }
  });
  it('deduplicates concurrent requests without duplicate source sessions or pending dispatch', async () => {
    const request = makeRequest('durable-owner', 'concurrent');
    const [a, b] = await Promise.all([submitServerDurableJob(request), submitServerDurableJob(request)]);
    expect(a.jobId).toBe(b.jobId);
    expect((await db.collection('durableJobs').get()).size).toBe(1);
    expect((await db.collection('sermons').get()).size).toBe(1);
    expect((await db.collection('durableJobOutbox').get()).size).toBe(0);
  });
  it('labels Activity from canonical content and ignores browser-provided entity labels', async () => {
    const request = makeRequest('durable-owner', 'canonical-label');
    const receipt = await submitServerDurableJob({
      ...request,
      entity: { ...request.entity, label: 'FAKE BROWSER LABEL' },
    });
    expect((await db.collection('durableJobs').doc(receipt.jobId).get()).get('entity.label')).toBe(
      payload.sermon.title
    );
    expect(
      (await submitServerDurableJob({ ...request, entity: { ...request.entity, label: 'ANOTHER FAKE LABEL' } })).jobId
    ).toBe(receipt.jobId);
  });
  it('rejects changed input with the same request ID', async () => {
    const request = makeRequest('durable-owner', 'immutable');
    await submitServerDurableJob(request);
    await expect(submitServerDurableJob({ ...request, payload: { ...payload, duration: 61 } })).rejects.toMatchObject({
      code: 'already-exists',
    });
  });
  it('scopes request receipts to the authenticated caller and project', async () => {
    const receipt = await submitServerDurableJob(makeRequest('durable-owner', 'caller'));
    expect(receipt.projectId).toBe(temporalProjectId());
    expect(await getServerDurableJobReceipt('durable-other', 'caller')).toBeNull();
    expect((await getServerDurableJobReceipt('durable-owner', 'caller'))?.jobId).toBe(receipt.jobId);
  });
  it('rejects disabled accounts and unauthorized job commands', async () => {
    await expect(submitServerDurableJob(makeRequest('durable-disabled', 'disabled'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    const receipt = await submitServerDurableJob(makeRequest('durable-owner', 'authorized'));
    await expect(
      commandServerDurableJob('durable-other', {
        jobId: receipt.jobId,
        requestId: 'cancel',
        expectedRevision: 1,
        action: 'cancel',
      })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('rejects a stale command and preserves live state', async () => {
    const receipt = await submitServerDurableJob(makeRequest('durable-owner', 'revision'));
    await expect(
      commandServerDurableJob('durable-owner', {
        jobId: receipt.jobId,
        requestId: 'cancel',
        expectedRevision: 0,
        action: 'cancel',
      })
    ).rejects.toMatchObject({ code: 'aborted' });
    expect((await db.collection('durableJobs').doc(receipt.jobId).get()).get('state')).toBe('awaiting_source');
  });
  it('pauses new admissions without blocking receipt recovery or existing source cancellation', async () => {
    const receipt = await submitServerDurableJob(makeRequest('durable-owner', 'before-pause'));
    await db.doc('_control/temporalRelease').update({ admission: 'paused', revision: 2 });
    expect((await submitServerDurableJob(makeRequest('durable-owner', 'before-pause'))).jobId).toBe(receipt.jobId);
    await expect(submitServerDurableJob(makeRequest('durable-owner', 'during-pause'))).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(
      commandServerDurableJob('durable-owner', {
        jobId: receipt.jobId,
        requestId: 'paused-cancel',
        expectedRevision: 1,
        action: 'cancel',
      })
    ).resolves.toMatchObject({ state: 'accepted' });
    expect((await db.collection('durableJobs').get()).size).toBe(1);
  });
  it('keeps pre-pause legacy work visible until completion and rejects late starts', async () => {
    await db.doc('_control/temporalRelease').update({ 'domains.media.owner': 'legacy' });
    let begin: () => void = () => undefined,
      finish: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const permittedFinish = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const invocation = withLegacyAdmissionLease(
      db,
      { domain: 'media', actorUid: 'durable-owner', operation: 'test-legacy', projectId: temporalProjectId() },
      async (lease) => {
        await lease.markEffectsStarted();
        begin();
        await permittedFinish;
        return 'done';
      }
    );
    await entered;
    await db.doc('_control/temporalRelease').update({ admission: 'paused', revision: 2 });
    expect((await db.collection('legacyAdmissionLeases').where('state', '==', 'active').get()).size).toBe(1);
    await expect(
      withLegacyAdmissionLease(
        db,
        { domain: 'media', actorUid: 'durable-owner', operation: 'late', projectId: temporalProjectId() },
        async () => 'unexpected'
      )
    ).rejects.toMatchObject({ code: 'unavailable' });
    finish();
    await expect(invocation).resolves.toBe('done');
    expect((await db.collection('legacyAdmissionLeases').where('state', '==', 'active').get()).size).toBe(0);
  });
  it('retains uncertain and expired legacy effects until audited reconciliation', async () => {
    await db.doc('_control/temporalRelease').update({ 'domains.media.owner': 'legacy' });
    await expect(
      withLegacyAdmissionLease(
        db,
        {
          domain: 'media',
          actorUid: 'durable-owner',
          operation: 'ambiguous',
          projectId: temporalProjectId(),
          diagnosticTimeoutMs: 1,
        },
        async (lease) => {
          await lease.markEffectsStarted();
          throw new Error('Lost acknowledgement');
        }
      )
    ).rejects.toThrow('Lost acknowledgement');
    const leases = await db.collection('legacyAdmissionLeases').get();
    expect(leases.docs[0].get('state')).toBe('needs_attention');
    expect(leases.docs[0].get('outcome')).toBe('unknown');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await leases.docs[0].ref.get()).get('state')).toBe('needs_attention');
  });
  it('rejects a series ownership transfer between upload preflight and transaction reservation', async () => {
    const series = db.collection('series').doc('ownership-race');
    await series.set({ ownerId: 'durable-owner', name: 'Series', itemCount: 0 });
    expect((await series.get()).get('ownerId')).toBe('durable-owner');
    const plan = normalizeUploadSource(
      { ...payload, sermon: { ...payload.sermon, seriesId: series.id } },
      'durable-owner',
      'ownership-job',
      db,
      { actorRole: 'uploader' }
    );
    await series.update({ ownerId: 'durable-other' });
    await expect(
      db.runTransaction((tx) => plan.reserve(tx, { jobId: 'ownership-job', projectId: temporalProjectId() }))
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await db.collection('sermons').doc(plan.sermon.id).get()).exists).toBe(false);
    expect((await series.get()).get('itemCount')).toBe(0);
  });
  it('atomically creates selected local list and series memberships without remote publishing', async () => {
    await db
      .collection('lists')
      .doc('selected-list')
      .set({ name: 'Local list', count: 2, logicalCount: 2, images: [], type: 'category-list' });
    await db
      .collection('series')
      .doc('selected-series')
      .set({ name: 'Local series', ownerId: 'durable-owner', itemCount: 1, publishedItemCount: 0 });
    await db.collection('series').doc('selected-series').collection('seriesItems').doc('existing').set({ position: 1 });
    const selectedPayload = {
      ...payload,
      listIds: ['selected-list'],
      sermon: { ...payload.sermon, seriesId: 'selected-series' },
    };
    const receipts = await Promise.all(
      ['membership-one', 'membership-two'].map((requestId) =>
        submitServerDurableJob({ ...makeRequest('durable-owner', requestId), payload: selectedPayload })
      )
    );
    expect((await db.collection('lists').doc('selected-list').get()).get('count')).toBe(4);
    expect((await db.collection('series').doc('selected-series').get()).get('itemCount')).toBe(3);
    const positions: number[] = [];
    for (const receipt of receipts) {
      const job = (await db.collection('durableJobs').doc(receipt.jobId).get()).data()!;
      const sermonId = job.entity.id;
      const membership = (
        await db.collection('sermons').doc(sermonId).collection('sermonLists').doc('selected-list').get()
      ).data()!;
      expect(membership.uploadStatus.status).toBe('NOT_UPLOADED');
      expect(membership._durableMembershipJobId).toBe(receipt.jobId);
      expect(
        (await db.collection('lists').doc('selected-list').collection('listItems').doc(sermonId).get()).exists
      ).toBe(true);
      const seriesItem = (
        await db.collection('series').doc('selected-series').collection('seriesItems').doc(sermonId).get()
      ).data()!;
      expect(seriesItem.publishedToSubsplash).toBe(false);
      positions.push(seriesItem.position);
    }
    expect(positions.sort()).toEqual([2, 3]);
  });
  it('atomically chooses cancellation or confirmed source plus child admission under a race', async () => {
    const receipt = await submitServerDurableJob(makeRequest('durable-owner', 'cancel-confirm-race'));
    const file = firebaseAdmin.storage().bucket().file(receipt.sourceUpload!.storagePath);
    await file.save(Buffer.from('test'), {
      metadata: {
        contentType: 'audio/mpeg',
        metadata: { durableJobId: receipt.jobId, fingerprint: JSON.stringify(fingerprint) },
      },
    });
    const [metadata] = await file.getMetadata();
    await Promise.allSettled([
      commandServerDurableJob('durable-owner', {
        jobId: receipt.jobId,
        requestId: 'race-cancel',
        expectedRevision: 1,
        action: 'cancel',
      }),
      confirmUploadSource('durable-owner', receipt.jobId, {
        storagePath: receipt.sourceUpload!.storagePath,
        generation: String(metadata.generation),
      }),
    ]);
    const job = (await db.collection('durableJobs').doc(receipt.jobId).get()).data()!;
    const session = (await db.collection('durableUploadSessions').doc(receipt.jobId).get()).data()!;
    expect(['cancelled', 'succeeded']).toContain(job.state);
    if (job.state === 'cancelled') {
      expect(session.state).toBe('cancelled');
      expect((await db.collection('temporalMediaRequests').get()).size).toBe(0);
    } else {
      expect(session.state).toBe('confirmed');
      expect(session.mediaJobRef.jobId).toBe(job.result.mediaJobId);
      expect((await db.collection('durableJobOutbox').get()).size).toBe(1);
    }
  });
});
