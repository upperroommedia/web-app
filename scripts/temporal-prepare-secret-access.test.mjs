import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCloudRunSecretAccess } from './temporal-prepare-secret-access.mjs';
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
  let state, policy = { version: 3, etag: 'original', bindings: [
    { role: 'roles/secretmanager.secretAccessor', members: ['serviceAccount:legacy@example.test'] },
    { role: 'roles/secretmanager.viewer', members: ['user:auditor@example.test'], condition: { title: 'existing-condition', expression: 'request.time < timestamp("2030-01-01T00:00:00Z")' } } ],
    auditConfigs: [{ service: 'allServices', auditLogConfigs: [{ logType: 'DATA_READ', exemptedMembers: ['user:auditor@example.test'] }] }] };
  const events = [], writes = [];
  const options = { platform: p, role: 'controls', settings: { apiKeyVersion: '2', runtimeSecrets: [] }, secret: 'TEMPORAL_WORKER_API_KEY', releaseId, operationId, evidenceDigest: 'c'.repeat(64),
    identityReceipt: { releaseId, identityState: { stage: 'completed', plan: { kind: 'runner', role: 'controls', buildId, email: runner, evidenceDigest: 'c'.repeat(64) }, account: { email: runner, uniqueId: '12345678901234567890', description: 'owned-create' } } },
    save: async next => { events.push(`save:${next.stage}`); state = structuredClone(next); },
    api: async (url, method = 'GET', body) => {
      events.push(`${method}:${url}`);
      if (url.includes('iam.googleapis.com')) return { projectId: 'urm-app-staging', email: runner, uniqueId: '12345678901234567890', description: 'owned-create' };
      if (url.includes('run.googleapis.com')) throw Object.assign(new Error('absent'), { status: 404 });
      if (url.includes('/versions/')) return { name: 'projects/urm-app-staging/secrets/TEMPORAL_WORKER_API_KEY/versions/2', state: 'ENABLED' };
      if (method === 'POST') {
        writes.push(structuredClone(body)); assert.equal(state.stage, 'attempted');
        assert.equal(body.policy.etag, policy.etag); assert.equal(body.updateMask, 'bindings,etag');
        policy = { ...structuredClone(body.policy), etag: `new-${writes.length}` };
      }
      return structuredClone(policy);
    } };
  return { options, events, writes, get saved() { return state; }, get policy() { return policy; }, set policy(value) { policy = value; } };
}
test('adds only source-derived runner accessor, preserving unrelated members/conditions/audits and exact etag', async () => {
  const f = fixture(), original = structuredClone(f.policy);
  const result = await prepareCloudRunSecretAccess(f.options);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].policy.bindings[1], original.bindings[1]);
  assert.deepEqual(f.writes[0].policy.auditConfigs, original.auditConfigs);
  assert.deepEqual(f.writes[0].policy.bindings[0].members, [...original.bindings[0].members, `serviceAccount:${f.options.platform.roleBindings[1].runnerServiceAccount}`]);
  assert.equal(result.outcome, 'acknowledged-write-and-policy-observation');
  assert.equal(f.events.some(event => /:access|workerPools.*POST|setIamPolicy.*projects\//.test(event)), false);
  const timestamp = result.verifiedAt;
  assert.equal((await prepareCloudRunSecretAccess({ ...f.options, saved: f.saved })).verifiedAt, timestamp);
  assert.equal(f.writes.length, 1);
});
test('unknown applied write acknowledgement is GET-only observed state, without causal claim or resend', async () => {
  const f = fixture(), api = f.options.api;
  f.options.api = async (...args) => { const value = await api(...args); if (args[1] === 'POST') throw new Error('lost acknowledgement'); return value; };
  const result = await prepareCloudRunSecretAccess(f.options);
  assert.equal(result.outcome, 'desired-policy-observed-after-unconfirmed-write');
  assert.equal(f.writes.length, 1);
  await prepareCloudRunSecretAccess({ ...f.options, saved: f.saved }); assert.equal(f.writes.length, 1);
});
test('unapplied unknown write stays fenced; later exact desired observation cannot resend', async () => {
  const f = fixture(), api = f.options.api; let attempts = 0;
  f.options.api = async (...args) => { if (args[1] === 'POST') { attempts++; throw new Error('unknown outcome'); } return api(...args); };
  await assert.rejects(prepareCloudRunSecretAccess(f.options)); assert.equal(f.saved.stage, 'attempted');
  await assert.rejects(prepareCloudRunSecretAccess({ ...f.options, saved: f.saved })); assert.equal(attempts, 1);
  f.policy = { ...f.saved.desired, etag: 'independent-exact-desired-observation' };
  const result = await prepareCloudRunSecretAccess({ ...f.options, saved: f.saved });
  assert.equal(result.outcome, 'desired-policy-observed-after-unconfirmed-write'); assert.equal(attempts, 1);
});
test('unknown checkpoint saves stop before HTTP or before subsequent reads', async () => {
  for (const stage of ['attempted', 'acknowledged']) {
    const f = fixture(), save = f.options.save;
    f.options.save = async state => { await save(state); if (state.stage === stage) throw new Error('unknown checkpoint'); };
    await assert.rejects(prepareCloudRunSecretAccess(f.options));
    assert.equal(f.events.at(-1), `save:${stage}`);
    assert.equal(f.writes.length, stage === 'attempted' ? 0 : 1);
    f.options.save = save;
    if (stage === 'attempted') await assert.rejects(prepareCloudRunSecretAccess({ ...f.options, saved: f.saved }));
    else await prepareCloudRunSecretAccess({ ...f.options, saved: f.saved });
    assert.equal(f.writes.length, stage === 'attempted' ? 0 : 1);
  }
});
test('existing desired direct grant is observed without mutation', async () => {
  const f = fixture(); f.policy.bindings[0].members.push(`serviceAccount:${f.options.platform.roleBindings[1].runnerServiceAccount}`);
  assert.equal((await prepareCloudRunSecretAccess(f.options)).outcome, 'observed-existing-direct-policy');
  assert.equal(f.writes.length, 0);
});
test('documented version normalization and native binding/member order do not imply drift', async () => {
  const f = fixture(), api = f.options.api;
  f.policy.bindings.pop(); f.policy.version = 3;
  f.options.api = async (...args) => { const value = await api(...args); if (value.bindings) { value.version = 1; value.bindings.reverse(); value.bindings.forEach(binding => binding.members.reverse()); } return value; };
  await prepareCloudRunSecretAccess(f.options); assert.equal(f.writes.length, 1);
});
for (const bad of ['foreign-secret', 'runner-uid', 'disabled-version', 'existing-pool', 'missing-etag', 'public', 'hidden-condition', 'bad-version', 'duplicate-role'])
  test(`denies ${bad} before granting`, async () => {
    const f = fixture(), api = f.options.api;
    if (bad === 'foreign-secret') f.options.secret = 'SOUNDCLOUD_CLIENT_SECRET';
    if (bad === 'missing-etag') delete f.policy.etag;
    if (bad === 'public') f.policy.bindings[0].members.push('allUsers');
    if (bad === 'hidden-condition') f.policy.bindings[0].role += '_withcond_hash';
    if (bad === 'bad-version') f.policy.version = 1;
    if (bad === 'duplicate-role') f.policy.bindings.push(structuredClone(f.policy.bindings[0]));
    f.options.api = async (...args) => {
      if (bad === 'existing-pool' && args[0].includes('run.googleapis.com')) return { name: 'existing' };
      const value = await api(...args);
      if (bad === 'runner-uid' && args[0].includes('iam.googleapis.com')) value.uniqueId = '99999999999999999999';
      if (bad === 'disabled-version' && args[0].includes('/versions/')) value.state = 'DISABLED';
      return value;
    };
    await assert.rejects(prepareCloudRunSecretAccess(f.options)); assert.equal(f.writes.length, 0);
  });
for (const bad of ['unrelated-member', 'condition', 'audit', 'stale-etag'])
  test(`concurrent ${bad} drift cannot trigger overwrite, merge or replay`, async () => {
    const f = fixture(), api = f.options.api;
    f.options.api = async (...args) => {
      if (args[1] === 'POST' && bad === 'stale-etag') {
        f.policy.etag = 'changed'; f.policy.bindings[0].members.push('user:new@example.test');
        throw Object.assign(new Error('etag conflict'), { status: 409 });
      }
      const value = await api(...args);
      if (args[1] === 'POST') {
        if (bad === 'unrelated-member') f.policy.bindings[0].members.push('user:new@example.test');
        if (bad === 'condition') f.policy.bindings[1].condition.expression = 'true';
        if (bad === 'audit') f.policy.auditConfigs = [];
      }
      return value;
    };
    await assert.rejects(prepareCloudRunSecretAccess(f.options));
    const count = f.writes.length;
    await assert.rejects(prepareCloudRunSecretAccess({ ...f.options, saved: f.saved }));
    assert.equal(f.writes.length, count); assert.notEqual(f.saved.stage, 'completed');
  });
test('corrupt saved desired policy cannot authorize a write or completion', async () => {
  const f = fixture(), save = f.options.save;
  f.options.save = async state => { await save(state); if (state.stage === 'attempted') throw new Error('stop'); };
  await assert.rejects(prepareCloudRunSecretAccess(f.options));
  const corrupted = structuredClone(f.saved); corrupted.desired.bindings[0].members.push('user:foreign@example.test');
  f.options.save = save;
  await assert.rejects(prepareCloudRunSecretAccess({ ...f.options, saved: corrupted })); assert.equal(f.writes.length, 0);
});
for (const status of [403, 409])
  test(`definite ${status} rejection cannot become an unknown-write success when desired policy appears`, async () => {
    const f = fixture(), api = f.options.api; let attempts = 0;
    f.options.api = async (...args) => {
      if (args[1] === 'POST') {
        attempts++;
        f.policy = { ...structuredClone(f.saved.desired), etag: 'independent-desired-policy' };
        throw Object.assign(new Error('definite rejection'), { status });
      }
      return api(...args);
    };
    await assert.rejects(prepareCloudRunSecretAccess(f.options));
    assert.equal(f.saved.stage, 'rejected'); assert.equal(f.saved.rejectedStatus, status);
    assert.equal(f.events.at(-1), 'save:rejected');
    await assert.rejects(prepareCloudRunSecretAccess({ ...f.options, saved: f.saved }));
    assert.equal(attempts, 1);
  });
test('empty native direct policy adds only the reviewed member and role', async () => {
  const f = fixture(); f.policy = { etag: 'empty-native' };
  await prepareCloudRunSecretAccess(f.options);
  assert.deepEqual(f.writes[0].policy.bindings, [{ role: 'roles/secretmanager.secretAccessor', members: [`serviceAccount:${f.options.platform.roleBindings[1].runnerServiceAccount}`] }]);
  assert.equal(f.writes[0].policy.auditConfigs, undefined);
});
test('conditional accessor remains untouched while the new unconditional grant is added separately', async () => {
  const f = fixture(); f.policy.bindings[0].condition = { title: 'old-conditional-grant', expression: 'false' };
  const original = structuredClone(f.policy.bindings[0]);
  await prepareCloudRunSecretAccess(f.options);
  assert.deepEqual(f.writes[0].policy.bindings[0], original);
  assert.equal(f.writes[0].policy.bindings.filter(binding => binding.role === 'roles/secretmanager.secretAccessor' && !binding.condition).length, 1);
});
