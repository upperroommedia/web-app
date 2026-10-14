import { createServer } from 'node:http';
import { Client, Connection } from '@temporalio/client';
import { VersioningBehavior } from '@temporalio/common';
import { NativeConnection, Worker } from '@temporalio/worker';
import { loadWorkerWitness } from './runtime/worker-witness';
import { assertRuntimeNamespace, loadRuntimeConfig, runtimeCredentialFingerprint } from './runtime/config';
import { initializeWorkerObservability, reportWorkerFailure, flushWorkerObservability } from './runtime/observability';
import { OutboxDispatcher } from './runtime/dispatcher';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  initializeWorkerObservability(config.projectId, config.buildId, config.queues);
  // Validate configuration before loading modules which initialize Firebase/provider adapters.
  const native = await NativeConnection.connect({ address: config.address, tls: config.tls, apiKey: config.apiKey });
  const connection = await Connection.connect({ address: config.address, tls: config.tls, apiKey: config.apiKey });
  const client = new Client({ connection, namespace: config.namespace });
  const namespaceDescription = await client.workflowService.describeNamespace({ namespace: config.namespace });
  assertRuntimeNamespace(config, namespaceDescription.namespaceInfo?.name);
  const witness = await loadWorkerWitness(
    config.buildId,
    process.env.NODE_ENV === 'production' && config.queues.includes('urm-orchestration')
  );
  const { createRuntimeActivities } = await import('./runtime/activities');
  const { db, queues } = createRuntimeActivities(config.projectId, config.queues, client, witness);
  const workers = await Promise.all(
    config.queues.map(async (queue) =>
      Worker.create({
        connection: native,
        namespace: config.namespace,
        taskQueue: queue,
        workflowBundle: ['urm-media', 'urm-controls'].includes(queue) ? undefined : { codePath: config.workflowBundle },
        activities: queues[queue as keyof typeof queues],
        workerDeploymentOptions: {
          useWorkerVersioning: true,
          defaultVersioningBehavior: VersioningBehavior.PINNED,
          version: { deploymentName: config.deploymentName, buildId: config.buildId },
        },
        maxConcurrentActivityTaskExecutions:
          queue === 'urm-media'
            ? config.mediaConcurrency
            : queue === 'urm-controls'
            ? config.controlsConcurrency
            : queue === 'urm-search'
            ? config.projectId === 'urm-app-staging' ? 2 : 8
            : 10,
        maxHeartbeatThrottleInterval: '1 second',
        defaultHeartbeatThrottleInterval: '1 second',
        shutdownGraceTime: '2 minutes',
      })
    )
  );
  const dispatcher = new OutboxDispatcher({ db, client, projectId: config.projectId });
  let draining = false;
  const initialCredentialFingerprint = runtimeCredentialFingerprint(config);
  let certificateProbe: ReturnType<typeof setInterval> | undefined;
  let temporalHealthy = true;
  let probing = false;
  const healthProbe = setInterval(async () => {
    if (draining || probing) return;
    probing = true;
    try {
      const description = await connection.withDeadline(Date.now() + 5000, () =>
        client.workflowService.describeNamespace({ namespace: config.namespace })
      );
      assertRuntimeNamespace(config, description.namespaceInfo?.name);
      temporalHealthy = true;
    } catch {
      temporalHealthy = false;
    } finally {
      probing = false;
    }
  }, 10_000);
  healthProbe.unref();
  const ready = () =>
    !draining &&
    temporalHealthy &&
    dispatcher.healthy &&
    workers.every((worker, index) => {
      const status = worker.getStatus();
      return (
        status.runState === 'RUNNING' &&
        (status.workflowPollerState === 'POLLING' ||
          (['urm-media', 'urm-controls'].includes(config.queues[index]) &&
            status.workflowPollerState === 'SHUTDOWN')) &&
        status.activityPollerState === 'POLLING'
      );
    });
  const server = createServer((request, response) => {
    if (request.url !== '/healthz' && request.url !== '/readyz') {
      response.writeHead(404).end();
      return;
    }
    const healthy = request.url === '/healthz' ? !draining : ready();
    response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(
      JSON.stringify({
        healthy,
        ready: ready(),
        draining,
        projectId: config.projectId,
        buildId: config.buildId,
        dispatcherEnabled: config.dispatcherEnabled,
      })
    );
  });
  server.listen(config.port, '0.0.0.0');
  if (config.dispatcherEnabled) dispatcher.start();
  else dispatcher.healthy = true;
  const shutdown = async () => {
    if (draining) return;
    draining = true;
    clearInterval(healthProbe);
    if (certificateProbe) clearInterval(certificateProbe);
    await dispatcher.stop();
    for (const worker of workers) worker.shutdown();
  };
  if (config.tls || config.apiKey) {
    certificateProbe = setInterval(() => {
      if (draining) return;
      try {
        const next = loadRuntimeConfig();
        if (
          runtimeCredentialFingerprint(next) !== initialCredentialFingerprint ||
          next.namespace !== config.namespace ||
          next.address !== config.address ||
          next.connectionMode !== config.connectionMode
        )
          void shutdown();
      } catch {
        temporalHealthy = false;
        // Missing/invalid rotated credentials must stop admission and drain existing work.
        void shutdown();
      }
    }, 60_000);
    certificateProbe.unref();
  }
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  try {
    await Promise.all(workers.map((worker) => worker.run()));
  } finally {
    await shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([connection.close(), native.close()]);
  }
}
main()
  .then(async () => {
    await flushWorkerObservability();
    process.exit(0);
  })
  .catch(async () => {
    reportWorkerFailure('TEMPORAL_WORKER_FAILED');
    await flushWorkerObservability();
    console.error('Temporal worker stopped: startup or runtime failed.');
    process.exit(1);
  });
