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
  ...serverlessResourceNames(buildId),
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
