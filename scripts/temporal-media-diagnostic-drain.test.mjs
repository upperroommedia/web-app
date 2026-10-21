import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  observeMediaDiagnosticDrain,
  observeMediaDiagnosticStopped,
  observeMediaDiagnosticNeverStarted,
  waitForMediaDiagnosticDrain,
  assertStoredMediaDiagnosticDrain,
} from './temporal-media-diagnostic-drain.mjs';
import { nativeSnapshotProof, proofDigest as hash } from './temporal-release-runtime.mjs';
const require = createRequire(import.meta.url),
  { Timestamp } = require('firebase-admin/firestore');
function fixture() {
  const id = randomUUID(),
    buildId = 'a'.repeat(40),
    oldBuild = 'b'.repeat(40),
    releaseId = randomUUID(),
    namespace = 'urm-app-staging.qwejt',
    deploymentName = 'urm-worker-media-recovery-staging',
    queue = 'urm-media-kernel-recovery';
  const plan = {
      operationId: id,
      role: 'media',
      releaseId,
      buildId,
      name: 'projects/urm-app-staging/locations/us-central1/workerPools/owned',
      image: `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'c'.repeat(64)}`,
      runner: 'owned@urm-app-staging.iam.gserviceaccount.com',
      contract: { deploymentName, queue },
    },
    pool = { desiredManualInstanceCount: 1, revision: `${plan.name}/revisions/owned`, revisionUid: 'owned-uid' };
  const cloudRun = {
      projectId: 'urm-app-staging',
      region: 'us-central1',
      pool: 'owned',
      revision: 'owned',
      revisionUid: 'owned-uid',
      imageDigest: plan.image.split('@')[1],
      serviceAccount: plan.runner,
      instanceId: 'same-container',
    },
    parent = { instanceId: randomUUID(), buildId, cloudRun };
  const docs = new Map(),
    rows = new Map(),
    calls = [];
  const state = { pendingPolls: 0, missingPollers: false, extraQueue: false, open: false };
  const add = (path, value) => docs.set(path, value),
    control = {
      releaseId,
      admission: 'paused',
      domains: Object.fromEntries(
        ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((k) => [
          k,
          { admission: 'paused' },
        ])
      ),
    };
  add('_control/temporalReleaseOperation', {
    action: 'diagnose-cloud-run-media-recovery',
    operationId: id,
    releaseId,
    bindingDigest: 'd'.repeat(64),
    cloudMediaRecovery: {
      stage: 'recovered',
      plan,
      start: { stage: 'completed', pool },
      recovery: { proofSHA256: 'e'.repeat(64) },
    },
  });
  add('_control/temporalRelease', control);
  add('_control/temporalReleaseState', { releaseId, phase: 'provider-usage-ready' });
  for (const k of ['Kernel', 'ReplacementKernel'])
    add(`_control/temporalMediaRecovery${k}-${id}`, {
      schemaVersion: 1,
      stage: 'closed',
      context: { operationId: id, intentSHA256: 'f'.repeat(64), parent },
      worker: { instanceId: randomUUID(), buildId, cloudRun },
      close: { code: 0, signal: k === 'Kernel' ? 'SIGKILL' : null, descendantsAbsent: true },
    });
  add(`_control/temporalMediaRecoveryReplacementIntent-${id}`, {});
  const snapshot = (path) => ({
    exists: docs.has(path),
    ref: { path },
    data: () => docs.get(path),
    get: (p) => p.split('.').reduce((a, k) => a?.[k], docs.get(path)),
    createTime: new Timestamp(1, 0),
    updateTime: new Timestamp(1, 0),
  });
  const db = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    doc: (path) => ({ path }),
    runTransaction: async (fn) => fn({ get: async (r) => snapshot(r.path) }),
    collection: (name) => {
      const q = {
        orderBy: () => q,
        limit: () => q,
        startAfter: () => q,
        get: async () => {
          const ds = (rows.get(name) ?? []).map((v, i) => {
            const path = `${name}/${i}`;
            add(path, v);
            return snapshot(path);
          });
          return { docs: ds, size: ds.length };
        },
      };
      return q;
    },
  };
  const service = {
    listWorkerDeployments: async () => ({ workerDeployments: [{ name: deploymentName }] }),
    describeWorkerDeployment: async () => ({
      workerDeploymentInfo: {
        name: deploymentName,
        routingConfig: {},
        versionSummaries: [buildId, oldBuild].map((buildId) => ({ deploymentVersion: { deploymentName, buildId } })),
      },
    }),
    describeWorkerDeploymentVersion: async (r) => ({
      workerDeploymentVersionInfo: {
        deploymentVersion: r.deploymentVersion,
        taskQueueInfos: [1, 2].map((type) => ({ name: queue, type })),
        computeConfig: null,
      },
      versionTaskQueues: [1, 2].map((type) => ({ name: queue, type, stats: { approximateBacklogCount: 0 } })),
    }),
    listTaskQueuePartitions: async (r) => {
      assert.deepEqual(r.taskQueue, { name: queue, kind: 1 });
      return {
        workflowTaskQueuePartitions: [{ key: queue }, { key: `/_sys/${queue}/1` }],
        activityTaskQueuePartitions: [{ key: queue }],
      };
    },
    describeTaskQueue: async (r) => {
      calls.push(r);
      return state.missingPollers
        ? {}
        : {
            pollers:
              state.pendingPolls-- > 0
                ? [{ identity: 'older-version', deploymentOptions: { deploymentName, buildId: oldBuild } }]
                : [],
          };
    },
    listWorkflowExecutions: async () => ({
      executions: state.open ? [{ execution: { workflowId: 'external', runId: id } }] : [],
    }),
    describeWorkflowExecution: async () => ({
      workflowExecutionInfo: {
        execution: { workflowId: 'external', runId: id },
        status: 1,
        taskQueue: 'unrelated',
        versioningInfo: { behavior: 1, deploymentVersion: { deploymentName: 'old', buildId: oldBuild } },
      },
      pendingActivities: [{ activityId: 'private-work' }],
    }),
  };
  const client = {
    options: { namespace },
    connection: { workflowService: service, withDeadline: async (_d, fn) => fn() },
  };
  const lockRef = db.doc('_control/temporalReleaseOperation'),
    controlRef = db.doc('_control/temporalRelease'),
    stateRef = db.doc('_control/temporalReleaseState');
  return {
    docs,
    snapshot,
    rows,
    calls,
    state,
    options: {
      client,
      firestore: db,
      plan,
      pool,
      operationId: id,
      bindingDigest: 'd'.repeat(64),
      lockRef,
      controlRef,
      stateRef,
      ownedOperation: nativeSnapshotProof(snapshot(lockRef.path)),
      expectedAuthority: {
        control: nativeSnapshotProof(snapshot(controlRef.path)),
        state: nativeSnapshotProof(snapshot(stateRef.path)),
      },
    },
  };
}
test('all-version drain covers both types and every partition without replacing original authority', async () => {
  const f = fixture(),
    before = hash([...f.docs]);
  const p = await observeMediaDiagnosticDrain(f.options);
  assert.equal(p.versionCount, 2);
  assert.equal(p.partitionCount, 3);
  assert.equal(hash([...f.docs]), before);
  assertStoredMediaDiagnosticDrain(p, f.options.plan, f.options.pool);
  assert(f.calls.some((c) => c.taskQueue.name.startsWith('/_sys/')));
});
for (const mode of [
  'poller',
  'missing-pollers',
  'external-private-activity',
  'lease',
  'unknown-command',
  'unknown-session',
  'active-session',
  'foreign-parent',
])
  test(`native drain policy denies ${mode}`, async () => {
    const f = fixture();
    if (mode === 'poller') f.state.pendingPolls = 1;
    if (mode === 'missing-pollers') f.state.missingPollers = true;
    if (mode === 'external-private-activity') f.state.open = true;
    if (mode === 'lease')
      f.rows.set('durableJobOutbox', [{ state: 'dispatched', leaseOwner: 'unknown', leaseExpiresAt: 1 }]);
    if (mode === 'unknown-command') f.rows.set('durableJobCommands', [{ state: 'unknown' }]);
    if (mode === 'active-session') f.rows.set('temporalProviderMutationSessions', [{ state: 'active' }]);
    if (mode === 'unknown-session') f.rows.set('temporalProviderMutationSessions', [{ state: 'unknown' }]);
    if (mode === 'foreign-parent')
      f.docs.get(`_control/temporalMediaRecoveryReplacementKernel-${f.options.operationId}`).context.parent = {
        ...f.docs.get(`_control/temporalMediaRecoveryKernel-${f.options.operationId}`).context.parent,
        instanceId: randomUUID(),
      };
    await assert.rejects(observeMediaDiagnosticDrain(f.options), /DRAIN_UNCONFIRMED|POLLERS_PRESENT/);
  });
test('GET-only native poller pending condition is actually retried until empty', async () => {
  const f = fixture();
  f.state.pendingPolls = 2;
  const p = await waitForMediaDiagnosticDrain(f.options);
  assert.equal(p.versionCount, 2);
  assert(f.calls.length > 3);
});

test('known committed and aborted sessions permit drain without changing history', async () => {
  const f = fixture();
  f.rows.set('temporalProviderMutationSessions', [{ state: 'committed' }, { state: 'aborted' }]);
  assert.equal((await observeMediaDiagnosticDrain(f.options)).versionCount, 2);
});

function stoppedFixture() {
  const f = fixture(),
    id = f.options.operationId,
    p = f.docs.get('_control/temporalReleaseOperation'),
    cycle = p.cloudMediaRecovery;
  cycle.start.pool.generation = '10';
  cycle.start.pool.etag = 'old-etag';
  const observation = {
    schemaVersion: 1,
    operationId: id,
    planSHA256: hash(f.options.plan),
    poolSHA256: hash(cycle.start.pool),
    namespace: 'urm-app-staging.qwejt',
    observedAt: new Date().toISOString(),
    closureSHA256: 'a'.repeat(64),
    protectionSHA256: 'b'.repeat(64),
    computeInventorySHA256: 'c'.repeat(64),
    versionCount: 2,
    partitionCount: 3,
  };
  cycle.drained = {
    kind: 'drained',
    operationId: id,
    bindingDigest: f.options.bindingDigest,
    buildId: f.options.plan.buildId,
    image: f.options.plan.image,
    proofSHA256: hash(observation),
    observation,
  };
  cycle.stage = 'drained';
  cycle.stop = {
    stage: 'completed',
    pool: { ...cycle.start.pool, desiredManualInstanceCount: 0, generation: '11', etag: 'new-etag' },
  };
  f.options.pool = cycle.stop.pool;
  f.docs.set(`_control/temporalMediaRecoveryDrain-${id}`, {
    schemaVersion: 1,
    operationId: id,
    releaseId: f.options.plan.releaseId,
    bindingDigest: f.options.bindingDigest,
    planSHA256: hash(f.options.plan),
    proof: cycle.drained,
  });
  f.options.ownedOperation = nativeSnapshotProof(f.snapshot(f.options.lockRef.path));
  return f;
}
function neverStartedFixture() {
  const f = fixture(),
    cycle = f.docs.get('_control/temporalReleaseOperation').cloudMediaRecovery;
  for (const key of [...f.docs.keys()]) if (key.startsWith('_control/temporalMediaRecovery')) f.docs.delete(key);
  cycle.stage = 'prepared';
  delete cycle.start;
  delete cycle.recovery;
  f.options.pool = { ...f.options.pool, desiredManualInstanceCount: 0 };
  cycle.diagnostic = { stage: 'completed', pool: f.options.pool };
  f.options.ownedOperation = nativeSnapshotProof(f.snapshot(f.options.lockRef.path));
  return f;
}
test('stopped observation requires immutable original drain and exact zero scaling successor', async () => {
  const f = stoppedFixture();
  assert.equal((await observeMediaDiagnosticStopped(f.options)).poolSHA256, hash(f.options.pool));
  f.docs.delete(`_control/temporalMediaRecoveryDrain-${f.options.operationId}`);
  await assert.rejects(observeMediaDiagnosticStopped(f.options), /STOP_UNCONFIRMED/);
});
for (const mode of ['running-kernel', 'wrong-generation', 'changed-revision', 'poller', 'pending-work'])
  test(`stopped confirmation denies ${mode}`, async () => {
    const f = stoppedFixture();
    if (mode === 'running-kernel')
      f.docs.get(`_control/temporalMediaRecoveryKernel-${f.options.operationId}`).stage = 'running';
    if (mode === 'wrong-generation') f.options.pool.generation = '12';
    if (mode === 'changed-revision') f.options.pool.revisionUid = 'foreign';
    if (mode === 'poller') f.state.pendingPolls = 1;
    if (mode === 'pending-work') f.state.open = true;
    await assert.rejects(observeMediaDiagnosticStopped(f.options), /STOP_UNCONFIRMED/);
  });
test('never-started requires no owned execution intent/facts and definite native absence', async () => {
  const f = neverStartedFixture();
  f.options.client.connection.workflowService.describeWorkerDeployment = async () => {
    throw Object.assign(new Error('not found'), { code: 5 });
  };
  f.options.client.connection.workflowService.listWorkerDeployments = async () => ({ workerDeployments: [] });
  assert.equal((await observeMediaDiagnosticNeverStarted(f.options)).versionCount, 0);
  f.docs.set(`_control/temporalMediaRecoveryStartup-${f.options.operationId}`, { stage: 'attempted' });
  await assert.rejects(observeMediaDiagnosticNeverStarted(f.options), /NEVER_STARTED_UNCONFIRMED/);
});
for (const mode of ['unknown-start', 'start-intent', 'work', 'ambiguous-absence', 'private-open', 'poller'])
  test(`never-started denies ${mode}`, async () => {
    const f = neverStartedFixture(),
      p = f.docs.get('_control/temporalReleaseOperation');
    if (mode === 'unknown-start') p.cloudMediaRecovery.start = { stage: 'attempted' };
    if (mode === 'start-intent') p.mediaRecoveryWorkflowStart = { nonce: 'unknown' };
    if (mode === 'work') f.docs.set(`_control/temporalMediaRecoveryWork-${f.options.operationId}`, {});
    if (mode === 'ambiguous-absence')
      f.options.client.connection.workflowService.describeWorkerDeployment = async () => {
        throw Object.assign(new Error('unknown'), { code: 14 });
      };
    if (mode === 'private-open') f.state.open = true;
    if (mode === 'poller') f.state.pendingPolls = 1;
    await assert.rejects(observeMediaDiagnosticNeverStarted(f.options), /NEVER_STARTED_UNCONFIRMED/);
  });
