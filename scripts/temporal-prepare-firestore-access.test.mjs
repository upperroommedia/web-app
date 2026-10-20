import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCloudRunFirestoreAccess } from './temporal-prepare-firestore-access.mjs';
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
  const identityReceipt = { releaseId: '11111111-2222-4333-8444-555555555555', identityState: { stage: 'completed',
    plan: { kind: 'runner', role: 'controls', buildId, email: runner, evidenceDigest: 'c'.repeat(64) },
    account: { email: runner, uniqueId: '11111111111111111111', description: 'owned-runner' } } };
  let policy = { version: 1, etag: 'original', bindings: [{ role: 'roles/viewer', members: ['user:auditor@example.test'] }] }, state, checks = 0;
  const writes = [], database = { name: 'projects/urm-app-staging/databases/(default)', uid: 'db-native', type: 'FIRESTORE_NATIVE', locationId: 'us-central1' };
  const options = { platform: p, role: 'controls', settings: { apiKeyVersion: '2', runtimeSecrets: [] },
    operationId: '22222222-2222-4333-8444-555555555555', releaseId: identityReceipt.releaseId,
    evidenceDigest: 'c'.repeat(64), identityReceipt, save: async next => { state = structuredClone(next); },
    api: async (url, method = 'GET', body) => {
      if (url.includes(':getIamPolicy')) { assert.equal(method, 'POST'); assert.deepEqual(body, { options: { requestedPolicyVersion: 3 } }); return structuredClone(policy); }
      if (url.includes(':setIamPolicy')) {
        assert.equal(state.stage, 'attempted'); assert.equal(body.policy.etag, policy.etag);
        assert.equal(body.updateMask, 'bindings,etag'); assert.equal(body.policy.version, 3);
        writes.push(structuredClone(body)); policy = { ...structuredClone(body.policy), etag: 'new' }; return structuredClone(policy);
      }
      if (url.includes('/serviceAccounts/')) return { projectId: 'urm-app-staging', ...identityReceipt.identityState.account };
      if (url.startsWith('https://firestore.googleapis.com/')) { checks++; return structuredClone(database); }
      if (url.startsWith('https://run.googleapis.com/')) throw Object.assign(new Error('absent'), { status: 404 });
      throw new Error('Unexpected API');
    } };
  return { options, writes, database, get state() { return state; }, get checks() { return checks; }, get policy() { return policy; }, set policy(p) { policy = p; } };
}
test('only own runner receives exact database condition; unrelated unconditional grant is preserved', async () => {
  const f = fixture(); f.policy.bindings.push({ role: 'roles/datastore.user', members: ['serviceAccount:other@urm-app-staging.iam.gserviceaccount.com'] });
  const result = await prepareCloudRunFirestoreAccess(f.options);
  assert.equal(f.checks, 2); assert.equal(f.writes.length, 1);
  const grants = f.writes[0].policy.bindings;
  assert.equal(grants.length, 3); assert.equal(grants[1].condition, undefined);
  assert.deepEqual(grants[1].members, ['serviceAccount:other@urm-app-staging.iam.gserviceaccount.com']);
  assert.deepEqual(grants[2], { role: 'roles/datastore.user', members: [`serviceAccount:${f.options.platform.roleBindings[1].runnerServiceAccount}`],
    condition: { title: 'urm-temporal-default-firestore', expression: 'resource.name=="projects/urm-app-staging/databases/(default)"' } });
  assert.equal(result.prerequisites.database.uid, 'db-native');
});
test('different condition is never widened or used as the requested grant', async () => {
  const f = fixture(); const original = { role: 'roles/datastore.user', members: ['serviceAccount:other@urm-app-staging.iam.gserviceaccount.com'], condition: { title: 'other', expression: 'resource.name=="projects/urm-app-staging/databases/other"' } };
  f.policy.version = 3; f.policy.bindings.push(original);
  await prepareCloudRunFirestoreAccess(f.options);
  assert.deepEqual(f.writes[0].policy.bindings[1], original);
});
for (const bad of ['database', 'uid', 'type', 'location', 'deleted', 'runner', 'pool', 'prewrite-uid', 'prewrite-pool'])
  test(`denies ${bad} before IAM update`, async () => {
    const f = fixture(), api = f.options.api;
    if (bad === 'database') f.database.name = 'projects/urm-app/databases/(default)';
    if (bad === 'uid') delete f.database.uid;
    if (bad === 'type') f.database.type = 'DATASTORE_MODE';
    if (bad === 'location') f.database.locationId = 'eur3';
    if (bad === 'deleted') f.database.deleteTime = '2026-01-01T00:00:00Z';
    if (bad === 'runner') f.options.identityReceipt.identityState.plan.role = 'media';
    f.options.api = async (...args) => {
      if ((bad === 'pool' || (bad === 'prewrite-pool' && f.checks >= 2)) && args[0].startsWith('https://run.')) return { name: 'pool' };
      const value = await api(...args);
      if (bad === 'prewrite-uid' && args[0].startsWith('https://firestore.') && f.checks === 2) value.uid = 'recreated';
      return value;
    };
    await assert.rejects(prepareCloudRunFirestoreAccess(f.options)); assert.equal(f.writes.length, 0);
  });
test('unknown acknowledgement reconciles exact conditional policy without second write', async () => {
  const f = fixture(), api = f.options.api;
  f.options.api = async (...args) => { const result = await api(...args); if (args[0].includes(':setIamPolicy')) throw new Error('lost'); return result; };
  const result = await prepareCloudRunFirestoreAccess(f.options);
  assert.equal(result.outcome, 'desired-policy-observed-after-unconfirmed-write');
  await prepareCloudRunFirestoreAccess({ ...f.options, saved: f.state }); assert.equal(f.writes.length, 1);
  f.database.uid = 'replacement';
  await assert.rejects(prepareCloudRunFirestoreAccess({ ...f.options, saved: f.state })); assert.equal(f.writes.length, 1);
});
test('definite rejection cannot become an observed success or resend', async () => {
  const f = fixture(), api = f.options.api; let attempted = 0;
  f.options.api = async (...args) => {
    if (args[0].includes(':setIamPolicy')) { attempted++; f.policy = { ...f.state.desired, etag: 'independent' }; throw Object.assign(new Error('denied'), { status: 403 }); }
    return api(...args);
  };
  await assert.rejects(prepareCloudRunFirestoreAccess(f.options)); assert.equal(f.state.stage, 'rejected');
  await assert.rejects(prepareCloudRunFirestoreAccess({ ...f.options, saved: f.state })); assert.equal(attempted, 1);
});
for (const stage of ['attempted', 'acknowledged', 'completed'])
  test(`missing original database UID cannot reconcile ${stage} checkpoint`, async () => {
    const f = fixture();
    await prepareCloudRunFirestoreAccess(f.options);
    const saved = structuredClone(f.state); saved.stage = stage;
    delete saved.prerequisites.database.uid;
    f.database.uid = 'replacement';
    await assert.rejects(prepareCloudRunFirestoreAccess({ ...f.options, saved }));
    assert.equal(f.writes.length, 1);
  });
