import test from 'node:test';
import assert from 'node:assert/strict';
import { observeNamespaceComputeIsolation } from './temporal-compute-isolation.mjs';
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
