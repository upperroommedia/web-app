import test from 'node:test';
import assert from 'node:assert/strict';
import { scanRestoredMediaInventory } from './temporal-restored-media-inventory.mjs';
import { proofDigest as hash } from './temporal-release-runtime.mjs';
const normal = 'urm-worker-media-staging',
  old = 'urm-worker-staging';
function fixture() {
  const plan = { operationId: '11111111-1111-1111-1111-111111111111', buildId: 'a'.repeat(40) };
  const startup = {
    kind: 'restored-media-startup-witness-v1',
    operationId: plan.operationId,
    planSHA256: hash(plan),
    identity: 'media-restored-22222222-2222-2222-2222-222222222222',
  };
  const current = { deploymentName: old, buildId: 'b'.repeat(40) };
  const candidate = { deploymentName: normal, buildId: plan.buildId };
  const report = {
    workerDeploymentInfo: { name: normal, routingConfig: {}, versionSummaries: [{ deploymentVersion: candidate }] },
  };
  const detail = {
    workerDeploymentVersionInfo: { deploymentVersion: candidate, taskQueueInfos: [{ name: 'urm-media', type: 2 }] },
    versionTaskQueues: [{ name: 'urm-media', type: 2, stats: { approximateBacklogCount: '0' } }],
  };
  const parts = {
    workflowTaskQueuePartitions: [{ key: 'urm-media' }],
    activityTaskQueuePartitions: [{ key: 'urm-media' }, { key: '/_sys/urm-media/1' }],
  };
  const own = { identity: startup.identity, deploymentOptions: { ...candidate, workerVersioningMode: 2 } };
  const retained = { identity: 'protected-original', deploymentOptions: { ...current, workerVersioningMode: 2 } };
  const queues = new Map([
    [
      1,
      {
        taskQueueStatus: { backlogCountHint: '0' },
        versioningInfo: { currentDeploymentVersion: current },
        pollers: [retained],
      },
    ],
    [
      2,
      {
        taskQueueStatus: { backlogCountHint: '0' },
        versioningInfo: { currentDeploymentVersion: current },
        pollers: [retained, own],
      },
    ],
  ]);
  const calls = [];
  const service = {
    describeWorkerDeployment: async (q) =>
      q.deploymentName === normal
        ? report
        : { workerDeploymentInfo: { name: old, routingConfig: { currentDeploymentVersion: current } } },
    describeWorkerDeploymentVersion: async (q) =>
      q.deploymentVersion.deploymentName === normal
        ? detail
        : { workerDeploymentVersionInfo: { deploymentVersion: current } },
    listTaskQueuePartitions: async () => parts,
    describeTaskQueue: async (q) => {
      calls.push(q);
      return queues.get(q.taskQueueType);
    },
  };
  const options = { client: { connection: { workflowService: service } }, plan, startup, rpc: (fn) => fn() };
  return { options, report, detail, parts, queues, own, retained, calls, service };
}
test('normal exact Activity-only identity across every partition; retained originals separated', async () => {
  const f = fixture(),
    r = await scanRestoredMediaInventory(f.options);
  assert.equal(r.ownedPollers.length, 2);
  assert.equal(r.protected.pollers.length, 3);
  assert.equal(r.protected.partitions.length, 3);
  assert.ok(f.calls.every((q) => q.includeTaskQueueStatus && q.taskQueue.kind === 1 && !('deploymentOptions' in q)));
  f.queues.get(2).pollers.pop();
  const without = await scanRestoredMediaInventory(f.options);
  assert.deepEqual(without.protected, r.protected);
  assert.equal(without.ownedPollers.length, 0);
});
for (const [name, mutate] of [
  [
    'wrong startup operation',
    (f) => {
      f.options.startup.operationId = 'foreign';
    },
  ],
  [
    'wrong startup plan',
    (f) => {
      f.options.startup.planSHA256 = 'b'.repeat(64);
    },
  ],
  [
    'missing startup with own pollers',
    (f) => {
      f.options.startup = null;
    },
  ],
  [
    'Workflow own poller',
    (f) => {
      f.queues.get(1).pollers.push(f.own);
    },
  ],
  [
    'same-build foreign instance',
    (f) => {
      f.own.identity = 'media-restored-33333333-3333-3333-3333-333333333333';
    },
  ],
  [
    'other version normal poller',
    (f) => {
      f.own.deploymentOptions.buildId = 'c'.repeat(40);
    },
  ],
  [
    'unversioned poller',
    (f) => {
      delete f.own.deploymentOptions;
    },
  ],
  [
    'normal Workflow registration',
    (f) => {
      f.detail.workerDeploymentVersionInfo.taskQueueInfos[0].type = 1;
    },
  ],
  [
    'missing version backlog',
    (f) => {
      delete f.detail.versionTaskQueues[0].stats.approximateBacklogCount;
    },
  ],
  [
    'other-version backlog',
    (f) => {
      f.report.workerDeploymentInfo.versionSummaries.push({
        deploymentVersion: { deploymentName: normal, buildId: 'c'.repeat(40) },
      });
    },
  ],
  [
    'missing partition status',
    (f) => {
      delete f.queues.get(1).taskQueueStatus;
    },
  ],
  [
    'nonzero root backlog',
    (f) => {
      f.queues.get(2).taskQueueStatus.backlogCountHint = '1';
    },
  ],
  [
    'missing Workflow root',
    (f) => {
      f.parts.workflowTaskQueuePartitions = [];
    },
  ],
  [
    'duplicate Activity partition',
    (f) => {
      f.parts.activityTaskQueuePartitions.push({ key: 'urm-media' });
    },
  ],
  [
    'foreign partition',
    (f) => {
      f.parts.activityTaskQueuePartitions[1].key = '/_sys/foreign/1';
    },
  ],
  [
    'candidate current',
    (f) => {
      f.queues.get(2).versioningInfo.currentDeploymentVersion = {
        deploymentName: normal,
        buildId: f.options.plan.buildId,
      };
    },
  ],
  [
    'ramp',
    (f) => {
      f.report.workerDeploymentInfo.routingConfig.rampingDeploymentVersion = {
        deploymentName: normal,
        buildId: 'c'.repeat(40),
      };
    },
  ],
  [
    'foreign retained poller',
    (f) => {
      f.retained.deploymentOptions.buildId = 'c'.repeat(40);
    },
  ],
  [
    'unknown peer routing',
    (f) => {
      const original = f.service.describeWorkerDeployment;
      f.service.describeWorkerDeployment = async (q) =>
        q.deploymentName === normal ? original(q) : { workerDeploymentInfo: { name: old, routingConfig: {} } };
    },
  ],
])
  test(name + ' denies', async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(scanRestoredMediaInventory(f.options), /RESTORED_MEDIA_QUEUE_PROTECTION_UNCONFIRMED/);
  });
test('no startup and no own pollers grants no exception', async () => {
  const f = fixture();
  f.options.startup = null;
  f.queues.get(2).pollers.pop();
  assert.equal((await scanRestoredMediaInventory(f.options)).ownedPollers.length, 0);
});
