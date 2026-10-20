import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapStopCloudRunControlsPool as cycle } from './temporal-bootstrap-pool.mjs';
import { controlsBootstrapFixture as fixture } from './tests/fixtures/controls-bootstrap.mjs';
test('one start/owned stop, original immutable activation before observation; completed resume is GET-only', async () => {
  const f = fixture(),
    observe = f.options.observeRegistration;
  f.options.observeRegistration = async () => {
    assert.equal(f.saved.activationState.stage, 'completed');
    assert.equal(f.pool.scaling.manualInstanceCount, 1);
    return observe();
  };
  const r = await cycle(f.options);
  assert.equal(r.stage, 'completed');
  assert.equal(r.observation.status, 'confirmed');
  assert.equal(r.start.pool.uid, r.stop.pool.uid);
  assert.equal(r.stop.pool.desiredManualInstanceCount, 0);
  assert.deepEqual(
    f.calls.filter((c) => c.method === 'PATCH').map((c) => c.request.scaling.manualInstanceCount),
    [1, 0]
  );
  await cycle({ ...f.options, saved: f.saved });
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 2);
});
test('native registration failure still stops the same unused owned pool and retains failure', async () => {
  const f = fixture();
  f.options.observeRegistration = async () => {
    throw new Error('unconfirmed');
  };
  await assert.rejects(cycle(f.options));
  assert.equal(f.saved.stage, 'completed');
  assert.equal(f.saved.observation.status, 'unconfirmed');
  assert.equal(f.pool.scaling.manualInstanceCount, 0);
  await assert.rejects(cycle({ ...f.options, saved: f.saved }));
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 2);
});
for (const key of ['runnerScaler', 'scalerTrust', 'poolAccess', 'firestore', 'projectAccess', 'storageAccess'])
  test(`changed ${key} receipt cannot authorize start`, async () => {
    const f = fixture();
    f.options.receipts[key].identityState.plan.grants = [];
    await assert.rejects(cycle(f.options));
    assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 0);
  });
for (const key of ['start', 'stop'])
  test(`${key} unknown accepted ACK is GET-only on resume`, async () => {
    const f = fixture(),
      api = f.options.api;
    let injected = false;
    f.options.api = async (...args) => {
      const r = await api(...args);
      if (args[1] === 'PATCH' && args[2].scaling.manualInstanceCount === (key === 'start' ? 1 : 0) && !injected) {
        injected = true;
        throw new Error('lost');
      }
      return r;
    };
    const r = await cycle(f.options);
    assert.equal(r[key].outcome, 'desired-count-observed-after-unknown-ack');
    assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 2);
  });
test('checkpoint ACK loss before native PATCH never resends and remains fenced', async () => {
  const f = fixture(),
    save = f.options.save;
  f.options.save = async (s) => {
    await save(s);
    if (s.start?.stage === 'attempted') throw new Error('lost');
  };
  await assert.rejects(cycle(f.options));
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 0);
  f.options.save = save;
  await assert.rejects(cycle({ ...f.options, saved: f.saved }));
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 0);
});
test('checkpoint ACK loss after native LRO resumes only the saved operation', async () => {
  const f = fixture(),
    save = f.options.save;
  let failed = false;
  f.options.save = async (s) => {
    await save(s);
    if (s.start?.stage === 'acknowledged' && !failed) {
      failed = true;
      throw new Error('lost');
    }
  };
  await assert.rejects(cycle(f.options));
  f.options.save = save;
  await cycle({ ...f.options, saved: f.saved });
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 2);
});
test('post-checkpoint protection drift prevents scaling', async () => {
  const f = fixture(),
    observe = f.options.observeProtection;
  let count = 0;
  f.options.observeProtection = async () => ({
    ...(await observe()),
    protectionSHA256: (++count === 1 ? 'd' : 'b').repeat(64),
  });
  await assert.rejects(cycle(f.options));
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 0);
});
test('current candidate/protected work refuses stop and retains active ownership fence', async () => {
  const f = fixture(),
    observe = f.options.observeProtection;
  f.options.observeRegistration = async () => {
    throw new Error('native work appeared');
  };
  f.options.observeProtection = async () => {
    if (f.saved.observation) throw new Error('candidate no longer safe');
    return observe();
  };
  await assert.rejects(cycle(f.options));
  assert.equal(f.saved.stage, 'stopping');
  assert.equal(f.pool.scaling.manualInstanceCount, 1);
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 1);
});
for (const bad of ['uid', 'generation', 'revision', 'secret', 'role', 'db', 'bucket', 'policy'])
  test(`fresh native ${bad} mismatch stops before mutation`, async () => {
    const f = fixture(),
      api = f.options.api;
    if (bad === 'uid') f.pool.uid = 'replacement';
    if (bad === 'generation') {
      f.pool.generation = '2';
      f.pool.observedGeneration = '2';
    }
    if (bad === 'revision') {
      f.pool.latestCreatedRevision += 'x';
      f.pool.latestReadyRevision += 'x';
    }
    if (bad === 'db') f.database.uid = 'replacement';
    if (bad === 'bucket') f.bucket.timeCreated = '2026-02-01T00:00:00Z';
    if (bad === 'role') for (const r of f.roles.values()) r.includedPermissions.push('extra');
    if (bad === 'policy') f.policies.get('projects/urm-app-staging').bindings = [];
    f.options.api = async (...args) => {
      const r = await api(...args);
      if (bad === 'secret' && args[0].includes('/versions/')) r.state = 'DISABLED';
      return r;
    };
    await assert.rejects(cycle(f.options));
    assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 0);
  });
