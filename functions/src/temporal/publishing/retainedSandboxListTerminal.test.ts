import type { DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
import { acknowledgedProjectionDigest as digest } from './acknowledgedProjectionDigest';
import { isTerminalSandboxListPartialStop } from './retainedSandboxListTerminal';

const projectId = 'urm-app-staging';
const jobId = 'reviewed-publish';
const workflowId = 'publishing:urm-app-staging:reviewed-publish';
const operation = 'publishing:' + jobId + ':lists:publish:all';
const scope = { projectId, jobId, operation };
const sessionId = digest(scope);
const commandId = 'a'.repeat(64);
const resources = ['list-1', 'list-2'].map((resourceId) => ({
  provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'list', resourceId,
}));
const resourceKeys = resources.map((resource) => digest([projectId, resource.provider, resource.account, resource.resourceId]));
const result = { state: 'completed', mode: 'partial_stop', providerEffects: 'partial', contentPreserved: true };
const stoppedAt = { seconds: 42, nanoseconds: 3, isEqual: (other: unknown) => other === stoppedAt };
const terminalAt = { seconds: 42, nanoseconds: 4, isEqual: (other: unknown) => other === terminalAt };
function snapshot(id: string, data?: Record<string, unknown>, create = stoppedAt, update = create) {
  return {
    id,
    exists: Boolean(data),
    createTime: create,
    updateTime: update,
    data: () => data,
    get: (key: string) => key.split('.').reduce<unknown>((value, part) =>
      typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[part] : undefined, data),
  } as unknown as DocumentSnapshot;
}

function fixture() {
  const stop = {
    schemaVersion: 1, projectId, jobId, sessionId, generation: 1, workflowId, commandId,
    resourceKeys: [...resourceKeys].sort(), result,
    sourceDigest: 'b'.repeat(64), approvalDigest: 'c'.repeat(64), journalDigest: 'd'.repeat(64),
    projectionDigest: 'e'.repeat(64), claimDigest: 'f'.repeat(64),
  };
  const ownerRecord = {
    schemaVersion: 1, scope, state: 'sandbox_partial_stop', resourceKeys, resources,
    sandboxPartialStopDigest: digest(stop),
  };
  const lock = {
    schemaVersion: 1, projectId, jobId, sessionId, state: 'held',
  };
  const witness = {
    schemaVersion: 1, source: 'temporal_workflow_history', projectId, jobId, sessionId, generation: 1, workflowId,
    runId: '5369296b-33ee-4b72-8dd7-5d958adb2c77', closeEventId: 93,
    closeEventType: 'WorkflowExecutionCanceled', stopDigest: digest(stop), commandId,
  };
  const closedJob = { projectId, jobId, kind: 'sermon.publish', workflowId, generation: 1, state: 'cancelled' };
  const rows = new Map([
    ['temporalSandboxListPartialStops/' + sessionId, snapshot(sessionId, stop)],
    ['temporalSandboxListPartialStopTerminals/' + sessionId, snapshot(sessionId, witness, terminalAt)],
    ['durableJobs/' + jobId, snapshot(jobId, closedJob, terminalAt)],
  ]);
  const getAll = jest.fn(async (...paths: string[]) => paths.map((path) => rows.get(path) ?? snapshot(path)));
  const tx = { getAll } as unknown as Transaction;
  const db = { doc: (path: string) => path, projectId, databaseId: '(default)' } as unknown as Firestore;
  const check = (owner = snapshot(sessionId, ownerRecord), resource = snapshot(resourceKeys[0], lock)) =>
    isTerminalSandboxListPartialStop(tx, db, projectId, owner, resource);
  return { rows, ownerRecord, lock, witness, closedJob, check, getAll };
}

test('terminal simulator disposition qualifies each exact lock for a successor', async () => {
  const subject = fixture();
  await expect(subject.check()).resolves.toBe(true);
  await expect(subject.check(undefined, snapshot(resourceKeys[1], subject.lock))).resolves.toBe(true);
});

test('a committed partial receipt and public cancellation alone do not release ownership', async () => {
  const subject = fixture();
  subject.rows.delete('temporalSandboxListPartialStopTerminals/' + sessionId);
  await expect(subject.check()).resolves.toBe(false);
});

test('a stale generation, mutable terminal proof or different original command cannot release the lock', async () => {
  const subject = fixture();
  const path = 'temporalSandboxListPartialStopTerminals/' + sessionId;
  subject.rows.set(path, snapshot(sessionId, { ...subject.witness, generation: 2 }, terminalAt));
  await expect(subject.check()).resolves.toBe(false);
  subject.rows.set(path, snapshot(sessionId, subject.witness, stoppedAt, terminalAt));
  await expect(subject.check()).resolves.toBe(false);
  subject.rows.set(path, snapshot(sessionId, { ...subject.witness, commandId: 'b'.repeat(64) }, terminalAt));
  await expect(subject.check()).resolves.toBe(false);
});

test('the terminal witness must postdate the atomic stop and bind a cancelled original job', async () => {
  const subject = fixture();
  const path = 'temporalSandboxListPartialStopTerminals/' + sessionId;
  subject.rows.set(path, snapshot(sessionId, subject.witness));
  await expect(subject.check()).resolves.toBe(false);
  subject.rows.set(path, snapshot(sessionId, subject.witness, terminalAt));
  subject.rows.set('durableJobs/' + jobId, snapshot(jobId, { ...subject.closedJob, state: 'cancel_requested' }, terminalAt));
  await expect(subject.check()).resolves.toBe(false);
});

test('the owner cannot attest a substituted lock or a separately rewritten session', async () => {
  const subject = fixture();
  await expect(subject.check(undefined, snapshot('different-lock', subject.lock))).resolves.toBe(false);
  expect(subject.getAll).not.toHaveBeenCalled();
  await expect(subject.check(snapshot(sessionId, subject.ownerRecord, stoppedAt, terminalAt))).resolves.toBe(false);
});
