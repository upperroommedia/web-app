import * as usage from './provider-usage';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  createDurableJobStore,
  durableEntityKey,
  getDurableJobScope,
  type CreateDurableJobInput,
  type DurableActivityExecution,
} from './job-store';

/** Transaction emulator for read-before-write and atomic commits; no production emulator ports. */
function memoryFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  let tail: Promise<unknown> = Promise.resolve();
  const ref = (path: string) => ({ path, get: async () => snapshot(path) });
  const snapshot = (path: string) => ({
    exists: docs.has(path),
    data: () => (docs.has(path) ? structuredClone(docs.get(path)) : undefined),
    get: (key: string) => docs.get(path)?.[key],
  });
  const firestore = {
    collection: (collection: string) => ({ doc: (id: string) => ref(`${collection}/${id}`) }),
    runTransaction: <T>(callback: (tx: Transaction) => Promise<T>) => {
      const run = tail.then(async () => {
        const writes: Array<{ path: string; value: Record<string, unknown>; create: boolean; merge: boolean }> = [];
        let writing = false;
        const tx = {
          get: async (document: { path: string }) => {
            if (writing) throw new Error('Read after write');
            return snapshot(document.path);
          },
          create: (document: { path: string }, value: Record<string, unknown>) => {
            writing = true;
            writes.push({ path: document.path, value: structuredClone(value), create: true, merge: false });
            return tx;
          },
          set: (document: { path: string }, value: Record<string, unknown>, options?: { merge: boolean }) => {
            writing = true;
            writes.push({ path: document.path, value: structuredClone(value), create: false, merge: !!options?.merge });
            return tx;
          },
        };
        const result = await callback(tx as unknown as Transaction);
        const created = new Set<string>();
        for (const write of writes) {
          if (write.create && (docs.has(write.path) || created.has(write.path))) throw new Error('ALREADY_EXISTS');
          if (write.create) created.add(write.path);
        }
        for (const write of writes)
          docs.set(write.path, write.merge ? { ...docs.get(write.path), ...write.value } : write.value);
        return result;
      });
      tail = run.catch(() => undefined);
      return run;
    },
  } as unknown as Firestore;
  return { firestore, docs };
}
const ref = { jobId: 'job1', projectId: 'staging' };
function admission(overrides: Partial<CreateDurableJobInput> = {}): CreateDurableJobInput {
  return {
    ref,
    kind: 'sermon.publish',
    entity: { type: 'sermon', id: 'sermon1' },
    actorUid: 'admin1',
    payload: { privateToken: 'not public' },
    requestId: 'request1',
    generation: 1,
    dispatch: {
      workflowType: 'PublishSermon',
      workflowId: 'publish:staging:sermon1',
      taskQueue: 'urm-orchestration',
      ref,
    },
    createdAt: 100,
    ...overrides,
  };
}
async function setup() {
  const memory = memoryFirestore();
  const store = createDurableJobStore({ firestore: memory.firestore, projectId: 'staging', now: () => 200 });
  await memory.firestore.runTransaction(async (tx) => {
    store.createInTransaction(tx, admission());
  });
  return { ...memory, store };
}

describe('durable job store', () => {
  test('admission is write-only and atomically keeps sensitive intent out of public job and history', async () => {
    const { docs, store } = await setup();
    expect((await store.loadIntent<{ privateToken: string }>(ref)).payload.privateToken).toBe('not public');
    expect(JSON.stringify(await store.loadJob(ref))).not.toContain('privateToken');
    expect(docs.get('durableJobOutbox/job1')).toMatchObject({
      state: 'pending',
      nextAttemptAt: 0,
      leaseExpiresAt: 0,
      attempt: 0,
    });
    expect(docs.get('sermons/sermon1')).toMatchObject({ activeDurableJobs: { publishing: { ...ref, generation: 1 } } });
  });
  test('awaiting source creates a durable record without starting a workflow', async () => {
    const { firestore, docs } = memoryFirestore();
    const store = createDurableJobStore({ firestore, projectId: 'staging' });
    await firestore.runTransaction(async (tx) => {
      store.createInTransaction(tx, admission({ initialState: 'awaiting_source', kind: 'upload.create' }));
    });
    expect(docs.has('durableJobOutbox/job1')).toBe(false);
    expect((await store.loadJob(ref)).actions).toEqual(['resume_upload', 'cancel']);
  });
  test('duplicate admission rolls back every write', async () => {
    const { firestore, docs, store } = await setup();
    const previous = structuredClone([...docs]);
    await expect(
      firestore.runTransaction(async (tx) => {
        store.createInTransaction(tx, admission({ generation: 2 }));
      })
    ).rejects.toThrow('ALREADY_EXISTS');
    expect([...docs]).toEqual(previous);
  });
  test('parallel step writers preserve both steps and increment projection revision', async () => {
    const { store } = await setup();
    await Promise.all([
      store.recordStep(ref, { id: 'soundcloud', label: 'SoundCloud', state: 'running', attempt: 1 }),
      store.recordStep(ref, { id: 'subsplash', label: 'Subsplash', state: 'running', attempt: 1 }),
    ]);
    const job = await store.loadJob(ref);
    expect(job.revision).toBe(3);
    expect(job.steps.map((s) => s.id).sort()).toEqual(['soundcloud', 'subsplash']);
  });
  test('partial step projections retain completed earlier stages', async () => {
    const { store } = await setup();
    await store.project(ref, { steps: [{ id: 'acquire', label: 'Acquire', state: 'succeeded', attempt: 1 }] });
    await store.project(ref, { steps: [{ id: 'merge', label: 'Merge', state: 'running', attempt: 1 }] });
    expect((await store.loadJob(ref)).steps.map((step) => step.id)).toEqual(['acquire', 'merge']);
  });
  test('optimistic command racing an activity refuses stale revision', async () => {
    const { store } = await setup();
    const results = await Promise.allSettled([
      store.project(ref, { state: 'running', expectedRevision: 1 }),
      store.project(ref, { state: 'cancel_requested', expectedRevision: 1 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await store.loadJob(ref)).revision).toBe(2);
  });
  test('new publishing generation fences old jobs but audio remains independent', async () => {
    const { store, firestore } = await setup();
    const audioRef = { ...ref, jobId: 'audio1' };
    await firestore.runTransaction(async (tx) => {
      store.createInTransaction(
        tx,
        admission({ ref: audioRef, kind: 'audio.process', dispatch: { ...admission().dispatch, ref: audioRef } })
      );
    });
    await store.assertCurrent(ref);
    await store.assertCurrent(audioRef);
    const newRef = { ...ref, jobId: 'job2' };
    await firestore.runTransaction(async (tx) => {
      store.createInTransaction(
        tx,
        admission({ ref: newRef, generation: 2, dispatch: { ...admission().dispatch, ref: newRef } })
      );
    });
    await expect(store.project(ref, { state: 'succeeded' })).rejects.toMatchObject({ code: 'STALE_GENERATION' });
    await store.assertCurrent(audioRef);
    await store.project(ref, { state: 'superseded' });
    expect((await store.loadJob(ref)).state).toBe('superseded');
  });
  test('atomic domain commit primitive reads before the caller writes', async () => {
    const { store, firestore } = await setup();
    await firestore.runTransaction(async (tx) => {
      const intent = await store.assertCurrentInTransaction(tx, ref);
      expect(intent.actorUid).toBe('admin1');
      tx.set(firestore.collection('sermons').doc('sermon1'), { published: true }, { merge: true });
    });
  });
  test('revoked actor is rechecked immediately before external effects', async () => {
    const { firestore } = await setup();
    const hook = jest.fn().mockRejectedValue(new Error('Permission revoked'));
    const store = createDurableJobStore({ firestore, projectId: 'staging', authorizeActor: hook });
    await expect(store.assertCurrent(ref)).rejects.toThrow('Permission revoked');
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ actorUid: 'admin1' }));
  });
  test('terminal retries cannot reopen jobs; identical completion is idempotent', async () => {
    const { store } = await setup();
    const completed = await store.project(ref, { state: 'succeeded', result: { requestVersion: 'v1' } });
    expect(completed.actions).toEqual([]);
    await expect(store.project(ref, { state: 'running' })).rejects.toMatchObject({ code: 'TERMINAL_JOB' });
    expect((await store.project(ref, { state: 'succeeded', result: { requestVersion: 'v1' } })).revision).toBe(
      completed.revision
    );
    await expect(
      store.recordStep(ref, { id: 'late', label: 'Late', state: 'running', attempt: 1 })
    ).rejects.toMatchObject({ code: 'TERMINAL_JOB' });
  });
  test('old attempt and regressing progress cannot overwrite new work', async () => {
    const { store } = await setup();
    await store.recordStep(ref, {
      id: 'transfer',
      label: 'Transfer',
      state: 'running',
      attempt: 2,
      progress: { completed: 50, total: 100, unit: 'bytes' },
    });
    await expect(
      store.recordStep(ref, { id: 'transfer', label: 'Transfer', state: 'running', attempt: 1 })
    ).rejects.toMatchObject({ code: 'STALE_STEP' });
    await expect(
      store.recordStep(ref, {
        id: 'transfer',
        label: 'Transfer',
        state: 'running',
        attempt: 2,
        progress: { completed: 1, total: 100, unit: 'bytes' },
      })
    ).rejects.toMatchObject({ code: 'STALE_STEP' });
  });
  test('identity, raw diagnostics, secrets, arbitrary results and history payloads are rejected', async () => {
    const { store, firestore } = await setup();
    await expect(store.loadJob({ ...ref, projectId: 'production' })).rejects.toMatchObject({
      code: 'PROJECT_MISMATCH',
    });
    await expect(store.project(ref, { result: { token: 'secret' } })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(
      store.project(ref, {
        error: { code: 'PROVIDER', message: 'https://provider/path?token=secret', retryable: true },
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      store.project(ref, {
        result: {
          sourceUpload: {
            storagePath: 'sources/file',
            jobRevision: 1,
            expectedFile: { name: 'audio.wav', size: 10, lastModified: 123, token: 'secret' },
          },
        },
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const unsafeReference = { ...ref, password: 'secret' };
    await expect(
      firestore.runTransaction(async (tx) => {
        store.createInTransaction(tx, admission({ dispatch: { ...admission().dispatch, ref: unsafeReference } }));
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      firestore.runTransaction(async (tx) => {
        store.createInTransaction(
          tx,
          admission({
            ref: { ...ref, jobId: 'private' },
            dispatch: { ...admission().dispatch, ref: { ...ref, jobId: 'private' }, startArgs: { password: 'secret' } },
          })
        );
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
  test('source upload descriptor is bounded and explicitly allows fingerprint and child job reference', async () => {
    const { store } = await setup();
    await store.project(ref, {
      result: {
        sourceUpload: {
          storagePath: 'sources/audio.wav',
          jobRevision: 1,
          expectedFile: {
            name: 'audio.wav',
            size: 10,
            lastModified: 123,
            fingerprint: { algorithm: 'sha256-chunks-v1', chunkBytes: 4194304, value: 'a'.repeat(64) },
          },
        },
        mediaJobRef: { ...ref, jobId: 'media1' },
      },
    });
    expect((await store.loadJob(ref)).result?.sourceUpload).toBeDefined();
  });
  test('derived series metadata cannot supersede an editor publishing request', () => {
    expect(getDurableJobScope('series.sync_metadata')).toBe('series-derived');
    expect(getDurableJobScope('series.publish')).toBe('series');
  });
  test('account claim and role mutation share fencing scope', () => {
    expect(getDurableJobScope('invite.claim')).toBe(getDurableJobScope('role.resolve'));
    const entity = { type: 'user' as const, id: 'user1' };
    expect(durableEntityKey('staging', entity, 'invite.claim')).toBe(
      durableEntityKey('staging', entity, 'role.resolve')
    );
    expect(durableEntityKey('staging', entity, 'invite.claim')).not.toBe(
      durableEntityKey('production', entity, 'invite.claim')
    );
  });
  function execution(overrides: Partial<DurableActivityExecution> = {}): DurableActivityExecution {
    return {
      workflowId: admission().dispatch.workflowId,
      runId: 'run1',
      activityId: '1',
      activityType: 'applyAccountClaims',
      scheduledAt: 1000,
      attempt: 1,
      runStartedAtNanos: '1000000000001',
      ...overrides,
    };
  }
  function executableStore(firestore: Firestore, identity: DurableActivityExecution) {
    return createDurableJobStore({ firestore, projectId: 'staging', getExecution: () => identity, now: () => 2000 });
  }
  test('resumed SDK attempt one becomes cumulative attempt thirteen and fences old execution', async () => {
    const { firestore } = await setup();
    const oldIdentity = execution({ attempt: 12 });
    const old = executableStore(firestore, oldIdentity);
    await old.registerActivityExecution(ref, oldIdentity, { stepIds: ['claims'] });
    await old.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'retrying', attempt: 12 });
    const newIdentity = execution({ activityId: '2', scheduledAt: 2000 });
    const resumed = executableStore(firestore, newIdentity);
    await resumed.registerActivityExecution(ref, newIdentity, { stepIds: ['claims'] });
    await resumed.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'running', attempt: 1 });
    expect((await resumed.loadJob(ref)).steps[0].attempt).toBe(13);
    await expect(old.assertCurrent(ref)).rejects.toMatchObject({ code: 'STALE_EXECUTION' });
    await expect(
      old.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'succeeded', attempt: 12 })
    ).rejects.toMatchObject({ code: 'STALE_EXECUTION' });
    await expect(old.project(ref, { state: 'succeeded' })).rejects.toMatchObject({ code: 'STALE_EXECUTION' });
    await expect(old.registerActivityExecution(ref, oldIdentity, { stepIds: ['claims'] })).rejects.toMatchObject({
      code: 'STALE_EXECUTION',
    });
  });
  test('automatic retries within one execution map SDK attempts without resetting the base', async () => {
    const { firestore } = await setup();
    const first = execution();
    const store1 = executableStore(firestore, first);
    await store1.registerActivityExecution(ref, first, { stepIds: ['claims'] });
    await store1.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'retrying', attempt: 1 });
    const retry = execution({ attempt: 12 });
    const store12 = executableStore(firestore, retry);
    await store12.registerActivityExecution(ref, retry, { stepIds: ['claims'] });
    await store12.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'running', attempt: 12 });
    expect((await store12.loadJob(ref)).steps[0].attempt).toBe(12);
    await expect(store1.assertCurrent(ref)).rejects.toMatchObject({ code: 'STALE_EXECUTION' });
    await expect(store1.registerActivityExecution(ref, first, { stepIds: ['claims'] })).rejects.toMatchObject({
      code: 'STALE_EXECUTION',
    });
  });
  test('attention activity fences its provider step without inventing another provider attempt', async () => {
    const { firestore } = await setup();
    const oldIdentity = execution({ attempt: 12 });
    const old = executableStore(firestore, oldIdentity);
    await old.registerActivityExecution(ref, oldIdentity, { stepIds: ['claims'] });
    await old.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'retrying', attempt: 12 });
    const reportIdentity = execution({ activityId: '2', activityType: 'reportAccountAttention', scheduledAt: 2000 });
    const report = executableStore(firestore, reportIdentity);
    await report.registerActivityExecution(ref, reportIdentity, { stepIds: ['claims'], countsAttempt: false });
    await report.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'waiting', attempt: 1 });
    expect((await report.loadJob(ref)).steps[0].attempt).toBe(12);
    await expect(old.assertCurrent(ref)).rejects.toMatchObject({ code: 'STALE_EXECUTION' });
    const nextIdentity = execution({ activityId: '3', scheduledAt: 3000 });
    const next = executableStore(firestore, nextIdentity);
    await next.registerActivityExecution(ref, nextIdentity, { stepIds: ['claims'] });
    await next.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'running', attempt: 1 });
    expect((await next.loadJob(ref)).steps[0].attempt).toBe(13);
  });
  test('continue-as-new millisecond ties use authoritative run start nanoseconds', async () => {
    const { firestore } = await setup();
    const first = execution({ attempt: 12 });
    const previous = executableStore(firestore, first);
    await previous.registerActivityExecution(ref, first, { stepIds: ['claims'] });
    await previous.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'retrying', attempt: 12 });
    const nextIdentity = execution({ runId: 'run2', runStartedAtNanos: '1000000000002' });
    const next = executableStore(firestore, nextIdentity);
    await next.registerActivityExecution(ref, nextIdentity, { stepIds: ['claims'] });
    await next.recordStep(ref, { id: 'claims', label: 'Apply access', state: 'running', attempt: 1 });
    expect((await next.loadJob(ref)).steps[0].attempt).toBe(13);
    await expect(previous.assertCurrent(ref)).rejects.toMatchObject({ code: 'STALE_EXECUTION' });
  });
  test('numeric activity order handles same-run millisecond ties without lexical ordering', async () => {
    const { firestore } = await setup();
    const first = execution({ activityId: '9', attempt: 12 });
    const previous = executableStore(firestore, first);
    await previous.registerActivityExecution(ref, first, { stepIds: ['claims'] });
    const nextIdentity = execution({ activityId: '10' });
    const next = executableStore(firestore, nextIdentity);
    await next.registerActivityExecution(ref, nextIdentity, { stepIds: ['claims'] });
    await expect(previous.assertCurrent(ref)).rejects.toMatchObject({ code: 'STALE_EXECUTION' });
  });
  test('an activity must register before effects and cannot claim a different workflow', async () => {
    const { firestore } = await setup();
    const identity = execution();
    const store = executableStore(firestore, identity);
    await expect(store.assertCurrent(ref)).rejects.toMatchObject({ code: 'STALE_EXECUTION' });
    await expect(
      store.registerActivityExecution(ref, { ...identity, workflowId: 'another-workflow' })
    ).rejects.toMatchObject({ code: 'STALE_EXECUTION' });
  });
  test('running and successful projections clear transient failures while retaining completed steps', async () => {
    const { store } = await setup();
    await store.recordStep(ref, {
      id: 'download',
      label: 'Download',
      state: 'succeeded',
      attempt: 1,
      progress: { completed: 10, total: 10, unit: 'bytes' },
    });
    await store.project(ref, {
      state: 'retrying',
      error: { code: 'RETRY', message: 'Temporary problem', retryable: true },
      attention: { kind: 'source_unavailable', message: 'Source temporarily unavailable' },
    });
    await store.project(ref, { state: 'running' });
    const resumed = await store.loadJob(ref);
    expect(resumed.error).toBeUndefined();
    expect(resumed.attention).toBeUndefined();
    expect(resumed.steps[0].progress).toEqual({ completed: 10, total: 10, unit: 'bytes' });
  });

  test('identical-looking newly scheduled attempt one still advances the server counter', async () => {
    const { firestore } = await setup();
    const one = execution();
    const first = executableStore(firestore, one);
    const step = { id: 'claims', label: 'Apply access', state: 'running' as const, attempt: 1 };
    await first.registerActivityExecution(ref, one, { stepIds: ['claims'] });
    await first.recordStep(ref, step);
    const two = execution({ activityId: '2', scheduledAt: 2000 });
    const resumed = executableStore(firestore, two);
    await resumed.registerActivityExecution(ref, two, { stepIds: ['claims'] });
    await resumed.recordStep(ref, step);
    expect((await resumed.loadJob(ref)).steps[0].attempt).toBe(2);
  });
});

describe('private active intent provider usage', () => {
  afterEach(() => jest.restoreAllMocks());
  test('provider-bearing intent requires preparation and rejects payload mutation after index preparation', async () => {
    const { firestore, docs } = memoryFirestore();
    const store = createDurableJobStore({ firestore, projectId: 'staging' });
    const input = admission({ payload: { subsplashId: 'remote1' } });
    await expect(firestore.runTransaction(async (tx) => store.createInTransaction(tx, input))).rejects.toThrow(
      'require read-only usage preparation'
    );
    expect(docs.size).toBe(0);
    const prepare = jest.spyOn(usage, 'prepareProviderUsageChange').mockResolvedValue(() => {});
    await expect(
      firestore.runTransaction(async (tx) => {
        const apply = await store.prepareCreateInTransaction(tx, input);
        input.payload = { subsplashId: 'remote2' };
        apply();
        store.createInTransaction(tx, input);
      })
    ).rejects.toThrow('require read-only usage preparation');
    expect(docs.size).toBe(0);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  test('admission installs a private intent edge and terminal projection releases only that edge', async () => {
    const { firestore } = memoryFirestore();
    const store = createDurableJobStore({ firestore, projectId: 'staging' });
    const prepare = jest.spyOn(usage, 'prepareProviderUsageChange').mockResolvedValue(() => {});
    const input = admission({ payload: { subsplashId: 'remote1' } });
    await firestore.runTransaction(async (tx) => {
      const apply = await store.prepareCreateInTransaction(tx, input);
      apply();
      store.createInTransaction(tx, input);
    });
    expect(prepare.mock.calls[0][2]).toMatchObject({
      canonicalPath: 'durableJobIntents/job1',
      before: undefined,
      after: { payload: { subsplashId: 'remote1' } },
    });
    await store.project(ref, { state: 'succeeded' });
    expect(prepare.mock.calls[1][2]).toMatchObject({
      canonicalPath: 'durableJobIntents/job1',
      before: { payload: { subsplashId: 'remote1' } },
      after: undefined,
    });
    await store.project(ref, { state: 'succeeded' });
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});

test('public orphan attention and result expose only bounded opaque acknowledgement IDs', async () => {
  const { store } = await setup();
  const acknowledgementId = 'a'.repeat(64);
  const projected = await store.project(ref, {
    state: 'needs_attention',
    actions: ['resolve'],
    attention: { kind: 'external_result_unknown', message: 'Review the additional allocation.', acknowledgementId },
    result: { acknowledgementId },
  });
  expect(projected.attention?.acknowledgementId).toBe(acknowledgementId);
  await expect(
    store.project(ref, {
      attention: { kind: 'external_result_unknown', message: 'Review', acknowledgementId: 'private/receipt/body' },
    })
  ).rejects.toThrow('Invalid provider acknowledgement');
  await expect(store.project(ref, { result: { acknowledgementId: 'not-a-hash' } })).rejects.toThrow(
    'Invalid provider acknowledgement'
  );
});

test('known-resource retention attention is derived from an exact scoped confirmed private receipt', async () => {
  const { store, docs } = await setup();
  docs.set('temporalProviderReceipts/receipt1', {
    projectId: 'staging',
    jobId: 'job1',
    operationKey: 'durable:staging:job1:publish',
    state: 'confirmed',
    result: { id: 'known-image' },
  });
  const result = await store.project(ref, {
    state: 'needs_attention',
    actions: ['resolve'],
    error: {
      code: 'PUBLISHING_CANCEL_EXTERNAL_REFERENCE_REVIEW_REQUIRED',
      message: 'Review shared resource',
      retryable: false,
    },
    attention: { kind: 'external_result_unknown', message: 'Review shared resource', receiptId: 'receipt1' },
  });
  expect(result.attention).toMatchObject({ resolutionKind: 'retain_existing_resource', remoteId: 'known-image' });
  docs.get('temporalProviderReceipts/receipt1')!.jobId = 'other-job';
  const foreign = await store.project(ref, {
    error: { code: 'PUBLISHING_CANCEL_EXTERNAL_REFERENCE_REVIEW_REQUIRED', message: 'Review', retryable: false },
    attention: { kind: 'external_result_unknown', message: 'Review', receiptId: 'receipt1' },
  });
  expect(foreign.attention?.resolutionKind).toBeUndefined();
});

describe('irreversible desired mutation critical boundary', () => {
  test('cancel winning before critical checkpoint prevents the irreversible phase and every write', async () => {
    const { store, firestore, docs } = await setup();
    await firestore.runTransaction(async (tx) => {
      tx.set(firestore.collection('durableJobCancellationIntents').doc('job1'), {
        projectId: 'staging',
        jobId: 'job1',
      });
      tx.set(firestore.collection('durableJobs').doc('job1'), {
        ...docs.get('durableJobs/job1'),
        state: 'cancel_requested',
      });
    });
    await expect(store.markCritical(ref, { reasonCode: 'PUBLISHING_DELETE_MEDIA' })).rejects.toMatchObject({
      code: 'STALE_REVISION',
    });
    expect(docs.has('durableJobCriticalSections/job1')).toBe(false);
    expect((await store.loadJob(ref)).state).toBe('cancel_requested');
  });
  test('critical checkpoint atomically removes cancellation and later projections cannot restore it', async () => {
    const { store, docs } = await setup();
    const critical = await store.markCritical(ref, { reasonCode: 'PUBLISHING_DELETE_MEDIA' });
    expect(critical).toMatchObject({ revision: 2, actions: [] });
    expect(docs.get('durableJobCriticalSections/job1')).toMatchObject({
      ...ref,
      generation: 1,
      workflowId: critical.workflowId,
      revision: 2,
    });
    const retry = await store.project(ref, { state: 'retrying', actions: ['cancel', 'resolve'] });
    expect(retry.actions).toEqual([]);
    expect((await store.markCritical(ref, { reasonCode: 'PUBLISHING_DELETE_MEDIA' })).revision).toBe(retry.revision);
  });
  test('stale execution cannot enter a new irreversible phase', async () => {
    const { store, firestore, docs } = await setup();
    const workflowId = (await store.loadJob(ref)).workflowId;
    const oldExecution: DurableActivityExecution = {
      workflowId,
      runId: 'run1',
      activityId: '1',
      activityType: 'deletePublishingMedia',
      scheduledAt: 1000,
      attempt: 1,
    };
    const freshExecution = { ...oldExecution, activityId: '2', scheduledAt: 2000 };
    const old = createDurableJobStore({ firestore, projectId: 'staging', getExecution: () => oldExecution });
    const fresh = createDurableJobStore({ firestore, projectId: 'staging', getExecution: () => freshExecution });
    await old.registerActivityExecution(ref, oldExecution);
    await fresh.registerActivityExecution(ref, freshExecution);
    await expect(old.markCritical(ref, { reasonCode: 'PUBLISHING_DELETE_MEDIA' })).rejects.toMatchObject({
      code: 'STALE_EXECUTION',
    });
    expect(docs.has('durableJobCriticalSections/job1')).toBe(false);
  });
});

test('critical attention only exposes a prepared certificate and commits it atomically', async () => {
  const { store, firestore, docs } = await setup();
  await store.markCritical(ref, { reasonCode: 'PUBLISHING_DELETE_MEDIA' });
  const certificateId = 'c'.repeat(64);
  const preparedStore = createDurableJobStore({
    firestore,
    projectId: 'staging',
    prepareCriticalAttention: async (tx, job) => {
      await tx.get(firestore.collection('durableJobs').doc(job.jobId));
      return {
        attention: {
          kind: 'permission_changed',
          message: 'Approve the certified cleanup.',
          resolutionKind: 'critical_repair',
          certificateId,
          repairPurpose: 'complete_fixed_cleanup',
        },
        commit: () => {
          tx.set(firestore.collection('temporalPublishingCriticalRepairs').doc(certificateId), { jobId: job.jobId });
        },
      };
    },
  });
  const projected = await preparedStore.project(ref, {
    state: 'needs_attention',
    actions: ['resume', 'cancel'],
    attention: { kind: 'permission_changed', message: 'Permission changed.' },
  });
  expect(projected.actions).toEqual(['resolve']);
  expect(projected.attention).toMatchObject({ certificateId, resolutionKind: 'critical_repair' });
  expect(docs.has(`temporalPublishingCriticalRepairs/${certificateId}`)).toBe(true);
});

test('critical activity reports cannot invent a certificate or restore ordinary replay', async () => {
  const { store } = await setup();
  await store.markCritical(ref, { reasonCode: 'PUBLISHING_DELETE_MEDIA' });
  await expect(
    store.project(ref, {
      state: 'needs_attention',
      actions: ['resolve'],
      attention: {
        kind: 'permission_changed',
        message: 'Forged repair',
        resolutionKind: 'critical_repair',
        certificateId: 'a'.repeat(64),
        repairPurpose: 'repair_confirmed_changes',
      },
    })
  ).rejects.toThrow('trusted source planner');
  const unprepared = await store.project(ref, {
    state: 'needs_attention',
    actions: ['resume', 'cancel', 'resolve'],
    attention: { kind: 'permission_changed', message: 'Review unavailable.' },
  });
  expect(unprepared.actions).toEqual([]);
});

test('certified repair cleanup retains specialized provider review without restoring desired replay', async () => {
  const { store, firestore, docs } = await setup();
  const job = await store.markCritical(ref, { reasonCode: 'PUBLISHING_DELETE_MEDIA' });
  docs.set('durableJobCancellationIntents/job1', {
    ...ref,
    workflowId: job.workflowId,
    generation: job.generation,
    purpose: 'critical_repair_cleanup',
    certificateId: 'a'.repeat(64),
  });
  const planner = jest.fn(async () => undefined);
  const controls = createDurableJobStore({ firestore, projectId: 'staging', prepareCriticalAttention: planner });
  const acknowledgementId = 'b'.repeat(64);
  const result = await controls.project(ref, {
    state: 'needs_attention',
    actions: ['resume', 'cancel', 'resolve'],
    error: {
      code: 'PUBLISHING_CANCEL_ORPHAN_REVIEW_REQUIRED',
      message: 'Review additional allocation.',
      retryable: false,
    },
    attention: { kind: 'external_result_unknown', message: 'Review additional allocation.', acknowledgementId },
  });
  expect(result.actions).toEqual(['resolve']);
  expect(result.attention?.acknowledgementId).toBe(acknowledgementId);
  expect(planner).not.toHaveBeenCalled();
});

describe('prepared provider reservation and irreversible phase', () => {
  test('reservation preparation can read after critical preparation and commits together', async () => {
    const { store, firestore, docs } = await setup();
    await firestore.runTransaction(async (tx) => {
      const critical = await store.prepareCritical(tx, ref, { reasonCode: 'PUBLISHING_DELETE_MEDIA' });
      const reservation = firestore.collection('providerReservations').doc('media1');
      expect((await tx.get(reservation)).exists).toBe(false);
      tx.create(reservation, { jobId: ref.jobId });
      critical.commit();
    });
    expect(docs.has('durableJobCriticalSections/job1')).toBe(true);
    expect(docs.get('providerReservations/media1')).toEqual({ jobId: ref.jobId });
    expect((await store.loadJob(ref)).actions).not.toContain('cancel');
  });
  test('reservation failure rolls back both marker and reservation', async () => {
    const { store, firestore, docs } = await setup();
    await expect(
      store.markCritical(ref, {
        reasonCode: 'PUBLISHING_DELETE_MEDIA',
        prepare: async (tx) => {
          await tx.get(firestore.collection('providerReservations').doc('media1'));
          return () => {
            tx.create(firestore.collection('providerReservations').doc('media1'), { jobId: ref.jobId });
            throw new Error('reservation write failed');
          };
        },
      })
    ).rejects.toThrow('reservation write failed');
    expect(docs.has('durableJobCriticalSections/job1')).toBe(false);
    expect(docs.has('providerReservations/media1')).toBe(false);
    expect((await store.loadJob(ref)).revision).toBe(1);
  });
  test('cancel winning prevents reservation preparation and all critical writes', async () => {
    const { store, docs } = await setup();
    docs.set('durableJobCancellationIntents/job1', { ...ref });
    const prepare = jest.fn();
    await expect(store.markCritical(ref, { reasonCode: 'PUBLISHING_DELETE_MEDIA', prepare })).rejects.toMatchObject({
      code: 'STALE_REVISION',
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(docs.has('durableJobCriticalSections/job1')).toBe(false);
  });
  test('actor revocation during provider preparation prevents committing the boundary', async () => {
    const { firestore, docs } = await setup();
    let revoked = false;
    const store = createDurableJobStore({
      firestore,
      projectId: 'staging',
      authorizeActor: async () => {
        if (revoked) throw new Error('actor revoked');
      },
    });
    await expect(
      store.markCritical(ref, {
        reasonCode: 'PUBLISHING_DELETE_MEDIA',
        prepare: async (tx) => {
          await tx.get(firestore.collection('providerReservations').doc('media1'));
          revoked = true;
          return () => {
            tx.create(firestore.collection('providerReservations').doc('media1'), { jobId: ref.jobId });
          };
        },
      })
    ).rejects.toThrow('actor revoked');
    expect(docs.has('durableJobCriticalSections/job1')).toBe(false);
    expect(docs.has('providerReservations/media1')).toBe(false);
  });
});

test('retention acknowledgement capability can change only through a trusted critical source planner', async () => {
  const { store, firestore } = await setup();
  await store.markCritical(ref, { reasonCode: 'PUBLISHING_DELETE_MEDIA' });
  const prepared = createDurableJobStore({
    firestore,
    projectId: 'staging',
    prepareCriticalAttention: async () => ({
      attention: {
        kind: 'remote_drift',
        message: 'Review retained legacy resource.',
        resolutionKind: 'critical_repair',
        certificateId: 'a'.repeat(64),
        repairPurpose: 'repair_confirmed_changes',
        requiresRetentionAcknowledgement: true,
      },
      commit: () => {},
    }),
  });
  const job = await prepared.project(ref, {
    state: 'needs_attention',
    attention: { kind: 'remote_drift', message: 'Review required.' },
  });
  expect(job.attention?.requiresRetentionAcknowledgement).toBe(true);
  await expect(
    store.project(ref, { attention: { ...job.attention!, requiresRetentionAcknowledgement: false } })
  ).rejects.toThrow('trusted source planner');
  await expect(
    store.project(ref, { attention: { ...job.attention!, requiresRetentionAcknowledgement: 'yes' as never } })
  ).rejects.toThrow('trusted source planner');
});

describe('private publishing source protocol enrollment', () => {
  test('new publishing admission authors private enrollment and never exposes it publicly', async () => {
    const { store, docs } = await setup();
    expect((await store.loadIntent(ref)).publishingSourceProtocol).toBe('publishing-source-catalog-v1');
    expect((await store.loadJob(ref)) as unknown as Record<string, unknown>).not.toHaveProperty(
      'publishingSourceProtocol'
    );
    expect(docs.get('durableJobOutbox/job1')).not.toHaveProperty('publishingSourceProtocol');
    await store.project(ref, { state: 'running' });
    await store.recordStep(ref, { id: 'provider', label: 'Provider request', state: 'retrying', attempt: 2 });
    expect((await store.loadIntent(ref)).publishingSourceProtocol).toBe('publishing-source-catalog-v1');
    await expect(
      store.project(ref, { result: { publishingSourceProtocol: 'publishing-source-catalog-v1' } })
    ).rejects.toThrow('Unsafe result field');
  });
  test.each(['speaker.mutate', 'list.membership', 'series.sync_metadata', 'sermon.delete'] as const)(
    'publishing kind %s receives authoritative enrollment',
    async (kind) => {
      const { firestore } = memoryFirestore();
      const store = createDurableJobStore({ firestore, projectId: 'staging' });
      await firestore.runTransaction(async (tx) => {
        store.createInTransaction(tx, admission({ kind }));
      });
      expect((await store.loadIntent(ref)).publishingSourceProtocol).toBe('publishing-source-catalog-v1');
    }
  );
  test.each([
    'role.assign',
    'speaker.resolve',
    'email.deliver',
    'audio.process',
    'image.ingest',
    'search.sync',
    'bundle.regenerate',
  ] as const)('nonpublishing kind %s is not enrolled or gated by the marker', async (kind) => {
    const { firestore } = memoryFirestore();
    const store = createDurableJobStore({ firestore, projectId: 'staging' });
    await firestore.runTransaction(async (tx) => {
      store.createInTransaction(tx, admission({ kind }));
    });
    expect(await store.loadIntent(ref)).not.toHaveProperty('publishingSourceProtocol');
    await expect(store.assertCurrent(ref)).resolves.toMatchObject({ kind });
  });
  test('operation-specific media maintenance is excluded', async () => {
    const { firestore } = memoryFirestore();
    const store = createDurableJobStore({ firestore, projectId: 'staging' });
    await firestore.runTransaction(async (tx) => {
      store.createInTransaction(
        tx,
        admission({ kind: 'maintenance.run', payload: { operation: 'media_artifacts_cleanup' } })
      );
    });
    expect(await store.loadIntent(ref)).not.toHaveProperty('publishingSourceProtocol');
  });
  test('caller-supplied enrollment is rejected in both metadata and payload before admission writes', async () => {
    const { firestore, docs } = memoryFirestore();
    const store = createDurableJobStore({ firestore, projectId: 'staging' });
    for (const input of [
      Object.assign(admission(), { publishingSourceProtocol: 'publishing-source-catalog-v1' }),
      admission({ payload: { publishingSourceProtocol: 'forged-v2' } }),
    ]) {
      await expect(
        firestore.runTransaction(async (tx) => {
          store.createInTransaction(tx, input);
        })
      ).rejects.toThrow('server-authored');
    }
    expect(docs.size).toBe(0);
  });
  test('old intent absence is preserved by read, projection and duplicate admission', async () => {
    const { store, firestore, docs } = await setup();
    delete docs.get('durableJobIntents/job1')!.publishingSourceProtocol;
    await store.project(ref, { state: 'running' });
    await expect(
      firestore.runTransaction(async (tx) => {
        store.createInTransaction(tx, admission());
      })
    ).rejects.toThrow('ALREADY_EXISTS');
    expect(await store.loadIntent(ref)).not.toHaveProperty('publishingSourceProtocol');
    expect((await store.loadJob(ref)).state).toBe('running');
  });
});

test.each(['not_started', 'partial'])(
  'public certified stop preserves exact safe %s metadata through terminal cancellation',
  async (providerEffects) => {
    const { store } = await setup();
    const result = { mode: 'partial_stop', providerEffects, contentPreserved: true, resolutionPurpose: 'cleanup' };
    await store.project(ref, { state: 'cancel_requested', actions: [], result });
    expect((await store.project(ref, { state: 'cancelled', actions: [] })).result).toEqual(result);
  }
);
test('public stopped metadata rejects misleading dispositions, partial descriptors and private source authority', async () => {
  const { store } = await setup();
  for (const result of [
    { mode: 'succeeded', providerEffects: 'not_started', contentPreserved: true },
    { mode: 'partial_stop', providerEffects: 'deleted', contentPreserved: true },
    { mode: 'partial_stop', providerEffects: 'partial', contentPreserved: false },
    { mode: 'partial_stop' },
    { mode: 'partial_stop', providerEffects: 'not_started', contentPreserved: true, planId: 'a'.repeat(64) },
    { mode: 'partial_stop', providerEffects: 'not_started', contentPreserved: true, certificateId: 'a'.repeat(64) },
    { mode: 'partial_stop', providerEffects: 'not_started', contentPreserved: true, sessionId: 'a'.repeat(64) },
  ])
    await expect(store.project(ref, { result })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
});

describe('server-authored provider simulation projection', () => {
  test('staging immutable intent profile becomes public provenance, including replacement admissions', async () => {
    const { firestore, docs } = memoryFirestore(),
      projectId = 'urm-app-staging',
      store = createDurableJobStore({ firestore, projectId });
    const pin = {
      mode: 'sandbox',
      profileId: 'urm-app-staging-publishing-v1',
      version: 1,
      scenario: 'transient-failure',
    };
    const input = admission({
      ref: { projectId, jobId: 'sandbox-job' },
      payload: { providerExecution: pin },
      dispatch: {
        workflowType: 'PublishSermon',
        workflowId: 'sandbox-workflow',
        taskQueue: 'urm-orchestration',
        ref: { projectId, jobId: 'sandbox-job' },
      },
    });
    await firestore.runTransaction(async (tx) => {
      store.createInTransaction(tx, input);
    });
    expect(docs.get('durableJobs/sandbox-job')?.providerExecution).toEqual(pin);
    expect((docs.get('durableJobIntents/sandbox-job')?.payload as Record<string, unknown>).providerExecution).toEqual(
      pin
    );
    const replacement = {
      ...input,
      ref: { projectId, jobId: 'replacement' },
      generation: 2,
      dispatch: { ...input.dispatch, ref: { projectId, jobId: 'replacement' } },
      payload: structuredClone(input.payload),
    };
    await firestore.runTransaction(async (tx) => {
      store.createInTransaction(tx, replacement);
    });
    expect(docs.get('durableJobs/replacement')?.providerExecution).toEqual(pin);
  });
  test('invalid or production simulation provenance never projects', async () => {
    const { firestore } = memoryFirestore(),
      store = createDurableJobStore({ firestore, projectId: ref.projectId });
    await expect(
      firestore.runTransaction(async (tx) =>
        store.createInTransaction(
          tx,
          admission({
            payload: { providerExecution: { mode: 'sandbox', profileId: 'fake', version: 1, scenario: 'success' } },
          })
        )
      )
    ).rejects.toThrow('provenance');
  });
});

describe('private staging email capture projection through the real store validator', () => {
  const captureRef = { projectId: 'urm-app-staging', jobId: 'email-capture-fixture' };
  const transport = {
    schemaVersion: 1,
    mode: 'capture',
    projectId: 'urm-app-staging',
    profileId: 'urm-app-staging-mail-capture-v1',
    version: 1,
    captureId: 'a'.repeat(64),
    payloadSha256: 'b'.repeat(64),
  };
  async function captureStore(projectId = captureRef.projectId, kind: CreateDurableJobInput['kind'] = 'email.deliver') {
    const target = { ...captureRef, projectId };
    const { firestore } = memoryFirestore();
    const store = createDurableJobStore({ firestore, projectId: target.projectId });
    await firestore.runTransaction(async (tx) => {
      store.createInTransaction(
        tx,
        admission({
          ref: target,
          kind,
          entity: { type: 'mail', id: 'mail-fixture' },
          payload: {},
          dispatch: {
            workflowType: 'emailDeliveryWorkflow',
            workflowId: 'email:fixture',
            taskQueue: 'urm-email',
            ref: target,
          },
        })
      );
    });
    return { store, target };
  }
  test('projects the acknowledged private capture without treating its safe provenance as a stale email job', async () => {
    const { store } = await captureStore();
    await expect(
      store.project(captureRef, {
        state: 'succeeded',
        actions: [],
        result: { deliveryTransport: transport, externalDelivery: false },
        destinations: [
          {
            destination: 'email',
            state: 'confirmed',
            message: 'Staging simulation: captured privately; no external email sent.',
          },
        ],
      })
    ).resolves.toMatchObject({ state: 'succeeded', result: { deliveryTransport: transport, externalDelivery: false } });
  });
  test.each([
    { label: 'external delivery', result: { deliveryTransport: transport, externalDelivery: true } },
    { label: 'missing no-delivery marker', result: { deliveryTransport: transport } },
    { label: 'missing transport', result: { externalDelivery: false } },
    {
      label: 'recipient leakage',
      result: { deliveryTransport: { ...transport, to: 'private@example.test' }, externalDelivery: false },
    },
    {
      label: 'invalid capture hash',
      result: { deliveryTransport: { ...transport, captureId: 'bad' }, externalDelivery: false },
    },
    {
      label: 'wrong profile',
      result: { deliveryTransport: { ...transport, profileId: 'other' }, externalDelivery: false },
    },
    {
      label: 'wrong project',
      result: { deliveryTransport: { ...transport, projectId: 'urm-app' }, externalDelivery: false },
    },
    {
      label: 'missing payload proof',
      result: { deliveryTransport: { ...transport, payloadSha256: undefined }, externalDelivery: false },
    },
  ])('rejects $label without committing a successful task', async ({ result }) => {
    const { store } = await captureStore();
    await expect(store.project(captureRef, { state: 'succeeded', result })).rejects.toThrow('capture');
    expect((await store.loadJob(captureRef)).state).toBe('queued');
  });
  test.each([
    { projectId: 'urm-app', kind: 'email.deliver' as const },
    { projectId: 'urm-app-staging', kind: 'sermon.publish' as const },
  ])('refuses capture results for $projectId / $kind', async ({ projectId, kind }) => {
    const { store, target } = await captureStore(projectId, kind);
    await expect(
      store.project(target, { state: 'succeeded', result: { deliveryTransport: transport, externalDelivery: false } })
    ).rejects.toThrow('capture');
  });
  test('allows a profile-only non-success marker but requires complete proof for success', async () => {
    const { store } = await captureStore();
    const { captureId: _captureId, payloadSha256: _payloadSha256, ...profile } = transport;
    const result = { deliveryTransport: profile, externalDelivery: false };
    await expect(store.project(captureRef, { state: 'retrying', result })).resolves.toMatchObject({
      state: 'retrying',
    });
    await expect(store.project(captureRef, { state: 'succeeded', result })).rejects.toThrow('provenance');
    await expect(store.project(captureRef, { state: 'succeeded' })).rejects.toThrow('provenance');
  });
});
