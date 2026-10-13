import { randomUUID } from 'node:crypto';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { withProviderIndexedTransaction } from '@upperroom/orchestration/provider-transaction';
import {
  extractProviderResources,
  providerResourceKey,
  providerEdgeKey,
  PROVIDER_USAGE_CONTROL,
  PROVIDER_USAGE_COLLECTION,
} from '@upperroom/orchestration/provider-usage';
import {
  createDurableJobStore,
  durableEntityKey,
  type DurableActivityExecution,
} from '@upperroom/orchestration/job-store';

/** Run through firebase emulators:exec --config ../firebase.test.json; never dev emulators. */
describe('durable activity execution fencing against Firestore', () => {
  const projectId = 'urm-app';
  const db = getFirestore();
  const fixtures: Array<{ jobId: string; entityId: string }> = [];
  beforeAll(() => {
    if (
      !process.env.FIRESTORE_EMULATOR_HOST ||
      !/^(127\.0\.0\.1|localhost):/.test(process.env.FIRESTORE_EMULATOR_HOST)
    ) {
      throw new Error('This test requires the dedicated local Firebase emulator harness.');
    }
  });
  afterAll(async () => {
    for (const fixture of fixtures) {
      const entity = { type: 'sermon' as const, id: fixture.entityId };
      const docs = await Promise.all(
        ['durableActivityExecutions', 'durableJobStepExecutions'].map((collection) =>
          db.collection(collection).where('jobId', '==', fixture.jobId).get()
        )
      );
      const batch = db.batch();
      docs.forEach((snapshot) => snapshot.docs.forEach((doc) => batch.delete(doc.ref)));
      for (const collection of [
        'durableJobs',
        'durableJobIntents',
        'durableJobOutbox',
        'durableJobCriticalSections',
        'durableJobCancellationIntents',
      ])
        batch.delete(db.collection(collection).doc(fixture.jobId));
      batch.delete(db.collection('durableJobEntities').doc(durableEntityKey(projectId, entity, 'sermon.publish')));
      batch.delete(db.collection('sermons').doc(fixture.entityId));
      await batch.commit();
    }
  });
  async function fixture() {
    const id = `epoch-${randomUUID()}`;
    const ref = { projectId, jobId: id };
    const entity = { type: 'sermon' as const, id };
    fixtures.push({ jobId: id, entityId: id });
    const workflowId = `epoch-test:${id}`;
    const plain = createDurableJobStore({ firestore: db, projectId });
    await db.runTransaction(async (tx) => {
      plain.createInTransaction(tx, {
        ref,
        kind: 'sermon.publish',
        entity,
        actorUid: 'epoch-test-actor',
        payload: {},
        requestId: id,
        generation: 1,
        createdAt: Date.now(),
        dispatch: { ref, workflowType: 'PublishSermon', workflowId, taskQueue: 'test-only' },
      });
    });
    const identity = (override: Partial<DurableActivityExecution> = {}): DurableActivityExecution => ({
      workflowId,
      runId: 'first-run',
      activityId: '1',
      activityType: 'applyAccountClaims',
      scheduledAt: 1000,
      runStartedAtNanos: '1000000000001',
      attempt: 12,
      ...override,
    });
    const executing = (execution: DurableActivityExecution) =>
      createDurableJobStore({ firestore: db, projectId, getExecution: () => execution });
    return { ref, identity, executing };
  }
  test('new resumed attempt advances twelve to thirteen and late old writes cannot commit', async () => {
    const { ref, identity, executing } = await fixture();
    const previous = identity();
    const old = executing(previous);
    await old.registerActivityExecution(ref, previous, { stepIds: ['claims'] });
    await old.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'retrying', attempt: 12 });
    const resumedIdentity = identity({ activityId: '2', scheduledAt: 2000, attempt: 1 });
    const resumed = executing(resumedIdentity);
    await resumed.registerActivityExecution(ref, resumedIdentity, { stepIds: ['claims'] });
    const before = (await resumed.loadJob(ref)).revision;
    const outcomes = await Promise.allSettled([
      old.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'succeeded', attempt: 12 }),
      old.project(ref, { state: 'succeeded' }),
      resumed.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'running', attempt: 1 }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
    const job = await resumed.loadJob(ref);
    expect(job.revision).toBe(before + 1);
    expect(job.steps[0]).toMatchObject({ state: 'running', attempt: 13 });
    await expect(
      db.runTransaction(async (tx) => {
        await old.assertCurrentInTransaction(tx, ref);
        tx.set(db.collection('sermons').doc(ref.jobId), { staleEpochCommitted: true }, { merge: true });
      })
    ).rejects.toMatchObject({ code: 'STALE_EXECUTION' });
    expect((await db.collection('sermons').doc(ref.jobId).get()).get('staleEpochCommitted')).toBeUndefined();
  });
  test('a separate attention activity fences the provider without counting a fake attempt', async () => {
    const { ref, identity, executing } = await fixture();
    const oldIdentity = identity();
    const old = executing(oldIdentity);
    await old.registerActivityExecution(ref, oldIdentity, { stepIds: ['claims'] });
    await old.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'retrying', attempt: 12 });
    const reportIdentity = identity({
      activityId: '2',
      activityType: 'reportAccountAttention',
      scheduledAt: 2000,
      attempt: 1,
    });
    const report = executing(reportIdentity);
    await report.registerActivityExecution(ref, reportIdentity, { stepIds: ['claims'], countsAttempt: false });
    await report.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'waiting', attempt: 1 });
    expect((await report.loadJob(ref)).steps[0].attempt).toBe(12);
    await expect(old.assertCurrent(ref)).rejects.toMatchObject({ code: 'STALE_EXECUTION' });
    const newIdentity = identity({ activityId: '3', scheduledAt: 3000, attempt: 1 });
    const resumed = executing(newIdentity);
    await resumed.registerActivityExecution(ref, newIdentity, { stepIds: ['claims'] });
    await resumed.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'running', attempt: 1 });
    expect((await resumed.loadJob(ref)).steps[0].attempt).toBe(13);
  });
  test('prepared critical boundary and fixed reservation commit or roll back together', async () => {
    const { ref } = await fixture();
    const store = createDurableJobStore({ firestore: db, projectId });
    const reservation = db.collection('testCriticalProviderReservations').doc(ref.jobId);
    const marker = db.collection('durableJobCriticalSections').doc(ref.jobId);
    try {
      await expect(
        store.markCritical(ref, {
          reasonCode: 'PUBLISHING_DELETE_MEDIA',
          prepare: async (tx) => {
            await tx.get(reservation);
            return () => {
              tx.create(reservation, { jobId: ref.jobId });
              throw new Error('injected reservation failure');
            };
          },
        })
      ).rejects.toThrow('injected reservation failure');
      expect((await marker.get()).exists).toBe(false);
      expect((await reservation.get()).exists).toBe(false);
      await db.runTransaction(async (tx) => {
        const entered = await store.prepareCritical(tx, ref, { reasonCode: 'PUBLISHING_DELETE_MEDIA' });
        expect((await tx.get(reservation)).exists).toBe(false);
        tx.create(reservation, { jobId: ref.jobId });
        entered.commit();
      });
      expect((await marker.get()).exists).toBe(true);
      expect((await reservation.get()).get('jobId')).toBe(ref.jobId);
      expect((await store.loadJob(ref)).actions).not.toContain('cancel');
    } finally {
      await reservation.delete();
    }
  });
  test('cancel admission and irreversible critical entry have exactly one transaction winner', async () => {
    const { ref } = await fixture();
    const store = createDurableJobStore({ firestore: db, projectId });
    const target = db.collection('durableJobs').doc(ref.jobId);
    const critical = db.collection('durableJobCriticalSections').doc(ref.jobId);
    let effects = 0;
    const outcomes = await Promise.allSettled([
      store.markCritical(ref, { reasonCode: 'PUBLISHING_DELETE_MEDIA' }).then(() => {
        effects += 1;
      }),
      db.runTransaction(async (tx) => {
        const [job, entered] = await Promise.all([tx.get(target), tx.get(critical)]);
        if (entered.exists) throw new Error('critical mutation cannot be cancelled');
        tx.set(db.collection('durableJobCancellationIntents').doc(ref.jobId), {
          ...ref,
          generation: job.get('generation'),
          workflowId: job.get('workflowId'),
        });
        tx.update(target, { state: 'cancel_requested', revision: job.get('revision') + 1, actions: [] });
      }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    if (outcomes[0].status === 'fulfilled') {
      expect(effects).toBe(1);
      expect((await critical.get()).exists).toBe(true);
      expect((await target.get()).get('state')).not.toBe('cancel_requested');
    } else {
      expect(effects).toBe(0);
      expect((await critical.get()).exists).toBe(false);
      expect((await target.get()).get('state')).toBe('cancel_requested');
    }
  });
});

describe('public reference deletion index projection against Firestore', () => {
  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST || !/^(127\.0\.0\.1|localhost):/.test(process.env.FIRESTORE_EMULATOR_HOST))
      throw new Error('This test requires the dedicated local Firebase emulator harness.');
  });
  test('dotted and merge sentinel removals commit exact edge deltas with canonical deletion', async () => {
    const db = getFirestore(),
      projectId = 'urm-app',
      epoch = `deletion-${randomUUID()}`;
    const marker = db.doc(PROVIDER_USAGE_CONTROL),
      previous = await marker.get();
    const canonical = db.collection('sermons').doc(epoch);
    const data = { subsplashId: `audio-${epoch}`, nested: { tagId: `speaker-${epoch}`, title: 'keep' } };
    const resources = extractProviderResources(projectId, canonical.path, data);
    try {
      await marker.set({ schemaVersion: 1, projectId, epoch, status: 'ready', releaseId: epoch, controlRevision: 1 });
      await db.runTransaction(async (tx) =>
        withProviderIndexedTransaction(tx, db, projectId, async (recording) => {
          recording.create(canonical, data);
        })
      );
      const aggregates = resources.map((resource) =>
        db.collection(PROVIDER_USAGE_COLLECTION).doc(providerResourceKey(resource)).collection('epochs').doc(epoch)
      );
      expect((await Promise.all(aggregates.map((ref) => ref.get()))).map((doc) => doc.get('referenceCount'))).toEqual([
        1, 1,
      ]);
      await db.runTransaction(async (tx) =>
        withProviderIndexedTransaction(tx, db, projectId, async (recording) => {
          recording.update(canonical, { 'nested.tagId': FieldValue.delete() });
          recording.set(canonical, { subsplashId: FieldValue.delete() }, { merge: true });
        })
      );
      expect((await canonical.get()).data()).toEqual({ nested: { title: 'keep' } });
      expect((await Promise.all(aggregates.map((ref) => ref.get()))).map((doc) => doc.get('referenceCount'))).toEqual([
        0, 0,
      ]);
      expect(
        (
          await Promise.all(aggregates.map((ref) => ref.collection('edges').doc(providerEdgeKey(canonical.path)).get()))
        ).every((doc) => !doc.exists)
      ).toBe(true);
    } finally {
      await canonical.delete();
      for (const resource of resources)
        await db.recursiveDelete(db.collection(PROVIDER_USAGE_COLLECTION).doc(providerResourceKey(resource)));
      if (previous.exists) await marker.set(previous.data()!);
      else await marker.delete();
    }
  });
});
