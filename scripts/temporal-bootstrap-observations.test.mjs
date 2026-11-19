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
  const documents = new Map([
    ['_control/temporalReleaseOperation', p],
    ['_control/temporalRelease', c],
    ['_control/temporalReleaseState', s],
  ]);
  const query = (name, filter = () => true, limit = Infinity, count = false) => ({
    where: (field, op, value) => query(name, (doc) =>
      filter(doc) && (op === 'in' ? value.includes(doc.get(field)) : doc.get(field) === value), limit, count),
    limit: (size) => query(name, filter, size, count),
    count: () => query(name, filter, limit, true),
    read: () => {
      const docs = rows.filter((x) => x.collection === name && filter(x)).slice(0, limit);
      if (count) return { data: () => ({ count: docs.length }) };
      assert.equal(limit, 2);
      return { docs, size: docs.length };
    },
  });
  const db = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    doc: (path) => ({ path }),
    collection: query,
    runTransaction: (fn, options) => {
      assert.deepEqual(options, { readOnly: true });
      return fn({ get: async (ref) => ref.read ? ref.read() : documents.get(ref.path) ?? { exists: false } });
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
    setAction: (action) => { p.data().action = action; },
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
test('settled staging-scale historical inventory does not prevent bootstrap and candidate work still does', async () => {
  const f = fixture();
  for (let index = 0; index < 4204; index++) {
    const doc = f.snapshot({ state: 'dispatched', leaseOwner: 'historical-owner', leaseExpiresAt: 0 });
    doc.collection = 'durableJobOutbox';
    doc.ref = { path: `durableJobOutbox/${index}` };
    f.rows.push(doc);
  }
  await observeBootstrapProtection(f.options);
  const doc = f.snapshot({ state: 'dispatched', leaseExpiresAt: 0, execution: { worker: { buildId: 'a'.repeat(40) } } });
  doc.collection = 'durableJobCommands';
  doc.ref = { path: 'durableJobCommands/unexpected-candidate' };
  f.rows.push(doc);
  await assert.rejects(observeBootstrapProtection(f.options));
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
 f.setAction('activate-cloud-run-orchestration-pool');
 const queues=[{name:'urm-orchestration',type:1},{name:'urm-orchestration',type:2}];
 f.service.describeWorkerDeploymentVersion=async()=>({workerDeploymentVersionInfo:{deploymentVersion:{deploymentName:'candidate',buildId:'a'.repeat(40)},taskQueueInfos:queues}});
 assert.deepEqual((await observeBootstrapRegistration(f.options)).queues,queues);
 await observeBootstrapProtection(f.options);
 queues.push({name:'urm-controls',type:2});
 await assert.rejects(observeBootstrapRegistration(f.options));await assert.rejects(observeBootstrapProtection(f.options));
});

test('search accepts exactly its Activity queue; Workflow/shared queues deny proof and stop',async()=>{
 const f=fixture();f.options.role='search';f.options.platform.roleBindings[0].role='search';
 f.setAction('activate-cloud-run-search-pool');
 const queues=[{name:'urm-search',type:2}];
 f.service.describeWorkerDeploymentVersion=async()=>({workerDeploymentVersionInfo:{deploymentVersion:{deploymentName:'candidate',buildId:'a'.repeat(40)},taskQueueInfos:queues}});
 assert.deepEqual((await observeBootstrapRegistration(f.options)).queues,queues);await observeBootstrapProtection(f.options);
 queues.push({name:'urm-search',type:1});await assert.rejects(observeBootstrapRegistration(f.options));await assert.rejects(observeBootstrapProtection(f.options));
});

test('email requires exactly its Activity queue; an extra Workflow or foreign queue denies unused stop',async()=>{
 const f=fixture();f.options.role='email';f.options.platform.roleBindings[0].role='email';
 f.setAction('activate-cloud-run-email-pool');
 const queues=[{name:'urm-email',type:2}];f.service.describeWorkerDeploymentVersion=async()=>({workerDeploymentVersionInfo:{deploymentVersion:{deploymentName:'candidate',buildId:'a'.repeat(40)},taskQueueInfos:queues}});
 assert.deepEqual((await observeBootstrapRegistration(f.options)).queues,queues);await observeBootstrapProtection(f.options);
 queues.push({name:'urm-email',type:1});await assert.rejects(observeBootstrapRegistration(f.options));await assert.rejects(observeBootstrapProtection(f.options));
});

test('images exact Activity queue denies extra Workflow registration and unused stop',async()=>{
 const f=fixture();f.options.role='images';f.options.platform.roleBindings[0].role='images';
 f.setAction('activate-cloud-run-images-pool');
 const queues=[{name:'urm-images',type:2}];f.service.describeWorkerDeploymentVersion=async()=>({workerDeploymentVersionInfo:{deploymentVersion:{deploymentName:'candidate',buildId:'a'.repeat(40)},taskQueueInfos:queues}});
 assert.deepEqual((await observeBootstrapRegistration(f.options)).queues,queues);await observeBootstrapProtection(f.options);
 queues.push({name:'urm-images',type:1});await assert.rejects(observeBootstrapRegistration(f.options));await assert.rejects(observeBootstrapProtection(f.options));
});

test('media requires exactly its Activity queue and cannot use a Workflow poller as stop proof',async()=>{
 const f=fixture();f.options.role='media';f.options.platform.roleBindings[0].role='media';f.setAction('activate-cloud-run-media-pool');
 const queues=[{name:'urm-media',type:2}];f.service.describeWorkerDeploymentVersion=async()=>({workerDeploymentVersionInfo:{deploymentVersion:{deploymentName:'candidate',buildId:'a'.repeat(40)},taskQueueInfos:queues}});
 assert.deepEqual((await observeBootstrapRegistration(f.options)).queues,queues);await observeBootstrapProtection(f.options);queues.push({name:'urm-media',type:1});await assert.rejects(observeBootstrapRegistration(f.options));await assert.rejects(observeBootstrapProtection(f.options));
});
