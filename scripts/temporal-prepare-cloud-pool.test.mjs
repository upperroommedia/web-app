import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCloudRunZeroPool } from './temporal-prepare-cloud-pool.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { dispatchResourceNames } from './temporal-serverless-dispatch-resources.mjs';
const buildId = 'a'.repeat(40), image = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`;
function platform() {
  const workerRoles = ['orchestration', 'controls'];
  return { schemaVersion: 1, environment: 'staging', workerHosting: 'cloud-run', connectionMode: 'temporal-cloud',
    firebaseProjectId: 'urm-app-staging', firebaseResources: { storageBucket: 'urm-app-staging.firebasestorage.app', imagesBucket: 'urm-app-staging-images', databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/' },
    temporalNamespace: 'urm-app-staging.qwejt', cloudAccountId: 'qwejt', cloudProvider: 'gcp', cloudRegion: 'us-central1', cloudAddress: 'us-central1.gcp.api.temporal.io:7233', cloudReplicaRegions: [], cloudEvidence: '/private/tmp/native-namespace', workerBuildId: buildId, workerImage: image, workerRoles, dispatcherEnabled: false,
    operatorApiKeyFile: '/private/tmp/operator-key', operatorApiKeySHA256: 'c'.repeat(64), dispatch: { ...dispatchResourceNames(buildId), apiKeyVersion: '2' },
    roleBindings: workerRoles.map(role => ({ projectId: 'urm-app-staging', region: 'us-central1', namespace: 'urm-app-staging.qwejt', buildId, role, ...serverlessResourceNames(buildId, role), image, maxInstances: 1, stabilizationSeconds: 180 })) };
}

function fixture() {
  const p = platform(), runner = p.roleBindings[1].runnerServiceAccount;
  const releaseId = '11111111-2222-4333-8444-555555555555', operationId = '22222222-2222-4333-8444-555555555555';
  const op = 'projects/urm-app-staging/locations/us-central1/operations/native-create';
  let state, pool, postCount = 0;
  const calls = [], states = [];
  const options = { platform: p, role: 'controls', settings: { apiKeyVersion: '2', runtimeSecrets: [] }, operationId, releaseId, evidenceDigest: 'c'.repeat(64),
    identityReceipt: { releaseId, identityState: { stage: 'completed', plan: { kind: 'runner', role: 'controls', buildId, email: runner, evidenceDigest: 'c'.repeat(64) }, account: { email: runner, uniqueId: '12345678901234567890', description: 'owned-create' } } },
    observeComputeIsolation: async () => ({ namespace: p.temporalNamespace, inventorySHA256: 'd'.repeat(64), observedAt: new Date().toISOString() }),
    save: async next => { state = structuredClone(next); states.push(state.stage); },
    api: async (url, method = 'GET', body) => {
      calls.push([method, url]);
      if (url.startsWith('https://iam.googleapis.com/')) return { projectId: 'urm-app-staging', email: runner, uniqueId: '12345678901234567890', description: 'owned-create' };
      if (url.includes('secretmanager') && url.includes(':getIamPolicy')) return { etag: 'native', bindings: [{ role: 'roles/secretmanager.secretAccessor', members: [`serviceAccount:${runner}`] }] };
      if (url.includes('secretmanager')) return { name: 'projects/urm-app-staging/secrets/TEMPORAL_WORKER_API_KEY/versions/2', state: 'ENABLED' };
      if (method === 'POST') {
        postCount++;
        assert.equal(state.stage, 'attempted');
        pool = { ...structuredClone(body), uid: 'native-pool-uid', generation: '1', observedGeneration: '1', terminalCondition: { state: 'CONDITION_SUCCEEDED' },
          latestCreatedRevision: `${body.name}/revisions/rev1`, latestReadyRevision: `${body.name}/revisions/rev1` };
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
for (const bad of ['operation', 'nonzero', 'null-count', 'command', 'marker', 'uid', 'failed'])
  test(`native ${bad} readback cannot complete preparation or cause another create`, async () => {
    const f = fixture(), api = f.options.api;
    f.options.api = async (...args) => {
      const value = await api(...args);
      if (args[0].includes('/operations/')) {
        if (bad === 'operation') value.name = value.name.replace('urm-app-staging', 'urm-app');
        if (bad === 'failed') { value.error = { code: 7 }; delete value.response; }
        if (bad === 'nonzero') value.response.scaling.manualInstanceCount = 1;
        if (bad === 'null-count') value.response.scaling.manualInstanceCount = null;
        if (bad === 'command') value.response.template.containers[0].command = ['different'];
        if (bad === 'marker') value.response.annotations = {};
        if (bad === 'uid') value.response.uid = 'different';
      }
      return value;
    };
    await assert.rejects(prepareCloudRunZeroPool(f.options)); assert.equal(f.posts, 1);
    assert.notEqual(f.saved.stage, 'completed');
  });
