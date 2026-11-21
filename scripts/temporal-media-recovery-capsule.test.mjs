import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mediaRecoveryFixture } from './tests/fixtures/media-recovery.mjs';
import {
  controlledRecoveryCapsuleFacts,
  controlledCapsuleOperatorIdentity,
} from './tests/fixtures/media-recovery-capsule.mjs';
import { runMediaRecoveryCycle } from './temporal-media-recovery-cycle.mjs';
import {
  prepareCompletedMediaRecoveryCapsule as prepare,
  confirmCompletedMediaRecoveryCapsule as confirm,
} from './temporal-media-recovery-capsule.mjs';
import { proofDigest as hash, nativeSnapshotProof } from './temporal-release-runtime.mjs';
const require = createRequire(import.meta.url),
  { Timestamp } = require('firebase-admin/firestore');
async function fixture() {
  const f = await mediaRecoveryFixture(),
    next = structuredClone(await runMediaRecoveryCycle(f.options)),
    p = next.plan,
    id = p.operationId;
  const authority = { control: { controlled: 'control' }, state: { controlled: 'state' } },
    journal = { planSHA256: hash(p), authority, attemptedAt: p.createdAt };
  next.prepared.proofSHA256 = hash(journal);
  const { intent, facts } = controlledRecoveryCapsuleFacts(next);
  facts.Journal = journal;
  const principal = { email: 'controlled@example.test' },
    root = {
      action: 'diagnose-cloud-run-media-recovery',
      operationId: id,
      releaseId: p.releaseId,
      bindingDigest: p.bindingDigest,
      operatorPrincipal: principal,
      operatorIdentity: controlledCapsuleOperatorIdentity,
      mediaRecoveryJournalAttempt: { stage: 'completed', recordSHA256: hash(journal), attemptedAt: p.createdAt },
      mediaRecoveryWorkflowStart: intent,
      cloudMediaRecovery: { stage: 'stopped' },
    };
  const docs = new Map(Object.entries(facts).map(([k, v]) => [`_control/temporalMediaRecovery${k}-${id}`, v]));
  const snapshot = (path) => ({
    ref: { path },
    exists: docs.has(path),
    data: () => docs.get(path),
    get: (key) => key.split('.').reduce((v, k) => v?.[k], docs.get(path)),
    createTime: new Timestamp(1, 2),
    updateTime: new Timestamp(3, 4),
  });
  docs.set('parent', root);
  const o = {
      operationId: id,
      bindingDigest: p.bindingDigest,
      config: { releaseId: p.releaseId },
      expectedAuthority: authority,
      firestore: { doc: (path) => ({ path }) },
    },
    tx = { get: async (ref) => snapshot(ref.path) },
    completion = { operationId: id, identityState: next, operatorPrincipal: principal },
    drain = { controlled: 'drain' };
  return {
    o,
    tx,
    root,
    next,
    docs,
    completion,
    drain,
    snapshot,
    read: () => prepare(o, tx, snapshot('parent'), next, completion, drain),
  };
}
test('completion capsule freezes allowlisted provenance and exact native fact stamps without new authority', async () => {
  const f = await fixture();
  f.root.unrelatedPrivateDiagnostic = 'DO_NOT_COPY';
  const first = await f.read();
  assert.equal(first.create, true);
  assert.equal(first.record.kind, 'completed-media-recovery-provenance-only-v1');
  assert.equal(first.record.facts.length, 14);
  assert.equal(first.record.completionSHA256, hash(f.completion));
  assert(!JSON.stringify(first.record).includes('DO_NOT_COPY'));
  f.docs.set(first.ref.path, structuredClone(first.record));
  f.root.cloudMediaRecovery = f.next;
  const second = await f.read();
  assert.equal(second.create, false);
  assert.deepEqual(second.record, first.record);
  f.docs.get(`_control/temporalMediaRecoveryWork-${f.o.operationId}`).changed = true;
  await assert.rejects(f.read(), /CAPSULE_UNCONFIRMED/);
});
for (const [name, change] of [
  [
    'failed recovery',
    (f) => {
      f.next.recoveryFailed = {};
    },
  ],
  [
    'never started',
    (f) => {
      f.next.neverStarted = {};
    },
  ],
  ['missing native journal', (f) => f.docs.delete(`_control/temporalMediaRecoveryJournal-${f.o.operationId}`)],
  ['missing original ACK', (f) => f.docs.delete(`_control/temporalMediaRecoveryStart-${f.o.operationId}`)],
  [
    'different original intent',
    (f) => {
      f.root.mediaRecoveryWorkflowStart.taskQueue = 'foreign';
    },
  ],
  [
    'unknown original run',
    (f) => {
      f.docs.get(`_control/temporalMediaRecoveryStart-${f.o.operationId}`).runId = null;
    },
  ],
  [
    'foreign operator',
    (f) => {
      f.completion.operatorPrincipal = { email: 'foreign@example.test' };
    },
  ],
  [
    'uncertain descendant drain',
    (f) => {
      f.docs.get(`_control/temporalMediaRecoveryKernel-${f.o.operationId}`).close.descendantsAbsent = false;
    },
  ],
  [
    'observer failure',
    (f) => {
      f.docs.get(`_control/temporalMediaRecoveryReplacementKernel-${f.o.operationId}`).close.observerFailed = true;
    },
  ],
  [
    'missing capsule on old completed operation',
    (f) => {
      f.root.cloudMediaRecovery = f.next;
    },
  ],
])
  test(`capsule denies ${name}`, async () => {
    const f = await fixture();
    change(f);
    await assert.rejects(f.read());
  });

async function confirmationFixture() {
  const f = await fixture(),
    capsule = await f.read();
  f.docs.set(capsule.ref.path, structuredClone(capsule.record));
  f.root.cloudMediaRecovery = f.next;
  f.docs.set('control', {
    releaseId: f.o.config.releaseId,
    admission: 'paused',
    domains: Object.fromEntries(
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((k) => [
        k,
        { admission: 'paused' },
      ])
    ),
  });
  f.docs.set('state', { releaseId: f.o.config.releaseId, phase: 'provider-usage-ready' });
  f.docs.set(`_control/temporalCloudMediaRecovery-${f.o.operationId}`, f.completion);
  f.docs.set(`_control/temporalMediaRecoveryDrain-${f.o.operationId}`, f.drain);
  Object.assign(f.o, {
    lockRef: { path: 'parent' },
    controlRef: { path: 'control' },
    stateRef: { path: 'state' },
    ownedOperation: nativeSnapshotProof(f.snapshot('parent')),
  });
  f.o.expectedAuthority = {
    control: nativeSnapshotProof(f.snapshot('control')),
    state: nativeSnapshotProof(f.snapshot('state')),
  };
  const journal = f.docs.get(`_control/temporalMediaRecoveryJournal-${f.o.operationId}`);
  journal.authority = f.o.expectedAuthority;
  f.root.mediaRecoveryJournalAttempt.recordSHA256 = hash(journal);
  f.next.prepared.proofSHA256 = hash(journal);
  const seeded = controlledRecoveryCapsuleFacts(f.next);
  f.root.mediaRecoveryWorkflowStart = seeded.intent;
  f.docs.set(`_control/temporalMediaRecoveryStart-${f.o.operationId}`, seeded.facts.Start);
  f.root.cloudMediaRecovery = { stage: 'stopped' };
  f.docs.delete(capsule.ref.path);
  const sealed = await f.read();
  f.docs.set(sealed.ref.path, structuredClone(sealed.record));
  f.root.cloudMediaRecovery = f.next;
  f.o.ownedOperation = nativeSnapshotProof(f.snapshot('parent'));
  Object.assign(f.o.firestore, {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    runTransaction: async (fn) => fn(f.tx),
  });
  return f;
}
test('same-parent capsule confirmation preserves exact read-only facts', async () => {
  const f = await confirmationFixture();
  assert.equal((await confirm(f.o)).scope, 'historical-provenance-only-no-activation-authority');
});
test('confirmation times out a never-settling read without backfill', async () => {
  const f = await confirmationFixture();
  f.o.firestore.runTransaction = () => new Promise(() => {});
  await assert.rejects(confirm(f.o), /CAPSULE_UNCONFIRMED/);
});
test('confirmation rejects a late-settling native read even if its microtask wins the timer', async () => {
  const f = await confirmationFixture(),
    run = f.o.firestore.runTransaction;
  f.o.firestore.runTransaction = async (fn) => {
    const v = await run(fn);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5100);
    return v;
  };
  await assert.rejects(confirm(f.o), /CAPSULE_UNCONFIRMED/);
});
test('capsule denies missing original source operator identity', async () => {
  const f = await fixture();
  delete f.root.operatorIdentity;
  await assert.rejects(f.read(), /CAPSULE_UNCONFIRMED/);
});

test('Job capsule retains owned RUN and the unchanged zero pool with both exact task witnesses', async () => {
  const f = await fixture();
  const { next, root, o, docs } = f;
  const id = o.operationId;
  const plan = next.plan;
  const job = {
    name: 'projects/urm-app-staging/locations/us-central1/jobs/urm-media-recovery-' + id.replaceAll('-', ''),
  };
  plan.job = job;
  const execution = job.name + '/executions/original';
  const witness = {
    execution,
    executionUid: 'original-uid',
    task: execution + '/tasks/index-zero',
    taskUid: 'fc47dae1-a5f4-4a1a-9f56-569de759ce3d',
  };
  const provider = {
    runIdentity: { stage: 'acknowledged', jobPlanSHA256: hash(job), execution, executionUid: witness.executionUid },
  };
  root.mediaRecoveryJobProvider = provider;
  for (const key of ['start', 'diagnostic', 'restore', 'stop', 'stopped', 'drained']) delete next[key];
  next.disposition = 'normal-zero-after-job';
  next.jobTermination = { ...witness, proofSHA256: 'c'.repeat(64) };
  next.jobDrain = { terminationSHA256: next.jobTermination.proofSHA256 };
  f.drain.proof = next.jobDrain;
  const facts = (name) => docs.get(`_control/temporalMediaRecovery${name}-${id}`);
  const journal = facts('Journal');
  journal.planSHA256 = hash(plan);
  next.prepared.proofSHA256 = hash(journal);
  root.mediaRecoveryJournalAttempt.recordSHA256 = hash(journal);
  const intent = root.mediaRecoveryWorkflowStart;
  intent.planSHA256 = hash(plan);
  intent.preparedSHA256 = hash(next.prepared);
  intent.cycleSHA256 = hash({ plan, stage: 'prepared', prepared: next.prepared });
  delete intent.poolSHA256;
  intent.jobRunSHA256 = hash(provider.runIdentity);
  const start = facts('Start');
  delete start.poolSHA256;
  start.jobRunSHA256 = intent.jobRunSHA256;
  start.intentSHA256 = hash(intent);
  for (const name of ['Kernel', 'ReplacementKernel']) facts(name).worker = { cloudRunJob: structuredClone(witness) };
  root.cloudMediaRecovery = { stage: 'prepared' };
  const capsule = await f.read();
  assert.equal(capsule.record.schemaVersion, 2);
  assert.equal(capsule.record.kind, 'completed-media-recovery-job-provenance-v2');
  assert.deepEqual(capsule.record.restoredPool, plan.origin);
  assert.deepEqual(capsule.record.originalParent.mediaRecoveryJobProvider, provider);
  facts('ReplacementKernel').worker.cloudRunJob.taskUid = 'foreign-task';
  await assert.rejects(f.read(), /CAPSULE_UNCONFIRMED/);
});
