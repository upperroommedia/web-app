import assert from 'node:assert/strict';
import test from 'node:test';
import { observeStagingPredecessorTemporal } from './temporal-staging-predecessor-temporal.mjs';

const namespace = 'urm-app-staging.qwejt';
const old = 'b008afa426291ad2aa94cb8319d4bf06afdce1e0';
const successor = 'c'.repeat(40);
const shared = 'urm-worker-staging';
const controls = 'urm-worker-controls-staging';
const current = { deploymentName: shared, buildId: 'a'.repeat(40) };
const retained = { deploymentName: shared, buildId: 'b'.repeat(40) };
const stopped = { deploymentName: controls, buildId: old };
const queueNames = ['orchestration', 'controls', 'email', 'images', 'media', 'search'].map(role => 'urm-' + role);
const execution = { workflowId: 'publishing-review', runId: '11111111-2222-4333-8444-555555555555' };
const timerWorkflow = {
  workflowExecutionInfo: {
    execution, status: 1, type: { name: 'publishingWorkflow' }, taskQueue: 'urm-orchestration',
    versioningInfo: { behavior: 1, deploymentVersion: retained },
  },
  pendingActivities: [], pendingChildren: [], pendingNexusOperations: [],
};
const types = name => name === 'urm-orchestration' ? [1, 2] : [2];

function fixture(change = () => {}) {
  const calls = [];
  const service = {
    listWorkerDeployments: q => q.nextPageToken ?
      { workerDeployments: [{ name: controls }] } :
      { workerDeployments: [{ name: shared }], nextPageToken: Buffer.from('second') },
    describeWorkerDeployment: ({ deploymentName }) => {
      const historical = deploymentName === controls;
      const versions = historical ? [stopped] : [current, retained];
      return { workerDeploymentInfo: { name: deploymentName,
        versionSummaries: versions.map(deploymentVersion => ({ deploymentVersion })),
        routingConfig: historical ? { currentVersion: '__unversioned__' } : { currentDeploymentVersion: current },
      } };
    },
    describeWorkerDeploymentVersion: ({ deploymentVersion, reportTaskQueueStats }) => {
      const historical = deploymentVersion.buildId === old;
      const queues = historical ? [{ name: 'urm-controls', type: 2 }] :
        queueNames.flatMap(name => types(name).map(type => ({ name, type })));
      return { workerDeploymentVersionInfo: { deploymentVersion, status: historical ? 1 : 2, taskQueueInfos: queues },
        ...(reportTaskQueueStats && {
          versionTaskQueues: queues.map(q => ({ ...q, stats: { approximateBacklogCount: '0' } })),
        }) };
    },
    listTaskQueuePartitions: ({ taskQueue: { name } }) => {
      const parts = [{ key: name }, { key: '/_sys/' + name + '/1' }];
      return { workflowTaskQueuePartitions: parts, activityTaskQueuePartitions: parts };
    },
    describeTaskQueue: ({ taskQueue, taskQueueType }) => {
      const name = taskQueue.name.startsWith('/_sys/') ? taskQueue.name.split('/')[2] : taskQueue.name;
      const serving = types(name).includes(taskQueueType);
      return { versioningInfo: serving ? { currentDeploymentVersion: current } : {},
        taskQueueStatus: { backlogCountHint: '0' },
        pollers: serving ? [current, retained].map(v => ({
          identity: 'traditional-' + v.buildId, deploymentOptions: { ...v, workerVersioningMode: 2 },
        })) : [],
      };
    },
    listWorkflowExecutions: () => ({ executions: [{ execution }] }),
    listActivityExecutions: () => ({ executions: [] }),
    listNexusOperationExecutions: () => ({ operations: [] }),
    describeWorkflowExecution: () => timerWorkflow,
  };
  const workflowService = Object.fromEntries(Object.entries(service).map(([name, fn]) => [name, async q => {
    assert.equal(q.namespace, namespace);
    calls.push({ name, q });
    const reply = structuredClone(fn(q));
    change(name, q, reply);
    return reply;
  }]));
  return { calls, client: { options: { namespace }, connection: {
    withDeadline: (_end, fn) => fn(), workflowService,
  } } };
}

test('preserves a pinned traditional timer run and dormant controls registration through native reads', async () => {
  const { client, calls } = fixture();
  const result = await observeStagingPredecessorTemporal(client, successor);
  assert.equal(result.pinnedTraditionalRuns, 1);
  assert.equal(result.partitionCount, 24);
  assert.equal(result.excludedBuildId, old);
  assert.equal(result.successorBuildId, successor);
  assert.deepEqual(result.sharedCurrent, current);
  assert.ok(calls.some(({ name, q }) => name === 'listWorkerDeployments' && q.nextPageToken));
  assert.ok(calls.some(({ name, q }) => name === 'describeTaskQueue' && q.taskQueue.name === '/_sys/urm-media/1'));
  assert.ok(calls.some(({ name, q }) =>
    name === 'describeWorkerDeploymentVersion' && q.deploymentVersion.buildId === old && q.reportTaskQueueStats));
  assert.deepEqual([...new Set(calls.map(c => c.name))].filter(name => !/^(list|describe)/.test(name)), []);
});

test('requires a distinct full successor SHA before making a native read', async () => {
  for (const id of [undefined, null, [successor], old, old.slice(0, 20) + 'f'.repeat(20), 'a'.repeat(39)]) {
    const f = fixture();
    await assert.rejects(observeStagingPredecessorTemporal(f.client, id));
    assert.deepEqual(f.calls, []);
  }
});

test('rejects a registered successor on either deployment even with no assigned work or routing', async () => {
  for (const deploymentName of [shared, controls]) {
    const f = fixture((method, q, r) => {
      if (method === 'describeWorkerDeployment' && q.deploymentName === deploymentName) {
        r.workerDeploymentInfo.versionSummaries.push({ deploymentVersion: { deploymentName, buildId: successor } });
      }
    });
    await assert.rejects(observeStagingPredecessorTemporal(f.client, successor));
  }
});

test('rejects successor references independently in list, describe, partition and workflow projections', async () => {
  const target = { deploymentName: shared, buildId: successor }, alias = shared + '.' + successor;
  const cases = [
    ['listWorkerDeployments', r => { r.workerDeployments[0].latestVersionSummary = { version: alias }; }],
    ['listWorkerDeployments', r => { r.workerDeployments[0].routingConfig = { currentDeploymentVersion: target }; }],
    ['describeWorkerDeployment', r => { r.workerDeploymentInfo.versionSummaries[0].version = alias; }],
    ['describeWorkerDeploymentVersion', r => { r.workerDeploymentVersionInfo.version = alias; }],
    ['describeTaskQueue', r => { r.versioningInfo = { currentDeploymentVersion: target }; }],
    ['describeTaskQueue', r => {
      r.pollers = [{ identity: 'registered', deploymentOptions: { ...target, workerVersioningMode: 2 } }];
    }],
    ['listWorkflowExecutions', r => { r.executions[0].versioningInfo = { versioningOverride: { oneTime: { targetDeploymentVersion: target } } }; }],
    ['describeWorkflowExecution', r => { r.workflowExecutionInfo.versioningInfo.deploymentVersion = target; }],
    ['describeWorkflowExecution', r => { r.workflowExecutionInfo.versioningInfo.versioningOverride = { pinned: { behavior: 1, version: target } }; }],
    ['describeWorkflowExecution', r => { r.workflowExecutionInfo.inheritedBuildId = successor; }],
  ];
  for (const [method, inject] of cases) {
    const f = fixture((observed, _q, r) => { if (observed === method) inject(r); });
    await assert.rejects(observeStagingPredecessorTemporal(f.client, successor), undefined, method);
  }
});

test('rejects routing or pollers hidden on a child partition or a later namespace page', async () => {
  for (const field of ['route', 'legacy-route', 'ramp', 'poller', 'legacy-poller', 'unversioned', 'backlog', 'compute', 'controls-active', 'controls-backlog']) {
    const f = fixture((method, q, r) => {
      if (method === 'describeTaskQueue' && q.taskQueue.name === '/_sys/urm-media/1' && q.taskQueueType === 2) {
        if (field === 'route') r.versioningInfo.currentDeploymentVersion = stopped;
        if (field === 'legacy-route') r.versioningInfo.currentVersion = controls + '.' + old;
        if (field === 'ramp') r.versioningInfo.rampingDeploymentVersion = stopped;
        if (field === 'poller') r.pollers[0].deploymentOptions = { ...stopped, workerVersioningMode: 2 };
        if (field === 'legacy-poller') r.pollers[0].workerVersionCapabilities = { buildId: old };
        if (field === 'unversioned') r.pollers[0].deploymentOptions.workerVersioningMode = 1;
        if (field === 'backlog') r.taskQueueStatus.backlogCountHint = '1';
      }
      if (method === 'describeWorkerDeploymentVersion' && q.deploymentVersion.buildId === old) {
        if (field === 'compute') r.workerDeploymentVersionInfo.computeConfig = { scalingGroups: { group: {} } };
        if (field === 'controls-active') r.workerDeploymentVersionInfo.status = 2;
        if (field === 'controls-backlog') r.versionTaskQueues[0].stats.approximateBacklogCount = '1';
      }
    });
    await assert.rejects(observeStagingPredecessorTemporal(f.client, successor), undefined, field);
  }
});

test('checks workflow overrides, legacy version mirrors, and in-progress transitions on raw Describe responses', async () => {
  for (const change of [
    (v) => { v.deploymentVersion = stopped; },
    (v) => { v.versioningOverride = { oneTime: { version: stopped } }; },
    (v) => { v.versioningOverride = { pinned: { behavior: 1, version: stopped } }; },
    (v) => { v.versioningOverride = { pinned: { behavior: 1, version: retained }, pinnedVersion: controls + '.' + old }; },
    (v) => { v.versionTransition = { deploymentVersion: stopped }; },
    (v) => { v.deploymentTransition = { deployment: { seriesName: controls, buildId: old } }; },
    (v) => { v.deployment = { seriesName: controls, buildId: old }; },
    (v) => { v.version = controls + '.' + old; },
    (_v, i) => { i.assignedBuildId = old; }, (_v, i) => { i.inheritedBuildId = old; },
    (_v, i) => { i.mostRecentWorkerVersionStamp = { buildId: old }; },
    (_v, _i, r) => { r.pendingActivities = [{ lastDeploymentVersion: stopped }]; },
    (_v, _i, r) => { r.pendingNexusOperations = [{}]; }, (_v, _i, r) => { r.pendingChildren = [{}]; },
    (_v, _i, r) => { r.pendingWorkflowTask = {}; },
  ]) {
    const f = fixture((method, _q, r) => {
      if (method === 'describeWorkflowExecution') change(r.workflowExecutionInfo.versioningInfo, r.workflowExecutionInfo, r);
    });
    await assert.rejects(observeStagingPredecessorTemporal(f.client, successor));
  }
});

test('rejects incomplete partitions, incomplete visibility, duplicate pagination, standalone work and missing held registration', async () => {
  for (const field of ['partition', 'visibility', 'cursor', 'activity', 'nexus', 'historical']) {
    const f = fixture((method, q, r) => {
      if (method === 'listTaskQueuePartitions' && field === 'partition') r.activityTaskQueuePartitions.shift();
      if (method === 'listWorkflowExecutions' && field === 'visibility') delete r.executions;
      if (method === 'listWorkerDeployments' && field === 'cursor') r.nextPageToken = Buffer.from('second');
      if (method === 'listActivityExecutions' && field === 'activity') r.executions.push({});
      if (method === 'listNexusOperationExecutions' && field === 'nexus') r.operations.push({});
      if (method === 'describeWorkerDeployment' && q.deploymentName === controls && field === 'historical')
        r.workerDeploymentInfo.versionSummaries = [];
    });
    await assert.rejects(observeStagingPredecessorTemporal(f.client, successor), undefined, field);
  }
  const f = fixture();
  f.client.options.namespace = 'other';
  await assert.rejects(observeStagingPredecessorTemporal(f.client, successor));
  assert.equal(f.calls.length, 0);
});
