import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCloudRunRuntimeRole } from './temporal-prepare-runtime-role.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { dispatchResourceNames } from './temporal-serverless-dispatch-resources.mjs';
const buildId = 'a'.repeat(40), image = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`;
function platform() {
  const workerRoles = ['orchestration', 'controls', 'media', 'email', 'images', 'search'];
  return { schemaVersion: 1, environment: 'staging', workerHosting: 'cloud-run', connectionMode: 'temporal-cloud',
    firebaseProjectId: 'urm-app-staging', firebaseResources: { storageBucket: 'urm-app-staging.firebasestorage.app', imagesBucket: 'urm-app-staging-images', databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/' },
    temporalNamespace: 'urm-app-staging.qwejt', cloudAccountId: 'qwejt', cloudProvider: 'gcp', cloudRegion: 'us-central1', cloudAddress: 'us-central1.gcp.api.temporal.io:7233', cloudReplicaRegions: [], cloudEvidence: '/private/tmp/native-namespace', workerBuildId: buildId, workerImage: image, workerRoles, dispatcherEnabled: false,
    operatorApiKeyFile: '/private/tmp/operator-key', operatorApiKeySHA256: 'c'.repeat(64), dispatch: { ...dispatchResourceNames(buildId), apiKeyVersion: '2' },
    roleBindings: workerRoles.map(role => ({ projectId: 'urm-app-staging', region: 'us-central1', namespace: 'urm-app-staging.qwejt', buildId, role, ...serverlessResourceNames(buildId, role), image, maxInstances: 1, stabilizationSeconds: 180 })) };
}

const all = ['firebaseauth.users.get','firebaseauth.users.update','firebasedatabase.instances.get','firebasedatabase.instances.update','storage.objects.get','storage.objects.create','storage.objects.delete','storage.objects.update'];
function fixture(role = 'orchestration', surface = 'project') {
  const p = platform(), runner = p.roleBindings.find(b => b.role === role).runnerServiceAccount;
  const identityReceipt = { releaseId: '11111111-2222-4333-8444-555555555555', identityState: { stage: 'completed', plan: { kind: 'runner', role, buildId, email: runner, evidenceDigest: 'c'.repeat(64) }, account: { email: runner, uniqueId: '11111111111111111111', description: 'owned' } } };
  let state, native, creates = 0, observations = 0;
  const options = { platform: p, role, surface, settings: { apiKeyVersion: '2', runtimeSecrets: role === 'orchestration' ? ['RUNTIME_ALERT_RECIPIENTS', 'ADMIN_BASE_URL'].map(name => ({ name, secret: name, version: '2' })) : role === 'search' ? [{ name: 'TEMPORAL_SEARCH_CONFIG_JSON', secret: 'TEMPORAL_SEARCH_CONFIG', version: '2' }] : [], ...(role === 'email' ? { emailEgressVersion: '2' } : {}) }, operationId: '22222222-2222-4333-8444-555555555555', releaseId: identityReceipt.releaseId, evidenceDigest: 'c'.repeat(64), identityReceipt,
    save: async value => { state = structuredClone(value); },
    api: async (url, method = 'GET', body) => {
      if (url.endsWith('permissions:queryTestablePermissions')) { observations++; return { permissions: all.map(name => ({ name, stage: 'GA' })) }; }
      if (url.includes('/serviceAccounts/')) return { projectId: 'urm-app-staging', ...identityReceipt.identityState.account };
      if (url.startsWith('https://run.')) throw Object.assign(new Error('absent'), { status: 404 });
      if (url.endsWith('/roles') && method === 'POST') {
        assert.equal(state.stage, 'attempted'); creates++; native = { ...structuredClone(body.role), name: `projects/urm-app-staging/roles/${body.roleId}`, etag: 'native-role-etag' }; return structuredClone(native);
      }
      if (url.includes('/roles/') && method === 'GET') { if (native) return structuredClone(native); throw Object.assign(new Error('absent'), { status: 404 }); }
      throw new Error('Unexpected API');
    } };
  return { options, get state() { return state; }, get creates() { return creates; }, get observations() { return observations; }, get native() { return native; }, set native(value) { native = value; } };
}
for (const role of ['orchestration','controls','media','email','images','search'])
 for (const surface of ['project','storage']) test(`${role} ${surface} exact source permission definition only`, async () => {
  const f = fixture(role, surface);
  if (surface === 'storage' && ['email','search'].includes(role)) { await assert.rejects(prepareCloudRunRuntimeRole(f.options)); assert.equal(f.creates, 0); return; }
  const result = await prepareCloudRunRuntimeRole(f.options), permissions = result.nativeRole.includedPermissions;
  assert.equal(f.creates, 1); assert.equal(f.observations, 2);
  assert.equal(result.stage, 'completed'); assert.match(result.scope, /no binding/);
  if (surface === 'project') {
    const expected = ['firebaseauth.users.get', ...(role === 'orchestration' ? ['firebaseauth.users.update'] : []), ...(['orchestration','controls','media','images'].includes(role) ? ['firebasedatabase.instances.get','firebasedatabase.instances.update'] : [])].sort();
    assert.deepEqual(permissions, expected);
  } else assert.deepEqual(permissions, ['storage.objects.get', ...(role !== 'controls' ? ['storage.objects.delete'] : []), ...(role === 'images' ? ['storage.objects.update'] : []), ...(['orchestration','media'].includes(role) ? ['storage.objects.create'] : [])].sort());
  await prepareCloudRunRuntimeRole({ ...f.options, saved: f.state }); assert.equal(f.creates, 1);
 });
for (const bad of ['missing','testing','deprecated','disabled','predefined','alias','duplicate','pagination','runner','pool','prewrite-pool'])
 test(`rejects ${bad} prerequisite before custom role creation`, async () => {
  const f = fixture(), api = f.options.api;
  f.options.api = async (...args) => {
    if (args[0].startsWith('https://run.') && (bad === 'pool' || (bad === 'prewrite-pool' && f.observations === 2))) return {};
    const value = await api(...args);
    if (args[0].includes('/serviceAccounts/') && bad === 'runner') value.uniqueId = '99999999999999999999';
    if (args[0].endsWith('permissions:queryTestablePermissions')) {
      const entry = value.permissions[0];
      if (bad === 'missing') value.permissions = [];
      if (bad === 'testing') entry.customRolesSupportLevel = 'TESTING';
      if (bad === 'deprecated') entry.stage = 'DEPRECATED';
      if (bad === 'disabled') entry.apiDisabled = true;
      if (bad === 'predefined') entry.onlyInPredefinedRoles = true;
      if (bad === 'alias') entry.primaryPermission = 'other';
      if (bad === 'duplicate') value.permissions.push({ ...entry });
      if (bad === 'pagination') { value.permissions = [{ name: `unrelated.${f.observations}`, stage: 'GA' }]; value.nextPageToken = 'same'; }
    }
    return value;
  };
  await assert.rejects(prepareCloudRunRuntimeRole(f.options)); assert.equal(f.creates, 0);
 });
test('preexisting definition cannot be adopted by matching role name', async () => {
  const f = fixture(); f.native = { name: 'preexisting' };
  await assert.rejects(prepareCloudRunRuntimeRole(f.options)); assert.equal(f.creates, 0);
});
test('unknown create acknowledgement stays fenced even when exact definition exists', async () => {
  const f = fixture(), api = f.options.api;
  f.options.api = async (...args) => { const value = await api(...args); if (args[0].endsWith('/roles') && args[1] === 'POST') throw new Error('lost'); return value; };
  await assert.rejects(prepareCloudRunRuntimeRole(f.options)); assert.equal(f.state.stage, 'attempted');
  await assert.rejects(prepareCloudRunRuntimeRole({ ...f.options, saved: f.state })); assert.equal(f.creates, 1);
});
test('saved native acknowledgement can resume exact etag without another creation', async () => {
  const f = fixture(), save = f.options.save;
  f.options.save = async next => { await save(next); if (next.stage === 'acknowledged') throw new Error('checkpoint response lost'); };
  await assert.rejects(prepareCloudRunRuntimeRole(f.options)); assert.equal(f.state.stage, 'acknowledged');
  f.options.save = save;
  await prepareCloudRunRuntimeRole({ ...f.options, saved: f.state }); assert.equal(f.creates, 1);
  f.native.etag = 'independently-edited';
  await assert.rejects(prepareCloudRunRuntimeRole({ ...f.options, saved: f.state })); assert.equal(f.creates, 1);
});
test('definite create rejection is retained and cannot be retried', async () => {
  const f = fixture(), api = f.options.api; let attempts = 0;
  f.options.api = async (...args) => { if (args[0].endsWith('/roles') && args[1] === 'POST') { attempts++; throw Object.assign(new Error('denied'), { status: 403 }); } return api(...args); };
  await assert.rejects(prepareCloudRunRuntimeRole(f.options)); assert.equal(f.state.stage, 'rejected');
  await assert.rejects(prepareCloudRunRuntimeRole({ ...f.options, saved: f.state })); assert.equal(attempts, 1);
});
