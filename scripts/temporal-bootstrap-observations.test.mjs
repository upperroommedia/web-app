import test from 'node:test';
import assert from 'node:assert/strict';
import { observeBootstrapProtection, observeBootstrapRegistration } from './temporal-bootstrap-observations.mjs';
import { nativeSnapshotProof } from './temporal-release-runtime.mjs';
function fixture() {
  const role = 'controls',
    buildId = 'a'.repeat(40),
    namespace = 'urm-app-staging.qwejt',
    operationId = '11111111-2222-4333-8444-555555555555',
    releaseId = operationId,
    bindingDigest = 'd'.repeat(64);
  const snapshot = (value) => {
    const stamp = { seconds: 1, nanoseconds: 0, toDate: () => new Date(1000) };
    return {
      data: () => value,
      get: (key) => key.split('.').reduce((a, k) => a?.[k], value),
      createTime: stamp,
      updateTime: stamp,
    };
  };
  const p = snapshot({ operationId, releaseId, bindingDigest, action: 'bootstrap-stop-cloud-run-controls' }),
    c = snapshot({
      releaseId,
      admission: 'paused',
      domains: Object.fromEntries(
        ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
          d,
          { admission: 'paused' },
        ])
      ),
    }),
    s = snapshot({ releaseId, phase: 'provider-usage-ready' });
  const platform = { temporalNamespace: namespace, roleBindings: [{ role, buildId, deploymentName: 'candidate' }] },
    rows = [];
  const db = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    doc: (path) => path,
    getAll: async () => [p, c, s],
    collection: (name) => {
      const q = {
        orderBy: () => q,
        limit: () => q,
        startAfter: () => q,
        get: async () => ({
          docs: rows.filter((x) => x.collection === name),
          size: rows.filter((x) => x.collection === name).length,
        }),
      };
      return q;
    },
  };
  const service = {
    describeWorkerDeploymentVersion:async()=>{throw Object.assign(new Error('absent'),{code:5});},
    listWorkerDeployments: async () => ({ workerDeployments: [], nextPageToken: [] }),
    listWorkflowExecutions: async () => ({ executions: [], nextPageToken: [] }),
    describeWorkerDeployment: async () => ({
      workerDeploymentInfo: { name: 'candidate', versionSummaries: [], routingConfig: {} },
    }),
  };
  const client = {
    options: { namespace },
    connection: { workflowService: service, withDeadline: async (_, fn) => fn() },
  };
  return {
    options: {
      client,
      firestore: db,
      platform,
      role,
      operationId,
      releaseId,
      bindingDigest,
      expectedAuthority: { control: nativeSnapshotProof(c), state: nativeSnapshotProof(s) },
    },
    service,
    rows,
    snapshot,
  };
}
test('a long stable scan must not renew old compute/protection timestamps', async () => {
  const f = fixture(),
    now = Date.now;
  let elapsed = 0;
  Date.now = () => now() + elapsed;
  f.service.listWorkflowExecutions = async () => {
    elapsed += 6000;
    return { executions: [] };
  };
  try {
    await assert.rejects(observeBootstrapProtection(f.options));
  } finally {
    Date.now = now;
  }
});
test('empty stable paused native inventory confirms only conservative observations', async () => {
  const f = fixture(),
    result = await observeBootstrapProtection(f.options);
  assert.equal(result.protectedRunCount, 0);
  assert.match(result.scope, /not cross-API exclusion/);
});
for (const collection of [
  'durableJobCriticalSections',
  'temporalProviderMutationLocks',
  'temporalProviderMutationSessions',
  'durableJobOutbox',
  'durableJobCommands',
  'durableActivityExecutions',
])
  test(`unresolved ${collection} is preserved and denies bootstrap`, async () => {
    const f = fixture(),
      doc = f.snapshot({
        state: collection === 'temporalProviderMutationSessions' ? 'active' : 'pending',
        worker: { buildId: 'a'.repeat(40) },
      });
    doc.collection = collection;
    doc.ref = { path: `${collection}/original` };
    f.rows.push(doc);
    await assert.rejects(observeBootstrapProtection(f.options));
    assert.equal(f.rows.length, 1);
  });
test('noncurrent queue registration cannot substitute current candidate readiness', async () => {
  const f = fixture();
  f.service.describeWorkerDeploymentVersion = async () => ({
    workerDeploymentVersionInfo: {
      deploymentVersion: { deploymentName: 'candidate', buildId: 'a'.repeat(40) },
      taskQueueInfos: [{ name: 'urm-controls', type: 2 }],
    },
  });
  const result = await observeBootstrapRegistration(f.options);
  assert.match(result.scope, /no workflow start, promotion or readiness/);
});
for(const extra of [{name:'urm-media',type:2},{name:'urm-orchestration',type:1}])test('controls complete queue inventory denies extra/shared-role queues',async()=>{
 const f=fixture();f.service.describeWorkerDeploymentVersion=async()=>({workerDeploymentVersionInfo:{deploymentVersion:{deploymentName:'candidate',buildId:'a'.repeat(40)},taskQueueInfos:[{name:'urm-controls',type:2},extra]}});
 await assert.rejects(observeBootstrapRegistration(f.options));await assert.rejects(observeBootstrapProtection(f.options));
});
test('orchestration registration requires only its Workflow+Activity pair; extra role queues deny both proof and stop protection',async()=>{
 const f=fixture();f.options.role='orchestration';f.options.platform.roleBindings[0].role='orchestration';
 const get=f.options.firestore.getAll;f.options.firestore.getAll=async()=>{const d=await get();d[0].data().action='activate-cloud-run-orchestration-pool';return d;};
 const queues=[{name:'urm-orchestration',type:1},{name:'urm-orchestration',type:2}];
 f.service.describeWorkerDeploymentVersion=async()=>({workerDeploymentVersionInfo:{deploymentVersion:{deploymentName:'candidate',buildId:'a'.repeat(40)},taskQueueInfos:queues}});
 assert.deepEqual((await observeBootstrapRegistration(f.options)).queues,queues);
 await observeBootstrapProtection(f.options);
 queues.push({name:'urm-controls',type:2});
 await assert.rejects(observeBootstrapRegistration(f.options));await assert.rejects(observeBootstrapProtection(f.options));
});

test('search accepts exactly its Activity queue; Workflow/shared queues deny proof and stop',async()=>{
 const f=fixture();f.options.role='search';f.options.platform.roleBindings[0].role='search';
 const get=f.options.firestore.getAll;f.options.firestore.getAll=async()=>{const d=await get();d[0].data().action='activate-cloud-run-search-pool';return d;};
 const queues=[{name:'urm-search',type:2}];
 f.service.describeWorkerDeploymentVersion=async()=>({workerDeploymentVersionInfo:{deploymentVersion:{deploymentName:'candidate',buildId:'a'.repeat(40)},taskQueueInfos:queues}});
 assert.deepEqual((await observeBootstrapRegistration(f.options)).queues,queues);await observeBootstrapProtection(f.options);
 queues.push({name:'urm-search',type:1});await assert.rejects(observeBootstrapRegistration(f.options));await assert.rejects(observeBootstrapProtection(f.options));
});
