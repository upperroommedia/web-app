import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTraditionalWorkerDrain, traditionalDeployment } from './temporal-traditional-worker-handoff.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';

function fixture() {
  const observedAt = Date.now();
  const handoffAt = observedAt - 10000;
  const old = { deploymentName: traditionalDeployment, buildId: 'a'.repeat(40) };
  const newBuild = 'b'.repeat(40);
  const roles = ['orchestration', 'controls', 'media', 'email', 'images', 'search'];
  const candidates = roles.map((role) => {
    const names = serverlessResourceNames(newBuild, role);
    return {
      buildId: newBuild,
      deploymentName: names.deploymentName,
      queue: names.taskQueue,
      identity: `poller-${role}`,
    };
  });
  const target = (replay) => ({ deploymentName: replay.deploymentName, buildId: replay.buildId });
  const queueInventory = candidates.flatMap((candidate) =>
    [1, 2].map((type) => {
      const serves = type === 2 || candidate.queue === 'urm-orchestration';
      return {
        name: candidate.queue,
        key: candidate.queue,
        type,
        current: serves ? target(candidate) : null,
        ramping: null,
        rampPercentage: 0,
        count: '0',
        pollers: serves ? [{ identity: candidate.identity, worker: target(candidate) }] : [],
      };
    })
  );
  const oldQueues = queueInventory.map(({ name, type }) => ({ name, type }));
  const inventory = {
    observedAt,
    digest: 'c'.repeat(64),
    routing: { current: target(candidates[0]), ramping: null, rampPercentage: 0 },
    versions: [
      {
        buildId: old.buildId,
        active: false,
        computeAttached: false,
        drainage: { status: 2, checkedAt: observedAt - 1000 },
        queues: oldQueues,
        stats: oldQueues.map((q) => ({ ...q, count: '0' })),
      },
    ],
    queueInventory,
    running: [],
    standaloneActivities: 0,
    standaloneNexus: 0,
  };
  return { inventory, options: { builds: [old.buildId], handoffAt, candidates }, old };
}
const deny = /TRADITIONAL_WORKER_HANDOFF_UNCONFIRMED/;

test('distinguishes retiring builds from the orchestration candidate in the same deployment', () => {
  const { inventory, options, old } = fixture();
  inventory.queueInventory[1].pollers.push({ identity: 'old-kubernetes-poller', worker: old });
  assert.equal(assertTraditionalWorkerDrain(inventory, options).pollersGone, false);
  assert.throws(() => assertTraditionalWorkerDrain(inventory, { ...options, requireRetired: true }), deny);
  inventory.queueInventory[1].pollers.pop();
  assert.equal(assertTraditionalWorkerDrain(inventory, { ...options, requireRetired: true }).pollersGone, true);
});

test('blocks stale drainage, old pinned work, unknown attempts, backlog and missing candidate routing', () => {
  const changes = [
    (f) => {
      f.inventory.routing.current = f.old;
    },
    (f) => {
      f.inventory.versions[0].drainage.checkedAt = f.options.handoffAt - 1;
    },
    (f) => {
      f.inventory.versions[0].stats.pop();
    },
    (f) => {
      f.inventory.versions[0].stats[0].count = '1';
    },
    (f) => {
      f.inventory.queueInventory[0].count = null;
    },
    (f) => {
      f.inventory.queueInventory[0].current = f.old;
    },
    (f) => {
      f.inventory.queueInventory[0].pollers = [];
    },
    (f) => {
      f.inventory.queueInventory[0].pollers[0].identity = 'foreign';
    },
    (f) => {
      f.inventory.queueInventory[0].pollers.push({ identity: 'unversioned', worker: null });
    },
    (f) => f.inventory.running.push({ latestWorker: f.old, pendingActivities: [], pendingNexus: 0 }),
    (f) =>
      f.inventory.running.push({
        latestWorker: f.options.candidates[0],
        pendingActivities: [{ id: 'already-scheduled' }],
        pendingNexus: 0,
      }),
    (f) => {
      f.inventory.standaloneActivities = 1;
    },
    (f) => {
      f.inventory.standaloneNexus = 1;
    },
  ];
  for (const change of changes) {
    const state = fixture();
    change(state);
    assert.throws(() => assertTraditionalWorkerDrain(state.inventory, state.options), deny);
  }
});

test('retains an already-drained build only from matching native pre-handoff evidence', () => {
  const { inventory, options } = fixture();
  const old = inventory.versions[0];
  old.drainage.checkedAt = options.handoffAt - 30 * 86400 * 1000;
  assert.throws(() => assertTraditionalWorkerDrain(inventory, options), deny);
  options.preHandoffInventory = {
    observedAt: options.handoffAt - 1000,
    versions: [structuredClone(old)],
  };
  assert.equal(assertTraditionalWorkerDrain(inventory, options).pollersGone, false);
  options.preHandoffInventory.versions[0].active = true;
  assert.throws(() => assertTraditionalWorkerDrain(inventory, options), deny);
});

test('a compute-managed role can be dormant, but every remaining poller has an authenticated identity', () => {
  const { inventory, options, old } = fixture();
  const target = options.candidates.find((candidate) => candidate.queue === 'urm-controls');
  const activity = inventory.queueInventory.find((row) => row.name === target.queue && row.type === 2);
  activity.pollers = [];
  assert.throws(() => assertTraditionalWorkerDrain(inventory, { ...options, requireRetired: true }), deny);
  Object.assign(target, { managed: true, identities: [] });
  assert.throws(() => assertTraditionalWorkerDrain(inventory, options), deny);
  assert.equal(assertTraditionalWorkerDrain(inventory, { ...options, requireRetired: true }).pollersGone, true);
  activity.pollers.push({
    identity: 'replacement',
    worker: { deploymentName: target.deploymentName, buildId: target.buildId },
  });
  assert.throws(() => assertTraditionalWorkerDrain(inventory, { ...options, requireRetired: true }), deny);
  target.identities.push('replacement');
  assert.equal(assertTraditionalWorkerDrain(inventory, { ...options, requireRetired: true }).pollersGone, true);
  activity.pollers.push({ identity: 'retired-worker', worker: old });
  assert.throws(() => assertTraditionalWorkerDrain(inventory, { ...options, requireRetired: true }), deny);
});
