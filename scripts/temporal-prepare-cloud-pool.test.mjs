import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCloudRunZeroPool } from './temporal-prepare-cloud-pool.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { dispatchResourceNames } from './temporal-serverless-dispatch-resources.mjs';
const buildId = 'a'.repeat(40), image = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`;
function platform() {
  const workerRoles = ['orchestration', 'controls','media'];
  return { schemaVersion: 1, environment: 'staging', workerHosting: 'cloud-run', connectionMode: 'temporal-cloud',
    firebaseProjectId: 'urm-app-staging', firebaseResources: { storageBucket: 'urm-app-staging.firebasestorage.app', imagesBucket: 'urm-app-staging-images', databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/' },
    temporalNamespace: 'urm-app-staging.qwejt', cloudAccountId: 'qwejt', cloudProvider: 'gcp', cloudRegion: 'us-central1', cloudAddress: 'us-central1.gcp.api.temporal.io:7233', cloudReplicaRegions: [], cloudEvidence: '/private/tmp/native-namespace', workerBuildId: buildId, workerImage: image, workerRoles, dispatcherEnabled: false,
    operatorApiKeyFile: '/private/tmp/operator-key', operatorApiKeySHA256: 'c'.repeat(64), dispatch: { ...dispatchResourceNames(buildId), apiKeyVersion: '2' },
    roleBindings: workerRoles.map(role => ({ projectId: 'urm-app-staging', region: 'us-central1', namespace: 'urm-app-staging.qwejt', buildId, role, ...serverlessResourceNames(buildId, role), image, maxInstances: 1, stabilizationSeconds: 180 })) };
}

function fixture(role='controls') {
  const p = platform(), runner = p.roleBindings.find(b=>b.role===role).runnerServiceAccount;
  const releaseId = '11111111-2222-4333-8444-555555555555', operationId = '22222222-2222-4333-8444-555555555555';
  const op = 'projects/urm-app-staging/locations/us-central1/operations/native-create';
  let state, pool, postCount = 0;
  const calls = [], states = [];
  const options = { authorizeCreate:async()=>{}, platform: p, role, settings: { apiKeyVersion: '2', runtimeSecrets: [] }, operationId, releaseId, evidenceDigest: 'c'.repeat(64),
    identityReceipt: { releaseId, identityState: { stage: 'completed', plan: { kind: 'runner', role, buildId, email: runner, evidenceDigest: 'c'.repeat(64) }, account: { email: runner, uniqueId: '12345678901234567890', description: 'owned-create' } } },
    observeComputeIsolation: async () => ({ namespace: p.temporalNamespace, inventorySHA256: 'd'.repeat(64), observedAt: new Date().toISOString() }),
    save: async next => { state = structuredClone(next); states.push(state.stage); },
    api: async (url, method = 'GET', body,beforeSend) => {
      if(beforeSend)await beforeSend();
      if(new URL(url).origin === 'https://cloudquotas.googleapis.com')return {name:url.split('/v1/')[1],quotaId:url.split('/').at(-1),metric:url.endsWith('MaxPerInstanceEphemeralDiskSizePerProjectRegion')?'run.googleapis.com/max_per_instance_ephemeral_disk':'run.googleapis.com/ephemeral_disk_allocation',service:'run.googleapis.com',metricUnit:'By',dimensions:['region'],dimensionsInfos:[{dimensions:{region:'us-central1'},applicableLocations:['us-central1'],details:{value:'107374182400'}}]};
      calls.push([method, url]);
      if (url.startsWith('https://iam.googleapis.com/')) return { projectId: 'urm-app-staging', email: runner, uniqueId: '12345678901234567890', description: 'owned-create' };
      if (url.includes('secretmanager') && url.includes(':getIamPolicy')) return { etag: 'native', bindings: [{ role: 'roles/secretmanager.secretAccessor', members: [`serviceAccount:${runner}`] }] };
      if (url.includes('secretmanager')) return { name: 'projects/urm-app-staging/secrets/TEMPORAL_WORKER_API_KEY/versions/2', state: 'ENABLED' };
      if (method === 'POST') {
        postCount++;
        assert.equal(state.stage, 'attempted');
        const request = new URL(url);
        const workerPoolId = request.searchParams.get('workerPoolId');
        const name = `${request.pathname.slice('/v2/'.length)}/${workerPoolId}`;
        assert.equal(request.pathname, '/v2/projects/urm-app-staging/locations/us-central1/workerPools');
        assert.equal(workerPoolId, p.roleBindings.find(binding => binding.role === role).poolName);
        assert.equal(Object.hasOwn(body, 'name'), false, 'WorkerPools.CreateWorkerPool rejects a name on the request body');
        assert.deepEqual({ name, ...body }, state.plan.body);
        pool = { name, ...structuredClone(body), uid: 'native-pool-uid', generation: '1', observedGeneration: '1', terminalCondition: { state: 'CONDITION_SUCCEEDED' },
          latestCreatedRevision: `${name}/revisions/rev1`, latestReadyRevision: `${name}/revisions/rev1` };
        return { name: op };
      }
      if (url.endsWith(op)) return { name: op, done: true, response: structuredClone(pool) };
      if (!pool) throw Object.assign(new Error('absent'), { status: 404 });
      return structuredClone(pool);
    } };
  return { options, calls, states, get saved() { return state; }, get posts() { return postCount; }, get pool() { return pool; }, set pool(value) { pool = value; } };
}
test('one zero-target create after saved attempt, exact acknowledged LRO and native UID readback', async () => {
  const f = fixture(), result = await prepareCloudRunZeroPool(f.options);
  assert.equal(result.pool.desiredManualInstanceCount, 0);
  assert.match(result.scope, /not observed live instance count/);
  assert.deepEqual(f.states, ['planned', 'attempted', 'acknowledged', 'completed']);
  assert.equal(f.posts, 1);
  assert.equal(f.calls.some(([method, url]) => method === 'PATCH' || /setIamPolicy|:access|compute-config/.test(url)), false);
  await prepareCloudRunZeroPool({ ...f.options, saved: f.saved });
  assert.equal(f.posts, 1);
});
test('native MANUAL mode and zero count complete preparation', async () => {
  const f = fixture(), api = f.options.api;
  f.options.api = async (...args) => {
    const value = await api(...args);
    const pool = value.response ?? value;
    if (pool.scaling) pool.scaling.scalingMode = 'MANUAL';
    return value;
  };
  const result = await prepareCloudRunZeroPool(f.options);
  assert.equal(result.pool.desiredManualInstanceCount, 0);
  assert.equal(f.posts, 1);
});
test('lost create ACK cannot be retried or adopted by matching pool GET', async () => {
  const f = fixture(), api = f.options.api;
  f.options.api = async (...args) => { const result = await api(...args); if (args[1] === 'POST') throw new Error('lost'); return result; };
  await assert.rejects(prepareCloudRunZeroPool(f.options));
  assert.equal(f.saved.stage, 'attempted');
  const count = f.calls.length;
  await assert.rejects(prepareCloudRunZeroPool({ ...f.options, saved: f.saved }));
  assert.equal(f.posts, 1); assert.equal(f.calls.length, count);
});
test('unknown attempted or acknowledged checkpoint save stops immediately; only known LRO resumes', async () => {
  for (const stage of ['attempted', 'acknowledged']) {
    const f = fixture(), save = f.options.save;
    f.options.save = async state => { await save(state); if (state.stage === stage) throw new Error('unknown checkpoint'); };
    await assert.rejects(prepareCloudRunZeroPool(f.options));
    assert.equal(f.posts, stage === 'attempted' ? 0 : 1);
    f.options.save = save;
    if (stage === 'attempted') await assert.rejects(prepareCloudRunZeroPool({ ...f.options, saved: f.saved }));
    else await prepareCloudRunZeroPool({ ...f.options, saved: f.saved });
    assert.equal(f.posts, stage === 'attempted' ? 0 : 1);
  }
});
for (const bad of ['runner', 'secret-version', 'secret-permission', 'isolation', 'preexisting'])
  test(`preparation denies ${bad} before pool create`, async () => {
    const f = fixture(), api = f.options.api;
    if (bad === 'runner') f.options.identityReceipt.releaseId = 'different';
    if (bad === 'isolation') f.options.observeComputeIsolation = async () => { throw new Error('association exists'); };
    if (bad === 'preexisting') f.pool = { name: 'existing' };
    f.options.api = async (...args) => {
      const value = await api(...args);
      if (bad === 'secret-version' && args[0].includes('/versions/')) value.state = 'DISABLED';
      if (bad === 'secret-permission' && args[0].includes('getIamPolicy')) value.bindings = [];
      return value;
    };
    await assert.rejects(prepareCloudRunZeroPool(f.options)); assert.equal(f.posts, 0);
  });
for (const bad of ['operation', 'nonzero', 'null-count', 'automatic-mode', 'automatic-settings', 'command', 'marker', 'uid', 'failed'])
  test(`native ${bad} readback cannot complete preparation or cause another create`, async () => {
    const f = fixture(), api = f.options.api;
    f.options.api = async (...args) => {
      const value = await api(...args);
      if (args[0].includes('/operations/')) {
        if (bad === 'operation') value.name = value.name.replace('urm-app-staging', 'urm-app');
        if (bad === 'failed') { value.error = { code: 7 }; delete value.response; }
        if (bad === 'nonzero') value.response.scaling.manualInstanceCount = 1;
        if (bad === 'null-count') value.response.scaling.manualInstanceCount = null;
        if (bad === 'automatic-mode') value.response.scaling = { scalingMode: 'AUTOMATIC' };
        if (bad === 'automatic-settings') value.response.scaling = { minInstanceCount: 0, maxInstanceCount: 1 };
        if (bad === 'command') value.response.template.containers[0].command = ['different'];
        if (bad === 'marker') value.response.annotations = {};
        if (bad === 'uid') value.response.uid = 'different';
      }
      return value;
    };
    await assert.rejects(prepareCloudRunZeroPool(f.options)); assert.equal(f.posts, 1);
    assert.notEqual(f.saved.stage, 'completed');
  });

test('media zero preparation saves effective quotas before one POST and checks again after credential acquisition',async()=>{
 const f=fixture('media');await prepareCloudRunZeroPool(f.options);assert.equal(f.posts,1);assert.equal(f.saved.prerequisites.mediaDiskQuota.components.length,2);
 await prepareCloudRunZeroPool({...f.options,saved:f.saved});assert.equal(f.posts,1);
});
for(const bad of ['instance','regional','desired-only','credential-drift','delayed-checkpoint'])test(`media ${bad} quota cannot authorize create`,async()=>{
 const f=fixture('media'),api=f.options.api,save=f.options.save;let credential=false;
 f.options.save=async state=>{await save(state);if(bad==='delayed-checkpoint'&&state.stage==='attempted')state.prerequisites.mediaDiskQuota.components.forEach(c=>c.observedAt=new Date(Date.now()-6000).toISOString());};
 f.options.api=async(...args)=>{
  if(args[1]==='POST'&&bad==='credential-drift')credential=true;
  const result=await api(...args);
  if(new URL(args[0]).origin === 'https://cloudquotas.googleapis.com'){
   if(bad==='desired-only'){delete result.dimensionsInfos[0].details.value;result.dimensionsInfos[0].details.desiredValue='107374182400';}
   if(bad==='instance'&&args[0].includes('MaxPerInstance')||bad==='regional'&&args[0].endsWith('EphemeralDiskAllocPerProjectRegion')||credential)result.dimensionsInfos[0].details.value='10737418240';
  }return result;
 };
 await assert.rejects(prepareCloudRunZeroPool(f.options));assert.equal(f.posts,0);
});

test('pool create authority is checked after credential acquisition before HTTP',async()=>{
 const f=fixture(),api=f.options.api;let authorized=true;
 f.options.authorizeCreate=async()=>{if(!authorized)throw new Error('authority changed');};
 f.options.api=async(...args)=>{if(args[1]==='POST')authorized=false;return api(...args);};
 await assert.rejects(prepareCloudRunZeroPool(f.options));assert.equal(f.posts,0);
});
for(const finalAwait of [2,4])test(`media final awaited authorizer ${finalAwait} cannot renew expired original quota`,async()=>{
 const f=fixture('media'),now=Date.now;let calls=0;
 f.options.authorizeCreate=async()=>{if(++calls===finalAwait)Date.now=()=>now()+6000;};
 try{await assert.rejects(prepareCloudRunZeroPool(f.options));assert.equal(f.posts,0);}
 finally{Date.now=now;}
});

for (const change of ['association', 'inventory', 'stale after authority check']) {
  test(`pool creation rejects ${change} at send and leaves the original attempt fenced`, async () => {
    const f = fixture(), api = f.options.api, observe = f.options.observeComputeIsolation;
    const now = Date.now;
    let credentialsReady = false, scans = 0;
    f.options.api = async (...args) => {
      if (args[1] === 'POST') credentialsReady = true;
      return api(...args);
    };
    f.options.observeComputeIsolation = async () => {
      scans++;
      assert.equal(credentialsReady, scans > 1);
      const evidence = await observe();
      if (scans === 1) return evidence;
      if (change === 'association') throw new Error('compute attached');
      if (change === 'inventory') return { ...evidence, inventorySHA256: 'e'.repeat(64) };
      return evidence;
    };
    f.options.authorizeCreate = async () => {
      if (credentialsReady && change === 'stale after authority check') Date.now = () => now() + 6000;
    };
    try {
      await assert.rejects(prepareCloudRunZeroPool(f.options), /CLOUD_RUN_ZERO_POOL_PREPARATION_UNCONFIRMED/);
      assert.equal(f.saved.stage, 'attempted');
      assert.equal(f.posts, 0);
      await assert.rejects(prepareCloudRunZeroPool({ ...f.options, saved: f.saved }));
      assert.equal(scans, 2);
      assert.equal(f.posts, 0);
    } finally {
      Date.now = now;
    }
  });
}
