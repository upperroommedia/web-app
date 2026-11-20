import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCloudRunRuntimeAccess } from './temporal-prepare-runtime-access.mjs';
import { runtimeRolePreparationPlan } from './temporal-prepare-runtime-role.mjs';
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

function fixture(role = 'images', surface = 'storage') {
 const p = platform(), runner = p.roleBindings.find(b => b.role === role).runnerServiceAccount;
 const releaseId = '11111111-2222-4333-8444-555555555555', evidenceDigest = 'c'.repeat(64);
 const identityReceipt = { releaseId, identityState: { stage: 'completed', plan: { kind: 'runner', role, buildId, email: runner, evidenceDigest }, account: { email: runner, uniqueId: '11111111111111111111', description: 'owned' } } };
 const settings = { apiKeyVersion: '2', runtimeSecrets: role === 'orchestration' ? ['RUNTIME_ALERT_RECIPIENTS','ADMIN_BASE_URL'].map(name => ({ name, secret: name, version: '2' })) : role === 'search' ? [{ name: 'TEMPORAL_SEARCH_CONFIG_JSON', secret: 'TEMPORAL_SEARCH_CONFIG', version: '2' }] : [], ...(role === 'email' ? { emailEgressVersion: '2' } : {}) };
 const original = runtimeRolePreparationPlan({ platform: p, role, surface, settings, releaseId, evidenceDigest, identityReceipt, operationId: '33333333-2222-4333-8444-555555555555' });
 const native = { name: `projects/urm-app-staging/roles/${original.request.roleId}`, ...structuredClone(original.request.role), etag: 'role-native-etag' };
 const roleReceipt = { releaseId, operationId: original.operationId, identityState: { stage: 'completed', plan: original, prerequisites: { runnerUniqueId: identityReceipt.identityState.account.uniqueId }, nativeRole: structuredClone(native) } };
 const bucket = role === 'images' ? p.firebaseResources.imagesBucket : p.firebaseResources.storageBucket;
 const metadata = { name: bucket, id: bucket, projectNumber: '251680231116', timeCreated: '2026-03-09T05:52:27.187Z' };
 let state, checks = 0, policy = { version: 1, etag: 'policy-original', bindings: [] };
 const writes = [], events = [];
 const envelope = () => ({ ...structuredClone(policy), kind: 'storage#policy', resourceId: `projects/_/buckets/${bucket}` });
 const options = { platform: p, role, surface, settings, releaseId, evidenceDigest, identityReceipt, roleReceipt, operationId: '22222222-2222-4333-8444-555555555555',
  save: async next => { state = structuredClone(next); events.push('save:'+state.stage); },
  api: async (url, method = 'GET', body) => {
   events.push(method+':'+url);
   if (url.includes('/serviceAccounts/')) return { ...identityReceipt.identityState.account, projectId: 'urm-app-staging' };
   if (url.includes('/roles/')) { checks++; return structuredClone(native); }
   if (url.startsWith('https://run.')) throw Object.assign(new Error('absent'), { status: 404 });
   if (url.startsWith('https://storage.')) {
    if (!url.includes('/iam')) return structuredClone(metadata);
    if (method === 'PUT') { assert.equal(state.stage, 'attempted'); assert.equal(body.etag, policy.etag); assert.equal(body.policy, undefined); assert.equal(body.updateMask, undefined); writes.push({ url, method, body: structuredClone(body) }); policy = { ...structuredClone(body), etag: 'policy-new' }; }
    return envelope();
   }
   if (url.endsWith(':getIamPolicy')) return structuredClone(policy);
   if (url.endsWith(':setIamPolicy')) { assert.equal(state.stage, 'attempted'); assert.equal(body.updateMask, 'bindings,etag'); writes.push({ url, method, body: structuredClone(body) }); policy = { ...structuredClone(body.policy), etag: 'policy-new' }; return structuredClone(policy); }
   if (url.startsWith('https://cloudresourcemanager.')) return { projectId: 'urm-app-staging', projectNumber: '251680231116', lifecycleState: 'ACTIVE' };
   throw new Error('Unexpected API');
  } };
 return { options, writes, events, native, metadata, get checks() { return checks; }, get state() { return state; }, get policy() { return policy; }, set policy(p) { policy = p; } };
}
for (const [role,surface] of [['images','storage'],['controls','storage'],['media','storage'],['orchestration','project'],['search','project'],['email','project']])
 test(`${role} ${surface} grants only exact owned source role after two native joins`, async () => {
  const f = fixture(role,surface), result = await prepareCloudRunRuntimeAccess(f.options);
  assert.equal(f.writes.length, 1); assert.equal(f.checks, 2); assert.equal(result.prerequisites.nativeRole.etag, 'role-native-etag');
  assert.deepEqual(result.plan.grants, [{ role: f.native.name, members: [`serviceAccount:${f.options.identityReceipt.identityState.account.email}`] }]);
  if (surface === 'storage') { assert.equal(f.writes[0].method, 'PUT'); assert.match(f.writes[0].url, new RegExp(role === 'images' ? 'urm-app-staging-images/iam$' : 'urm-app-staging.firebasestorage.app/iam$')); }
  else assert.match(f.writes[0].url, /projects\/urm-app-staging:setIamPolicy$/);
  await prepareCloudRunRuntimeAccess({ ...f.options, saved: f.state }); assert.equal(f.writes.length, 1);
 });
test('pre-existing public image read is preserved exactly, never requested as a grant', async () => {
 const f = fixture(); const baseline = { role: 'roles/storage.objectViewer', members: ['allUsers'] }; f.policy.bindings.push(baseline);
 await prepareCloudRunRuntimeAccess(f.options);
 assert.deepEqual(f.writes[0].body.bindings[0], baseline);
 assert.equal(f.state.plan.grants.some(b => b.members.includes('allUsers')), false);
});
for (const bad of ['public-writer','public-authenticated','conditional-public','audio-public','project-public','foreign-role','role-etag','role-permissions','runner','receipt','bucket-project','bucket-name','bucket-recreated','prewrite-role','prewrite-pool','envelope'])
 test(`denies ${bad} without any IAM update`, async () => {
  const f = fixture(bad === 'audio-public' ? 'media' : 'images', bad === 'project-public' ? 'project' : 'storage'), api = f.options.api;
  if (['public-writer','public-authenticated','audio-public','project-public','conditional-public'].includes(bad)) {
   f.policy.bindings.push({ role: bad === 'public-writer' ? 'roles/storage.objectAdmin' : 'roles/storage.objectViewer', members: [bad === 'public-authenticated' ? 'allAuthenticatedUsers' : 'allUsers'], ...(bad === 'conditional-public' ? { condition: { title: 'x', expression: 'true' } } : {}) });
   if (bad === 'conditional-public') f.policy.version = 3;
  }
  if (bad === 'foreign-role') f.options.roleReceipt.identityState.plan.request.roleId = 'foreign';
  if (bad === 'role-etag') f.native.etag = 'independent';
  if (bad === 'role-permissions') f.native.includedPermissions.push('storage.buckets.delete');
  if (bad === 'runner') f.options.roleReceipt.identityState.prerequisites.runnerUniqueId = '99999999999999999999';
  if (bad === 'receipt') f.options.roleReceipt.identityState.stage = 'attempted';
  if (bad === 'bucket-project') f.metadata.projectNumber = '123';
  if (bad === 'bucket-name') f.metadata.name = 'foreign';
  f.options.api = async (...args) => {
   if (bad === 'prewrite-pool' && f.checks === 2 && args[0].startsWith('https://run.')) return {};
   const value = await api(...args);
   if (bad === 'prewrite-role' && args[0].includes('/roles/') && f.checks === 2) value.etag = 'changed-before-write';
   if (bad === 'bucket-recreated' && args[0].startsWith('https://storage.') && !args[0].includes('/iam') && f.checks === 2) value.timeCreated = '2026-10-20T00:00:00Z';
   if (bad === 'envelope' && args[0].includes('/iam')) value.resourceId = 'projects/_/buckets/foreign';
   return value;
  };
  await assert.rejects(prepareCloudRunRuntimeAccess(f.options)); assert.equal(f.writes.length, 0);
 });
test('unknown Storage PUT acknowledgement only observes exact whole policy and never resends', async () => {
 const f = fixture(), api = f.options.api;
 f.policy.bindings.push({ role: 'roles/storage.objectViewer', members: ['allUsers'] });
 f.options.api = async (...args) => { const v = await api(...args); if (args[1] === 'PUT') throw new Error('lost'); return v; };
 const result = await prepareCloudRunRuntimeAccess(f.options); assert.equal(result.outcome, 'desired-policy-observed-after-unconfirmed-write');
 await prepareCloudRunRuntimeAccess({ ...f.options, saved: f.state }); assert.equal(f.writes.length, 1);
 f.policy.bindings[0].members.push('user:independent@example.test');
 await assert.rejects(prepareCloudRunRuntimeAccess({ ...f.options, saved: f.state })); assert.equal(f.writes.length, 1);
});
for (const stage of ['attempted','acknowledged','completed']) test(`missing original bucket identity cannot reconcile ${stage}`, async () => {
 const f = fixture(); await prepareCloudRunRuntimeAccess(f.options);
 const saved = structuredClone(f.state); saved.stage = stage; delete saved.prerequisites.resourceIdentity;
 await assert.rejects(prepareCloudRunRuntimeAccess({ ...f.options, saved })); assert.equal(f.writes.length, 1);
});
test('definite Storage rejection stays fenced even if desired policy appears independently', async () => {
 const f = fixture(), api = f.options.api; let writes = 0;
 f.options.api = async (...args) => { if (args[1] === 'PUT') { writes++; f.policy = { ...structuredClone(f.state.desired), etag: 'independent' }; throw Object.assign(new Error('denied'), { status: 403 }); } return api(...args); };
 await assert.rejects(prepareCloudRunRuntimeAccess(f.options)); assert.equal(f.state.stage, 'rejected');
 await assert.rejects(prepareCloudRunRuntimeAccess({ ...f.options, saved: f.state })); assert.equal(writes, 1);
});
