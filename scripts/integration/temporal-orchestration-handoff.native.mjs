import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { handoffOrchestration } from '../temporal-orchestration-handoff.mjs';
import { proofDigest } from '../temporal-release-runtime.mjs';

const require = createRequire(new URL('../../package.json', import.meta.url));
require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const { createLocalTestEnvironment } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/test-support/local-test-environment.ts', import.meta.url)
));
const { Connection, Client } = require('@temporalio/client');
const { Worker, Runtime, DefaultLogger } = require('@temporalio/worker');
Runtime.install({ logger: new DefaultLogger('ERROR', () => {}) });

test(
  'orchestration handoff persists original inventory and reconciles a lost native set-current acknowledgement',
  { timeout: 60000 },
  async () => {
    const namespace = 'urm-app-staging.qwejt',
      deploymentName = 'urm-worker-staging';
    const previousBuildId = 'a'.repeat(40),
      buildId = 'b'.repeat(40);
    const old = { deploymentName, buildId: previousBuildId };
    const orchestration = { deploymentName, buildId };
    const controls = { deploymentName: 'urm-worker-controls-staging', buildId };
    const local = await createLocalTestEnvironment({
      server: {
        namespace,
        ip: '127.0.0.1',
        ...(process.env.TEMPORAL_CLI_TEST_PATH
          ? { executable: { type: 'existing-path', path: process.env.TEMPORAL_CLI_TEST_PATH } }
          : {}),
      },
    });
    let connection;
    const workers = [];
    try {
      connection = await Connection.connect({
        address: local.connection.options.address,
        interceptors: [],
        channelArgs: { 'grpc.enable_retries': 0 },
      });
      const client = new Client({ connection, namespace });
      const service = connection.workflowService;
      const until = async (read) => {
        for (let i = 0; i < 100; i++) {
          try {
            if (await read()) return;
          } catch (error) {
            if (error?.code !== 5) throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('Native role did not settle');
      };
      const launch = async (version, taskQueue) => {
        const worker = await Worker.create({
          connection: local.nativeConnection,
          namespace,
          taskQueue,
          activities: { marker: async () => 'fixture' },
          workerDeploymentOptions: { useWorkerVersioning: true, defaultVersioningBehavior: 'PINNED', version },
          shutdownGraceTime: '2 seconds',
        });
        const done = worker.run();
        void done.catch(() => undefined);
        workers.push({ worker, done });
        await until(async () => {
          const reply = await service.describeWorkerDeploymentVersion({ namespace, deploymentVersion: version });
          return reply.workerDeploymentVersionInfo?.taskQueueInfos?.some((q) => q.name === taskQueue && q.type === 2);
        });
      };
      const change = async (version) => {
        const prior = await service.describeWorkerDeployment({ namespace, deploymentName: version.deploymentName });
        await service.setWorkerDeploymentCurrentVersion({
          namespace,
          ...version,
          conflictToken: prior.conflictToken,
          identity: 'local-fixture',
        });
      };
      const controlsCurrent = async () => {
        const report = await service.describeTaskQueue({
          namespace,
          taskQueue: { name: 'urm-controls', kind: 1 },
          taskQueueType: 2,
          includeTaskQueueStatus: true,
        });
        return (
          report.versioningInfo?.currentDeploymentVersion?.buildId === buildId &&
          report.versioningInfo.currentDeploymentVersion.deploymentName === controls.deploymentName
        );
      };
      await launch(old, 'urm-orchestration');
      await launch(old, 'urm-controls');
      await change(old);
      await launch(controls, 'urm-controls');
      await change(controls);
      await until(controlsCurrent);
      await launch(orchestration, 'urm-orchestration');

      let saved;
      let invocations = 0;
      const native = service.setWorkerDeploymentCurrentVersion.bind(service);
      service.setWorkerDeploymentCurrentVersion = async (request) => {
        assert.equal(saved.stage, 'attempted');
        assert.equal(saved.preHandoffInventory.versions.find((row) => row.buildId === previousBuildId).active, true);
        invocations++;
        await native(request);
        throw new Error('simulated acknowledgment loss after the native mutation');
      };
      const capture = async (phase) => {
        assert.equal(await controlsCurrent(), true);
        const versions = await Promise.all(
          [old, orchestration].map(async (version) => {
            const { workerDeploymentVersionInfo: info } = await service.describeWorkerDeploymentVersion({
              namespace,
              deploymentVersion: version,
            });
            return { buildId: version.buildId, active: Boolean(info.currentSinceTime), computeAttached: false };
          })
        );
        const observedAt = Date.now();
        return {
          observedAt,
          immutableSHA256: proofDigest(controls),
          protectedWorkSHA256: proofDigest([]),
          ...(phase === 'before'
            ? { preHandoffInventory: { observedAt, versions, digest: proofDigest(versions) } }
            : {}),
        };
      };
      const options = {
        client,
        buildId,
        previousBuildId,
        image: `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'c'.repeat(64)}`,
        releaseId: randomUUID(),
        operationId: randomUUID(),
        bindingDigest: 'd'.repeat(64),
        handoffPlanSHA256: 'e'.repeat(64),
        capture,
        authorizeMutation: async () => {},
        save: async (next) => {
          saved = structuredClone(next);
        },
      };
      const result = await handoffOrchestration(options);
      assert.equal(result.plan.handoffPlanSHA256, options.handoffPlanSHA256);
      assert.equal(result.outcome, 'desired-routing-observed-after-unknown-ack');
      assert.ok(result.handoffAt >= result.attemptedAt);
      assert.deepEqual(await handoffOrchestration({ ...options, saved }), result);
      await assert.rejects(handoffOrchestration({ ...options, saved, handoffPlanSHA256: 'f'.repeat(64) }), /UNCONFIRMED/);
      assert.equal(invocations, 1);
      assert.equal(await controlsCurrent(), true);
    } finally {
      for (const { worker } of workers) if (worker.getStatus().runState === 'RUNNING') worker.shutdown();
      await Promise.allSettled(workers.map(({ done }) => done));
      await connection?.close();
      await local.teardown();
    }
  }
);
