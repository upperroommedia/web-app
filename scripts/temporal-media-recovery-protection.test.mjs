import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaPrivateInventoryFixture } from './tests/fixtures/media-private-inventory.mjs';
import { observeMediaRecoveryProtection } from './temporal-media-recovery-protection.mjs';
import { nativeSnapshotProof, proofDigest as hash } from './temporal-release-runtime.mjs';
function fixture() {
  const f = mediaPrivateInventoryFixture(),
    o = f.options,
    id = o.operationId,
    p = o.plan;
  p.bindingDigest = o.bindingDigest;
  p.createdAt = new Date().toISOString();
  p.expiresAt = Date.parse(p.createdAt) + 300000;
  p.diagnosticTemplate = { controlled: 'diag' };
  p.normalTemplate = { controlled: 'normal' };
  const before = { ...o.pool, desiredManualInstanceCount: 0, generation: '10', etag: 'before' };
  for (const key of [...f.docs.keys()]) if (key.startsWith('_control/temporalMediaRecovery')) f.docs.delete(key);
  const journal = { schemaVersion: 1, operationId: id, planSHA256: hash(p), buildId: p.buildId, image: p.image };
  f.docs.set(`_control/temporalMediaRecoveryJournal-${id}`, journal);
  const root = f.docs.get(o.lockRef.path);
  root.cloudMediaRecovery = {
    stage: 'prepared',
    plan: p,
    prepared: { proofSHA256: hash(journal) },
    diagnostic: { stage: 'completed', pool: before },
    start: {
      stage: 'acknowledged',
      attemptedAt: new Date().toISOString(),
      nativeOperation: 'projects/urm-app-staging/locations/us-central1/operations/start',
      plan: { key: 'start', operationId: id, before, templateSHA256: hash(p.diagnosticTemplate), target: 1 },
      request: {
        url: `https://run.googleapis.com/v2/${p.name}?updateMask=scaling`,
        method: 'PATCH',
        body: { name: p.name, etag: before.etag, scaling: { manualInstanceCount: 1 } },
      },
    },
  };
  root.mediaRecoveryJournalAttempt = { stage: 'completed', recordSHA256: hash(journal) };
  const names = [
    'Kernel',
    'Startup',
    'Start',
    'OriginalReady',
    'OriginalSignal',
    'OriginalDeath',
    'Work',
    'ReplacementIntent',
    'ReplacementKernel',
    'ReplacementStartup',
    'ReplacementAdoption',
    'ReplacementCompleted',
    'ReplacementStop',
  ];
  const workerId = '11111111-1111-4111-8111-111111111111';
  f.docs.set(`_control/temporalMediaRecoveryKernel-${id}`, {
    stage: 'running',
    context: { controlled: 'context' },
    intent: { controlled: 'intent' },
    birth: { controlled: 'birth' },
    worker: { instanceId: workerId, buildId: p.buildId },
  });
  f.docs.set(`_control/temporalMediaRecoveryStartup-${id}`, { controlled: 'startup' });
  const kernel = () => f.docs.get(`_control/temporalMediaRecoveryKernel-${id}`);
  const idle = () => ({
    schemaVersion: 1,
    kind: 'owned-idle-media-startup-v1',
    operationId: id,
    planSHA256: hash(p),
    buildId: p.buildId,
    ownFactsSHA256: hash(
      names.map((k) => {
        const x = f.snapshot(`_control/temporalMediaRecovery${k}-${id}`);
        return {
          exists: x.exists,
          data: x.data() ?? null,
          createTime: x.createTime ? { seconds: x.createTime.seconds, nanoseconds: x.createTime.nanoseconds } : null,
          updateTime: x.updateTime ? { seconds: x.updateTime.seconds, nanoseconds: x.updateTime.nanoseconds } : null,
        };
      })
    ),
    stage: kernel()?.stage ?? 'absent',
    allowedPollerIdentity:
      kernel()?.stage === 'running' && f.docs.has(`_control/temporalMediaRecoveryStartup-${id}`)
        ? `media-recovery-${kernel().worker.instanceId}`
        : null,
    originSHA256: kernel() ? hash({ context: kernel().context, intent: kernel().intent }) : null,
    birthSHA256: kernel()?.birth ? hash(kernel().birth) : null,
    workerSHA256: kernel()?.worker ? hash(kernel().worker) : null,
    observedAt: new Date().toISOString(),
    scope: 'identity-only-no-work-or-poll-authority',
  });
  let reads = 0;
  o.readIdle = async () => {
    reads++;
    return idle();
  };
  o.phase = 'start';
  o.pool = before;
  o.phasePool = {
    kind: 'private-media-phase-pool-v1',
    operationId: id,
    phase: 'start',
    planSHA256: hash(p),
    position: 'successor',
    observedAt: new Date().toISOString(),
  };
  o.ownedOperation = nativeSnapshotProof(f.snapshot(o.lockRef.path));
  const service = o.client.connection.workflowService;
  service.describeTaskQueue = async (request) => {
    f.calls.push(request);
    return {
      taskQueueStatus: { backlogCountHint: 0 },
      pollers: f.state.ownPollers
        ? [
            {
              identity: idle().allowedPollerIdentity,
              deploymentOptions: {
                deploymentName: p.contract.deploymentName,
                buildId: p.buildId,
                workerVersioningMode: 2,
              },
            },
          ]
        : [],
    };
  };
  return {
    ...f,
    idle,
    get readCount() {
      return reads;
    },
  };
}
test('exact authenticated idle pollers are separate from stable protected baseline', async () => {
  const f = fixture(),
    empty = await observeMediaRecoveryProtection(f.options);
  f.state.ownPollers = true;
  const own = await observeMediaRecoveryProtection(f.options);
  assert.equal(own.protectionSHA256, empty.protectionSHA256);
  assert.notEqual(own.ownedPollersSHA256, empty.ownedPollersSHA256);
  assert.equal(own.ownStartupSHA256, f.idle().ownFactsSHA256);
  assert(f.readCount >= 4);
});
for (const mode of [
  'foreign-identity',
  'foreign-build',
  'unversioned',
  'no-startup-identity',
  'private-work',
  'provider-lock',
  'source-intent',
  'stale-idle',
  'arming-drift',
])
  test(`phase namespace guard denies ${mode}`, async () => {
    const f = fixture(),
      o = f.options,
      service = o.client.connection.workflowService;
    if (['foreign-identity', 'foreign-build', 'unversioned'].includes(mode))
      service.describeTaskQueue = async () => ({
        taskQueueStatus: { backlogCountHint: 0 },
        pollers: [
          {
            identity: mode === 'foreign-identity' ? 'foreign' : f.idle().allowedPollerIdentity,
            deploymentOptions: {
              deploymentName: o.plan.contract.deploymentName,
              buildId: mode === 'foreign-build' ? 'f'.repeat(40) : o.plan.buildId,
              workerVersioningMode: mode === 'unversioned' ? 1 : 2,
            },
          },
        ],
      });
    if (mode === 'no-startup-identity') {
      f.state.ownPollers = true;
      o.readIdle = async () => ({ ...f.idle(), stage: 'born', allowedPollerIdentity: null });
    }
    if (mode === 'private-work') f.state.open = true;
    if (mode === 'provider-lock') f.rows.set('temporalProviderMutationLocks', [{ state: 'active' }]);
    if (mode === 'source-intent') f.docs.get(o.lockRef.path).mediaRecoveryWorkflowStart = { nonce: 'foreign' };
    if (mode === 'stale-idle')
      o.readIdle = async () => ({ ...f.idle(), observedAt: new Date(Date.now() - 6000).toISOString() });
    if (mode === 'arming-drift') f.docs.get(`_control/temporalMediaRecoveryJournal-${o.operationId}`).image = 'foreign';
    await assert.rejects(observeMediaRecoveryProtection(o), /PHASE_PROTECTION_UNCONFIRMED/);
  });
test('independent exact idle identity cannot be replaced between scans', async () => {
  const f = fixture();
  let calls = 0;
  f.options.readIdle = async () => ({ ...f.idle(), ...(++calls === 2 ? { workerSHA256: 'f'.repeat(64) } : {}) });
  await assert.rejects(observeMediaRecoveryProtection(f.options), /PHASE_PROTECTION_UNCONFIRMED/);
});
test('running identity requires current native Kernel and Startup records', async () => {
  const f = fixture(),
    identity = f.idle().allowedPollerIdentity;
  f.docs.delete(`_control/temporalMediaRecoveryKernel-${f.options.operationId}`);
  f.docs.delete(`_control/temporalMediaRecoveryStartup-${f.options.operationId}`);
  f.options.readIdle = async () => ({ ...f.idle(), stage: 'running', allowedPollerIdentity: identity });
  await assert.rejects(observeMediaRecoveryProtection(f.options), /PHASE_PROTECTION_UNCONFIRMED/);
});

for (const kind of [
  'pending-standalone',
  'started-standalone',
  'standalone-nexus',
  'partition-backlog',
  'unsupported-activity-list',
])
  test(`native no-work guard denies ${kind} without Workflow/Firestore record`, async () => {
    const f = fixture(),
      service = f.options.client.connection.workflowService;
    if (kind === 'pending-standalone' || kind === 'started-standalone')
      service.listActivityExecutions = async () => ({
        executions: [
          {
            activityId: 'external',
            runId: '22222222-2222-4222-8222-222222222222',
            status: 1,
            taskQueue: 'urm-media-kernel-recovery',
            pendingState: kind === 'pending-standalone' ? 1 : 2,
          },
        ],
      });
    if (kind === 'standalone-nexus')
      service.listNexusOperationExecutions = async () => ({ operations: [{ status: 1 }] });
    if (kind === 'partition-backlog')
      service.describeTaskQueue = async () => ({ pollers: [], taskQueueStatus: { backlogCountHint: 1 } });
    if (kind === 'unsupported-activity-list')
      service.listActivityExecutions = async () => {
        throw Object.assign(Error('unsupported'), { code: 12 });
      };
    await assert.rejects(observeMediaRecoveryProtection(f.options), /PHASE_PROTECTION_UNCONFIRMED/);
  });
function cleanupFixture(phase) {
  const f = fixture(),
    o = f.options,
    p = o.plan,
    id = o.operationId,
    root = f.docs.get(o.lockRef.path),
    cycle = root.cloudMediaRecovery;
  const started = { ...cycle.diagnostic.pool, desiredManualInstanceCount: 1, generation: '11', etag: 'eleven' };
  cycle.start = { ...cycle.start, stage: 'completed', pool: started };
  cycle.stage = 'drained';
  cycle.recovery = { kind: 'recovery' };
  const old = f.docs.get(`_control/temporalMediaRecoveryKernel-${id}`);
  old.stage = 'closed';
  old.close = { descendantsAbsent: true };
  f.docs.set(`_control/temporalMediaRecoveryReplacementKernel-${id}`, {
    ...structuredClone(old),
    worker: { ...old.worker, instanceId: '33333333-3333-4333-8333-333333333333' },
  });
  f.docs.set(`_control/temporalMediaRecoveryReplacementIntent-${id}`, { controlled: 'replacement' });
  const stamp = (k) => {
    const x = f.snapshot(`_control/temporalMediaRecovery${k}-${id}`);
    return hash({ data: x.data(), created: x.createTime, updated: x.updateTime });
  };
  const obs = {
    schemaVersion: 1,
    operationId: id,
    planSHA256: hash(p),
    poolSHA256: hash(started),
    namespace: 'urm-app-staging.qwejt',
    observedAt: new Date().toISOString(),
    closureSHA256: hash(['Kernel', 'ReplacementKernel', 'ReplacementIntent'].map(stamp)),
    protectionSHA256: 'd'.repeat(64),
    computeInventorySHA256: 'e'.repeat(64),
    versionCount: 2,
    partitionCount: 3,
  };
  cycle.drained = {
    kind: 'drained',
    operationId: id,
    bindingDigest: o.bindingDigest,
    buildId: p.buildId,
    image: p.image,
    proofSHA256: hash(obs),
    observation: obs,
  };
  f.docs.set(`_control/temporalMediaRecoveryDrain-${id}`, {
    schemaVersion: 1,
    operationId: id,
    releaseId: p.releaseId,
    bindingDigest: o.bindingDigest,
    planSHA256: hash(p),
    proof: cycle.drained,
  });
  o.phase = phase;
  o.pool = started;
  o.phasePool = { ...o.phasePool, phase, position: 'before' };
  if (phase !== 'stop') {
    const zero = { ...started, desiredManualInstanceCount: 0, generation: '12', etag: 'twelve' };
    cycle.stage = 'stopped';
    cycle.stop = { stage: 'completed', pool: zero };
    cycle.stopped = { kind: 'stopped' };
    o.pool = zero;
    if (phase === 'completed') {
      cycle.stage = 'completed';
      cycle.disposition = 'restored-normal-zero';
      cycle.restore = {
        stage: 'completed',
        nativeOperation: 'projects/urm-app-staging/locations/us-central1/operations/restore',
        pool: {
          ...zero,
          revision: zero.revision + '-normal',
          revisionUid: 'normal-new',
          generation: '13',
          etag: 'thirteen',
        },
      };
      o.pool = cycle.restore.pool;
      o.phasePool.position = 'exact';
    }
  }
  o.ownedOperation = nativeSnapshotProof(f.snapshot(o.lockRef.path));
  return f;
}
for (const phase of ['stop', 'restore', 'completed'])
  test(`cleanup ${phase} consumes immutable drainage and never grants idle pollers`, async () => {
    const f = cleanupFixture(phase),
      proof = await observeMediaRecoveryProtection(f.options);
    assert.equal(proof.phase, phase);
    assert.equal(proof.ownStartupSHA256, null);
    f.state.ownPollers = true;
    await assert.rejects(observeMediaRecoveryProtection(f.options), /PHASE_PROTECTION_UNCONFIRMED/);
    f.state.ownPollers = false;
    f.docs.delete(`_control/temporalMediaRecoveryDrain-${f.options.operationId}`);
    await assert.rejects(observeMediaRecoveryProtection(f.options), /PHASE_PROTECTION_UNCONFIRMED/);
  });
