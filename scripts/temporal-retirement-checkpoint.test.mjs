import assert from 'node:assert/strict';
import test from 'node:test';
import { saveMediaPromotionCheckpoint } from './temporal-preparation-checkpoint.mjs';
import { nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';
import { serverlessComputeSettings, serverlessResourceNames } from './temporal-serverless-platform.mjs';
import {
  orchestrationHandoffAction,
  readOrchestrationHandoffReceipt,
  saveOrchestrationHandoffCheckpoint,
  readTraditionalRetirementAuthority,
  saveTraditionalRetirementCheckpoint,
  traditionalRetirementAction,
  traditionalRetirementField,
  computeAttachmentAction,
  readComputeAttachmentAuthority,
  saveComputeAttachmentCheckpoint,
  workerComputeOrder,
  workerWakeAction,
  readWorkerWakeAuthority,
  readWorkerWakeReadiness,
  saveWorkerReadinessStartIntent,
  saveWorkerWakeCheckpoint,
} from './temporal-retirement-checkpoint.mjs';

const scopes = ['accounts', 'bundles', 'emails', 'images', 'media', 'publishing', 'search'];
const releaseId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const bindingDigest = 'a'.repeat(64);
const lockPath = '_control/temporalReleaseOperation';
const controlPath = '_control/temporalRelease';
const statePath = '_control/temporalReleaseState';
const receiptPath = `_control/temporalTraditionalRetirement-${releaseId}`;
const deploy = '33333333-3333-4333-8333-333333333333';
const pod = '44444444-4444-4444-8444-444444444444';
const stamp = (seconds) => ({
  seconds,
  nanoseconds: 0,
  toDate: () => new Date(seconds * 1000),
  isEqual: (other) => other.seconds === seconds && other.nanoseconds === 0,
});

function fixture(action = traditionalRetirementAction) {
  const control = {
    releaseId,
    admission: 'paused',
    domains: Object.fromEntries(scopes.map((name) => [name, { admission: 'paused' }])),
  };
  const state = { releaseId, phase: 'provider-usage-ready' };
  const lock = { releaseId, operationId, bindingDigest, action };
  const docs = new Map([
    [lockPath, lock],
    [controlPath, control],
    [statePath, state],
  ]);
  const revisions = new Map();
  let activeProvider = false;
  const read = (path) => {
    const value = docs.has(path) ? structuredClone(docs.get(path)) : undefined;
    return {
      exists: value !== undefined,
      data: () => value,
      createTime: stamp(1),
      updateTime: stamp(revisions.get(path) ?? 1),
      get: (field) => field.split('.').reduce((obj, part) => obj?.[part], value),
    };
  };
  const db = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    collection(name) {
      const q = {
        count: () => ({ countQuery: true, count: activeProvider && name === 'temporalProviderMutationLocks' ? 1 : 0 }),
        where: () => q,
      };
      return q;
    },
    doc(path) {
      return { path, get: async () => read(path) };
    },
    async runTransaction(callback) {
      const writes = [];
      const result = await callback({
        get: async (ref) => (ref.countQuery ? { data: () => ({ count: ref.count }) } : read(ref.path)),
        update: (ref, fields) =>
          writes.push(() => {
            Object.assign(docs.get(ref.path), structuredClone(fields));
            revisions.set(ref.path, (revisions.get(ref.path) ?? 1) + 1);
          }),
        create: (ref, fields) =>
          writes.push(() => {
            assert.equal(docs.has(ref.path), false);
            docs.set(ref.path, structuredClone(fields));
          }),
      });
      writes.forEach((write) => write());
      return result;
    },
  };
  const config = { projectId: db.projectId, environment: 'staging', releaseId, domains: scopes };
  const expectedAuthority = {
    control: nativeSnapshotProof(read(controlPath)),
    state: nativeSnapshotProof(read(statePath)),
  };
  let ownedOperation = nativeSnapshotProof(read(lockPath));
  const attemptedAt = Date.now();
  const before = {
    digest: 'b'.repeat(64),
    observedAt: attemptedAt - 1,
    podResourceVersion: '10',
    deployments: [{ uid: deploy, desired: 1, resourceVersion: '9' }],
    pods: [{ uid: pod, deploymentUid: deploy }],
  };
  const plan = { schemaVersion: 1, releaseId, operationId, bindingDigest, before, protectionSHA256: 'c'.repeat(64) };
  const planned = { stage: 'planned', plan, attempts: {} };
  const prepared = {
    stage: 'retiring',
    plan,
    attempts: { [deploy]: { attemptedAt, resourceVersion: '9' } },
    watch: { beforeSHA256: before.digest, podResourceVersion: '10', pods: {} },
  };
  async function save(next) {
    ownedOperation = await saveTraditionalRetirementCheckpoint({
      firestore: db,
      config,
      expectedAuthority,
      ownedOperation,
      operationId,
      bindingDigest,
      next,
    });
  }
  return {
    docs,
    save,
    planned,
    prepared,
    attemptedAt,
    read,
    firestore: db,
    config,
    markChanged: (path) => revisions.set(path, 2),
    saveReadiness: (intent, artifactDirectory) =>
      saveWorkerReadinessStartIntent({
        firestore: db,
        config,
        expectedAuthority,
        ownedOperation,
        operationId,
        bindingDigest,
        action,
        intent,
        artifactDirectory,
      }),
    readWakeReadiness: (extra, tx) =>
      readWorkerWakeReadiness(
        {
          firestore: db,
          config,
          expectedAuthority,
          ownedOperation,
          operationId,
          bindingDigest,
          action,
          ...extra,
        },
        tx
      ),
    readWake: (extra) =>
      readWorkerWakeAuthority({
        firestore: db,
        config,
        expectedAuthority,
        ownedOperation,
        operationId,
        bindingDigest,
        ...extra,
      }),
    saveWake: async (extra, next) => {
      ownedOperation = await saveWorkerWakeCheckpoint({
        firestore: db,
        config,
        expectedAuthority,
        ownedOperation,
        operationId,
        bindingDigest,
        ...extra,
        next,
      });
    },
    readCompute: (extra) =>
      readComputeAttachmentAuthority({
        firestore: db,
        config,
        expectedAuthority,
        ownedOperation,
        operationId,
        bindingDigest,
        ...extra,
      }),
    saveCompute: async (extra, next) => {
      ownedOperation = await saveComputeAttachmentCheckpoint({
        firestore: db,
        config,
        expectedAuthority,
        ownedOperation,
        operationId,
        bindingDigest,
        ...extra,
        next,
      });
    },
    saveHandoff: async (next) => {
      ownedOperation = await saveOrchestrationHandoffCheckpoint({
        firestore: db,
        config,
        expectedAuthority,
        ownedOperation,
        operationId,
        bindingDigest,
        next,
      });
    },
    haveProviderLock: () => {
      activeProvider = true;
    },
    authority: (options) =>
      readTraditionalRetirementAuthority(
        {
          firestore: db,
          config,
          expectedAuthority,
          ownedOperation,
          operationId,
          bindingDigest,
        },
        options
      ),
  };
}

test('retirement persists original attempt and compact watch progress under existing release lock', async () => {
  const f = fixture();
  await f.save(f.planned);
  await f.save(f.prepared);
  const next = {
    ...f.prepared,
    watch: {
      ...f.prepared.watch,
      podResourceVersion: '12',
      pods: { [pod]: { stage: 'removed', finishedAt: f.attemptedAt } },
    },
  };
  await f.save(next);
  assert.deepEqual(f.read(lockPath).get(traditionalRetirementField), next);
  const receipt = {
    beforeSHA256: next.plan.before.digest,
    afterSHA256: 'd'.repeat(64),
    temporalSHA256: 'e'.repeat(64),
    podResourceVersion: '12',
    observedAt: f.attemptedAt,
    exited: [[pod, f.attemptedAt]],
  };
  await f.save({ ...next, stage: 'completed', receipt });
  assert.deepEqual(f.read(receiptPath).get('result'), receipt);
  await assert.rejects(f.save(next), /RETIREMENT_CHECKPOINT_UNCONFIRMED/);
});

test('lock loss, cursor rollback and changed attempt retain existing checkpoint', async () => {
  const f = fixture();
  await f.save(f.planned);
  await f.save(f.prepared);
  await assert.rejects(
    f.save({ ...f.prepared, watch: { ...f.prepared.watch, podResourceVersion: '9' } }),
    /UNCONFIRMED/
  );
  await assert.rejects(
    f.save({ ...f.prepared, attempts: { [deploy]: { ...f.prepared.attempts[deploy], resourceVersion: '8' } } }),
    /RETIREMENT_CHECKPOINT_UNCONFIRMED/
  );
  f.docs.get(controlPath).domains.media.admission = 'open';
  await assert.rejects(f.save(f.prepared), /RELEASE_NATIVE_AUTHORITY_CHANGED/);
  assert.deepEqual(f.read(lockPath).get(traditionalRetirementField), f.prepared);
});

test('resumed retirement sees the original attempt before refusing new provider work', async () => {
  const f = fixture();
  await f.save(f.planned);
  await f.save(f.prepared);
  assert.deepEqual((await f.authority()).saved, f.prepared);
  f.haveProviderLock();
  let retained = false;
  await assert.rejects(
    f.authority({
      onSaved: (saved) => {
        retained = saved.stage === 'retiring';
      },
    }),
    /TRADITIONAL_RETIREMENT_WORK_UNCONFIRMED/
  );
  assert.equal(retained, true);
});

test('routing saves the native pre-handoff evidence where retirement later reads it', async () => {
  const f = fixture(orchestrationHandoffAction);
  const platform = {
    workerBuildId: 'e'.repeat(40),
    workerImage: 'immutable',
    temporalNamespace: 'urm-app-staging.qwejt',
  };
  const previousBuildId = 'd'.repeat(40);
  const attemptedAt = Date.now() - 1000;
  const attempted = {
    stage: 'attempted',
    attemptedAt,
    originalToken: 'token',
    plan: {
      schemaVersion: 1,
      deploymentName: 'urm-worker-staging',
      operationId,
      bindingDigest,
      releaseId,
      buildId: platform.workerBuildId,
      previousBuildId,
      image: platform.workerImage,
      namespace: platform.temporalNamespace,
      handoffPlanSHA256: 'e'.repeat(64),
    },
    immutableSHA256: 'f'.repeat(64),
    protectedWorkSHA256: 'a'.repeat(64),
    preHandoffInventory: {
      observedAt: attemptedAt - 1,
      digest: 'b'.repeat(64),
      versions: [
        { buildId: previousBuildId, active: true },
        { buildId: platform.workerBuildId, active: false },
      ],
    },
  };
  await f.saveHandoff(attempted);
  const completed = { ...attempted, stage: 'completed', handoffAt: attemptedAt + 10 };
  await assert.rejects(f.saveHandoff({ ...completed, preHandoffInventory: {} }), /UNCONFIRMED/);
  await assert.rejects(
    f.saveHandoff({ ...completed, plan: { ...attempted.plan, handoffPlanSHA256: 'c'.repeat(64) } }),
    /UNCONFIRMED/
  );
  await f.saveHandoff(completed);
  await assert.rejects(readOrchestrationHandoffReceipt(f.firestore, f.config, platform, 'c'.repeat(64)), /UNCONFIRMED/);
  assert.deepEqual(
    await readOrchestrationHandoffReceipt(f.firestore, f.config, platform, attempted.plan.handoffPlanSHA256),
    completed
  );
  await assert.rejects(
    readOrchestrationHandoffReceipt(
      f.firestore,
      f.config,
      { ...platform, workerBuildId: 'b'.repeat(40) },
      attempted.plan.handoffPlanSHA256
    ),
    /UNCONFIRMED/
  );
});

test('compute attachment owns an immutable role receipt and requires exact retired state and earlier role records', async () => {
  const f = fixture(computeAttachmentAction);
  const buildId = 'd'.repeat(40),
    evidenceDigest = 'e'.repeat(64);
  const bindings = workerComputeOrder.map((role) => ({
    role,
    buildId,
    projectId: 'urm-app-staging',
    region: 'us-central1',
    namespace: 'urm-app-staging.qwejt',
    ...serverlessResourceNames(buildId, role),
    image: `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'f'.repeat(64)}`,
    maxInstances: 1,
    stabilizationSeconds: 180,
  }));
  const options = { platform: { roleBindings: bindings }, role: 'controls', evidenceDigest };
  await assert.rejects(f.readCompute(options), /UNCONFIRMED/);
  f.docs.set(receiptPath, {
    schemaVersion: 1,
    releaseId,
    operationId,
    bindingDigest,
    planSHA256: 'b'.repeat(64),
    result: { afterSHA256: 'c'.repeat(64), temporalSHA256: 'a'.repeat(64) },
  });
  await assert.rejects(f.readCompute({ ...options, role: 'search' }), /UNCONFIRMED/);
  assert.deepEqual((await f.readCompute(options)).attachedRoles, []);
  const binding = bindings[0];
  const attempted = {
    stage: 'attempted',
    attemptedAt: Date.now(),
    protectionSHA256: 'b'.repeat(64),
    plan: {
      operationId,
      releaseId,
      bindingDigest,
      evidenceDigest,
      bindingSHA256: proofDigest(binding),
      computeSHA256: proofDigest(serverlessComputeSettings(binding)),
    },
  };
  await f.saveCompute(options, attempted);
  assert.deepEqual((await f.readCompute(options)).saved, attempted);
  assert.equal(f.read(`_control/temporalWorkerCompute-${releaseId}-controls`).exists, false);
  await assert.rejects(
    f.saveCompute(options, { ...attempted, stage: 'completed', protectionSHA256: 'f'.repeat(64) }),
    /UNCONFIRMED/
  );
  const completed = {
    ...attempted,
    stage: 'completed',
    observedAt: Date.now(),
    outcome: 'desired-compute-observed-after-unknown-ack',
  };
  await f.saveCompute(options, completed);
  assert.deepEqual(f.read(`_control/temporalWorkerCompute-${releaseId}-controls`).get('state'), completed);
  await assert.rejects(f.saveCompute(options, completed), /UNCONFIRMED/);
});

test('a wake receipt preserves the native attempt, run and pending retry observation', async () => {
  const f = fixture(workerWakeAction),
    buildId = 'd'.repeat(40),
    evidenceDigest = 'e'.repeat(64);
  const workerImage = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'f'.repeat(64)}`;
  const roleBindings = workerComputeOrder.map((role) => ({
    role,
    buildId,
    projectId: 'urm-app-staging',
    region: 'us-central1',
    namespace: 'urm-app-staging.qwejt',
    ...serverlessResourceNames(buildId, role),
    image: workerImage,
    maxInstances: 1,
    stabilizationSeconds: 180,
  }));
  const options = { role: 'controls', evidenceDigest, platform: { roleBindings, workerBuildId: buildId, workerImage } };
  const attemptedAt = Date.now() - 100;
  f.docs.set(receiptPath, {
    schemaVersion: 1,
    releaseId,
    operationId,
    bindingDigest,
    planSHA256: 'b'.repeat(64),
    result: { afterSHA256: 'c'.repeat(64), temporalSHA256: 'a'.repeat(64) },
  });
  await assert.rejects(f.readWake(options), /UNCONFIRMED/);
  for (const binding of roleBindings) {
    f.docs.set(`_control/temporalWorkerCompute-${releaseId}-${binding.role}`, {
      schemaVersion: 1,
      role: binding.role,
      releaseId,
      state: {
        stage: 'completed',
        attemptedAt,
        observedAt: attemptedAt,
        outcome: 'native-acknowledgement-and-readback',
        plan: {
          operationId,
          releaseId,
          evidenceDigest,
          bindingSHA256: proofDigest(binding),
          computeSHA256: proofDigest(serverlessComputeSettings(binding)),
        },
      },
    });
  }
  const initial = await f.readWake(options);
  const nonce = operationId.replaceAll('-', '');
  const input = { nonce, projectId: 'urm-app-staging', role: 'controls', buildId, delayMs: 480000 };
  const workflowId = `worker-wake-${nonce}`;
  const plan = {
    operationId,
    bindingDigest,
    releaseId,
    evidenceDigest,
    role: 'controls',
    buildId,
    protectionSHA256: initial.protectionSHA256,
  };
  const attempted = { plan, stage: 'attempted', attempt: { workflowId, input, attemptedAt } };
  await f.saveWake(options, attempted);
  const run = { workflowId, runId: pod, input };
  const started = { ...attempted, stage: 'started', run };
  await f.saveWake(options, started);
  const retryWait = { workflowId, runId: pod, role: 'controls', observedAt: Date.now(), eligibleAt: Date.now() + 1000 };
  const waited = { ...started, stage: 'retry-wait', retryWait };
  await f.saveWake(options, waited);
  assert.deepEqual((await f.readWake(options)).saved, waited);
  const proof = { workflowId, runId: pod, timer: { role: 'orchestration' }, retry: { role: 'controls' } };
  await assert.rejects(
    f.saveWake(options, { ...waited, stage: 'completed', proof, run: { ...run, runId: deploy } }),
    /UNCONFIRMED/
  );
  await f.saveWake(options, { ...waited, stage: 'completed', proof });
  assert.equal(f.read(`_control/temporalWorkerWake-${releaseId}-controls`).get('state.run.runId'), pod);
});

test('Cloud Run readiness joins all six immutable wakes to exact retired fleet evidence', async () => {
  const f = fixture('workers-ready');
  const buildId = 'd'.repeat(40),
    evidenceDigest = 'e'.repeat(64);
  const workerImage = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'f'.repeat(64)}`;
  const roleBindings = workerComputeOrder.map((role) => ({
    role,
    buildId,
    projectId: 'urm-app-staging',
    region: 'us-central1',
    namespace: 'urm-app-staging.qwejt',
    ...serverlessResourceNames(buildId, role),
    image: workerImage,
    maxInstances: 1,
    stabilizationSeconds: 180,
  }));
  const pools = Object.fromEntries(
    workerComputeOrder.map((role) => [
      role,
      { poolUid: `pool-${role}`, revision: `revision-${role}`, revisionUid: `uid-${role}` },
    ])
  );
  const options = { evidenceDigest, pools, platform: { roleBindings, workerBuildId: buildId, workerImage } };
  const attemptedAt = Date.now() - 20000;
  f.docs.set(receiptPath, {
    schemaVersion: 1,
    releaseId,
    operationId,
    bindingDigest,
    planSHA256: 'b'.repeat(64),
    result: { afterSHA256: 'c'.repeat(64), temporalSHA256: 'a'.repeat(64) },
  });
  const id = (family, i) => `${family.repeat(8)}-2222-4222-8222-00000000000${i}`;
  const wake = (phase, role, eligibleAt) => ({
    phase,
    role,
    ...pools[role],
    zeroBefore: { count: 0, at: eligibleAt - 100 },
    scaleOut: { count: 1, at: eligibleAt + 100 },
    workerIdentity: `worker-${role}`,
    start: { at: eligibleAt + 200, instanceId: `instance-${role}`, workerIdentity: `worker-${role}` },
    scaleIn: { count: 0, at: eligibleAt + 500 },
    drain: { count: 0, at: eligibleAt + 600 },
  });
  const path = (role) => `_control/temporalWorkerWake-${releaseId}-${role}`;
  for (const [i, binding] of roleBindings.entries()) {
    const { role } = binding;
    f.docs.set(`_control/temporalWorkerCompute-${releaseId}-${role}`, {
      schemaVersion: 1,
      role,
      releaseId,
      state: {
        stage: 'completed',
        attemptedAt,
        observedAt: attemptedAt,
        outcome: 'native-acknowledgement-and-readback',
        plan: {
          operationId: id('a', i),
          releaseId,
          evidenceDigest,
          bindingSHA256: proofDigest(binding),
          computeSHA256: proofDigest(serverlessComputeSettings(binding)),
        },
      },
    });
    const operationId = id('b', i),
      runId = id('c', i),
      nonce = operationId.replaceAll('-', '');
    const workflowId = `worker-wake-${nonce}`;
    const input = { nonce, projectId: 'urm-app-staging', role, buildId, delayMs: 3000 };
    const eligibleAt = attemptedAt + 6000;
    f.docs.set(path(role), {
      schemaVersion: 1,
      role,
      releaseId,
      image: workerImage,
      buildId,
      evidenceDigest,
      state: {
        stage: 'completed',
        plan: {
          schemaVersion: 1,
          operationId,
          bindingDigest,
          releaseId,
          evidenceDigest,
          buildId,
          role,
          protectionSHA256: 'd'.repeat(64),
        },
        attempt: { workflowId, input, attemptedAt },
        run: { workflowId, runId, input },
        retryWait: { workflowId, runId, role, eligibleAt, observedAt: eligibleAt - 1000 },
        proof: {
          schemaVersion: 1,
          workflowId,
          runId,
          timer: wake('timer', 'orchestration', attemptedAt + 3000),
          retry: wake('retry', role, eligibleAt),
        },
      },
    });
  }
  const receipt = await f.readWakeReadiness(options);
  assert.match(receipt.wakeReceiptsSHA256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.retiredSHA256, 'c'.repeat(64));
  assert.deepEqual(await f.readWakeReadiness(options), receipt);
  // When the caller already owns a write transaction the reader must use its snapshot.
  await f.firestore.runTransaction(async (tx) => {
    const original = f.firestore.runTransaction;
    f.firestore.runTransaction = () => {
      throw new Error('Unexpected nested transaction');
    };
    try {
      assert.deepEqual(await f.readWakeReadiness(options, tx), receipt);
    } finally {
      f.firestore.runTransaction = original;
    }
  });

  const held = f.docs.get(path('media'));
  f.docs.delete(path('media'));
  await assert.rejects(f.readWakeReadiness(options), /UNCONFIRMED/);
  f.docs.set(path('media'), held);
  await assert.rejects(f.readWakeReadiness({ ...options, evidenceDigest: '1'.repeat(64) }), /UNCONFIRMED/);
  held.state.proof.retry.revisionUid = pools.email.revisionUid;
  await assert.rejects(f.readWakeReadiness(options), /UNCONFIRMED/);
  held.state.proof.retry.revisionUid = pools.media.revisionUid;
  assert.deepEqual(await f.readWakeReadiness(options), receipt);
  f.markChanged(path('media'));
  await assert.rejects(f.readWakeReadiness(options), /UNCONFIRMED/);
});

function injectCompetingLockUpdate(f) {
  const native = f.firestore.runTransaction.bind(f.firestore);
  f.firestore.runTransaction = async (callback, options) => {
    const result = await native(callback);
    if (!options?.readOnly) {
      assert.deepEqual(options, { maxAttempts: 1 });
      await native((tx) => tx.update(f.firestore.doc(lockPath), { unrelatedConcurrentWrite: true }));
    }
    return result;
  };
}

test('media promotion cannot adopt a foreign lock generation after persisting its own plan', async () => {
  const f = fixture('promote-cloud-run-media');
  injectCompetingLockUpdate(f);
  const firestore = f.firestore;
  const identityState = { stage: 'planned', plan: { role: 'media', operationId, releaseId } };
  await assert.rejects(
    saveMediaPromotionCheckpoint({
      firestore,
      identityState,
      operationId,
      bindingDigest,
      config: { ...f.config, domains: scopes },
      lockRef: firestore.doc(lockPath),
      controlRef: firestore.doc(controlPath),
      stateRef: firestore.doc(statePath),
      ownedOperation: nativeSnapshotProof(f.read(lockPath)),
      expectedAuthority: {
        control: nativeSnapshotProof(f.read(controlPath)),
        state: nativeSnapshotProof(f.read(statePath)),
      },
    }),
    /AUTHORITY_CHANGED/
  );
  assert.deepEqual(f.read(lockPath).get('cloudMediaPromotion'), identityState);
});

test('retirement cannot adopt a foreign same-document write after an acknowledged checkpoint', async () => {
  const f = fixture();
  injectCompetingLockUpdate(f);
  await assert.rejects(f.save(f.planned), /AUTHORITY_CHANGED/);
  assert.equal(f.read(lockPath).get('unrelatedConcurrentWrite'), true);
});

for (const outcome of ['committed', 'absent', 'changed lock', 'changed authority']) {
  test(`readiness intent loss reconciles only the same paused checkpoint: ${outcome}`, async () => {
    const f = fixture('workers-ready');
    const intent = { nonce: 'b'.repeat(32), workflowId: `serverless-readiness-${'b'.repeat(32)}` };
    const target = '/private/tmp/fixture';
    const transaction = f.firestore.runTransaction.bind(f.firestore);
    let attempted = 0;
    let observations = 0;
    f.firestore.runTransaction = async (callback, options) => {
      if (options?.readOnly) {
        observations++;
        return transaction(callback);
      }
      assert.deepEqual(options, { maxAttempts: 1 });
      attempted++;
      await transaction((tx) => callback(outcome === 'absent' ? { ...tx, update() {} } : tx));
      if (outcome === 'changed lock') {
        await transaction((tx) => tx.update(f.firestore.doc(lockPath), { concurrentChange: true }));
      }
      if (outcome === 'changed authority') f.markChanged(controlPath);
      throw Object.assign(new Error('injected commit ACK loss'), { code: 4 });
    };
    if (outcome === 'committed') {
      await assert.rejects(f.saveReadiness(intent, target), /WORKER_READINESS_INTENT_ACK_UNCONFIRMED/);
      assert.deepEqual(f.read(lockPath).get('cloudWorkerIntent'), { ...intent, artifactDirectory: target });
    } else {
      await assert.rejects(f.saveReadiness(intent, target), /UNCONFIRMED|AUTHORITY_CHANGED/);
    }
    assert.equal(attempted, 1);
    assert.equal(observations, 1);
  });
}
