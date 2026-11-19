import test from 'node:test';
import assert from 'node:assert/strict';
import { observeNamespaceComputeIsolation, observeNamespaceWorkerCompute } from './temporal-compute-isolation.mjs';
import { serverlessComputeSettings, serverlessResourceNames } from './temporal-serverless-platform.mjs';
function fixture() {
  const calls = [];
  const service = {
    listWorkerDeployments: async request => { calls.push('list'); assert.equal(request.namespace, 'urm-app-staging.qwejt'); return { workerDeployments: [{ name: 'urm-worker-staging' }], nextPageToken: new Uint8Array() }; },
    describeWorkerDeployment: async () => ({ workerDeploymentInfo: { name: 'urm-worker-staging', routingConfig: { currentDeploymentVersion: { deploymentName: 'urm-worker-staging', buildId: 'old' } },
      versionSummaries: [{ deploymentVersion: { deploymentName: 'urm-worker-staging', buildId: 'old' } }] } }),
    describeWorkerDeploymentVersion: async () => ({ workerDeploymentVersionInfo: { deploymentVersion: { deploymentName: 'urm-worker-staging', buildId: 'old' } } }),
  };
  return { calls, service, client: { connection: { workflowService: service, withDeadline: async (end, callback) => { assert.ok(end <= Date.now() + 10000); return callback(); } } } };
}
test('two complete stable inventories observe absence without touching version/routing', async () => {
  const f = fixture(), result = await observeNamespaceComputeIsolation(f.client, 'urm-app-staging.qwejt');
  assert.equal(result.deploymentCount, 1); assert.equal(result.versionCount, 1); assert.equal(f.calls.length, 2);
});
test('media switch changes full inventory but only allowed media routing fields leave the promotion inventory stable', async () => {
  const f = fixture();
  const namespace = 'urm-app-staging.qwejt';
  const media = 'urm-worker-media-staging', peer = 'urm-worker-staging';
  let current = false;
  let peerBuild = 'old';
  let managerIdentity = 'owned-manager';
  let ramp = 0;
  f.service.listWorkerDeployments = async () => ({ workerDeployments: [{ name: media }, { name: peer }] });
  f.service.describeWorkerDeployment = async ({ deploymentName }) => ({
    workerDeploymentInfo: {
      name: deploymentName,
      managerIdentity,
      lastModifierIdentity: current && deploymentName === media ? 'actual-promotion' : 'original',
      routingConfig: deploymentName === peer
        ? { currentDeploymentVersion: { deploymentName, buildId: peerBuild } }
        : { rampingVersionPercentage: ramp, ...(current && {
          currentDeploymentVersion: { deploymentName, buildId: 'candidate' },
          currentVersionChangedTime: { seconds: '1' },
        }) },
      versionSummaries: [{ deploymentVersion: { deploymentName, buildId: deploymentName === media ? 'candidate' : peerBuild } }],
    },
  });
  f.service.describeWorkerDeploymentVersion = async ({ deploymentVersion }) => ({ workerDeploymentVersionInfo: { deploymentVersion } });
  const scan = () => observeNamespaceComputeIsolation(f.client, namespace, { mediaPromotion: true });
  const before = await scan();
  current = true;
  const after = await scan();
  assert.notEqual(before.inventorySHA256, after.inventorySHA256);
  assert.equal(before.mediaPromotionSHA256, after.mediaPromotionSHA256);
  peerBuild = 'foreign';
  assert.notEqual((await scan()).mediaPromotionSHA256, after.mediaPromotionSHA256);
  peerBuild = 'old';
  ramp = 5;
  assert.notEqual((await scan()).mediaPromotionSHA256, after.mediaPromotionSHA256);
  ramp = 0;
  managerIdentity = 'other-manager';
  assert.notEqual((await scan()).mediaPromotionSHA256, after.mediaPromotionSHA256);
});
test('version configuration reads overlap in bounded batches and still cover two full inventories', async () => {
  const f = fixture();
  const deploymentName = 'urm-worker-staging';
  const builds = Array.from({ length: 9 }, (_, index) => `build-${index}`);
  const observed = [];
  let active = 0;
  let maxActive = 0;
  f.service.describeWorkerDeployment = async () => ({
    workerDeploymentInfo: {
      name: deploymentName,
      versionSummaries: builds.map((buildId) => ({ deploymentVersion: { deploymentName, buildId } })),
    },
  });
  f.service.describeWorkerDeploymentVersion = async ({ deploymentVersion }) => {
    observed.push(deploymentVersion.buildId);
    maxActive = Math.max(maxActive, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return { workerDeploymentVersionInfo: { deploymentVersion } };
  };
  const result = await observeNamespaceComputeIsolation(f.client, 'urm-app-staging.qwejt');
  assert.equal(result.versionCount, builds.length);
  assert.deepEqual(observed, [...builds, ...builds]);
  assert.equal(maxActive, 4);
});
test('every call stays inside the parent release deadline', async () => {
  const f = fixture();
  const namespace = 'urm-app-staging.qwejt';
  const deadline = Date.now() + 5000;
  f.client.connection.withDeadline = async (end, callback) => {
    assert.equal(end, deadline);
    return callback();
  };
  assert.equal((await observeNamespaceComputeIsolation(f.client, namespace, { deadline })).versionCount, 1);
  await assert.rejects(observeNamespaceComputeIsolation(f.client, namespace, { deadline: Date.now() - 1 }));
  assert.equal(f.calls.length, 2);
});
for (const bad of ['compute', 'unknown-compute', 'missing-versions', 'duplicate', 'routing-drift', 'repeat-token', 'wrong-version'])
  test(`denies ${bad} instead of treating incomplete state as no association`, async () => {
    const f = fixture();
    const describe = f.service.describeWorkerDeployment;
    let reads = 0;
    f.service.describeWorkerDeployment = async () => {
      const value = await describe(); reads++;
      if (bad === 'missing-versions') delete value.workerDeploymentInfo.versionSummaries;
      if (bad === 'duplicate') value.workerDeploymentInfo.versionSummaries.push(value.workerDeploymentInfo.versionSummaries[0]);
      if (bad === 'routing-drift' && reads === 2) value.workerDeploymentInfo.routingConfig.currentDeploymentVersion.buildId = 'changed';
      return value;
    };
    if (bad === 'repeat-token') f.service.listWorkerDeployments = async () => ({ workerDeployments: [], nextPageToken: Uint8Array.from([1]) });
    const version = f.service.describeWorkerDeploymentVersion;
    f.service.describeWorkerDeploymentVersion = async () => {
      const value = await version();
      if (bad === 'compute') value.workerDeploymentVersionInfo.computeConfig = { scalingGroups: { group: {} } };
      if (bad === 'unknown-compute') value.workerDeploymentVersionInfo.computeConfig = { futureProvider: {} };
      if (bad === 'wrong-version') value.workerDeploymentVersionInfo.deploymentVersion.buildId = 'different';
      return value;
    };
    await assert.rejects(observeNamespaceComputeIsolation(f.client, 'urm-app-staging.qwejt'), /ISOLATION_UNCONFIRMED/);
  });
test('pinned native protobuf omitted bytes cursor is a safe final page', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { temporal } = require('@temporalio/proto');
  const codec = temporal.api.workflowservice.v1.ListWorkerDeploymentsResponse;
  const decoded = codec.decode(codec.encode({ workerDeployments: [] }).finish());
  assert.equal(decoded.nextPageToken.length, 0);
  const f = fixture(); f.service.listWorkerDeployments = async () => decoded;
  assert.equal((await observeNamespaceComputeIsolation(f.client, 'urm-app-staging.qwejt')).deploymentCount, 0);
});

for (const cursor of [[1], '', 'cursor', {}, 0])
  test(`reject malformed native pagination cursor ${JSON.stringify(cursor)}`, async () => {
    const f = fixture(); f.service.listWorkerDeployments = async () => ({ workerDeployments: [], nextPageToken: cursor });
    await assert.rejects(observeNamespaceComputeIsolation(f.client, 'urm-app-staging.qwejt'));
  });

test('attachment inventory requires exact attached peers and permits only the target transition', async () => {
  const namespace = 'urm-app-staging.qwejt';
  const buildId = 'a'.repeat(40);
  const binding = role => ({
    role, buildId, namespace, projectId: 'urm-app-staging', region: 'us-central1',
    ...serverlessResourceNames(buildId, role),
    image: `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`,
    maxInstances: 1, stabilizationSeconds: 180,
  });
  const association = binding => ({
    scalingGroups: { default: Object.fromEntries(Object.entries(serverlessComputeSettings(binding)).map(([key, spec]) =>
      [key, { type: spec.type, details: { metadata: { encoding: Buffer.from('json/plain') },
        data: Buffer.from(JSON.stringify(spec.details)) } }])) },
  });
  const attached = binding('orchestration'), target = binding('controls');
  const configs = new Map([[attached.deploymentName, association(attached)]]);
  let legacyConfig;
  const f = fixture();
  f.service.listWorkerDeployments = async () => ({
    workerDeployments: [attached, target].map(({ deploymentName }) => ({ name: deploymentName })),
  });
  f.service.describeWorkerDeployment = async ({ deploymentName }) => ({
    workerDeploymentInfo: {
      name: deploymentName,
      versionSummaries: [buildId, ...(deploymentName === attached.deploymentName ? ['old'] : [])]
        .map(buildId => ({ deploymentVersion: { deploymentName, buildId } })),
    },
  });
  f.service.describeWorkerDeploymentVersion = async ({ deploymentVersion }) => ({
    workerDeploymentVersionInfo: { deploymentVersion,
      computeConfig: deploymentVersion.buildId === 'old' ? legacyConfig : configs.get(deploymentVersion.deploymentName) },
  });
  const observe = () => observeNamespaceWorkerCompute(f.client, namespace, { attached: [attached], target });
  assert.equal((await observe()).target, 'absent');
  configs.set(target.deploymentName, association(target));
  assert.equal((await observe()).target, 'exact');
  legacyConfig = association(attached);
  await assert.rejects(observe(), /ISOLATION_UNCONFIRMED/);
  legacyConfig = undefined;
  configs.set(attached.deploymentName, association({ ...attached, maxInstances: 2 }));
  await assert.rejects(observe(), /ISOLATION_UNCONFIRMED/);
  configs.delete(attached.deploymentName);
  await assert.rejects(observe(), /ISOLATION_UNCONFIRMED/);
});
