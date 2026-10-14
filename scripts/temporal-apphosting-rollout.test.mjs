import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileAppHostingRollout,
  rolloutIdentity,
  prepareLegacyRolloutIdentityMigration,
  restoreReviewedUiRecovery,
  ensureFrozenRecoveryPolicy,
} from './temporal-apphosting-rollout.mjs';

const config = {
  parent: 'projects/urm-app-staging/locations/us-central1/backends/web-staging',
  releaseId: 'c14abece-3454-4937-879d-42ebae7c1f2d',
  uiCommit: 'a'.repeat(40),
};
function harness() {
  const identity = rolloutIdentity(config);
  const resources = new Map();
  const posts = [];
  let checkpoint;
  let crashBeforeAcceptance = false;
  let timeoutAfterAcceptance = false;
  let otherRollouts = [];
  let frozen = true;
  let currentBuild = 'old';
  const api = async (path, method = 'GET', body) => {
    if (method === 'POST') {
      posts.push({ path, body });
      if (crashBeforeAcceptance) throw new Error('Connection lost before acceptance');
      const build = path.includes('/builds?');
      const name = build ? identity.buildName : identity.rolloutName;
      if (resources.has(name)) throw Object.assign(new Error('Already exists'), { status: 409 });
      resources.set(name, { ...body, name, state: build ? 'BUILDING' : 'PENDING_BUILD' });
      if (timeoutAfterAcceptance) throw new Error('Accepted but response lost');
      return { name: 'operations/pending' };
    }
    if (path.endsWith('/traffic'))
      return { rolloutPolicy: { disabled: frozen }, current: { splits: [{ build: currentBuild, percent: 100 }] } };
    if (path.includes('/rollouts?'))
      return { rollouts: [...otherRollouts, ...[...resources.values()].filter((v) => v.build)] };
    if (!resources.has(path)) throw Object.assign(new Error('Not found'), { status: 404 });
    return resources.get(path);
  };
  const run = () =>
    reconcileAppHostingRollout({
      config,
      checkpoint,
      api,
      saveIdentity: async (value) => {
        checkpoint = value;
      },
    });
  return {
    identity,
    resources,
    posts,
    api,
    run,
    setCheckpoint(value) {
      checkpoint = value;
    },
    get checkpoint() {
      return checkpoint;
    },
    crash(value) {
      crashBeforeAcceptance = value;
    },
    timeout(value) {
      timeoutAfterAcceptance = value;
    },
    concurrent(value) {
      otherRollouts = value;
    },
    freeze(value) {
      frozen = value;
    },
    ready() {
      resources.get(identity.buildName).state = 'READY';
      resources.get(identity.rolloutName).state = 'SUCCEEDED';
      currentBuild = identity.buildName;
    },
  };
}

test('crash after checkpoint but before server acceptance retries the same logical build and rollout', async () => {
  const h = harness();
  h.crash(true);
  assert.equal((await h.run()).status, 'pending');
  assert.deepEqual(h.checkpoint, h.identity);
  h.crash(false);
  assert.equal((await h.run()).status, 'pending');
  assert.equal(h.posts[0].path, h.posts[1].path);
  assert.equal(h.resources.size, 2);
  h.ready();
  assert.equal((await h.run()).status, 'ready');
  assert.equal(h.posts.length, 3);
});

test('accepted pending creations with lost responses are observed without duplicate dispatch', async () => {
  const h = harness();
  h.timeout(true);
  assert.equal((await h.run()).status, 'pending');
  assert.equal(h.posts.length, 2);
  assert.equal((await h.run()).status, 'pending');
  assert.equal(h.posts.length, 2);
  h.ready();
  assert.equal((await h.run()).status, 'ready');
});

test('saved checkpoint with no side effect yet resumes without manual checkpoint surgery', async () => {
  const h = harness();
  h.setCheckpoint(h.identity);
  assert.equal((await h.run()).status, 'pending');
  assert.equal(h.posts.length, 2);
});

test('process loss during checkpoint persistence cannot dispatch until identity is durable', async () => {
  const h = harness();
  let saved;
  await assert.rejects(
    reconcileAppHostingRollout({
      config,
      api: h.api,
      saveIdentity: async (value) => {
        saved = value;
        throw new Error('Process lost after checkpoint write');
      },
    }),
    /Process lost/
  );
  assert.equal(h.posts.length, 0);
  h.setCheckpoint(saved);
  await h.run();
  assert.equal(h.posts.length, 2);
});

test('failed rollout remains failed without a new logical identity', async () => {
  const h = harness();
  await h.run();
  h.resources.get(h.identity.rolloutName).state = 'FAILED';
  await assert.rejects(h.run(), /rollout is FAILED/);
  assert.equal(h.posts.length, 2);
});

test('same commit on another build cannot certify the reviewed named rollout', async () => {
  const h = harness();
  await h.run();
  h.resources.get(h.identity.buildName).source.codebase.hash = 'b'.repeat(40);
  await assert.rejects(h.run(), /immutable commit changed/);
});

test('unexpected concurrent rollout blocks before checkpoint or mutation', async () => {
  const h = harness();
  h.concurrent([{ name: `${config.parent}/rollouts/foreign`, state: 'PENDING_BUILD' }]);
  await assert.rejects(h.run(), /concurrent/);
  assert.equal(h.posts.length, 0);
  assert.equal(h.checkpoint, undefined);
});

test('unavailable lookup is not absence and cannot redispatch', async () => {
  const identity = rolloutIdentity(config);
  const h = harness();
  const api = async (path, ...rest) => {
    if (path === identity.buildName) throw Object.assign(new Error('Forbidden'), { status: 403 });
    return h.api(path, ...rest);
  };
  await assert.rejects(reconcileAppHostingRollout({ config, checkpoint: identity, api }), /Forbidden/);
  assert.equal(h.posts.length, 0);
});

test('immutable checkpoint changes and reopened automation fail closed', async () => {
  const h = harness();
  h.setCheckpoint({ ...h.identity, uiCommit: 'b'.repeat(40) });
  await assert.rejects(h.run(), /identity/);
  h.setCheckpoint(h.identity);
  h.freeze(false);
  await assert.rejects(h.run(), /remain paused/);
  assert.equal(h.posts.length, 0);
});

test('failed named build cannot be silently recreated', async () => {
  const h = harness();
  await h.run();
  h.resources.get(h.identity.buildName).state = 'FAILED';
  await assert.rejects(h.run(), /build is FAILED/);
  assert.equal(h.posts.length, 2);
});

function recoveryHarness() {
  const buildName = `${config.parent}/builds/reviewed`;
  const savedRolloutPolicy = { codebaseBranch: 'staging', disabled: false, requiredPaths: ['apps/web/**'] };
  let traffic = {
    name: `${config.parent}/traffic`,
    etag: 'e0',
    rolloutPolicy: { ...savedRolloutPolicy, disabled: true },
    current: { splits: [{ build: 'old', percent: 100 }] },
  };
  let build = { name: buildName, state: 'READY', source: { codebase: { hash: config.uiCommit } } };
  const patches = [];
  let loseTargetResponse = false;
  const api = async (path, method = 'GET', body) => {
    if (path === buildName) return structuredClone(build);
    if (method === 'GET') return structuredClone(traffic);
    assert.equal(body.etag, traffic.etag, 'Every mutation must use a fresh etag');
    patches.push({ path, body });
    traffic.etag = `e${patches.length}`;
    if (body.target) {
      traffic.current = structuredClone(body.target);
      traffic.target = structuredClone(body.target);
      delete traffic.rolloutPolicy; // The App Hosting traffic oneof discards this member.
      if (loseTargetResponse) throw new Error('Accepted target but response lost');
    } else {
      traffic.rolloutPolicy = structuredClone(body.rolloutPolicy);
      delete traffic.target;
    }
    return { done: true };
  };
  const input = {
    parent: config.parent,
    uiCommit: config.uiCommit,
    buildName,
    savedRolloutPolicy,
    api,
    settleOperation: async (op) => assert.equal(op.done, true),
  };
  return {
    input,
    patches,
    get traffic() {
      return traffic;
    },
    wrongCommit() {
      build.source.codebase.hash = 'b'.repeat(40);
    },
    branch(value) {
      traffic.rolloutPolicy.codebaseBranch = value;
    },
    loseResponse() {
      loseTargetResponse = true;
    },
    pending() {
      traffic.reconciling = true;
    },
  };
}

test('reviewed recovery restores traffic union branch policy while keeping automatic rollout disabled', async () => {
  const h = recoveryHarness();
  const proof = await restoreReviewedUiRecovery(h.input);
  assert.equal(proof.buildName, h.input.buildName);
  assert.equal(h.patches.length, 2);
  assert.deepEqual(h.traffic.rolloutPolicy, { ...h.input.savedRolloutPolicy, disabled: true });
  assert.equal(h.patches[1].body.etag, 'e1');
  await restoreReviewedUiRecovery(h.input);
  assert.equal(h.patches.length, 2, 'Repeated recovery must only observe an already restored target');
});

test('accepted target with unknown response resumes by observing target and restoring frozen policy', async () => {
  const h = recoveryHarness();
  h.loseResponse();
  await assert.rejects(restoreReviewedUiRecovery(h.input), /response lost/);
  assert.equal(h.traffic.rolloutPolicy, undefined);
  await restoreReviewedUiRecovery(h.input);
  assert.equal(h.patches.length, 2);
  assert.equal(h.patches.filter((patch) => patch.body.target).length, 1);
  assert.equal(h.traffic.rolloutPolicy.disabled, true);
});

test('wrong recovery commit or changed branch prevents any traffic mutation', async () => {
  const wrong = recoveryHarness();
  wrong.wrongCommit();
  await assert.rejects(restoreReviewedUiRecovery(wrong.input), /immutable commit/);
  assert.equal(wrong.patches.length, 0);
  const changed = recoveryHarness();
  changed.branch('independent');
  await assert.rejects(restoreReviewedUiRecovery(changed.input), /branch policy changed/);
  assert.equal(changed.patches.length, 0);
});

test('rollback policy restoration reconstructs removed union member without enabling automation', async () => {
  const h = recoveryHarness();
  delete h.traffic.rolloutPolicy;
  await ensureFrozenRecoveryPolicy(h.input);
  assert.equal(h.patches.length, 1);
  assert.equal(h.patches[0].body.rolloutPolicy.disabled, true);
  assert.equal(h.patches[0].body.rolloutPolicy.codebaseBranch, 'staging');
});

test('pending recovery target is observed without overwriting an active operation', async () => {
  const h = recoveryHarness();
  h.pending();
  await assert.rejects(restoreReviewedUiRecovery(h.input), /still pending/);
  assert.equal(h.patches.length, 0);
});

test('v2 build and rollout IDs satisfy the actual API 3..30 constraint while exact legacy derivation remains available', () => {
  const old = rolloutIdentity(config, 1),
    next = rolloutIdentity(config);
  assert.equal(old.schemaVersion, 1);
  assert.equal(old.buildName.split('/').at(-1).length, 41);
  assert.equal(next.schemaVersion, 2);
  for (const name of [next.buildName, next.rolloutName]) assert.match(name.split('/').at(-1), /^[a-z][a-z0-9-]{2,29}$/);
  assert.deepEqual(rolloutIdentity(config), next);
  assert.notEqual(old.buildRequestId, next.buildRequestId);
  assert.notEqual(old.rolloutRequestId, next.rolloutRequestId);
  assert.throws(() => rolloutIdentity(config, 3), /version/);
});
function migrationHarness() {
  const previous = rolloutIdentity(config, 1),
    next = rolloutIdentity(config);
  const calls = [];
  const traffic = {
    etag: 'original',
    rolloutPolicy: { disabled: true, codebaseBranch: 'staging' },
    current: { splits: [{ build: 'serving-old', percent: 100 }] },
  };
  const existing = new Map();
  let fault,
    read = 0,
    clock = 1000;
  const api = async (path, method = 'GET') => {
    calls.push({ path, method });
    assert.equal(method, 'GET');
    if (path.endsWith('/traffic')) {
      const value = structuredClone(traffic);
      if (++read > 1 && fault === 'changed-policy') value.rolloutPolicy.codebaseBranch = 'foreign';
      return value;
    }
    if (path.includes('/rollouts?')) return { rollouts: fault === 'concurrent' ? [{ state: 'PENDING_BUILD' }] : [] };
    if (fault === 'auth') throw Object.assign(new Error('Forbidden'), { status: 403 });
    if (existing.has(path)) return existing.get(path);
    throw Object.assign(new Error('Absent'), { status: 404 });
  };
  return {
    previous,
    next,
    calls,
    traffic,
    existing,
    api,
    fault: (value) => (fault = value),
    run: (checkpoint) =>
      prepareLegacyRolloutIdentityMigration({
        config,
        checkpoint: checkpoint ?? previous,
        api,
        now: () => {
          clock += fault === 'stale' ? 60001 : 1;
          return clock;
        },
      }),
  };
}
test('legacy identity migration proves all four absent resources and preserves full original identity/policy without any POST', async () => {
  const h = migrationHarness(),
    proof = await h.run();
  assert.deepEqual(proof.previousIdentity, h.previous);
  assert.deepEqual(proof.identity, h.next);
  assert.equal(proof.absentResources.length, 4);
  assert(proof.absentResources.every((r) => r.httpStatus === 404));
  assert.deepEqual(proof.traffic, h.traffic);
  assert(h.calls.every((r) => r.method === 'GET'));
});
for (const resource of ['old-build', 'old-rollout', 'new-build', 'new-rollout'])
  test(`migration refuses existing ${resource}`, async () => {
    const h = migrationHarness();
    const names = [h.previous.buildName, h.previous.rolloutName, h.next.buildName, h.next.rolloutName];
    h.existing.set(names[['old-build', 'old-rollout', 'new-build', 'new-rollout'].indexOf(resource)], {
      state: 'READY',
    });
    await assert.rejects(h.run(), /already exists/);
  });
for (const fault of ['auth', 'changed-policy', 'concurrent', 'stale'])
  test(`migration fails closed for ${fault}`, async () => {
    const h = migrationHarness();
    h.fault(fault);
    await assert.rejects(h.run());
  });
test('migration refuses arbitrary saved identities, missing etag, reconciling or enabled automation', async () => {
  for (const mutate of [
    (h) => (h.traffic.etag = undefined),
    (h) => (h.traffic.reconciling = true),
    (h) => (h.traffic.rolloutPolicy.disabled = false),
  ]) {
    const h = migrationHarness();
    mutate(h);
    await assert.rejects(h.run());
  }
  const h = migrationHarness();
  await assert.rejects(h.run({ ...h.previous, buildRequestId: h.next.buildRequestId }), /exact deterministic/);
});

test('migration requires an actual404 rather than an empty successful resource response', async () => {
  for (const value of [null, false, undefined]) {
    const h = migrationHarness();
    h.existing.set(h.previous.buildName, value);
    await assert.rejects(h.run(), /already exists/);
  }
});
