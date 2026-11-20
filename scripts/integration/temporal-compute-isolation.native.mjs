import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { observeNamespaceComputeIsolation } from '../temporal-compute-isolation.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
require('ts-node').register({ skipProject: true, transpileOnly: true, compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' } });
const { createLocalTestEnvironment } = require(fileURLToPath(new URL('../../apps/temporal-worker/src/test-support/local-test-environment.ts', import.meta.url)));
const { Worker, Runtime, DefaultLogger } = require('@temporalio/worker');
Runtime.install({ logger: new DefaultLogger('WARN', () => undefined) });
test('actual local SDK inventories every created deployment/version and keeps routing unchanged', async () => {
  const environment = await createLocalTestEnvironment({ server: { namespace: 'urm-app-staging.qwejt', executable: { type: 'cached-download', version: 'v1.9.1' } } });
  const workers = [], failures = [];
  try {
    const client = environment.client, service = client.connection.workflowService;
    const empty = await observeNamespaceComputeIsolation(client, 'urm-app-staging.qwejt');
    assert.equal(empty.deploymentCount, 0);
    for (const deploymentName of ['urm-worker-staging', 'urm-worker-controls-staging']) {
      const worker = await Worker.create({ connection: environment.nativeConnection, namespace: 'urm-app-staging.qwejt',
        taskQueue: `local-isolation-${deploymentName}`, activities: { unusedNativeMarker: async () => { throw new Error('Fixture must not execute work'); } },
        workerDeploymentOptions: { version: { deploymentName, buildId: 'a'.repeat(40) }, useWorkerVersioning: true, defaultVersioningBehavior: 'PINNED' },
        shutdownGraceTime: '2 seconds', shutdownForceTime: '10 seconds' });
      const done = worker.run(); void done.catch(error => failures.push(error)); workers.push({ worker, done });
      const deadline = Date.now() + 20000;
      let found = false;
      while (Date.now() < deadline) {
        try {
          const report = await client.connection.withDeadline(Date.now() + 5000, () => service.describeWorkerDeploymentVersion({ namespace: 'urm-app-staging.qwejt',
            deploymentVersion: { deploymentName, buildId: 'a'.repeat(40) } }));
          if (report.workerDeploymentVersionInfo?.taskQueueInfos?.length) { found = true; break; }
        } catch (error) { if (error.code !== 5) throw error; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(found, true, 'native pollers must register before inventory');
    }
    const result = await observeNamespaceComputeIsolation(client, 'urm-app-staging.qwejt');
    assert.equal(result.deploymentCount, 2); assert.equal(result.versionCount, 2);
    assert.match(result.scope, /not cross-API exclusion/);
    assert.equal(failures.length, 0);
  } finally {
    const cleanup = [];
    for (const { worker } of workers) { try { worker.shutdown(); } catch (error) { cleanup.push(error); } }
    for (const result of await Promise.allSettled(workers.map(item => item.done))) if (result.status === 'rejected') cleanup.push(result.reason);
    try { await environment.teardown(); } catch (error) { cleanup.push(error); }
    if (cleanup.length) throw new AggregateError(cleanup, 'Native fixture cleanup failed');
  }
});
