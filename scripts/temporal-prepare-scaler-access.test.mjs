import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCloudRunScalerAccess } from './temporal-prepare-scaler-access.mjs';
import { temporalCloudScalerPrincipals } from './temporal-release-cloud-run.mjs';
import { renderServerlessWorkerPool } from './temporal-serverless-resources.mjs';
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

function fixture(surface = 'scaler-trust') {
  const p = platform(), binding = p.roleBindings[1], releaseId = '11111111-2222-4333-8444-555555555555', operationId = '22222222-2222-4333-8444-555555555555';
  const poolId = '33333333-2222-4333-8444-555555555555', settings = { apiKeyVersion: '2', runtimeSecrets: [] }, evidenceDigest = 'c'.repeat(64);
  const identity = (kind, email, uniqueId) => ({ releaseId, identityState: { stage: 'completed', plan: { kind, role: 'controls', buildId, email, evidenceDigest }, account: { email, uniqueId, description: `owned-${kind}` } } });
  const runnerReceipt = identity('runner', binding.runnerServiceAccount, '11111111111111111111'), scalerReceipt = identity('scaler', binding.invokerServiceAccount, '22222222222222222222');
  const body = renderServerlessWorkerPool(binding, settings); body.annotations = { 'urm.upperroom.media/preparation': poolId };
  const poolMetadata = { ...structuredClone(body), uid: 'native-pool', generation: '1', observedGeneration: '1',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' }, latestCreatedRevision: `${body.name}/revisions/rev1`, latestReadyRevision: `${body.name}/revisions/rev1` };
  const poolReceipt = { releaseId, operationId: poolId, identityState: { stage: 'completed', plan: { operationId: poolId, releaseId, role: 'controls', buildId, evidenceDigest, runner: binding.runnerServiceAccount, body },
    prerequisites: { runnerUniqueId: runnerReceipt.identityState.account.uniqueId },
    pool: { name: body.name, uid: 'native-pool', generation: '1', revision: `${body.name}/revisions/rev1`, desiredManualInstanceCount: 0 } } };
  let state, policy = { version: 1, etag: 'original', bindings: [] }, observations = 0;
  const writes = [], events = [];
  const options = { platform: p, role: 'controls', surface, settings, operationId, releaseId, evidenceDigest, runnerReceipt, scalerReceipt, poolReceipt,
    save: async next => { state = structuredClone(next); events.push(`save:${state.stage}`); },
    observeComputeIsolation: async () => { observations++; events.push('isolation'); return { namespace: p.temporalNamespace, inventorySHA256: 'd'.repeat(64), observedAt: new Date().toISOString() }; },
    api: async (url, method = 'GET', body) => {
      events.push(`${method}:${url}`);
      if (url.includes(':setIamPolicy')) {
        assert.equal(state.stage, 'attempted'); assert.equal(body.policy.etag, policy.etag); assert.equal(body.updateMask, 'bindings,etag');
        writes.push({ url, method, body: structuredClone(body) }); policy = { ...structuredClone(body.policy), etag: 'new' };
        return structuredClone(policy);
      }
      if (url.includes(':getIamPolicy')) {
        assert.equal(method, surface === 'pool-access' ? 'GET' : 'POST'); return structuredClone(policy);
      }
      if (url.includes('/serviceAccounts/')) {
        const receipt = url.includes(binding.runnerServiceAccount) ? runnerReceipt : scalerReceipt;
        return { ...structuredClone(receipt.identityState.account), projectId: 'urm-app-staging' };
      }
      if (url.startsWith('https://run.googleapis.com/v2/')) return structuredClone(poolMetadata);
      throw new Error('Unexpected native resource');
    } };
  return { options, writes, events, poolMetadata, get saved() { return state; }, get observations() { return observations; }, get policy() { return policy; }, set policy(value) { policy = value; } };
}
for (const surface of ['runner-scaler-user', 'scaler-trust', 'pool-access'])
  test(`${surface} writes only its fixed own-resource grants after fresh compute/identity verification`, async () => {
    const f = fixture(surface), result = await prepareCloudRunScalerAccess(f.options);
    assert.equal(f.writes.length, 1); assert.equal(f.observations, 2);
    const grants = f.writes[0].body.policy.bindings;
    if (surface === 'runner-scaler-user') {
      assert.match(f.writes[0].url, /serviceAccounts\/tw-c-.*:setIamPolicy$/);
      assert.deepEqual(grants, [{ role: 'roles/iam.serviceAccountUser', members: [`serviceAccount:${f.options.platform.roleBindings[1].invokerServiceAccount}`] }]);
    }
    if (surface === 'scaler-trust') {
      assert.match(f.writes[0].url, /serviceAccounts\/ts-c-.*:setIamPolicy$/);
      assert.deepEqual(grants, [{ role: 'roles/iam.serviceAccountTokenCreator', members: [...temporalCloudScalerPrincipals] }]);
    }
    if (surface === 'pool-access') {
      assert.match(f.writes[0].url, /workerPools\/urm-worker-controls-.*:setIamPolicy$/);
      assert.deepEqual(grants.map(binding => binding.role), ['roles/run.viewer', 'roles/run.developer']);
    }
    assert.equal(result.prerequisites.runnerUniqueId, '11111111111111111111');
    assert.equal(result.outcome, 'acknowledged-write-and-policy-observation');
    const before = f.writes.length;
    await prepareCloudRunScalerAccess({ ...f.options, saved: f.saved }); assert.equal(f.writes.length, before);
  });
for (const bad of ['surface', 'missing-runner', 'scaler-kind', 'runner-id', 'same-ids', 'pool-receipt', 'pool-marker', 'pool-uid', 'pool-count', 'isolation', 'stale-isolation', 'prewrite-isolation', 'prewrite-pool'])
  test(`rejects ${bad} before granting scaler authority`, async () => {
    const f = fixture(), api = f.options.api, observe = f.options.observeComputeIsolation;
    if (bad === 'surface') f.options.surface = '__proto__';
    if (bad === 'missing-runner') f.options.runnerReceipt = null;
    if (bad === 'scaler-kind') f.options.scalerReceipt.identityState.plan.kind = 'runner';
    if (bad === 'pool-receipt') f.options.poolReceipt.releaseId = 'foreign';
    if (bad === 'pool-marker') f.options.poolReceipt.identityState.plan.body.annotations = {};
    if (bad === 'pool-uid') f.poolMetadata.uid = 'foreign';
    if (bad === 'pool-count') f.poolMetadata.scaling.manualInstanceCount = 1;
    f.options.api = async (...args) => {
      const value = await api(...args);
      if (bad === 'runner-id' && args[0].includes('/serviceAccounts/tw-') && !args[0].includes('IamPolicy')) value.uniqueId = '99999999999999999999';
      if (bad === 'same-ids' && args[0].includes('/serviceAccounts/ts-') && !args[0].includes('IamPolicy')) value.uniqueId = '11111111111111111111';
      if (bad === 'prewrite-pool' && args[0].includes('/workerPools/') && f.observations >= 1) value.uid = 'changed';
      return value;
    };
    f.options.observeComputeIsolation = async () => {
      const value = await observe();
      if (bad === 'isolation' || (bad === 'prewrite-isolation' && f.observations === 2)) throw new Error('Association exists');
      if (bad === 'stale-isolation') value.observedAt = '2000-01-01T00:00:00Z';
      return value;
    };
    await assert.rejects(prepareCloudRunScalerAccess(f.options)); assert.equal(f.writes.length, 0);
  });
for (const surface of ['runner-scaler-user', 'scaler-trust', 'pool-access'])
  test(`${surface} unknown acknowledgement may only observe desired policy, never resend`, async () => {
    const f = fixture(surface), api = f.options.api;
    f.options.api = async (...args) => { const value = await api(...args); if (args[0].includes(':setIamPolicy')) throw new Error('lost'); return value; };
    assert.equal((await prepareCloudRunScalerAccess(f.options)).outcome, 'desired-policy-observed-after-unconfirmed-write');
    await prepareCloudRunScalerAccess({ ...f.options, saved: f.saved }); assert.equal(f.writes.length, 1);
  });
test('definite rejection cannot be erased by independently appearing desired scaler trust', async () => {
  const f = fixture(), api = f.options.api; let attempts = 0;
  f.options.api = async (...args) => {
    if (args[0].includes(':setIamPolicy')) { attempts++; f.policy = { ...structuredClone(f.saved.desired), etag: 'independent' }; throw Object.assign(new Error('denied'), { status: 403 }); }
    return api(...args);
  };
  await assert.rejects(prepareCloudRunScalerAccess(f.options)); assert.equal(f.saved.stage, 'rejected');
  await assert.rejects(prepareCloudRunScalerAccess({ ...f.options, saved: f.saved })); assert.equal(attempts, 1);
});
test('unrelated direct grants are preserved, never silently removed to satisfy a later readiness gate', async () => {
  const f = fixture(); f.policy.bindings.push({ role: 'roles/viewer', members: ['user:auditor@example.test'] });
  await prepareCloudRunScalerAccess(f.options);
  assert.deepEqual(f.writes[0].body.policy.bindings[0], { role: 'roles/viewer', members: ['user:auditor@example.test'] });
});
test('already desired policy retains fresh prerequisite evidence without claiming a write', async () => {
  const f = fixture('scaler-trust');
  f.policy.bindings = [{ role: 'roles/iam.serviceAccountTokenCreator', members: [...temporalCloudScalerPrincipals] }];
  const result = await prepareCloudRunScalerAccess(f.options);
  assert.equal(f.writes.length, 0);
  assert.equal(f.observations, 1);
  assert.equal(result.prerequisites.runnerUniqueId, '11111111111111111111');
  assert.equal(result.prerequisites.scalerUniqueId, '22222222222222222222');
  assert.equal(result.stage, 'completed');
  assert.equal(result.outcome, 'observed-existing-direct-policy');
});
