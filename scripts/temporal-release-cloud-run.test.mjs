import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCloudRunReleasePlatform, readCloudRunOperatorKey, readCloudRunNamespaceEvidence, collectCloudRunReleaseWorkers, verifyCloudRunScalerPolicies, temporalCloudScalerPrincipals } from './temporal-release-cloud-run.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { dispatchResourceNames } from './temporal-serverless-dispatch-resources.mjs';
import { validateWorkerCoverage } from './temporal-release-lib.mjs';
import { loadReleaseResourceBinding } from './temporal-release-runtime.mjs';
const buildId = 'a'.repeat(40), image = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`;
function profile() {
  const workerRoles = ['orchestration', 'controls', 'email', 'search'];
  return {
    schemaVersion: 1, environment: 'staging', workerHosting: 'cloud-run', connectionMode: 'temporal-cloud',
    firebaseProjectId: 'urm-app-staging', firebaseResources: { storageBucket: 'urm-app-staging.firebasestorage.app',
      imagesBucket: 'urm-app-staging-images', databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/' },
    temporalNamespace: 'urm-app-staging.qwejt', cloudAccountId: 'qwejt', cloudProvider: 'gcp', cloudRegion: 'us-central1',
    cloudAddress: 'us-central1.gcp.api.temporal.io:7233', cloudReplicaRegions: [], cloudEvidence: '/private/tmp/cloud-evidence.json',
    workerBuildId: buildId, workerImage: image, workerRoles, dispatcherEnabled: false,
    operatorApiKeyFile: '/private/tmp/operator-api-key', operatorApiKeySHA256: 'c'.repeat(64), dispatch: { ...dispatchResourceNames(buildId), apiKeyVersion: '7' },
    roleBindings: workerRoles.map(role => ({ projectId: 'urm-app-staging', region: 'us-central1', namespace: 'urm-app-staging.qwejt',
      buildId, role, ...serverlessResourceNames(buildId, role), image, maxInstances: 1, stabilizationSeconds: 180 })),
  };
}
const peer = { environment: 'production', firebaseProjectId: 'urm-app', firebaseResources: {
  storageBucket: 'urm-app.appspot.com', imagesBucket: 'urm-app-images', databaseUrl: 'https://urm-app-default-rtdb.firebaseio.com/' } };
test('cloud descriptor binds real hosting without fabricated cluster fields and retains release resource checks', () => {
  const p = profile(); assert.equal(validateCloudRunReleasePlatform(p, peer), p);
  const release = { projectId: 'urm-app-staging', environment: 'staging', location: 'us-central1', compatibilityCommit: buildId,
    domains: ['publishing', 'emails', 'search'], databaseUrl: p.firebaseResources.databaseUrl,
    platformConfig: '/private/tmp/platform.json', platformPeerConfig: '/private/tmp/peer.json' };
  assert.equal(validateWorkerCoverage(release, p), p);
  const binding = loadReleaseResourceBinding(release, { read: path => Buffer.from(JSON.stringify(path === release.platformConfig ? p : peer)) });
  assert.equal(binding.workerImage, image); assert.equal(binding.projectId, release.projectId);
  assert.throws(() => validateWorkerCoverage({ ...release, domains: [...release.domains, 'media'] }, p));
  assert.throws(() => validateWorkerCoverage({ ...release, compatibilityCommit: 'c'.repeat(40) }, p));
});
for (const mismatch of ['production', 'cluster', 'dispatcher', 'missing-role', 'foreign-image', 'foreign-dispatch', 'foreign-peer'])
  test(`cloud descriptor rejects ${mismatch}`, () => {
    const p = profile(); let other = structuredClone(peer);
    if (mismatch === 'production') p.environment = 'production';
    if (mismatch === 'cluster') p.clusterUid = 'fake-cluster';
    if (mismatch === 'dispatcher') p.dispatcherEnabled = true;
    if (mismatch === 'missing-role') p.roleBindings.pop();
    if (mismatch === 'foreign-image') p.roleBindings[0].image = image.replace('b'.repeat(64), 'c'.repeat(64));
    if (mismatch === 'foreign-dispatch') p.dispatch.service = p.dispatch.service.replace('urm-app-staging', 'urm-app');
    if (mismatch === 'foreign-peer') other.firebaseResources.storageBucket = p.firebaseResources.storageBucket;
    assert.throws(() => validateCloudRunReleasePlatform(p, other));
  });
test('private operator key uses a bounded same-file descriptor and refuses public permissions or symlinks', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cloud-release-key-test-'))), path = join(directory, 'key');
  const digest = createHash('sha256').update('synthetic-only').digest('hex');
  try {
    await writeFile(path, 'synthetic-only\n', { mode: 0o600 });
    assert.equal(await readCloudRunOperatorKey(path, digest), 'synthetic-only');
    await assert.rejects(readCloudRunOperatorKey(path, 'd'.repeat(64)));
    await chmod(path, 0o644); await assert.rejects(readCloudRunOperatorKey(path, digest));
    await chmod(path, 0o600); await symlink(path, join(directory, 'link'));
    await assert.rejects(readCloudRunOperatorKey(join(directory, 'link'), digest));
    await writeFile(path, 'x'.repeat(16385)); await assert.rejects(readCloudRunOperatorKey(path, digest));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('malformed namespace evidence never echoes private file bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cloud-release-evidence-test-')), path = join(directory, 'evidence');
  try {
    await writeFile(path, 'SYNTHETIC_PRIVATE_VALUE', { mode: 0o600 });
    await assert.rejects(readCloudRunNamespaceEvidence({ cloudEvidence: path }), error =>
      error.message === 'CLOUD_RUN_NAMESPACE_EVIDENCE_UNCONFIRMED' && !error.message.includes('SYNTHETIC_PRIVATE_VALUE'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('definite pre-intent key failure leaves normal operation cleanup eligible', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cloud-release-preflight-test-')));
  let probePending = false;
  try {
    const p = profile(); p.operatorApiKeyFile = join(directory, 'key');
    await writeFile(p.operatorApiKeyFile, 'synthetic-only', { mode: 0o600 });
    // The mismatched SHA must fail before runtime loading or any native operation.
    await assert.rejects(collectCloudRunReleaseWorkers({ platform: p, binding: {}, config: {},
      firestore: null, artifactDirectory: directory, recordIntent: async () => { probePending = true; } }));
    assert.equal(probePending, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


function policyApi(p, mutate = () => {}) {
  const calls = [],
    ids = new Map();
  const api = async (url, method = 'GET', body) => {
    calls.push({ url, method, body });
    const binding = p.roleBindings.find(
      (b) => url.includes(b.runnerServiceAccount) || url.includes(b.invokerServiceAccount) || url.includes(b.poolName)
    );
    assert.ok(binding, 'all resources must bind to an exact role');
    let result;
    if (!url.includes(':getIamPolicy')) {
      const email = url.split('/').at(-1);
      if (!ids.has(email)) ids.set(email, String(100000000000000000000n + BigInt(ids.size)));
      result = { email, projectId: 'urm-app-staging', uniqueId: ids.get(email) };
    } else {
      assert.equal(body, undefined, 'getIamPolicy has an empty request body');
      assert.ok(url.endsWith('?options.requestedPolicyVersion=3'));
      if (url.includes('iam.googleapis.com')) assert.equal(method, 'POST');
      else assert.equal(method, 'GET');
      result = {
        etag: 'synthetic-etag',
        version: 3,
        bindings: url.includes(binding.poolName)
          ? [
              { role: 'roles/run.viewer', members: [`serviceAccount:${binding.runnerServiceAccount}`] },
              { role: 'roles/run.developer', members: [`serviceAccount:${binding.invokerServiceAccount}`] },
            ]
          : url.includes(binding.runnerServiceAccount)
          ? [{ role: 'roles/iam.serviceAccountUser', members: [`serviceAccount:${binding.invokerServiceAccount}`] }]
          : [{ role: 'roles/iam.serviceAccountTokenCreator', members: [...temporalCloudScalerPrincipals] }],
      };
    }
    mutate(result, url);
    return result;
  };
  return { api, calls };
}
test('mandatory scaler gate joins native accounts and exact direct trust/pool policies without writes', async () => {
  const p = profile(),
    { api, calls } = policyApi(p);
  const proof = await verifyCloudRunScalerPolicies(p, api);
  assert.equal(proof.roles.length, p.workerRoles.length);
  assert.equal(calls.length, p.workerRoles.length * 5);
  assert.equal(proof.buildId, buildId);
  assert.match(proof.scope, /inherited and effective access not established/);
  for (const role of proof.roles) {
    assert.equal(role.directPolicySHA256.length, 3);
    assert.ok(role.directPolicySHA256.every((sha) => /^[a-f0-9]{64}$/.test(sha)));
    assert.notEqual(role.runner.uniqueId, role.scaler.uniqueId);
  }
  assert.equal(
    calls.some((c) => /setIamPolicy|generateAccessToken|create|update/.test(c.url)),
    false
  );
});
for (const concern of [
  'disabled',
  'foreign-project',
  'missing-principal',
  'extra-principal',
  'conditional',
  'public',
  'cross-role',
  'duplicate-member',
  'missing-etag',
  'private-error',
])
  test(`scaler gate denies ${concern} with a fixed error`, async () => {
    const p = profile();
    const { api } = policyApi(p, (result, url) => {
      if (concern === 'private-error') throw new Error('SYNTHETIC_PRIVATE_API_PAYLOAD');
      if (!url.includes(':getIamPolicy')) {
        if (concern === 'disabled') result.disabled = true;
        if (concern === 'foreign-project') result.projectId = 'urm-app';
        return;
      }
      if (concern === 'missing-principal') result.bindings[0].members.pop();
      if (concern === 'extra-principal') result.bindings[0].members.push('user:other@example.test');
      if (concern === 'conditional') result.bindings[0].condition = { expression: 'true' };
      if (concern === 'public') result.bindings[0].members = ['allUsers'];
      if (concern === 'cross-role')
        result.bindings[0].members = [`serviceAccount:${p.roleBindings[1].runnerServiceAccount}`];
      if (concern === 'duplicate-member') result.bindings[0].members.push(result.bindings[0].members[0]);
      if (concern === 'missing-etag') delete result.etag;
    });
    await assert.rejects(
      verifyCloudRunScalerPolicies(p, api),
      (error) => error.message === 'CLOUD_RUN_SCALER_POLICY_UNCONFIRMED'
    );
  });

for (const version of ['latest', '', '0', 7, null])
  test(`dispatch key version must be a pinned numeric string: ${JSON.stringify(version)}`, () => {
    const p = profile(); p.dispatch.apiKeyVersion = version;
    assert.throws(() => validateCloudRunReleasePlatform(p));
  });
