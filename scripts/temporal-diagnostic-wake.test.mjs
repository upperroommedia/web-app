import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pulseDiagnosticOutbox,
  pulseDiagnosticWake,
  saveDispatchDiagnosticCompletion,
} from './temporal-diagnostic-wake.mjs';
import { nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';
function fixture(expired = true, surface = 'outbox') {
  const operationId = '11111111-2222-4333-8444-555555555555',
    releaseId = '22222222-2222-4333-8444-555555555555';
  const activationReceipt = { identityState: { stage: 'completed' } };
  const m = {
    operationId,
    releaseId,
    bindingDigest: 'a'.repeat(64),
    nonce: 'b'.repeat(32),
    controlVersion: '1:0',
    stateVersion: '2:0',
    expiresAt: Date.now() + (expired ? -1000 : 300000),
    activationDigest: proofDigest(activationReceipt),
  };
  const creation = {
    operationId,
    releaseId,
    bindingDigest: m.bindingDigest,
    identityState: {
      stage: 'completed',
      plan: { operationId, surface: `${surface}-trigger` },
      resource: { uid: 'controlled-owned-trigger' },
    },
  };
  const pulse = { operationId, nonce: m.nonce, creationReceiptDigest: proofDigest(creation) };
  const parent = {
    action: 'prepare-cloud-run-dispatch-diagnostic',
    operationId,
    releaseId,
    bindingDigest: m.bindingDigest,
    cloudDispatchDiagnostic: m,
    [surface === 'outbox' ? 'cloudDispatchDiagnosticWake' : 'cloudDispatchDiagnosticCommandsWake']: {
      stage: 'completed',
      creationState: creation.identityState,
    },
  };
  const journal = { manifestDigest: proofDigest(m), [`${surface}Pulse`]: pulse },
    record = { state: 'diagnostic', manifestDigest: proofDigest(m), diagnosticPulse: pulse };
  const values = {
    '_control/temporalReleaseOperation': parent,
    '_control/temporalRelease': {
      releaseId,
      admission: 'paused',
      domains: Object.fromEntries(
        ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
          d,
          { admission: 'paused' },
        ])
      ),
    },
    '_control/temporalReleaseState': { releaseId, phase: 'provider-usage-ready' },
    [`_control/temporalDispatchDiagnosticAuthorization-${operationId}`]: m,
    [`_control/temporalDispatchDiagnostic-${operationId}`]: journal,
    [`${surface === 'outbox' ? 'durableJobOutbox' : 'durableJobCommands'}/diagnostic-${operationId}-${surface}`]:
      record,
    [`_control/temporalDispatchDiagnosticWakeCreation-${operationId}-${surface}`]: creation,
  };
  let writes = 0,
    transactions = 0;
  const firestore = {
    doc: (path) => ({ path }),
    runTransaction: async (fn) => {
      transactions++;
      return fn({
        get: async (ref) => ({
          exists: Object.hasOwn(values, ref.path),
          data: () => values[ref.path],
          get: (key) => key.split('.').reduce((v, k) => v?.[k], values[ref.path]),
          updateTime: { seconds: ref.path === '_control/temporalRelease' ? 1 : 2, nanoseconds: 0 },
          readTime: { toMillis: () => Date.now() },
        }),
        update: () => {
          writes++;
          throw new Error('Unexpected write');
        },
      });
    },
  };
  return {
    diagnostic: { firestore, manifest: m, activationReceipt },
    markComplete: () => {
      values[`_control/temporalDispatchDiagnosticCompletion-${operationId}`] = {};
    },
    parent,
    creation,
    journal,
    record,
    m,
    get writes() {
      return writes;
    },
    get transactions() {
      return transactions;
    },
  };
}
test('expired original pulse remains GET-only after cleanup; expiry cannot emit a new event', async () => {
  const f = fixture();
  await pulseDiagnosticOutbox(f.diagnostic);
  assert.equal(f.writes, 0);
  f.parent.cloudDispatchDiagnosticWake.stage = 'created';
  delete f.journal.outboxPulse;
  delete f.record.diagnosticPulse;
  await assert.rejects(pulseDiagnosticOutbox(f.diagnostic));
  assert.equal(f.writes, 0);
});
test('a pre-pulse start/lease cannot be retroactively given a native-trigger pulse', async () => {
  const f = fixture(false);
  f.parent.cloudDispatchDiagnosticWake.stage = 'created';
  delete f.journal.outboxPulse;
  delete f.record.diagnosticPulse;
  f.record.startAttemptedAt = Date.now();
  await assert.rejects(pulseDiagnosticOutbox(f.diagnostic));
  assert.equal(f.writes, 0);
});
test('parent binding drift between preliminary read and pulse transaction cannot write', async () => {
  const f = fixture(false),
    run = f.diagnostic.firestore.runTransaction;
  f.diagnostic.firestore.runTransaction = async (fn) => {
    const r = await run(fn);
    if (f.transactions === 1) f.parent.bindingDigest = 'f'.repeat(64);
    return r;
  };
  await assert.rejects(pulseDiagnosticOutbox(f.diagnostic));
  assert.equal(f.writes, 0);
});

for (const surface of ['outbox', 'commands'])
  test(`${surface} cannot inherit the other surface pulse or receipt`, async () => {
    const f = fixture(false, surface),
      other = surface === 'outbox' ? 'commands' : 'outbox';
    await pulseDiagnosticWake(f.diagnostic, `${surface}-trigger`);
    const original = f.journal[`${surface}Pulse`];
    delete f.journal[`${surface}Pulse`];
    f.journal[`${other}Pulse`] = original;
    await assert.rejects(pulseDiagnosticWake(f.diagnostic, `${surface}-trigger`));
    f.journal[`${surface}Pulse`] = original;
    f.creation.identityState.plan.surface = `${other}-trigger`;
    await assert.rejects(pulseDiagnosticWake(f.diagnostic, `${surface}-trigger`));
    assert.equal(f.writes, 0);
  });
test('Scheduler cannot acquire a creation/pulse capability', async () => {
  const f = fixture(false);
  await assert.rejects(pulseDiagnosticWake(f.diagnostic, 'scheduler'));
  assert.equal(f.transactions, 0);
});

function completedFixture() {
  const { m, parent } = fixture();
  const evidenceDigest = '3'.repeat(64);
  const image = `controlled-worker@sha256:${'2'.repeat(64)}`;
  const activationReceipt = {
    releaseId: m.releaseId,
    operationId: 'bbbbbbbb-2222-4333-8444-555555555555',
    identityState: {
      stage: 'completed',
      plan: { evidenceDigest, buildId: '1'.repeat(40), desired: { template: { containers: [{ image }] } } },
      service: { revision: 'controlled-service-revision' },
    },
  };
  Object.assign(m, {
    schemaVersion: 2,
    commandsRecovery: 'scheduler',
    eventSubject: 'event-subject',
    schedulerSubject: 'scheduler-subject',
    serviceRevision: activationReceipt.identityState.service.revision,
    buildId: activationReceipt.identityState.plan.buildId,
    image,
    activationDigest: proofDigest(activationReceipt),
  });
  const lockPath = '_control/temporalReleaseOperation';
  const controlPath = '_control/temporalRelease';
  const statePath = '_control/temporalReleaseState';
  const receiptPath = `_control/temporalDispatchDiagnosticCompletion-${m.operationId}`;
  const docs = new Map([
    [lockPath, parent],
    [
      controlPath,
      {
        releaseId: m.releaseId,
        admission: 'paused',
        domains: Object.fromEntries(
          ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((domain) => [
            domain,
            { admission: 'paused' },
          ])
        ),
      },
    ],
    [statePath, { releaseId: m.releaseId, phase: 'provider-usage-ready' }],
    [`_control/temporalDispatchDiagnosticAuthorization-${m.operationId}`, m],
    [`_control/temporalCloudDispatchActivation-${activationReceipt.operationId}`, activationReceipt],
  ]);
  const journal = { manifestDigest: proofDigest(m) };
  docs.set(`_control/temporalDispatchDiagnostic-${m.operationId}`, journal);
  const [outbox, retry, scheduler] = ['outbox-trigger', 'commands-trigger', 'scheduler'].map((surface, i) => {
    const plan = {
      operationId: m.operationId,
      releaseId: m.releaseId,
      evidenceDigest,
      surface,
      body: { name: surface },
    };
    const creation = {
      operationId: m.operationId,
      releaseId: m.releaseId,
      bindingDigest: m.bindingDigest,
      identityState: { stage: 'completed', plan },
    };
    const key = ['outbox', 'commands', 'scheduler'][i];
    docs.set(`_control/temporalDispatchDiagnosticWakeCreation-${m.operationId}-${key}`, creation);
    const wake = {
      stage: 'completed',
      creationState: creation.identityState,
      plan: { creation: plan, diagnosticManifestSHA256: proofDigest(m) },
      stopState: {
        stage: 'completed',
        outcome: 'native-stop-acknowledged-and-observed',
        plan: {
          ...plan,
          creation: plan,
          diagnosticManifestSHA256: proofDigest(m),
          wakeReceiptSHA256: proofDigest(creation),
        },
      },
    };
    parent[
      ['cloudDispatchDiagnosticWake', 'cloudDispatchDiagnosticCommandsWake', 'cloudDispatchDiagnosticSchedulerWake'][i]
    ] = wake;
    const pulse = { operationId: m.operationId, nonce: m.nonce, creationReceiptDigest: proofDigest(creation) };
    return {
      wake,
      pulse,
      creation,
      path: `durableJob${i === 0 ? 'Outbox' : 'Commands'}/diagnostic-${m.operationId}-${key}`,
    };
  });
  for (const [surface, item, runId, letter] of [
    ['outbox', outbox, 'aaaaaaaa-2222-4333-8444-555555555555', 'a'],
    ['commands', retry, 'cccccccc-2222-4333-8444-555555555555', 'c'],
  ]) {
    const firstEventDelivery = { kind: 'event', id: `delivery-${surface}` };
    journal[`${surface}Pulse`] = item.pulse;
    const record = {
      state: 'diagnostic',
      surface,
      manifestDigest: proofDigest(m),
      dispatchAcknowledged: true,
      runId,
      diagnosticPulse: item.pulse,
      startPulseDigest: proofDigest(item.pulse),
      firstEventDelivery,
      caller: { kind: 'event', subject: m.eventSubject },
      delivery: firstEventDelivery,
    };
    docs.set(item.path, record);
    const observed = {
      schemaVersion: 1,
      operationId: m.operationId,
      manifestDigest: proofDigest(m),
      workflowId: `dispatch-diagnostic-${m.operationId}-${surface}`,
      surface,
      runId,
      historyDigest: letter.repeat(64),
      creationReceiptDigest: proofDigest(item.creation),
      pulseDigest: record.startPulseDigest,
      callerKind: 'event',
      callerSubject: m.eventSubject,
      deliveryId: firstEventDelivery.id,
      serviceRevision: m.serviceRevision,
    };
    item.wake.diagnosticObservation = observed;
    if (surface === 'commands') {
      Object.assign(record, {
        firstLeaseExpiresAt: 110,
        retryFaultAppliedAt: 101,
        lease: { attempt: 2 },
        claimedAt: 115,
        caller: { kind: 'scheduler', subject: m.schedulerSubject },
        delivery: { kind: 'scheduler', job: 'scheduler' },
      });
      journal.commandsRetry = {
        runId,
        pulseDigest: record.startPulseDigest,
        leaseExpiresAt: 110,
        delivery: firstEventDelivery,
      };
      Object.assign(observed, { recovery: 'retry', retryWitnessDigest: proofDigest(journal.commandsRetry) });
      const { deliveryId, ...common } = observed;
      scheduler.wake.diagnosticObservation = {
        ...common,
        recovery: 'scheduler',
        callerKind: 'scheduler',
        callerSubject: m.schedulerSubject,
        schedulerReceiptDigest: proofDigest(scheduler.creation),
        job: 'scheduler',
      };
    }
  }
  const stamp = (seconds) => ({
    seconds,
    nanoseconds: 0,
    toDate: () => new Date(seconds * 1000),
    isEqual: (other) => other.seconds === seconds && other.nanoseconds === 0,
  });
  const changed = new Set();
  const snapshot = (path) => ({
    exists: docs.has(path),
    data: () => structuredClone(docs.get(path)),
    get: (key) => key.split('.').reduce((value, part) => value?.[part], docs.get(path)),
    createTime: stamp(path === statePath ? 2 : 1),
    updateTime: stamp(changed.has(path) ? 3 : path === statePath ? 2 : 1),
  });
  let creates = 0;
  const firestore = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    doc: (path) => ({ path, get: async () => snapshot(path) }),
    runTransaction: (fn) =>
      fn({
        get: async ({ path }) => snapshot(path),
        create: ({ path }, value) => {
          assert.equal(path, receiptPath);
          assert.equal(docs.has(path), false);
          docs.set(path, structuredClone(value));
          creates++;
        },
      }),
  };
  const options = {
    diagnostic: { manifest: m, firestore, activationReceipt },
    evidenceDigest,
    lockRef: firestore.doc(lockPath),
    controlRef: firestore.doc(controlPath),
    stateRef: firestore.doc(statePath),
    expectedAuthority: {
      control: nativeSnapshotProof(snapshot(controlPath)),
      state: nativeSnapshotProof(snapshot(statePath)),
    },
  };
  return {
    get creates() {
      return creates;
    },
    outbox,
    retry,
    scheduler,
    journal,
    docs,
    changed,
    receiptPath,
    seal: () =>
      saveDispatchDiagnosticCompletion({ ...options, ownedOperation: nativeSnapshotProof(snapshot(lockPath)) }),
  };
}

test('immutable diagnostic completion joins the same command history and appends once', async () => {
  const f = completedFixture();
  const original = await f.seal();
  assert.deepEqual(await f.seal(), original);
  assert.equal(f.creates, 1);
  assert.equal(f.docs.get(f.receiptPath).observations[1].runId, f.docs.get(f.receiptPath).observations[2].runId);
  f.changed.add(f.receiptPath);
  await assert.rejects(f.seal(), /UNCONFIRMED/);
});

test('diagnostic receipt denies missing cleanup, foreign retry evidence and changed original history', async () => {
  for (const change of [
    (f) => {
      delete f.outbox.wake.stopState;
    },
    (f) => {
      f.scheduler.wake.diagnosticObservation.historyDigest = 'f'.repeat(64);
    },
    (f) => {
      f.retry.wake.diagnosticObservation.pulseDigest = 'f'.repeat(64);
    },
    (f) => {
      f.scheduler.wake.diagnosticObservation.job = 'foreign-job';
    },
    (f) => {
      f.journal.commandsRetry.leaseExpiresAt = 116;
    },
    (f) => {
      f.docs.get(f.retry.path).dispatchAcknowledged = false;
    },
  ]) {
    const f = completedFixture();
    change(f);
    await assert.rejects(f.seal(), /UNCONFIRMED/);
    assert.equal(f.creates, 0);
  }
});

test('a closed diagnostic cannot emit a fresh pulse while its parent is still held', async () => {
  const f = fixture(false);
  f.parent.cloudDispatchDiagnosticWake.stage = 'created';
  delete f.journal.outboxPulse;
  delete f.record.diagnosticPulse;
  f.markComplete();
  await assert.rejects(pulseDiagnosticOutbox(f.diagnostic), /UNCONFIRMED/);
  assert.equal(f.writes, 0);
});
