import test from 'node:test';
import assert from 'node:assert/strict';
import { serverlessResourceNames, serverlessComputeArguments } from './temporal-serverless-platform.mjs';
const buildId = 'a'.repeat(40);
const binding = () => ({
  projectId: 'urm-app-staging',
  region: 'us-central1',
  namespace: 'urm-app-staging.qwejt',
  deploymentName: 'urm-worker-staging',
  buildId,
  role: 'orchestration',
  ...serverlessResourceNames(buildId, 'orchestration'),
  image: `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`,
  maxInstances: 1,
  stabilizationSeconds: 180,
});
test('pins immutable version resources and all native scaler flags without executing a command', () => {
  const config = binding();
  const args = serverlessComputeArguments(config);
  assert.deepEqual(args.slice(0, 3), ['worker', 'deployment', 'update-version-compute-config']);
  const flags = Object.fromEntries(
    Array.from({ length: (args.length - 3) / 2 }, (_, i) => [args[3 + i * 2], args[4 + i * 2]])
  );
  assert.equal(flags['--gcp-cloud-run-min-instances'], '0');
  assert.equal(flags['--gcp-cloud-run-initial-instances'], '0');
  assert.equal(flags['--gcp-cloud-run-max-instances'], '1');
  assert.equal(flags['--gcp-cloud-run-scale-down-stabilization-duration'], '180s');
  assert.equal(flags['--gcp-cloud-run-utilization-target'], '0.8');
  assert.equal(flags['--gcp-cloud-run-service-account'], config.invokerServiceAccount);
  assert.notEqual(config.invokerServiceAccount, config.runnerServiceAccount);
  assert.equal(flags['--gcp-cloud-run-worker-pool'], config.poolName);
  assert.equal(flags['--build-id'], buildId);
  assert.equal(args.includes('set-current-version'), false);
});
for (const patch of [
  { projectId: 'urm-app' },
  { namespace: 'urm-app.qwejt' },
  { region: 'us-east1' },
  { buildId: 'tag' },
  { poolName: 'mutable-pool' },
  { image: 'image:latest' },
  { runnerServiceAccount: 'temporal-worker@urm-app-staging.iam.gserviceaccount.com' },
  { invokerServiceAccount: 'owner@urm-app.iam.gserviceaccount.com' },
  { maxInstances: 0 },
  { maxInstances: 30 },
  { maxInstances: 1.5 },
  { stabilizationSeconds: -1 },
  { stabilizationSeconds: 0 },
])
  test(`rejects an unsafe staging binding ${JSON.stringify(patch)}`, () => {
    assert.throws(() => serverlessComputeArguments({ ...binding(), ...patch }));
  });

test('each queue uses its own deployment, pool and least-privilege service identities', () => {
  const roles = ['orchestration', 'controls', 'media', 'email', 'images', 'search'];
  const names = roles.map((role) => serverlessResourceNames(buildId, role));
  for (const field of ['poolName', 'deploymentName', 'runnerServiceAccount', 'invokerServiceAccount'])
    assert.equal(new Set(names.map((name) => name[field])).size, roles.length);
  for (let index = 0; index < roles.length; index++) {
    assert.equal(names[index].taskQueue, `urm-${roles[index]}`);
    const args = serverlessComputeArguments({ ...binding(), role: roles[index], ...names[index] });
    assert.equal(args[args.indexOf('--deployment-name') + 1], names[index].deploymentName);
  }
  assert.throws(() => serverlessResourceNames(buildId, 'unknown'));
  assert.throws(() => serverlessResourceNames(buildId, ['controls']));
  assert.throws(() => serverlessComputeArguments({ ...binding(), role: 'controls' }));
});
test('media scaler cannot exceed the single reviewed regional workspace', () => {
  const media = { ...binding(), role: 'media', ...serverlessResourceNames(buildId, 'media'), maxInstances: 2 };
  assert.throws(() => serverlessComputeArguments(media));
  assert.doesNotThrow(() => serverlessComputeArguments({ ...binding(), maxInstances: 2 }));
});
