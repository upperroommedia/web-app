import { createHash } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { DURABLE_COLLECTIONS, durableActivityDrainKey } from '../../../../packages/orchestration/src/job-store';
import { providerReceiptId, providerPayloadFingerprint } from './providerReceipts';
import {
  PUBLISHING_CREATE_REVIEW_CHECKPOINTS,
  savePublishingCreateReviewCheckpoint as save,
  loadPublishingCreateReviewContinuation as load,
} from './reviewedCreateContinuation';
const ref = { projectId: 'urm-app', jobId: 'job-1' };
const hash = (name: string) =>
  createHash('sha256')
    .update(JSON.stringify([ref.projectId, ref.jobId, name]))
    .digest('hex');
function fixture() {
  const rows = new Map<string, any>();
  const get = (path: string) => rows.get(path);
  const tx = {
    get: async (doc: any) => ({
      exists: rows.has(doc.path),
      data: () => get(doc.path),
      get: (field: string) => field.split('.').reduce((value, key) => value?.[key], get(doc.path)),
    }),
    create: (doc: any, value: any) => {
      if (rows.has(doc.path)) throw Error('exists');
      rows.set(doc.path, value);
    },
  } as unknown as Transaction;
  const db = { doc: (path: string) => ({ path }), runTransaction: async (fn: any) => fn(tx) } as unknown as Firestore;
  const intent = {
    ...ref,
    kind: 'sermon.publish',
    entity: { type: 'sermon', id: 'sermon-1' },
    generation: 1,
    actorUid: 'actor-1',
    payload: {
      action: 'publish',
      sermonId: 'sermon-1',
      generation: 1,
      actorUid: 'actor-1',
      destinations: { listIds: ['list-1'], soundcloud: false },
      payload: { sermon: { subsplashId: 'existing-media' } },
    },
  };
  const job = {
    ...ref,
    kind: intent.kind,
    entity: intent.entity,
    generation: 1,
    requestedBy: intent.actorUid,
    workflowId: 'workflow-1',
    revision: 4,
    state: 'needs_review',
    steps: [],
    attention: { stepId: 'subsplash-media', receiptId: '' },
  };
  const operationKey = `durable:${ref.projectId}:${ref.jobId}:sermon-1:subsplash-create`,
    step = 'subsplash-media-item',
    receiptId = providerReceiptId(operationKey, step),
    intentPayload = { title: 'Original title' };
  const receipt = {
    ...ref,
    operationKey,
    step,
    fingerprint: providerPayloadFingerprint(intentPayload),
    intentPayload,
    owner: 'owner-1',
    revision: 1,
    state: 'needs_review',
    providerAccount: { provider: 'subsplash', account: 'app:9XTSHD' },
  };
  job.attention.receiptId = receiptId;
  rows.set(`${DURABLE_COLLECTIONS.intents}/${ref.jobId}`, intent);
  rows.set(`${DURABLE_COLLECTIONS.jobs}/${ref.jobId}`, job);
  rows.set(`temporalProviderReceipts/${receiptId}`, receipt);
  const assertCurrent = jest.fn(async () => {}),
    options = { firestore: db, commitCurrent: async (_ref: any, fn: any) => fn(tx) };
  const saveMain = (stages: string[] = []) =>
    save(ref, { workflow: 'publishing', waitingStep: 'subsplash-media', completedStages: stages }, options);
  function review() {
    const adoptionAudit = {
      decision: 'adopt_existing_resource',
      duplicateRiskAcknowledged: true,
      reason: 'Original create verified',
      evidenceReference: 'private-evidence-1',
    };
    Object.assign(receipt, {
      state: 'confirmed',
      revision: 2,
      result: { id: 'new-media' },
      resolvedBy: 'admin-1',
      resolutionCommandId: 'command-1',
      adoptionAudit,
      resolutionFingerprint: providerPayloadFingerprint({
        resolution: { type: 'adopt', remoteId: 'new-media' },
        adoptionAudit,
      }),
    });
    rows.set(`${DURABLE_COLLECTIONS.commands}/command-1`, {
      ...ref,
      workflowId: job.workflowId,
      actorUid: 'admin-1',
      action: 'resolve',
      signal: { name: 'publishingResume' },
      receipt: { requestId: 'command-1' },
      state: 'dispatched',
    });
  }
  function stage(name: string, ui: string) {
    const head = {
      ...ref,
      workflowId: job.workflowId,
      runId: 'run-1',
      activityId: name,
      activityType: name,
      scheduledAt: 10,
      attempt: 1,
      executionId: hash(name + '-execution'),
      epoch: 1,
      stepIds: [ui],
    };
    rows.set(`${DURABLE_COLLECTIONS.executions}/${hash(name)}`, head);
    rows.set(`${DURABLE_COLLECTIONS.drains}/${durableActivityDrainKey(ref.projectId, ref.jobId, head)}`, {
      ...ref,
      executionId: head.executionId,
      state: 'drained',
      source: 'worker_settled',
    });
    rows.set(`${DURABLE_COLLECTIONS.stepExecutions}/${hash(ui)}`, head);
    (job.steps as any[]).push({ id: ui, state: 'succeeded' });
  }
  return {
    rows,
    intent,
    job,
    receipt,
    receiptId,
    db,
    options,
    assertCurrent,
    saveMain,
    review,
    stage,
    load: (key: string) => load(ref, key, { firestore: db, assertCurrent }),
  };
}
describe('reviewed create continuation source authority', () => {
  test('unknown create is checkpointed but cannot be resumed until privately reviewed', async () => {
    const f = fixture(),
      cp = await f.saveMain();
    expect(cp).toBeDefined();
    expect(await f.load(cp!.checkpointId)).toBeUndefined();
    f.review();
    expect(await f.load(cp!.checkpointId)).toMatchObject({
      workflow: 'publishing',
      waitingStep: 'subsplash-media',
      completedStages: [],
      plan: { sermonId: 'sermon-1', lists: true },
    });
    expect(f.assertCurrent).toHaveBeenCalledTimes(3);
  });
  test('plain confirmed HTTP result is not reviewed desired continuation authority', async () => {
    const f = fixture(),
      cp = await f.saveMain();
    Object.assign(f.receipt, { state: 'confirmed', result: { id: 'new-media' } });
    expect(await f.load(cp!.checkpointId)).toBeUndefined();
  });
  test('attention cleared during checkpoint outage is rescued only by exact original reviewed route', async () => {
    const f = fixture();
    f.review();
    delete (f.job as any).attention;
    const cp = await f.saveMain();
    expect(cp).toBeDefined();
    expect(await f.load(cp!.checkpointId)).toBeDefined();
  });
  test.each(['cancel', 'critical', 'cleanup'])('rejects %s authority for desired resume', async (kind) => {
    const f = fixture();
    if (kind === 'cancel') f.rows.set(`durableJobCancellationIntents/${ref.jobId}`, {});
    if (kind === 'critical') f.rows.set(`${DURABLE_COLLECTIONS.critical}/${ref.jobId}`, {});
    if (kind === 'cleanup') (f.job as any).result = { resolutionPurpose: 'cleanup' };
    expect(await f.saveMain()).toBeUndefined();
  });
  test('private resolution command must match original workflow and desired resume signal', async () => {
    const f = fixture(),
      cp = await f.saveMain();
    f.review();
    f.rows.get(`${DURABLE_COLLECTIONS.commands}/command-1`).signal.name = 'publishingMetadataChanged';
    expect(await f.load(cp!.checkpointId)).toBeUndefined();
  });
  test('original actor revocation is checked even after admin adoption', async () => {
    const f = fixture(),
      cp = await f.saveMain();
    f.review();
    f.assertCurrent.mockRejectedValue(Error('actor revoked'));
    await expect(f.load(cp!.checkpointId)).rejects.toThrow('actor revoked');
  });
  test.each(['generation', 'intent'])('rejects changed %s', async (kind) => {
    const f = fixture(),
      cp = await f.saveMain();
    f.review();
    if (kind === 'generation') f.job.generation = 2;
    else f.intent.payload.destinations.listIds.push('list-2');
    expect(await f.load(cp!.checkpointId)).toBeUndefined();
  });
  test('workflow hints cannot manufacture completed stages', async () => {
    const f = fixture();
    expect(await f.saveMain(['ensurePublishingMedia'])).toBeUndefined();
  });
  test('settled allocation can skip ensure but never manufacture publication readiness', async () => {
    const f = fixture();
    f.rows.set('sermons/sermon-1', { subsplashId: 'existing-media' });
    f.stage('ensurePublishingMedia', 'subsplash-media');
    const cp = await f.saveMain(['ensurePublishingMedia']);
    f.review();
    expect(await f.load(cp!.checkpointId)).toMatchObject({ completedStages: ['ensurePublishingMedia'] });
  });
  test('a green readiness stage without publication evidence is not skipped', async () => {
    const f = fixture();
    f.rows.set('sermons/sermon-1', { subsplashId: 'existing-media' });
    f.stage('ensurePublishingMedia', 'subsplash-media');
    f.stage('checkPublishingMediaReady', 'subsplash-media');
    const cp = await f.saveMain();
    f.review();
    expect(await f.load(cp!.checkpointId)).toMatchObject({ completedStages: ['ensurePublishingMedia'] });
  });
  test('later SDK evidence mutation rejects saved completed proof', async () => {
    const f = fixture();
    f.rows.set('sermons/sermon-1', { subsplashId: 'existing-media' });
    f.stage('ensurePublishingMedia', 'subsplash-media');
    const cp = await f.saveMain();
    f.review();
    f.rows.get(`${DURABLE_COLLECTIONS.executions}/${hash('ensurePublishingMedia')}`).epoch++;
    expect(await f.load(cp!.checkpointId)).toBeUndefined();
  });
  test('checkpoint and continuation expose refs and selection only', async () => {
    const f = fixture(),
      cp = await f.saveMain();
    f.review();
    const stored = f.rows.get(`${PUBLISHING_CREATE_REVIEW_CHECKPOINTS}/${cp!.checkpointId}`),
      continued = await f.load(cp!.checkpointId);
    expect(JSON.stringify(stored)).not.toContain('Original title');
    expect(JSON.stringify(continued)).not.toContain('Original title');
    expect(JSON.stringify(continued)).not.toContain('admin-1');
  });
  test('late rescue rejects newer unresolved primitive instead of older adopted receipt', async () => {
    const f = fixture();
    f.review();
    delete (f.job as any).attention;
    const oldStep = 'subsplash-audio',
      operationKey = f.receipt.operationKey;
    f.rows.delete(`temporalProviderReceipts/${f.receiptId}`);
    f.rows.set(`temporalProviderReceipts/${providerReceiptId(operationKey, oldStep)}`, { ...f.receipt, step: oldStep });
    f.rows.set(`temporalProviderReceipts/${providerReceiptId(operationKey, 'subsplash-transcode')}`, {
      ...f.receipt,
      step: 'subsplash-transcode',
      state: 'needs_review',
    });
    expect(await f.saveMain()).toBeUndefined();
  });
  test('checkpoint outage rescue requires private command, not adoption fields alone', async () => {
    const f = fixture();
    f.review();
    delete (f.job as any).attention;
    f.rows.delete(`${DURABLE_COLLECTIONS.commands}/command-1`);
    expect(await f.saveMain()).toBeUndefined();
  });
  test('entity create yields dedicated remaining plan, never completed whole handler', async () => {
    const f = fixture();
    Object.assign(f.intent, {
      kind: 'list.create',
      entity: { type: 'list', id: 'list-1' },
      payload: {
        kind: 'list.create',
        entity: { type: 'list', id: 'list-1' },
        payload: { operation: 'create', input: { title: 'Original title' } },
      },
    });
    Object.assign(f.job, {
      kind: f.intent.kind,
      entity: f.intent.entity,
      attention: { stepId: 'entity', receiptId: '' },
    });
    const operationKey = `durable:${ref.projectId}:${ref.jobId}:list.create:create`,
      step = 'list-create',
      receiptId = providerReceiptId(operationKey, step);
    Object.assign(f.receipt, { operationKey, step });
    f.rows.delete(`temporalProviderReceipts/${f.receiptId}`);
    f.rows.set(`temporalProviderReceipts/${receiptId}`, f.receipt);
    f.job.attention.receiptId = receiptId;
    const cp = await save(ref, { workflow: 'publishingEntity', waitingStep: 'entity', completedStages: [] }, f.options);
    expect(cp).toBeDefined();
    f.review();
    expect(await f.load(cp!.checkpointId)).toMatchObject({
      workflow: 'publishingEntity',
      completedStages: [],
      plan: { continuation: 'reviewed-create', receiptStep: 'list-create', entity: { id: 'list-1' } },
    });
  });
});
