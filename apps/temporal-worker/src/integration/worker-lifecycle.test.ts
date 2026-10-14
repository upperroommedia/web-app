import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((yes, no) => {
    server.once('error', no);
    server.listen(0, '127.0.0.1', yes);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Port fixture failed');
  await new Promise<void>((yes, no) => server.close((error) => (error ? no(error) : yes())));
  return address.port;
}

test('real entrypoint naturally exits after repeated signals with live RTDB and Firestore sockets', async () => {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'demo-worker-lifecycle';
  const environment = await TestWorkflowEnvironment.createLocal({
    server: {
      namespace: projectId,
      ip: '127.0.0.1',
      ...(process.env.TEMPORAL_CLI_TEST_PATH
        ? { executable: { type: 'existing-path' as const, path: process.env.TEMPORAL_CLI_TEST_PATH } }
        : {}),
    },
  });
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let output = '';
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  try {
    const port = await unusedPort();
    child = spawn(process.execPath, [resolve(__dirname, 'fixtures/lifecycle-child.cjs')], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NODE_OPTIONS: process.env.WORKER_LIFECYCLE_NODE_OPTIONS || process.env.NODE_OPTIONS,
        FIREBASE_PROJECT_ID: projectId,
        GCLOUD_PROJECT: projectId,
        GOOGLE_CLOUD_PROJECT: projectId,
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
        FIREBASE_DATABASE_URL: `https://${projectId}-default-rtdb.firebaseio.com`,
        TEMPORAL_CONNECTION_MODE: 'self-hosted',
        TEMPORAL_ADDRESS: environment.address,
        TEMPORAL_NAMESPACE: projectId,
        TEMPORAL_BUILD_ID: 'natural-exit-fixture',
        TEMPORAL_DEPLOYMENT_NAME: 'natural-exit-fixture',
        TEMPORAL_TASK_QUEUES: 'urm-controls',
        TEMPORAL_DISPATCHER_ENABLED: 'false',
        TEMPORAL_WORKFLOW_BUNDLE: '/unused-controls-only.js',
        TEMPORAL_METRICS_ADDRESS: '127.0.0.1:0',
        TEMPORAL_API_KEY: undefined,
        TEMPORAL_API_KEY_FILE: undefined,
        TEMPORAL_CLOUD_ACCOUNT_ID: undefined,
        TEMPORAL_CLOUD_PROVIDER: undefined,
        TEMPORAL_CLOUD_REGION: undefined,
        TEMPORAL_TLS_CERT_FILE: undefined,
        TEMPORAL_TLS_KEY_FILE: undefined,
        TEMPORAL_TLS_CA_FILE: undefined,
        TEMPORAL_SENTRY_DSN: undefined,
        SENTRY_DSN: undefined,
        FUNCTIONS_SENTRY_DSN: undefined,
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = new Promise((yes, no) => {
      child!.once('error', no);
      child!.once('exit', (code, signal) => yes({ code, signal }));
    });
    const ready = new Promise<void>((yes) => {
      const record = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('LIFECYCLE_SOCKETS_READY')) yes();
      };
      child!.stdout!.on('data', record);
      child!.stderr!.on('data', record);
    });
    const deadline = new Promise<never>((_yes, no) => {
      timer = setTimeout(() => no(new Error(`Lifecycle child timed out: ${output.slice(-6000)}`)), 60_000);
    });
    await Promise.race([
      ready,
      exited.then(() => {
        throw new Error(`Child stopped before sockets were active: ${output.slice(-6000)}`);
      }),
      deadline,
    ]);
    child.kill('SIGTERM');
    child.kill('SIGTERM');
    child.kill('SIGINT');
    const result = await Promise.race([exited, deadline]);
    expect(result).toEqual({ code: 0, signal: null });
    expect(output).not.toMatch(/IllegalStateError|Not running\. Current state|unhandledRejection/);
  } finally {
    if (timer) clearTimeout(timer);
    // A failing test must not leave its process or local Temporal server behind.
    // Forced termination here is failure cleanup, never the success condition.
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (exited) await exited.catch(() => undefined);
    await environment.teardown();
  }
}, 120_000);
