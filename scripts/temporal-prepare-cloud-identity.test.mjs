import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCloudRunIdentity } from './temporal-prepare-cloud-identity.mjs';
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
  const p = platform(); let saved, account, postCount = 0;
  const events = [], states = [];
  const options = { platform: p, role: 'controls', kind: 'runner', creator: 'operator@example.test', evidenceDigest: 'e'.repeat(64), operationId: '11111111-2222-4333-8444-555555555555',
    save: async state => { events.push('save:' + state.stage); states.push(structuredClone(state)); saved = structuredClone(state); },
    api: async (url, method = 'GET', body) => {
      events.push(method + ':' + url);
      if (method === 'GET') { if (!account) throw Object.assign(new Error('synthetic absent'), { status: 404 }); return structuredClone(account); }
      if (url.includes('entries:list')) return { entries: [] };
      postCount++;
      assert.equal(saved.stage, 'attempted');
      assert.deepEqual(saved.plan.request, body);
      account = { projectId: 'urm-app-staging', email: saved.plan.email, uniqueId: '123456789012345678901', ...body.serviceAccount };
      return structuredClone(account);
    } };
  return { options, events, states, get saved() { return saved; }, get account() { return account; }, set account(value) { account = value; }, get postCount() { return postCount; } };
}
test('persists attempt before one native create, joins unique ID and records completion without keys/grants/compute', async () => {
  const f = fixture();
  const result = await prepareCloudRunIdentity(f.options);
  assert.equal(f.postCount, 1);
  assert.deepEqual(f.states.map(s => s.stage), ['planned', 'attempted', 'acknowledged', 'completed']);
  assert.equal(result.account.uniqueId, f.account.uniqueId);
  assert.ok(f.events.indexOf('save:attempted') < f.events.findIndex(e => e.startsWith('POST:')));
  assert.equal(f.events.some(e => /setIamPolicy|workerPools|keys/.test(e)), false);
  await prepareCloudRunIdentity({ ...f.options, saved: f.saved });
  assert.equal(f.postCount, 1);
});
test('lost attempt checkpoint acknowledgement cannot send HTTP', async () => {
  const f = fixture();
  const save = f.options.save;
  f.options.save = async state => { await save(state); if (state.stage === 'attempted') throw new Error('uncertain checkpoint'); };
  await assert.rejects(prepareCloudRunIdentity(f.options));
  assert.equal(f.postCount, 0);
  assert.equal(f.saved.stage, 'attempted');
  await assert.rejects(prepareCloudRunIdentity({ ...f.options, saved: f.saved }));
  assert.equal(f.postCount, 0);
});
test('lost create acknowledgement requires exact native audit binding, never adoption by marker alone', async () => {
  const f = fixture(), native = f.options.api;
  f.options.api = async (url, method, body) => {
    const value = await native(url, method, body);
    if (url.endsWith('/serviceAccounts') && method === 'POST') throw new Error('lost create response');
    return value;
  };
  await assert.rejects(prepareCloudRunIdentity(f.options));
  assert.equal(f.postCount, 1);
  assert.equal(f.saved.stage, 'attempted');
  f.options.api = async (url, method, body) => {
    if (!url.includes('entries:list')) return native(url, method, body);
    assert.match(body.filter, /operator@example.test/);
    return { entries: [{ insertId: 'native-create', timestamp: f.saved.attemptedAt,
      protoPayload: { serviceName: 'iam.googleapis.com', methodName: 'google.iam.admin.v1.CreateServiceAccount',
        authenticationInfo: { principalEmail: f.options.creator }, request: f.saved.plan.request,
        response: { email: f.account.email, uniqueId: f.account.uniqueId } } }] };
  };
  const result = await prepareCloudRunIdentity({ ...f.options, saved: f.saved });
  assert.equal(result.account.uniqueId, f.account.uniqueId);
  assert.equal(f.saved.audit.insertId, 'native-create');
  assert.equal(f.postCount, 1);
});
test('unknown acknowledgement persistence stops before any subsequent native request', async () => {
  const f = fixture(), save = f.options.save;
  f.options.save = async state => { await save(state); if (state.stage === 'acknowledged') throw new Error('lost checkpoint'); };
  await assert.rejects(prepareCloudRunIdentity(f.options));
  const posts = f.postCount;
  assert.equal(f.events.at(-1), 'save:acknowledged');
  f.options.save = save;
  await prepareCloudRunIdentity({ ...f.options, saved: f.saved });
  assert.equal(f.postCount, posts);
});
test('pre-existing accounts, mismatched manifest and changed unique IDs cannot be adopted', async () => {
  const f = fixture();
  f.account = { email: 'existing@example.test' };
  await assert.rejects(prepareCloudRunIdentity(f.options));
  assert.equal(f.postCount, 0);
  const g = fixture(); await prepareCloudRunIdentity(g.options);
  await assert.rejects(prepareCloudRunIdentity({ ...g.options, saved: g.saved, evidenceDigest: 'f'.repeat(64) }));
  g.account = { ...g.account, uniqueId: '999999999999999999999' };
  await assert.rejects(prepareCloudRunIdentity({ ...g.options, saved: g.saved }));
  assert.equal(g.postCount, 1);
});
for (const mismatch of ['actor', 'request', 'unique-id', 'duplicate', 'time', 'pagination'])
  test(`lost acknowledgement rejects audit ${mismatch} without create replay`, async () => {
    const f = fixture(), native = f.options.api;
    f.options.api = async (url, method, body) => {
      const value = await native(url, method, body);
      if (method === 'POST' && url.endsWith('/serviceAccounts')) throw new Error('lost');
      return value;
    };
    await assert.rejects(prepareCloudRunIdentity(f.options));
    f.options.api = async (url, method, body) => {
      if (!url.includes('entries:list')) return native(url, method, body);
      const entry = { insertId: 'native', timestamp: f.saved.attemptedAt, protoPayload: {
        serviceName: 'iam.googleapis.com', methodName: 'google.iam.admin.v1.CreateServiceAccount',
        authenticationInfo: { principalEmail: f.options.creator }, request: structuredClone(f.saved.plan.request),
        response: { email: f.account.email, uniqueId: f.account.uniqueId } } };
      if (mismatch === 'actor') entry.protoPayload.authenticationInfo.principalEmail = 'foreign@example.test';
      if (mismatch === 'request') entry.protoPayload.request.serviceAccount.description = 'wrong';
      if (mismatch === 'unique-id') entry.protoPayload.response.uniqueId = '99999999999999999';
      if (mismatch === 'time') entry.timestamp = '2000-01-01T00:00:00Z';
      return { entries: mismatch === 'duplicate' ? [entry, entry] : [entry], ...(mismatch === 'pagination' ? { nextPageToken: 'more' } : {}) };
    };
    await assert.rejects(prepareCloudRunIdentity({ ...f.options, saved: f.saved }));
    assert.equal(f.postCount, 1);
    assert.equal(f.saved.stage, 'attempted');
  });
test('definite rejection remains recorded and cannot be resubmitted', async () => {
  const f = fixture(), native = f.options.api;
  f.options.api = async (url, method, body) => {
    if (method === 'POST') throw Object.assign(new Error('denied'), { status: 403 });
    return native(url, method, body);
  };
  await assert.rejects(prepareCloudRunIdentity(f.options));
  assert.equal(f.saved.stage, 'rejected');
  await assert.rejects(prepareCloudRunIdentity({ ...f.options, saved: f.saved }));
  assert.equal(f.events.filter(e => e.startsWith('save:rejected')).length, 1);
});
