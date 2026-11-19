import assert from 'node:assert/strict';
import test from 'node:test';
import { attachWorkerCompute, observeWorkerCompute } from './temporal-attach-worker-compute.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';

const buildId = 'a'.repeat(40);
const binding = {
  projectId: 'urm-app-staging',
  region: 'us-central1',
  namespace: 'urm-app-staging.qwejt',
  role: 'controls',
  ...serverlessResourceNames(buildId, 'controls'),
  buildId,
  image: `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`,
  maxInstances: 2,
  stabilizationSeconds: 180,
};
const denial = /CLOUD_RUN_WORKER_COMPUTE_ATTACHMENT_UNCONFIRMED/;

function fixture() {
  let config;
  let saved;
  let attempts = 0;
  let decision = 'ack';
  let guard = 'c'.repeat(64);
  const service = {
    async describeWorkerDeploymentVersion({ namespace, deploymentVersion }) {
      assert.equal(namespace, binding.namespace);
      assert.deepEqual(deploymentVersion, { deploymentName: binding.deploymentName, buildId });
      return {
        workerDeploymentVersionInfo: { deploymentVersion, currentSinceTime: { seconds: 1 }, computeConfig: config },
      };
    },
    async updateWorkerDeploymentVersionComputeConfig(request) {
      attempts++;
      assert.equal(saved.stage, 'attempted');
      assert.equal(request.requestId, saved.plan.operationId);
      assert.equal(request.identity, `urm-controls-compute-${request.requestId}`);
      const update = request.computeConfigScalingGroups.default;
      assert.deepEqual(update.updateMask.paths, ['provider.type', 'provider.details', 'scaler.type', 'scaler.details']);
      const { provider, scaler } = update.scalingGroup;
      assert.equal(provider.type, 'gcp-cloud-run');
      assert.equal(scaler.type, 'rate-based');
      assert.deepEqual(JSON.parse(provider.details.data), {
        project: binding.projectId,
        region: binding.region,
        worker_pool: binding.poolName,
        service_account: binding.invokerServiceAccount,
      });
      assert.deepEqual(JSON.parse(scaler.details.data), {
        initial_count: 1,
        min_count: 0,
        max_count: 2,
        no_sync_quiet_ms: 180000,
        utilization_target: 0.8,
      });
      if (decision !== 'lost-before') config = { scalingGroups: { default: update.scalingGroup } };
      if (decision !== 'ack') throw new Error('lost request outcome');
      return {};
    },
  };
  const options = {
    binding,
    client: {
      options: { namespace: binding.namespace },
      connection: {
        options: { channelArgs: { 'grpc.enable_retries': 0 }, interceptors: [] },
        withDeadline: async (_, callback) => callback(),
        workflowService: service,
      },
    },
    operationId: '11111111-1111-4111-8111-111111111111',
    releaseId: '22222222-2222-4222-8222-222222222222',
    bindingDigest: 'd'.repeat(64),
    evidenceDigest: 'e'.repeat(64),
    observeProtection: async (expected) => {
      assert.equal(observeWorkerCompute(config, binding), expected);
      return { observedAt: Date.now(), protectionSHA256: guard };
    },
    authorize: async () => {},
    save: async (state) => {
      saved = state;
    },
  };
  return {
    options,
    run: () => attachWorkerCompute({ ...options, saved }),
    saved: () => saved,
    config: () => config,
    attempts: () => attempts,
    decision: (value) => {
      decision = value;
    },
    drift: () => {
      guard = 'f'.repeat(64);
    },
  };
}

test('native compute attach uses exact role bindings, persists before update and rereads the same version', async () => {
  const f = fixture();
  assert.equal((await f.run()).outcome, 'native-acknowledgement-and-readback');
  assert.equal(observeWorkerCompute(f.config(), binding), 'exact');
  const { default: group } = f.config().scalingGroups;
  assert.equal(
    observeWorkerCompute({ scalingGroups: { default: { ...group, taskQueueTypes: [] } } }, binding),
    'exact'
  );
  assert.throws(
    () => observeWorkerCompute({ scalingGroups: { default: { ...group, taskQueueTypes: [1] } } }, binding),
    denial
  );
  assert.throws(() => observeWorkerCompute({ scalingGroups: { default: group, other: group } }, binding), denial);
  assert.throws(() => observeWorkerCompute(f.config(), { ...binding, maxInstances: 3 }), denial);
  await f.run();
  assert.equal(f.attempts(), 1);
});

test('unknown update acknowledgement reconciles exactly once when the compute is present', async () => {
  const f = fixture();
  f.decision('lost-after');
  assert.equal((await f.run()).outcome, 'desired-compute-observed-after-unknown-ack');
  await f.run();
  assert.equal(f.attempts(), 1);
});

test('unknown update with no observed compute stays attempted across invocations', async () => {
  const f = fixture();
  f.decision('lost-before');
  await assert.rejects(f.run(), denial);
  assert.equal(f.saved().stage, 'attempted');
  await assert.rejects(f.run(), denial);
  assert.equal(f.attempts(), 1);
});

test('changed handoff protection denies update even after persisting the attempt', async () => {
  const f = fixture();
  const save = f.options.save;
  f.options.save = async (state) => {
    await save(state);
    f.drift();
  };
  await assert.rejects(f.run(), denial);
  await assert.rejects(f.run(), denial);
  assert.equal(f.saved().stage, 'attempted');
  assert.equal(f.attempts(), 0);
});

test('a saved update cannot be reused with different scaler settings', async () => {
  const f = fixture();
  f.decision('lost-before');
  await assert.rejects(f.run(), denial);
  f.options.binding = { ...binding, stabilizationSeconds: 181 };
  await assert.rejects(f.run(), denial);
  assert.equal(f.attempts(), 1);
});
