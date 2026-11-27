import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { acknowledgedProjectionDigest as digest } from '../../../../functions/src/temporal/publishing/acknowledgedProjectionDigest';
import { readSandboxListStopHandoff, requestSandboxListNativeCancellation } from './sandbox-list-stop-handoff';

const ref = { projectId: 'urm-app-staging', jobId: 'reviewed-publish' };
const scope = { ...ref, operation: 'publishing:' + ref.jobId + ':lists:publish:all' };
const sessionId = digest(scope);
const certificateId = 'a'.repeat(64);
const approvalId = 'b'.repeat(64);
const commandId = 'c'.repeat(64);
const sourceDigest = 'd'.repeat(64);
const actorUid = 'staging-admin';
const at = { isEqual: (value: unknown) => value === at };

function fixture() {
  const origin = { ...ref, generation: 1, workflowId: 'publishing-workflow' };
  const review = { sessionId, certificateId, workflowId: origin.workflowId, generation: 1 };
  const result = { state: 'completed', mode: 'partial_stop', providerEffects: 'partial', contentPreserved: true };
  const stop = {
    ...origin, sessionId, commandId, sourceDigest, result,
    approvalDigest: digest({ review, actorUid, commandId, sourceDigest }),
  };
  const paths = {
    stop: 'temporalSandboxListPartialStops/' + sessionId,
    intent: 'durableJobCancellationIntents/' + ref.jobId,
    job: 'durableJobs/' + ref.jobId,
    holder: 'temporalProviderMutationSessions/' + sessionId,
    approval: 'temporalSandboxListCommitReviews/' + approvalId,
    command: 'durableJobCommands/' + commandId,
  };
  const entries = new Map<string, Record<string, unknown>>([
    [paths.stop, stop],
    [paths.intent, {
      ...origin, purpose: 'sandbox_list_partial_stop', reviewCommandId: commandId, approvalId, sessionId, certificateId,
      actorUid, acceptedUserCancellation: false,
    }],
    [paths.job, {
      ...origin, state: 'cancel_requested', kind: 'sermon.publish', result: { ...result, resolutionPurpose: 'cleanup' },
    }],
    [paths.holder, { scope, state: 'sandbox_partial_stop', sandboxPartialStopDigest: digest(stop) }],
    [paths.approval, { ...ref, actorUid, review, sourceDigest, nativeWitnessDigest: 'e'.repeat(64) }],
    [paths.command, {
      ...ref, actorUid, workflowId: origin.workflowId, action: 'resolve', sandboxListApprovalId: approvalId,
      state: 'dispatching', signal: { name: 'publishingCriticalRepair', args: [{ certificateId }] },
    }],
  ]);
  const snapshot = (path: string) => {
    const row = entries.get(path);
    return {
      exists: entries.has(path), createTime: at, updateTime: at, data: () => row,
      get: (field: string) => field.split('.').reduce<unknown>(
        (value, part) => typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[part] : undefined,
        row
      ),
    };
  };
  const tx = {
    get: async (path: string) => snapshot(path),
    getAll: async (...requested: string[]) => requested.map(snapshot),
  } as unknown as Transaction;
  const runTransaction = jest.fn(async (run: (transaction: Transaction) => Promise<unknown>) => run(tx));
  const db = { projectId: ref.projectId, databaseId: '(default)', doc: (path: string) => path, runTransaction } as unknown as Firestore;
  const assertCurrent = jest.fn(async () => {});
  const check = (id = certificateId) => readSandboxListStopHandoff(db, ref, id, assertCurrent);
  return { entries, paths, result, assertCurrent, check, runTransaction, db };
}

test('the original bound simulator cancellation returns a partial stop without provider work', async () => {
  const candidate = fixture();
  await expect(candidate.check()).resolves.toEqual({ ...candidate.result, nativeCancellationRequired: true });
  expect(candidate.assertCurrent).toHaveBeenCalledWith(expect.anything(), ref);
  expect(candidate.runTransaction).toHaveBeenCalledWith(expect.any(Function), { readOnly: true });
});

test('unrelated certified repair has no simulator handoff', async () => {
  const candidate = fixture();
  candidate.entries.delete(candidate.paths.stop);
  candidate.entries.delete(candidate.paths.intent);
  await expect(candidate.check()).resolves.toBeUndefined();
  expect(candidate.assertCurrent).not.toHaveBeenCalled();
});

test('a prepared but unclaimed command cannot authorize the original workflow handoff', async () => {
  const candidate = fixture();
  candidate.entries.get(candidate.paths.command)!.state = 'pending';
  await expect(candidate.check()).rejects.toThrow('SANDBOX_LIST_PARTIAL_STOP_HANDOFF_UNCONFIRMED');
});

test('a different source certificate, missing receipt or stale workflow execution is denied', async () => {
  const first = fixture();
  await expect(first.check('f'.repeat(64))).rejects.toThrow('SANDBOX_LIST_PARTIAL_STOP_HANDOFF_UNCONFIRMED');
  const second = fixture();
  second.entries.delete(second.paths.stop);
  await expect(second.check()).rejects.toThrow('SANDBOX_LIST_PARTIAL_STOP_HANDOFF_UNCONFIRMED');
  const third = fixture();
  third.assertCurrent.mockRejectedValueOnce(new Error('STALE_EXECUTION'));
  await expect(third.check()).rejects.toThrow('STALE_EXECUTION');
});

test('native retries address the same authenticated run and request identity', async () => {
  const candidate = fixture();
  const request = jest.fn(async (_body: unknown) => ({}));
  const client = {
    connection: {
      withDeadline: async (_deadline: number, work: () => Promise<unknown>) => work(),
      workflowService: { requestCancelWorkflowExecution: request },
    },
  } as unknown as Parameters<typeof requestSandboxListNativeCancellation>[1];
  const execution = {
    workflowId: 'publishing-workflow',
    runId: '23b877bb-d304-4e2b-a44a-3a31eb9d69f6',
    activityId: '42',
    attempt: 1,
    scheduledAt: 100,
    activityType: 'requestSandboxListNativeCancellation',
    temporalNamespace: 'urm-app-staging.qwejt',
  };
  const invoke = (current = execution) =>
    requestSandboxListNativeCancellation(candidate.db, client, ref, certificateId, current, candidate.assertCurrent);
  await invoke();
  await invoke({ ...execution, attempt: 2 });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0][0]).toEqual(request.mock.calls[1][0]);
  expect(request.mock.calls[0][0]).toMatchObject({
    namespace: execution.temporalNamespace,
    workflowExecution: { workflowId: execution.workflowId, runId: execution.runId },
  });
  await expect(invoke({ ...execution, workflowId: 'different-workflow' })).rejects.toThrow(
    'SANDBOX_LIST_PARTIAL_STOP_HANDOFF_UNCONFIRMED'
  );
  expect(request).toHaveBeenCalledTimes(2);
});
