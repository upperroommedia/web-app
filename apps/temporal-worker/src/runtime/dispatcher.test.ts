import { providerMutationFingerprint } from '../../../../functions/src/temporal/publishing/providerMutationGuard';
import { durableEntityKey } from '@upperroom/orchestration/job-store';
import { OutboxDispatcher } from './dispatcher';
import { loadRuntimeConfig } from './config';
import { safeActivities } from './safe-activities';
import { ApplicationFailure, CancelledFailure, WorkflowIdReusePolicy } from '@temporalio/common';
const mockContext: any = { cancellationSignal: { aborted: false }, info: { attempt: 1 } };
jest.mock('@temporalio/activity', () => ({ Context: { current: () => mockContext } }));

const ref = { projectId: 'test-project', jobId: 'job1' };
const dispatch = {
  ref,
  workflowType: 'testWorkflow',
  workflowId: 'test:test-project:job1',
  taskQueue: 'urm-orchestration',
};
function harness(records: Record<string, any>, now = 1000) {
  const doc = (id: string): any => ({
    id,
    get: async () => ({ exists: !!records[id], data: () => records[id], get: (field: string) => records[id]?.[field] }),
    collection: (child: string) => ({ doc: (key: string) => doc(`${id}/${child}/${key}`) }),
    update: async (patch: any) => Object.assign(records[id], patch),
  });
  const db: any = {
    runTransaction: async (run: any) =>
      run({
        get: async (reference: any) => ({ data: () => structuredClone(records[reference.id]) }),
        update: (reference: any, patch: any) => Object.assign(records[reference.id], patch),
      }),
    collection: (collection: string) => {
      const filters: Array<[string, string, any]> = [];
      const query: any = {
        doc: (id: string) => doc(collection + '/' + id),
        where: (key: string, op: string, value: any) => {
          filters.push([key, op, value]);
          return query;
        },
        orderBy: () => query,
        limit: () => query,
        get: async () => ({
          docs: Object.entries(records)
            .filter(
              ([id, value]) =>
                id.startsWith(collection + '/') &&
                filters.every(([k, op, v]) => (op === '==' ? value[k] === v : value[k] <= v))
            )
            .map(([id]) => ({ ref: doc(id) })),
        }),
      };
      return query;
    },
  };
  const workflow = {
    start: jest.fn().mockResolvedValue({}),
    signalWithStart: jest.fn().mockResolvedValue({}),
    getHandle: jest.fn().mockReturnValue({ cancel: jest.fn(), signal: jest.fn() }),
  };
  const dispatcher = new OutboxDispatcher({
    db,
    client: { workflow } as any,
    projectId: ref.projectId,
    now: () => now,
    leaseMs: 100,
  });
  return { dispatcher, workflow, db };
}
const pending = (extra: any = {}) => ({
  state: 'pending',
  dispatch,
  attempt: 0,
  nextAttemptAt: 0,
  leaseExpiresAt: 0,
  ...extra,
});
test('dispatches a stable workflow and acknowledges only after Temporal accepts it', async () => {
  const records = { 'durableJobOutbox/a': pending() };
  const { dispatcher, workflow } = harness(records);
  await dispatcher.tick();
  expect(workflow.start).toHaveBeenCalledWith(
    'testWorkflow',
    expect.objectContaining({ workflowId: dispatch.workflowId, args: [ref] })
  );
  expect(records['durableJobOutbox/a'].state).toBe('dispatched');
  expect(dispatcher.healthy).toBe(true);
});
test('recovers an expired lease and safely confirms an ambiguous previous start', async () => {
  const records = { 'durableJobOutbox/a': pending({ state: 'dispatching', leaseExpiresAt: 900, leaseToken: 'old' }) };
  const { dispatcher, workflow } = harness(records);
  workflow.start.mockRejectedValue(
    Object.assign(new Error('already started'), { name: 'WorkflowExecutionAlreadyStartedError' })
  );
  await dispatcher.tick();
  expect(records['durableJobOutbox/a'].state).toBe('dispatched');
  expect(records['durableJobOutbox/a'].leaseToken).not.toBe('old');
});
test('never steals an unexpired lease', async () => {
  const { dispatcher, workflow } = harness({
    'durableJobOutbox/a': pending({ state: 'dispatching', leaseExpiresAt: 1100 }),
  });
  await dispatcher.tick();
  expect(workflow.start).not.toHaveBeenCalled();
});
test('uses signalWithStart for singleton admission with reference-only arguments', async () => {
  const { dispatcher, workflow } = harness({
    'durableJobOutbox/a': pending({
      dispatch: { ...dispatch, startArgs: { initial: ref }, signal: { name: 'request', args: ref } },
    }),
  });
  await dispatcher.tick();
  expect(workflow.signalWithStart).toHaveBeenCalledWith(
    'testWorkflow',
    expect.objectContaining({
      args: [{ initial: ref }],
      signal: 'request',
      signalArgs: [ref],
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
    })
  );
});
test('cross-project records fail before reaching Temporal', async () => {
  const { dispatcher, workflow } = harness({
    'durableJobOutbox/a': pending({ dispatch: { ...dispatch, ref: { ...ref, projectId: 'production' } } }),
  });
  await expect(dispatcher.tick()).rejects.toThrow('OUTBOX_PROJECT_MISMATCH');
  expect(workflow.start).not.toHaveBeenCalled();
});
test('cancel commands signal singleton cancellation without destroying its coordinator', async () => {
  const records = {
    'durableJobCommands/a': pending({
      dispatch: undefined,
      ...ref,
      workflowId: dispatch.workflowId,
      action: 'cancel',
      signal: { name: 'media.cancel', args: [ref.jobId] },
    }),
  };
  const { dispatcher, workflow } = harness(records);
  await dispatcher.tick();
  expect(workflow.getHandle).toHaveBeenCalledWith(dispatch.workflowId);
  expect(workflow.getHandle().signal).toHaveBeenCalledWith('media.cancel', ref.jobId);
  expect(workflow.getHandle().cancel).not.toHaveBeenCalled();
});
test('lost acknowledgements remain pending with bounded backoff and readiness false', async () => {
  const records = { 'durableJobOutbox/a': pending() };
  const { dispatcher, workflow } = harness(records);
  workflow.start.mockRejectedValue(new Error('network'));
  await dispatcher.tick();
  expect(records['durableJobOutbox/a'].state).toBe('pending');
  expect(records['durableJobOutbox/a'].nextAttemptAt).toBeGreaterThan(1000);
  expect(dispatcher.healthy).toBe(false);
});
test('rejects namespace/project mismatch and missing production TLS before startup', () => {
  const env = { FIREBASE_PROJECT_ID: 'test', TEMPORAL_NAMESPACE: 'other' };
  expect(() => loadRuntimeConfig(env)).toThrow('namespace');
  expect(() => loadRuntimeConfig({ ...env, TEMPORAL_NAMESPACE: 'test', NODE_ENV: 'production' })).toThrow('mutual TLS');
});
test('sanitizes raw provider secrets and ApplicationFailure details', async () => {
  const activities = safeActivities({
    raw: async () => {
      throw { message: 'secret', config: { headers: { Authorization: 'token' } } };
    },
    known: async () => {
      throw ApplicationFailure.nonRetryable('private signed URL', 'AMBIGUOUS', 'private-detail');
    },
    cancel: async () => {
      throw new CancelledFailure('private');
    },
  });
  await expect(activities.raw()).rejects.toMatchObject({
    message: 'Operation is temporarily unavailable',
    type: 'ACTIVITY_UNAVAILABLE',
  });
  await expect(activities.known()).rejects.toMatchObject({
    message: 'Operation could not be confirmed',
    type: 'AMBIGUOUS',
    nonRetryable: true,
  });
  await expect(activities.cancel()).rejects.toMatchObject({ message: 'Operation cancelled' });
});

test('a delayed acknowledgement cannot overwrite a newer lease', async () => {
  const records = { 'durableJobOutbox/a': pending() };
  const { dispatcher, workflow } = harness(records);
  workflow.start.mockImplementation(async () => {
    records['durableJobOutbox/a'].leaseToken = 'new-owner-token';
    return {};
  });
  await dispatcher.tick();
  expect(records['durableJobOutbox/a'].state).toBe('dispatching');
  expect(records['durableJobOutbox/a'].leaseToken).toBe('new-owner-token');
});

test('retry projections follow actual server retry policy and never hide the original failure', async () => {
  mockContext.info = { attempt: 2, retryPolicy: { maximumAttempts: 3 } };
  const project = jest.fn().mockRejectedValue(new Error('projection unavailable'));
  const operations = safeActivities(
    {
      run: async () => {
        throw new Error('private-provider-message');
      },
    },
    project
  );
  await expect(operations.run()).rejects.toMatchObject({ type: 'ACTIVITY_UNAVAILABLE' });
  expect(project).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 2, automaticRetry: true }));
  mockContext.info.attempt = 3;
  await expect(operations.run()).rejects.toMatchObject({ type: 'ACTIVITY_UNAVAILABLE' });
  expect(project).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 3, automaticRetry: false }));
  mockContext.info = { attempt: 1 };
});

test('lost acknowledgements of completed singleton jobs do not restart old intent', async () => {
  const records = {
    'durableJobOutbox/a': pending({ dispatch: { ...dispatch, signal: { name: 'request', args: ref } } }),
    'durableJobs/job1': { projectId: ref.projectId, state: 'succeeded' },
  };
  const { dispatcher, workflow } = harness(records);
  await dispatcher.tick();
  expect(workflow.signalWithStart).not.toHaveBeenCalled();
  expect(records['durableJobOutbox/a'].state).toBe('dispatched');
});

test('heartbeat cancellation waits for provider work and receipts to drain', async () => {
  jest.useFakeTimers();
  mockContext.heartbeat = jest.fn();
  mockContext.info = { attempt: 1, heartbeatTimeoutMs: 1000 };
  let finish: (() => void) | undefined;
  let receiptWritten = false;
  const activity = safeActivities({
    write: async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      receiptWritten = true;
    },
  });
  const pending = activity.write();
  const assertion = expect(pending).rejects.toBeInstanceOf(CancelledFailure);
  mockContext.cancellationSignal.aborted = true;
  jest.advanceTimersByTime(500);
  expect(mockContext.heartbeat).toHaveBeenCalled();
  expect(receiptWritten).toBe(false);
  finish!();
  await assertion;
  expect(receiptWritten).toBe(true);
  mockContext.cancellationSignal.aborted = false;
  mockContext.info = { attempt: 1 };
  jest.useRealTimers();
});

test('superseded projections still deliver the explicit server cancellation command', async () => {
  const records = {
    'durableJobCommands/a': pending({
      dispatch: undefined,
      ...ref,
      workflowId: dispatch.workflowId,
      action: 'cancel',
      cancellationReason: 'superseded',
    }),
    'durableJobs/job1': { projectId: ref.projectId, state: 'superseded' },
  };
  const { dispatcher, workflow } = harness(records);
  await dispatcher.tick();
  expect(workflow.getHandle().cancel).toHaveBeenCalled();
  expect(records['durableJobCommands/a'].state).toBe('dispatched');
});

test.each([
  'PROVIDER_MUTATION_UNRESOLVED',
  'PUBLISHING_CANCEL_MUTATION_REVIEW_REQUIRED',
  'PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED',
])('quarantined destination failure %s retains its safe code without generic SDK replay', async (code) => {
  const activity = safeActivities({
    write: async () => {
      throw { code, message: 'private provider request', config: { headers: { Authorization: 'secret' } } };
    },
  });
  await expect(activity.write()).rejects.toMatchObject({
    type: code,
    nonRetryable: true,
    message: 'Operation is no longer eligible',
  });
});

function evidenceFixture() {
  const scope = { ...ref, operation: 'metadata' },
    sessionId = providerMutationFingerprint(scope),
    claim = 'claim',
    step = 'patch',
    factId = providerMutationFingerprint([sessionId, step, claim]);
  const payload = { ...ref, generation: 2, sessionId, factId },
    entity = { type: 'sermon' as const, id: 's' },
    kind = 'sermon.publish' as const;
  const records: any = {
    'durableJobCommands/evidence': pending({
      dispatch: undefined,
      ...ref,
      workflowId: dispatch.workflowId,
      generation: 2,
      evidenceVersion: 1,
      action: 'evidence_available',
      signal: { name: 'publishingEvidenceAvailable', args: [payload] },
    }),
    'durableJobs/job1': { ...ref, workflowId: dispatch.workflowId, generation: 2, state: 'needs_attention' },
    'durableJobIntents/job1': { ...ref, generation: 2, entity, kind },
    [`temporalProviderMutationSessions/${sessionId}`]: { scope },
    [`temporalProviderMutationFacts/${factId}`]: {
      sessionId,
      claim,
      step,
      executionId: 'original',
      fingerprint: 'body',
      completion: 'acknowledged',
    },
    [`temporalProviderMutationSessions/${sessionId}/requests/${providerMutationFingerprint(step)}`]: {
      claim,
      executionId: 'original',
      fingerprint: 'body',
      state: 'acknowledged',
    },
    [`durableJobEntities/${durableEntityKey(ref.projectId, entity, kind)}`]: { generation: 2, activeJobId: ref.jobId },
  };
  return { records, payload, ...harness(records) };
}
test('metadata evidence signals only an exact current private original completion', async () => {
  const f = evidenceFixture();
  await f.dispatcher.tick();
  expect(f.workflow.getHandle().signal).toHaveBeenCalledWith('publishingEvidenceAvailable', f.payload);
  expect(f.workflow.start).not.toHaveBeenCalled();
  expect(f.records['durableJobCommands/evidence'].state).toBe('dispatched');
});
test.each(['generation', 'fact', 'terminal'])(
  'drops %s evidence without signaling desired operations',
  async (mode) => {
    const f = evidenceFixture();
    if (mode === 'generation') f.records['durableJobs/job1'].generation = 3;
    if (mode === 'terminal') f.records['durableJobs/job1'].state = 'succeeded';
    if (mode === 'fact') f.records[`temporalProviderMutationFacts/${f.payload.factId}`].claim = 'forged';
    await f.dispatcher.tick();
    expect(f.workflow.getHandle().signal).not.toHaveBeenCalled();
    expect(f.records['durableJobCommands/evidence'].state).toBe('dispatched');
  }
);
test('a new coalesced fact arriving while signaling remains pending after old lease acknowledgement', async () => {
  const f = evidenceFixture();
  f.workflow.getHandle().signal.mockImplementation(async () => {
    f.records['durableJobCommands/evidence'].evidenceVersion = 2;
  });
  await f.dispatcher.tick();
  expect(f.records['durableJobCommands/evidence']).toMatchObject({
    state: 'pending',
    evidenceVersion: 2,
    acknowledgedEvidenceVersion: 1,
    nextAttemptAt: 0,
  });
});
