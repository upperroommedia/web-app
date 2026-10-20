import test from 'node:test';
import assert from 'node:assert/strict';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { renderServerlessWorkerPool } from './temporal-serverless-resources.mjs';
const buildId = 'c'.repeat(40);
const config = (role) => ({
  projectId: 'urm-app-staging',
  region: 'us-central1',
  namespace: 'urm-app-staging.qwejt',
  buildId,
  role,
  ...serverlessResourceNames(buildId, role),
  image: `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'d'.repeat(64)}`,
  maxInstances: 1,
  stabilizationSeconds: 180,
});
const settings = () => ({ apiKeyVersion: '3', runtimeSecrets: [] });
test('a controls pool starts at zero with one queue, its own identity and no provider secrets', () => {
  const c = config('controls');
  const pool = renderServerlessWorkerPool(c, settings());
  assert.equal(pool.name, `projects/${c.projectId}/locations/${c.region}/workerPools/${c.poolName}`);
  assert.equal(pool.scaling.manualInstanceCount, 0);
  assert.equal(pool.template.serviceAccount, c.runnerServiceAccount);
  const worker = pool.template.containers[0];
  assert.equal(worker.image, c.image);
  assert.equal(worker.name, 'worker');
  const env = Object.fromEntries(worker.env.map((entry) => [entry.name, entry.value]));
  assert.equal(env.TEMPORAL_TASK_QUEUES, 'urm-controls');
  assert.equal(env.TEMPORAL_DISPATCHER_ENABLED, 'false');
  assert.equal(env.TEMPORAL_WORKER_HOSTING, 'cloud-run');
  assert.equal(env.TEMPORAL_WORKER_IMAGE, c.image);
  assert.equal(env.STAGING_PROVIDER_MODE, 'sandbox');
  assert.equal(Object.hasOwn(env, 'GOOGLE_APPLICATION_CREDENTIALS'), false);
  assert.equal(Object.hasOwn(env, 'CLOUD_RUN_REVISION'), false);
  assert.equal(
    worker.env.some((entry) => entry.valueSource),
    false
  );
  assert.equal(pool.template.volumes[0].secret.items[0].version, '3');
});
test('media gets a disk-backed workspace and preserves the full source/output/headroom budgets', () => {
  const pool = renderServerlessWorkerPool(config('media'), settings());
  const worker = pool.template.containers[0];
  const env = Object.fromEntries(worker.env.map((entry) => [entry.name, entry.value]));
  assert.equal(env.TEMPORAL_MEDIA_CONCURRENCY, '1');
  assert.equal(env.TEMPORAL_MEDIA_WORKSPACE_MAX_BYTES, String(64 * 2 ** 30));
  assert.equal(env.TEMPORAL_MEDIA_DISK_HEADROOM_BYTES, String(16 * 2 ** 30));
  assert.deepEqual(pool.template.volumes.find((volume) => volume.name === 'scratch').emptyDir, {
    medium: 'DISK',
    sizeLimit: '100Gi',
  });
  assert.equal(worker.resources.limits.cpu, '2');
});
test('search uses an immutable same-project Secret Manager reference, never a literal write key', () => {
  const options = settings();
  options.runtimeSecrets.push({ name: 'TEMPORAL_SEARCH_CONFIG_JSON', secret: 'TEMPORAL_SEARCH_CONFIG', version: '7' });
  const pool = renderServerlessWorkerPool(config('search'), options);
  const entry = pool.template.containers[0].env.find((entry) => entry.name === 'TEMPORAL_SEARCH_CONFIG_JSON');
  assert.deepEqual(entry.valueSource.secretKeyRef, { secret: 'TEMPORAL_SEARCH_CONFIG', version: '7' });
  assert.equal(Object.hasOwn(entry, 'value'), false);
});
for (const options of [
  { apiKeyVersion: 'latest', runtimeSecrets: [] },
  { apiKeyVersion: '1', runtimeSecrets: [{ name: 'SUBSPLASH_PASSWORD', secret: 'SUBSPLASH_PASSWORD', version: '2' }] },
  { apiKeyVersion: '1', runtimeSecrets: [{ name: 'TEMPORAL_BUILD_ID', secret: 'OTHER', version: '2' }] },
  { apiKeyVersion: '1', runtimeSecrets: [], environment: { GOOGLE_APPLICATION_CREDENTIALS: '/file' } },
])
  test('rejects unsafe resource settings before rendering', () =>
    assert.throws(() => renderServerlessWorkerPool(config('controls'), options)));
test('required role configuration cannot silently omit search or email descriptors', () => {
  assert.throws(() => renderServerlessWorkerPool(config('search'), settings()));
  assert.throws(() => renderServerlessWorkerPool(config('email'), settings()));
});
test('orchestration preserves approved operational alert recipients and admin URL', () => {
  const options = settings();
  assert.throws(() => renderServerlessWorkerPool(config('orchestration'), options));
  options.runtimeSecrets.push({ name: 'RUNTIME_ALERT_RECIPIENTS', secret: 'RUNTIME_ALERT_RECIPIENTS', version: '2' });
  assert.throws(() => renderServerlessWorkerPool(config('orchestration'), options));
  options.runtimeSecrets.push({ name: 'ADMIN_BASE_URL', secret: 'ADMIN_BASE_URL', version: '4' });
  const pool = renderServerlessWorkerPool(config('orchestration'), options);
  assert.equal(
    pool.template.containers[0].env.find((entry) => entry.name === 'ADMIN_BASE_URL').valueSource.secretKeyRef.version,
    '4'
  );
});
