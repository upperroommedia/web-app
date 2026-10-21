import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { restoredMediaProtectionFixture } from './tests/fixtures/restored-media-protection.mjs';
import { proofDigest as hash, nativeSnapshotProof } from './temporal-release-runtime.mjs';
import {
  observeRestoredMediaPhaseProtection,
  assertRestoredMediaStartupProgress,
} from './temporal-restored-media-protection.mjs';
function fixture() {
  const f = restoredMediaProtectionFixture(),
    old = f.options.plan,
    p = {
      ...old,
      operationId: randomUUID(),
      bindingDigest: f.options.bindingDigest,
      recoveryOperationId: old.operationId,
    };
  const root = f.docs.get(f.options.lockRef.path);
  root.operatorPrincipal = { adcAndGcloudAccountMatch: true };
  root.action = 'activate-restored-cloud-run-media';
  root.operationId = p.operationId;
  root.cloudRestoredMediaActivation = { plan: p, stage: 'starting' };
  const idle = {
    kind: 'restored-media-phase-startup-v1',
    operationId: p.operationId,
    planSHA256: hash(p),
    stage: 'absent',
    allowedPollerIdentity: null,
    originSHA256: null,
    birthSHA256: null,
    workerSHA256: null,
    ownFactsSHA256: 'a'.repeat(64),
    scope: 'identity-only-no-work-or-poll-authority',
    observedAt: new Date().toISOString(),
  };
  const o = {
    ...f.options,
    role: 'media',
    releaseId: p.releaseId,
    plan: p,
    operationId: p.operationId,
    recoveryOperationId: old.operationId,
    state: root.cloudRestoredMediaActivation,
    key: 'start',
    originalPlan: old,
    originalAuth: {},
    ownedOperation: nativeSnapshotProof(f.snapshot(f.options.lockRef.path)),
    phasePool: {
      kind: 'restored-media-phase-resource-v1',
      operationId: p.operationId,
      planSHA256: hash(p),
      key: 'start',
      position: 'before',
      provenanceSHA256: 'b'.repeat(64),
      observedAt: new Date().toISOString(),
    },
    readStartup: async () => ({ ...idle, observedAt: new Date().toISOString() }),
  };
  return { f, o, idle };
}
test('empty exact before phase protects namespace without owned poller exception', async () => {
  const { o } = fixture();
  const p = await observeRestoredMediaPhaseProtection(o);
  assert.equal(p.kind, 'restored-media-activation-phase-v1');
  assert.match(p.phaseSHA256, /^[a-f0-9]{64}$/);
  assert.match(p.computeSHA256, /^[a-f0-9]{64}$/);
});
test('authenticated post-ACK idle identity can only Activity poll; owned pollers excluded from stable baseline', async () => {
  const { f, o, idle } = fixture();
  o.phasePool.position = 'successor';
  idle.stage = 'running';
  idle.originSHA256 = 'c'.repeat(64);
  idle.birthSHA256 = 'd'.repeat(64);
  idle.workerSHA256 = 'e'.repeat(64);
  idle.allowedPollerIdentity = 'media-restored-' + randomUUID();
  const before = await observeRestoredMediaPhaseProtection(o);
  f.normal.identity = idle.allowedPollerIdentity;
  const after = await observeRestoredMediaPhaseProtection(o);
  assert.equal(before.phaseSHA256, after.phaseSHA256);
  assert.notEqual(before.ownedPollersSHA256, after.ownedPollersSHA256);
});
for (const [name, mutate] of [
  [
    'missing startup with owned poller',
    ({ f }) => {
      f.normal.identity = 'media-restored-' + randomUUID();
    },
  ],
  [
    'standalone Nexus unsupported',
    ({ o }) => {
      o.client.connection.workflowService.listNexusOperationExecutions = async () => {
        throw Object.assign(Error('unsupported'), { code: 12 });
      };
    },
  ],
  [
    'standalone Activity work',
    ({ o }) => {
      o.client.connection.workflowService.listActivityExecutions = async () => ({ executions: [{}] });
    },
  ],
  [
    'pending workflow work',
    ({ f }) => {
      f.state.open = true;
    },
  ],
  [
    'provider lock',
    ({ f }) => {
      f.rows.set('temporalProviderMutationLocks', [{ state: 'held' }]);
    },
  ],
  [
    'unknown provider session',
    ({ f }) => {
      f.rows.set('temporalProviderMutationSessions', [{ state: 'unknown' }]);
    },
  ],
  [
    'normal version backlog',
    ({ f }) => {
      f.normal.normalBacklog = 1;
    },
  ],
  [
    'before resource with existing birth',
    ({ idle }) => {
      idle.stage = 'armed';
    },
  ],
  [
    'regressing own startup',
    ({ o, idle }) => {
      o.phasePool.position = 'successor';
      let count = 0;
      o.readStartup = async () => ({
        ...idle,
        stage: ++count === 1 ? 'born' : 'armed',
        observedAt: new Date().toISOString(),
      });
    },
  ],
  [
    'foreign current authority',
    ({ f }) => {
      f.docs.get(f.options.controlRef.path).admission = 'open';
    },
  ],
])
  test(name + ' denies', async () => {
    const x = fixture();
    mutate(x);
    await assert.rejects(observeRestoredMediaPhaseProtection(x.o));
  });
test('cleanup closed-without-capacity carries no identity and protects all work', async () => {
  const { o, idle } = fixture();
  o.key = 'stop';
  o.phasePool.key = 'stop';
  o.phasePool.position = 'exact';
  idle.stage = 'closed';
  idle.originSHA256 = 'c'.repeat(64);
  idle.birthSHA256 = 'd'.repeat(64);
  idle.workerSHA256 = 'e'.repeat(64);
  assert.equal((await observeRestoredMediaPhaseProtection(o)).key, 'stop');
});
test('unknown incomplete startup never permits unused stop', async () => {
  const { o, idle } = fixture();
  o.key = 'stop';
  o.phasePool.key = 'stop';
  o.phasePool.position = 'exact';
  for (const stage of ['absent', 'armed', 'born', 'running']) {
    idle.stage = stage;
    await assert.rejects(observeRestoredMediaPhaseProtection(o));
  }
});
test('startup hashes cannot change after birth', () => {
  const a = { stage: 'born', originSHA256: 'a', birthSHA256: 'b' };
  assert.throws(() => assertRestoredMediaStartupProgress(a, { ...a, stage: 'running', birthSHA256: 'foreign' }));
});

test('owned closure is monotonic, drops polling identity and then remains immutable', () => {
  const a = {
    stage: 'running',
    originSHA256: 'a',
    birthSHA256: 'b',
    workerSHA256: 'c',
    allowedPollerIdentity: 'owned',
    ownFactsSHA256: 'before',
  };
  const b = { ...a, stage: 'closed', allowedPollerIdentity: null, ownFactsSHA256: 'closed' };
  assert.doesNotThrow(() => assertRestoredMediaStartupProgress(a, b));
  assert.throws(() => assertRestoredMediaStartupProgress(b, { ...b, ownFactsSHA256: 'rewritten' }));
});

test('candidate Activity registration may appear with authenticated startup without changing original baseline', async () => {
  const { f, o, idle } = fixture();
  o.phasePool.position = 'successor';
  f.normal.registered = false;
  let reads = 0;
  o.readStartup = async () => {
    const ready = ++reads > 1;
    if (ready) f.normal.registered = true;
    return {
      ...idle,
      stage: ready ? 'running' : 'born',
      originSHA256: 'a',
      birthSHA256: 'b',
      workerSHA256: ready ? 'c' : null,
      allowedPollerIdentity: ready ? 'media-restored-' + o.operationId : null,
      observedAt: new Date().toISOString(),
    };
  };
  assert.equal((await observeRestoredMediaPhaseProtection(o)).key, 'start');
});
