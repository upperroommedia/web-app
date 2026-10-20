import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCloudRunReleasePlatform, readCloudRunOperatorKey, readCloudRunNamespaceEvidence, collectCloudRunReleaseWorkers } from './temporal-release-cloud-run.mjs';
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
    operatorApiKeyFile: '/private/tmp/operator-api-key', operatorApiKeySHA256: 'c'.repeat(64), dispatch: dispatchResourceNames(buildId),
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
