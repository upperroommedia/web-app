import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mediaRecoveryFixture } from './tests/fixtures/media-recovery.mjs';
import { runMediaRecoveryCycle } from './temporal-media-recovery-cycle.mjs';
import { observeMediaRecoveryPhasePool } from './temporal-media-recovery-phase-pool.mjs';
import { nativeSnapshotProof } from './temporal-release-runtime.mjs';
const require = createRequire(import.meta.url),
  { Timestamp } = require('firebase-admin/firestore');
function nativeOptions(f, scope, transform = () => {}) {
  const values = new Map(),
    releaseId = f.options.releaseId;
  const lockRef = { path: '_control/temporalReleaseOperation' },
    controlRef = { path: '_control/temporalRelease' },
    stateRef = { path: '_control/temporalReleaseState' };
  values.set(lockRef.path, {
    operationId: f.options.operationId,
    bindingDigest: f.options.bindingDigest,
    releaseId,
    action: 'diagnose-cloud-run-media-recovery',
    cloudMediaRecovery: f.saved,
  });
  values.set(controlRef.path, {
    releaseId,
    admission: 'paused',
    domains: Object.fromEntries(
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
        d,
        { admission: 'paused' },
      ])
    ),
  });
  values.set(stateRef.path, { releaseId, phase: 'provider-usage-ready' });
  const snapshot = (r) => ({
    exists: true,
    ref: r,
    createTime: new Timestamp(1, 0),
    updateTime: new Timestamp(1, 0),
    data: () => values.get(r.path),
    get: (k) => k.split('.').reduce((a, k) => a?.[k], values.get(r.path)),
  });
  let calls = 0;
  const firestore = {
    runTransaction: async (fn) => {
      transform(++calls, values);
      return fn({ get: async (r) => snapshot(r) });
    },
  };
  return {
    ...f.options,
    ...scope,
    firestore,
    lockRef,
    controlRef,
    stateRef,
    config: { releaseId },
    ownedOperation: nativeSnapshotProof(snapshot(lockRef)),
    expectedAuthority: {
      control: nativeSnapshotProof(snapshot(controlRef)),
      state: nativeSnapshotProof(snapshot(stateRef)),
    },
  };
}
test('actual phase resource fence follows source-saved before and known successor through all four transitions', async () => {
  const f = await mediaRecoveryFixture(),
    base = f.options.observeProtection,
    seen = [];
  f.options.observeProtection = async (scope) => {
    const observation = await observeMediaRecoveryPhasePool(nativeOptions(f, scope));
    seen.push(observation);
    return base(scope);
  };
  const completed = await runMediaRecoveryCycle(f.options);
  assert(seen.some((x) => x.position === 'before'));
  assert(seen.some((x) => x.position === 'successor'));
  assert.deepEqual([...new Set(seen.map((x) => x.phase))], ['diagnostic', 'start', 'stop', 'restore']);
  const p = await observeMediaRecoveryPhasePool(
    nativeOptions(f, { plan: completed.plan, phase: 'completed', pool: completed.restore.pool })
  );
  assert.equal(p.position, 'exact');
  assert.equal(p.readOnly, true);
});
for (const phase of ['diagnostic', 'start', 'stop', 'restore'])
  test(`unknown ${phase} ACK cannot adopt observed successor`, async () => {
    const f = await mediaRecoveryFixture(),
      api = f.options.api;
    f.options.api = async (...args) => {
      const v = await api(...args);
      if (args[1] === 'PATCH' && f.calls.at(-1).key === phase) throw Error('controlled lostACK');
      return v;
    };
    await assert.rejects(runMediaRecoveryCycle(f.options));
    assert.equal(f.saved[phase].stage, 'attempted');
    await assert.rejects(
      observeMediaRecoveryPhasePool(nativeOptions(f, { plan: f.saved.plan, phase, pool: f.saved[phase].plan.before })),
      /PHASE_POOL_UNCONFIRMED/
    );
  });
test('source phase is derived from native parent, not a caller-provided label', async () => {
  const f = await mediaRecoveryFixture(),
    completed = await runMediaRecoveryCycle(f.options);
  for (const phase of ['diagnostic', 'start', 'never-started'])
    await assert.rejects(
      observeMediaRecoveryPhasePool(nativeOptions(f, { plan: completed.plan, phase, pool: completed.plan.origin })),
      /PHASE_POOL_UNCONFIRMED/
    );
});
test('native final authority drift denies phase resource proof', async () => {
  const f = await mediaRecoveryFixture(),
    completed = await runMediaRecoveryCycle(f.options);
  const o = nativeOptions(f, { plan: completed.plan, phase: 'completed', pool: completed.restore.pool }, (n, map) => {
    if (n === 2) map.get('_control/temporalRelease').drift = true;
  });
  await assert.rejects(observeMediaRecoveryPhasePool(o), /PHASE_POOL_UNCONFIRMED/);
});

test('known pending start LRO may observe exact predecessor without granting a second PATCH', async () => {
  const f = await mediaRecoveryFixture(),
    base = f.options.observeProtection,
    api = f.options.api;
  let predecessor,
    pendingRead = false;
  f.options.api = async (...args) => {
    if (args[1] === 'PATCH' && args[2]?.scaling?.manualInstanceCount === 1) predecessor = structuredClone(f.f.pool);
    return api(...args);
  };
  f.options.observeProtection = async (scope) => {
    const o = nativeOptions(f, scope);
    if (scope.phase === 'start' && f.saved.start?.stage === 'acknowledged' && !pendingRead) {
      o.api = async (url, ...args) =>
        url.includes('/operations/')
          ? { name: f.saved.start.nativeOperation, done: false }
          : url === `https://run.googleapis.com/v2/${scope.plan.name}`
          ? structuredClone(predecessor)
          : api(url, ...args);
      assert.equal((await observeMediaRecoveryPhasePool(o)).position, 'before');
      pendingRead = true;
    } else await observeMediaRecoveryPhasePool(o);
    return base(scope);
  };
  await runMediaRecoveryCycle(f.options);
  assert(pendingRead);
  assert.equal(f.calls.length, 4);
});
test('completed LRO with predecessor configuration cannot advance to SDK execution', async () => {
  const f = await mediaRecoveryFixture(),
    base = f.options.observeProtection,
    api = f.options.api;
  let predecessor,
    executed = false;
  f.options.runtime.execute = async () => {
    executed = true;
    throw Error('unexpected');
  };
  f.options.api = async (...args) => {
    if (args[1] === 'PATCH' && args[2]?.scaling?.manualInstanceCount === 1) predecessor = structuredClone(f.f.pool);
    return api(...args);
  };
  f.options.observeProtection = async (scope) => {
    const o = nativeOptions(f, scope);
    if (scope.phase === 'start' && f.saved.start?.stage === 'acknowledged')
      o.api = async (url, ...args) =>
        url === `https://run.googleapis.com/v2/${scope.plan.name}` ? structuredClone(predecessor) : api(url, ...args);
    await observeMediaRecoveryPhasePool(o);
    return base(scope);
  };
  await assert.rejects(runMediaRecoveryCycle(f.options));
  assert.equal(executed, false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.saved.start.stage, 'acknowledged');
});
