import { createServer } from 'node:http';
import { Client, Connection } from '@temporalio/client';
import * as Sentry from '@sentry/node';
import { getSharedFirebaseAppOwnership } from '@upperroom/shared/firebase/firebaseAdminOwnership';
import { loadRuntimeConfig, assertRuntimeNamespace } from './runtime/config';
import { nativeDispatchCallerAuthorization, type DispatchAuthorization } from './runtime/dispatch-caller';
import { DispatchDiagnostic } from './runtime/dispatch-diagnostic';
import { OutboxDispatcher } from './runtime/dispatcher';
import { createServerlessDispatchHandler } from './runtime/serverless-dispatch';

/** Private Cloud Run service entrypoint. Eventarc and Scheduler wake bounded passes;
 * no Worker/NativeConnection, task polling or native telemetry Runtime is installed.
 */
export async function runDispatchService() {
  const config = loadRuntimeConfig();
  if (config.connectionMode !== 'temporal-cloud' || config.dispatcherEnabled)
    throw new Error('Serverless dispatch requires Cloud mode and the worker polling dispatcher disabled');
  const reconcileJob = process.env.TEMPORAL_DISPATCH_RECONCILE_JOB;
  if (!reconcileJob) throw new Error('Serverless dispatch requires an independent reconciliation job');
  Sentry.init({
    dsn: process.env.TEMPORAL_SENTRY_DSN,
    enabled: Boolean(process.env.TEMPORAL_SENTRY_DSN),
    environment: config.projectId,
    release: config.buildId,
    beforeSend: (event) => {
      delete event.request;
      delete event.breadcrumbs;
      delete event.extra;
      return event;
    },
    beforeSendLog: () => null,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    defaultIntegrations: false,
  });
  let connection: Connection | undefined;
  let owner = getSharedFirebaseAppOwnership();
  let handler: ReturnType<typeof createServerlessDispatchHandler> | undefined;
  const server = createServer((req, res) => {
    if (!handler) {
      req.resume();
      res.writeHead(503).end();
      return;
    }
    void handler(req, res);
  });
  let dispatcher: OutboxDispatcher | undefined;
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= (async () => {
      // Refuse new dispatch before closing the server; leave interrupted leases for reconciliation.
      const stopping = dispatcher?.stop();
      const draining = handler?.drain();
      await Promise.all([
        stopping,
        draining,
        server.listening ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve(),
      ]);
      await connection?.close();
      if (owner && owner.app.options.projectId === config.projectId && owner.isRegistered()) {
        await owner.terminateFirestore();
        await owner.deleteApp();
      }
      await Sentry.close(2000);
    })());
  try {
    connection = await Connection.connect({ address: config.address, tls: config.tls, apiKey: config.apiKey });
    const client = new Client({ connection, namespace: config.namespace });
    const description = await client.workflowService.describeNamespace({ namespace: config.namespace });
    assertRuntimeNamespace(config, description.namespaceInfo?.name);
    await import('@upperroom/shared/firebase/firebaseAdmin');
    owner = getSharedFirebaseAppOwnership();
    if (
      !owner ||
      owner.app.name !== '[DEFAULT]' ||
      owner.app.options.projectId !== config.projectId ||
      !owner.isRegistered()
    )
      throw new Error('Serverless dispatcher requires its creator-owned Firebase app');
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(owner.app);
    const sandboxListSettlement = config.projectId === 'urm-app-staging'
      ? (await import('./runtime/sandbox-list-settlement')).reconcileSandboxListSettlement
      : undefined;
    dispatcher = new OutboxDispatcher({ db, client, projectId: config.projectId, requireOpenAdmission: true });
    const diagnostic = new DispatchDiagnostic({ db: getFirestore(owner.app), client, projectId: config.projectId,
      buildId: config.buildId, serviceRevision: `projects/${config.projectId}/locations/us-central1/services/${process.env.K_SERVICE ?? ''}/revisions/${process.env.K_REVISION ?? ''}` });
    handler = createServerlessDispatchHandler({
      projectId: config.projectId,
      admission: (() => {
        const admission = process.env.TEMPORAL_DISPATCH_ADMISSION;
        if (admission !== 'enabled' && admission !== 'disabled') throw new Error('Explicit dispatch admission required');
        return admission;
      })(),
      reconcileJob,
      authorization: process.env.TEMPORAL_DISPATCH_ADMISSION === 'enabled'
        ? nativeDispatchCallerAuthorization({ projectId: config.projectId, buildId: config.buildId,
          audience: process.env.TEMPORAL_DISPATCH_AUDIENCE ?? '', eventSubject: process.env.TEMPORAL_DISPATCH_EVENT_SUBJECT ?? '',
          schedulerSubject: process.env.TEMPORAL_DISPATCH_SCHEDULER_SUBJECT ?? '' })
        : { verify: async () => { throw new Error('DISPATCH_CALLER_UNCONFIRMED'); }, drain: async () => undefined } satisfies DispatchAuthorization,
      run: async (signal, context) => {
        const observed = await connection!.withDeadline(Date.now() + 20000, () => diagnostic.tick(signal, context));
        if (observed !== undefined) return !signal.aborted && observed;
        await connection!.withDeadline(Date.now() + 20000, () => dispatcher!.tick(signal));
        if (sandboxListSettlement && context.delivery.kind === 'scheduler' && !signal.aborted)
          await sandboxListSettlement(db, client, config.namespace, signal);
        return !signal.aborted && dispatcher!.healthy;
      },
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '0.0.0.0', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    return { close, server };
  } catch {
    await close();
    throw new Error('SERVERLESS_DISPATCH_STARTUP_FAILED');
  }
}

if (require.main === module) {
  let shutdown: (() => Promise<void>) | undefined;
  let stopping = false;
  const stop = () => {
    stopping = true;
    void shutdown?.().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  void runDispatchService()
    .then(({ close }) => {
      shutdown = close;
      if (stopping) stop();
    })
    .catch(() => {
      Sentry.captureException(new Error('SERVERLESS_DISPATCH_STARTUP_FAILED'));
      process.exitCode = 1;
    });
}
