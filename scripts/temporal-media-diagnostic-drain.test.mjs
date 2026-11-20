import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { scanPrivateMediaInventory } from './temporal-media-private-inventory.mjs';
import { mediaPrivateInventoryFixture as fixture } from './tests/fixtures/media-private-inventory.mjs';
import {
  observeMediaDiagnosticDrain,
  observeMediaDiagnosticStopped,
  observeMediaDiagnosticStopEvents,
  observeMediaDiagnosticNeverStarted,
  waitForMediaDiagnosticDrain,
  assertStoredMediaDiagnosticDrain,
} from './temporal-media-diagnostic-drain.mjs';
import { nativeSnapshotProof, proofDigest as hash } from './temporal-release-runtime.mjs';
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

test('the read-only waiter can reconcile poller history beyond the former 45-second timeout', async (t) => {
  const f = fixture(),
    began = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: began });
  const original = f.options.client.connection.workflowService.describeTaskQueue;
  f.state.pendingPolls = 1;
  f.options.client.connection.workflowService.describeTaskQueue = (...args) => {
    const result = original(...args);
    if (f.state.pendingPolls === 0) {
      // Advance across the old wait deadline after the poller-pending scan rejects.
      setImmediate(() => t.mock.timers.setTime(began + 46000));
    }
    return result;
  };
  const observation = await waitForMediaDiagnosticDrain(f.options);
  assert.ok(Date.parse(observation.observedAt) - began > 45000);
  assertStoredMediaDiagnosticDrain(observation, f.options.plan, f.options.pool);
});

test('known committed and aborted sessions permit drain without changing history', async () => {
  const f = fixture();
  f.rows.set('temporalProviderMutationSessions', [{ state: 'committed' }, { state: 'aborted' }]);
  assert.equal((await observeMediaDiagnosticDrain(f.options)).versionCount, 2);
});

function indexedJobFixture() {
  const f = fixture();
  const { client, firestore: db, plan, operationId } = f.options;
  const readField = (doc, field) => field.split('.').reduce((value, part) => value?.[part], doc);
  const query = (collection, matches = () => true, limit = undefined, aggregate = false) => ({
    where: (field, op, value) =>
      query(
        collection,
        (doc) =>
          matches(doc) && (op === 'in' ? value.includes(readField(doc, field)) : readField(doc, field) === value),
        limit,
        aggregate
      ),
    limit: (size) => query(collection, matches, size, aggregate),
    count: () => query(collection, matches, limit, true),
    read: () => {
      const values = (f.rows.get(collection) ?? [])
        .map((doc, index) => ({ doc, index }))
        .filter(({ doc }) => matches(doc))
        .slice(0, limit);
      if (aggregate) return { data: () => ({ count: values.length }) };
      assert.equal(limit, 2, 'indexed candidate queries must stay bounded');
      return {
        size: values.length,
        docs: values.map(({ doc, index }) => {
          const path = `${collection}/${index}`;
          f.docs.set(path, doc);
          return f.snapshot(path);
        }),
      };
    },
  });
  const native = {
    projectId: db.projectId,
    databaseId: db.databaseId,
    doc: db.doc,
    collection: query,
    runTransaction: (fn, options) => {
      assert.deepEqual(options, { readOnly: true });
      return fn({ get: async (ref) => (ref.read ? ref.read() : f.snapshot(ref.path)) });
    },
  };
  const ready = { workflowId: 'original-workflow', runId: randomUUID(), activityId: 'original-activity' };
  const worker = { instanceId: randomUUID(), buildId: plan.buildId };
  const candidate = {
    ...ready,
    worker,
    projectId: 'urm-app-staging',
    jobId: `media-recovery-${operationId}`,
    activityType: 'acquireMedia',
    attempt: 2,
  };
  const observed = () =>
    scanPrivateMediaInventory({
      client,
      db: native,
      plan: { ...plan, job: {} },
      operationId,
      read: (fn) => fn(),
      rpc: (fn) => fn(),
      auth: { ready, worker },
    });
  return { ...f, candidate, observed };
}

test('finite Job inventory counts all terminal historical receipts and joins only its authorized Activity', async () => {
  const f = indexedJobFixture();
  f.rows.set(
    'durableJobOutbox',
    Array.from({ length: 4204 }, () => ({
      state: 'dispatched',
      leaseExpiresAt: 0,
      leaseOwner: 'retained-historical-owner',
    }))
  );
  f.rows.set('durableActivityExecutions', [f.candidate]);
  const result = await f.observed();
  assert.equal(result.jobWork.candidateRows.length, 1);
  assert.match(result.jobWork.idleSHA256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.rows, []);
});

for (const [name, mutate] of [
  ['live lease', (f) => f.rows.set('durableJobOutbox', [{ state: 'dispatched', leaseExpiresAt: 1 }])],
  ['active provider session', (f) => f.rows.set('temporalProviderMutationSessions', [{ state: 'active' }])],
  [
    'foreign candidate by nested build',
    (f) =>
      f.rows.set('durableJobCommands', [
        { state: 'dispatched', leaseExpiresAt: 0, execution: { worker: f.candidate.worker } },
      ]),
  ],
  ['duplicate candidate activity', (f) => f.rows.set('durableActivityExecutions', [f.candidate, f.candidate])],
]) {
  test('finite Job inventory rejects ' + name, async () => {
    const f = indexedJobFixture();
    mutate(f);
    await assert.rejects(f.observed(), /UNCONFIRMED/);
  });
}

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
function stopEventsFixture() {
  const f = stoppedFixture(),
    id = f.options.operationId,
    root = f.docs.get('_control/temporalReleaseOperation'),
    cycle = root.cloudMediaRecovery,
    kernel = f.docs.get(`_control/temporalMediaRecoveryKernel-${id}`),
    now = Date.now();
  cycle.start.attemptedAt = new Date(now - 5000).toISOString();
  cycle.stop.attemptedAt = new Date(now - 1000).toISOString();
  cycle.stop.nativeOperation = 'projects/urm-app-staging/locations/us-central1/operations/owned-stop';
  kernel.intent = { launchId: randomUUID() };
  kernel.birth = { nonce: randomUUID(), pid: 100 };
  const { context, intent, birth, worker } = kernel;
  const startup = {
    schemaVersion: 1,
    kind: 'private-diagnostic-startup-only-no-recovery-proof',
    operationId: id,
    intentSHA256: context.intentSHA256,
    worker,
    kernel: { operationId: id, birthDigest: hash({ context, intent, birth, worker }) },
    observedAt: new Date(now - 4000).toISOString(),
  };
  const startupPath = `_control/temporalMediaRecoveryStartup-${id}`;
  f.docs.set(startupPath, startup);
  f.options.ownedOperation = nativeSnapshotProof(f.snapshot(f.options.lockRef.path));
  const { pool, revision, revisionUid } = worker.cloudRun;
  const providerInstance = 'original-provider-instance';
  const providerBase = {
    labels: { instanceId: providerInstance },
    resource: {
      type: 'cloud_run_worker_pool',
      labels: {
        project_id: 'urm-app-staging',
        location: 'us-central1',
        worker_pool_name: pool,
        revision_name: revision,
      },
    },
  };
  const startLog = {
    ...providerBase,
    logName: 'projects/urm-app-staging/logs/run.googleapis.com%2Fstdout',
    timestamp: startup.observedAt,
    insertId: 'original-startup',
    jsonPayload: {
      event: 'temporal_media_recovery_worker_started',
      workerIdentity: `media-recovery-${worker.instanceId}`,
      pool,
      revision,
      revisionUid,
      buildId: cycle.plan.buildId,
      taskQueue: cycle.plan.contract.queue,
      operationId: id,
      child: 'original',
      startupSHA256: hash(startup),
    },
  };
  const systemLog = {
    ...providerBase,
    logName: 'projects/urm-app-staging/logs/run.googleapis.com%2Fvarlog%2Fsystem',
    timestamp: new Date(now - 500).toISOString(),
    insertId: 'original-stop',
    textPayload: 'Instance shutting down',
  };
  return { ...f, cycle, startupPath, startLog, systemLog, providerInstance };
}
test('owned stop collects exact original provider logs before restoration and makes no exit claim', async () => {
  const f = stopEventsFixture(),
    requests = [];
  f.options.api = async (url, method, body) => {
    const endpoint = new URL(url);
    if (endpoint.hostname === 'monitoring.googleapis.com') {
      assert.equal(method, undefined);
      assert.match(endpoint.searchParams.get('filter'), /instance_count/);
      return {
        timeSeries: [
          {
            resource: f.startLog.resource,
            metric: { type: 'run.googleapis.com/container/instance_count', labels: { state: 'active' } },
            metricKind: 'GAUGE',
            valueType: 'INT64',
            points: [
              { interval: { endTime: f.systemLog.timestamp }, value: { int64Value: '0' } },
              { interval: { endTime: f.startLog.timestamp }, value: { int64Value: '1' } },
            ],
          },
        ],
      };
    }
    assert.equal(url, 'https://logging.googleapis.com/v2/entries:list');
    assert.equal(method, 'POST');
    requests.push(body.filter);
    return { entries: [requests.length === 1 ? f.startLog : f.systemLog] };
  };
  const result = await observeMediaDiagnosticStopEvents(f.options);
  assert.equal(result.stopObservation.startup.instanceId, f.providerInstance);
  assert.equal(result.stopObservation.events.length, 1);
  assert.equal(result.stopObservation.events[0].lifecycleText, true);
  assert.deepEqual(result.stopObservation.instanceCounts, [
    { at: Date.parse(f.startLog.timestamp), count: 1 },
    { at: Date.parse(f.systemLog.timestamp), count: 0 },
  ]);
  assert.equal(Object.hasOwn(result, 'kind'), false);
  assert.ok(requests[1].includes(`labels.instanceId = "${f.providerInstance}"`));
  assert.ok(requests[1].includes(f.cycle.stop.attemptedAt));
  assert.equal(f.cycle.restore, undefined);
});
for (const mode of ['missing-startup', 'foreign-system-label', 'startup-drift-during-provider-read', 'restoring'])
  test(`owned stop log observation denies ${mode}`, async () => {
    const f = stopEventsFixture();
    if (mode === 'missing-startup') f.docs.delete(f.startupPath);
    if (mode === 'restoring') {
      f.cycle.restore = { stage: 'attempted' };
      f.options.ownedOperation = nativeSnapshotProof(f.snapshot(f.options.lockRef.path));
    }
    f.options.api = async (_url, _method, body) => {
      if (typeof body?.filter !== 'string') return {};
      if (body.filter.includes('temporal_media_recovery_worker_started')) return { entries: [f.startLog] };
      if (mode === 'startup-drift-during-provider-read') f.docs.get(f.startupPath).observedAt = 'foreign';
      if (mode === 'foreign-system-label') f.systemLog.labels = { instanceId: 'foreign' };
      return { entries: [f.systemLog] };
    };
    await assert.rejects(observeMediaDiagnosticStopEvents(f.options), /UNCONFIRMED/);
  });

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
