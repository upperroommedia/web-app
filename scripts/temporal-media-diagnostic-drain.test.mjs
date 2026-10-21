import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mediaPrivateInventoryFixture as fixture } from './tests/fixtures/media-private-inventory.mjs';
import {
  observeMediaDiagnosticDrain,
  observeMediaDiagnosticStopped,
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
