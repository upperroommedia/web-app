import { createServer, type Server } from 'node:http';
import { getSharedFirebaseAppOwnership } from '@upperroom/shared/firebase/firebaseAdminOwnership';
import { Client, Connection } from '@temporalio/client';
import { VersioningBehavior } from '@temporalio/common';
import { NativeConnection, Worker, type Runtime } from '@temporalio/worker';
import { loadWorkerWitness } from './runtime/worker-witness';
import { assertRuntimeNamespace, loadRuntimeConfig, runtimeCredentialFingerprint } from './runtime/config';
import { initializeWorkerObservability, reportWorkerFailure, flushWorkerObservability } from './runtime/observability';
import { OutboxDispatcher } from './runtime/dispatcher';
import { WorkerLifecycle, WorkerLifecycleFailure } from './runtime/worker-lifecycle';
import { verifyProviderSandboxReadiness, type ProviderSandboxReadiness } from './runtime/provider-sandbox-readiness';

export async function runWorkerProcess(bindShutdown?: (shutdown: () => Promise<void>) => void): Promise<void> {
  const config = loadRuntimeConfig();
  // One Runtime installation retains telemetry and disables SDK signal ownership
  // before any native connection/worker can initialize Runtime implicitly.
  let runtime: Runtime | undefined;
  let native: NativeConnection | undefined;
  let connection: Connection | undefined;
  let ownedFirebase = getSharedFirebaseAppOwnership();
  let dispatcher: OutboxDispatcher | undefined;
  let server: Server | undefined;
  let healthProbe: ReturnType<typeof setInterval> | undefined;
  let certificateProbe: ReturnType<typeof setInterval> | undefined;
  let probe: Promise<void> | undefined;
  let temporalHealthy = true;
  let providerSandbox: ProviderSandboxReadiness | undefined;
  const assertOwnedApp = () => {
    if (!ownedFirebase) return;
    if (
      ownedFirebase.app.name !== '[DEFAULT]' ||
      ownedFirebase.app.options.projectId !== config.projectId ||
      !ownedFirebase.isRegistered()
    )
      throw new Error('Worker Firebase app identity changed before teardown');
  };
  const lifecycle = new WorkerLifecycle({
    onDraining: () => {
      if (healthProbe) clearInterval(healthProbe);
      if (certificateProbe) clearInterval(certificateProbe);
    },
    stopDispatcher: async () => {
      await dispatcher?.stop();
    },
    resources: [
      {
        name: 'health.probe',
        close: async () => {
          await probe;
        },
      },
      {
        name: 'health.server',
        close: async () => {
          if (server?.listening)
            await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
        },
      },
      {
        name: 'firebase.firestore',
        close: async () => {
          if (ownedFirebase) {
            assertOwnedApp();
            await ownedFirebase.terminateFirestore();
          }
        },
      },
      {
        name: 'firebase.app',
        close: async () => {
          // deleteApp also closes this app's RTDB clients/token refresh timers.
          // Firestore needs the explicit terminate above (Admin14.5 has no delete).
          if (ownedFirebase) {
            assertOwnedApp();
            await ownedFirebase.deleteApp();
          }
        },
      },
      {
        name: 'temporal.client',
        close: async () => {
          await connection?.close();
        },
      },
      {
        name: 'temporal.native',
        close: async () => {
          await native?.close();
        },
      },
      {
        name: 'temporal.runtime',
        close: async () => {
          await runtime?.shutdown();
        },
      },
    ],
  });
  const requestShutdown = () => {
    // main/finally owns the same promise's result; callbacks never orphan it.
    void lifecycle.shutdown().catch(() => undefined);
  };
  try {
    bindShutdown?.(() => lifecycle.shutdown());
    initializeWorkerObservability(config.projectId, config.buildId, config.queues, (installed) => {
      runtime = installed;
    });
    native = await NativeConnection.connect({ address: config.address, tls: config.tls, apiKey: config.apiKey });
    if (lifecycle.draining) return;
    connection = await Connection.connect({ address: config.address, tls: config.tls, apiKey: config.apiKey });
    if (lifecycle.draining) return;
    const client = new Client({ connection, namespace: config.namespace });
    const namespaceDescription = await client.workflowService.describeNamespace({ namespace: config.namespace });
    assertRuntimeNamespace(config, namespaceDescription.namespaceInfo?.name);
    if (lifecycle.draining) return;
    const witness = await loadWorkerWitness(
      config.buildId,
      process.env.NODE_ENV === 'production' && config.queues.includes('urm-orchestration')
    );
    if (lifecycle.draining) return;
    // Capture creator identity, not an app-list snapshot: static imports may
    // already have initialized our shared app. Never claim a pre-existing app.
    await import('@upperroom/shared/firebase/firebaseAdmin');
    ownedFirebase = getSharedFirebaseAppOwnership();
    if (
      !ownedFirebase ||
      ownedFirebase.app.name !== '[DEFAULT]' ||
      ownedFirebase.app.options.projectId !== config.projectId ||
      !ownedFirebase.isRegistered()
    )
      throw new Error('Worker requires its creator-owned Firebase app');
    if (lifecycle.draining) return;
    const { createRuntimeActivities } = await import('./runtime/activities');
    const { db, queues } = createRuntimeActivities(config.projectId, config.queues, client, witness);
    providerSandbox = await verifyProviderSandboxReadiness(db, config.projectId, config.queues, true);
    if (lifecycle.draining) return;
    // Retain every created worker even if a subsequent create fails.
    for (const queue of config.queues) {
      const worker = await Worker.create({
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
            ? config.projectId === 'urm-app-staging'
              ? 2
              : 8
            : 10,
        maxHeartbeatThrottleInterval: '1 second',
        defaultHeartbeatThrottleInterval: '1 second',
        shutdownGraceTime: '2 minutes',
      });
      lifecycle.workers.push(worker);
      if (lifecycle.draining) return;
    }
    dispatcher = new OutboxDispatcher({ db, client, projectId: config.projectId });
    const ready = () =>
      !lifecycle.draining &&
      temporalHealthy &&
      Boolean(dispatcher?.healthy) &&
      lifecycle.workers.every((worker, index) => {
        const status = (worker as Worker).getStatus();
        return (
          status.runState === 'RUNNING' &&
          (status.workflowPollerState === 'POLLING' ||
            (['urm-media', 'urm-controls'].includes(config.queues[index]) &&
              status.workflowPollerState === 'SHUTDOWN')) &&
          status.activityPollerState === 'POLLING'
        );
      });
    server = createServer((request, response) => {
      if (request.url !== '/healthz' && request.url !== '/readyz') {
        response.writeHead(404).end();
        return;
      }
      const healthy = request.url === '/healthz' ? !lifecycle.draining : ready();
      response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(
        JSON.stringify({
          healthy,
          ready: ready(),
          draining: lifecycle.draining,
          projectId: config.projectId,
          buildId: config.buildId,
          dispatcherEnabled: config.dispatcherEnabled,
          ...(providerSandbox ? { providerSandbox } : {}),
        })
      );
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(config.port, '0.0.0.0', () => {
        server!.removeListener('error', reject);
        resolve();
      });
    });
    if (lifecycle.draining) return;
    healthProbe = setInterval(() => {
      if (lifecycle.draining || probe) return;
      probe = (async () => {
        try {
          const description = await connection!.withDeadline(Date.now() + 5000, () =>
            client.workflowService.describeNamespace({ namespace: config.namespace })
          );
          assertRuntimeNamespace(config, description.namespaceInfo?.name);
          temporalHealthy = true;
        } catch {
          temporalHealthy = false;
        }
      })().finally(() => {
        probe = undefined;
      });
    }, 10_000);
    healthProbe.unref();
    const initialCredentialFingerprint = runtimeCredentialFingerprint(config);
    if (config.tls || config.apiKey) {
      certificateProbe = setInterval(() => {
        if (lifecycle.draining) return;
        try {
          const next = loadRuntimeConfig();
          if (
            runtimeCredentialFingerprint(next) !== initialCredentialFingerprint ||
            next.namespace !== config.namespace ||
            next.address !== config.address ||
            next.connectionMode !== config.connectionMode
          )
            requestShutdown();
        } catch (error) {
          temporalHealthy = false;
          lifecycle.fail('credential.reload', error);
          requestShutdown();
        }
      }, 60_000);
      certificateProbe.unref();
    }
    if (config.dispatcherEnabled) dispatcher.start();
    else dispatcher.healthy = true;
    lifecycle.completeStartup();
    await lifecycle.run();
  } catch (error) {
    // shutdown() already retains stage-specific errors; don't nest its own result.
    if (!lifecycle.isShutdownFailure(error)) lifecycle.fail('startup', error);
  } finally {
    ownedFirebase ??= getSharedFirebaseAppOwnership();
    lifecycle.completeStartup();
    await lifecycle.shutdown();
  }
}

export async function startWorkerProcess(): Promise<void> {
  let requested = false;
  let shutdown: (() => Promise<void>) | undefined;
  const requestShutdown = () => {
    requested = true;
    if (shutdown) void shutdown().catch(() => undefined);
  };
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGUSR2'];
  signals.forEach((signal) => process.on(signal, requestShutdown));
  try {
    await runWorkerProcess((ownedShutdown) => {
      shutdown = ownedShutdown;
      if (requested) requestShutdown();
    });
  } catch (error) {
    process.exitCode = 1;
    try {
      reportWorkerFailure('TEMPORAL_WORKER_FAILED');
    } catch {
      console.error('Temporal worker failure reporting failed.');
    }
    // Keep raw causes in AggregateError internally, never print provider payloads.
    const failures = error instanceof AggregateError ? error.errors : [error];
    console.error(
      'Temporal worker stopped: startup or runtime failed.',
      failures.map((failure) => ({
        stage: failure instanceof WorkerLifecycleFailure ? failure.stage : 'startup',
        type:
          failure instanceof Error &&
          /^[A-Za-z][A-Za-z0-9]*Error$/.test(failure.cause instanceof Error ? failure.cause.name : failure.name)
            ? failure.cause instanceof Error
              ? failure.cause.name
              : failure.name
            : 'Error',
      }))
    );
  } finally {
    try {
      await flushWorkerObservability();
    } catch {
      process.exitCode = 1;
      console.error('Temporal worker observability flush failed.');
    } finally {
      // Keep the same signal owner through final reporting/flush as well.
      signals.forEach((signal) => process.removeListener(signal, requestShutdown));
    }
  }
  // Let Node exit naturally after all owned SDK handles and telemetry settle.
}
if (require.main === module) void startWorkerProcess();
