// Source Activity under a real SDK worker, with dedicated local Firebase only.
const { createRequire } = require('node:module');
const rootRequire = createRequire(require('node:path').resolve(__dirname, '../../../package.json'));
require('./current-workspace-source.cjs');
rootRequire('ts-node').register({
  preferTsExts: true,
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const { NativeConnection, Worker, Runtime, DefaultLogger } = rootRequire('@temporalio/worker');
const { Client, Connection } = rootRequire('@temporalio/client');
const { Context } = rootRequire('@temporalio/activity');
const { initializeApp, deleteApp } = rootRequire('firebase-admin/app');
const { getFirestore } = rootRequire('firebase-admin/firestore');
const { randomUUID } = require('node:crypto');
const harness = require('../../../firebase.test.json');
for (const [name, port] of [
  ['FIREBASE_AUTH_EMULATOR_HOST', harness.emulators.auth.port],
  ['FIRESTORE_EMULATOR_HOST', harness.emulators.firestore.port],
  ['FIREBASE_DATABASE_EMULATOR_HOST', harness.emulators.database.port],
  ['FIREBASE_STORAGE_EMULATOR_HOST', harness.emulators.storage.port],
])
  if (process.env[name] !== `127.0.0.1:${port}`) throw new Error('Dedicated emulator required');
// Fixture byte budgets apply only to this isolated process, before source import.
require('../../../apps/temporal-worker/src/workflows/media/resource-test-environment.cjs');
// Actual production factory below retains store execution, actor and canonical ownership checks.
Runtime.install({ shutdownSignals: [], logger: new DefaultLogger('ERROR', () => undefined) });
let clientConnection,
  connection,
  worker,
  running,
  app,
  started = false,
  stage = 'start';
const instanceId = randomUUID(),
  identity = `owned-media-${process.pid}-${instanceId}`;
const send = (value) => {
  if (process.connected) process.send(value);
};
const fail = () => {
  send({ type: 'error', stage });
  process.exitCode = 1;
};
process.once('message', async (message) => {
  try {
    if (
      started ||
      message?.type !== 'start' ||
      Object.keys(message).sort().join(',') !== 'address,holdAck,type' ||
      !/^(127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(message.address) ||
      typeof message.holdAck !== 'boolean'
    )
      throw new Error();
    started = true;
    stage = 'firebase';
    app = initializeApp({
      projectId: 'urm-app-staging',
      storageBucket: 'urm-app-staging.appspot.com',
      databaseURL: 'https://urm-app-staging-default-rtdb.firebaseio.com',
    });
    const db = getFirestore(app);
    stage = 'connection';
    connection = await NativeConnection.connect({ address: message.address });
    clientConnection = await Connection.connect({ address: message.address });
    const client = new Client({ connection: clientConnection, namespace: 'default' });
    const { createRuntimeActivities } = require('../../../apps/temporal-worker/src/runtime/activities.ts');
    const activities = createRuntimeActivities('urm-app-staging', ['urm-media'], client, {
      instanceId,
      buildId: 'a'.repeat(40),
    }).queues['urm-media'];
    stage = 'worker';
    worker = await Worker.create({
      connection,
      namespace: 'default',
      taskQueue: 'owned-media-adoption',
      identity,
      activities: {
        acquireMedia: async (ref) => {
          stage = 'acquire';
          const context = Context.current();
          context.heartbeat({ fixture: 'source-acquire' });
          const timer = setInterval(() => context.heartbeat({ fixture: 'source-acquire' }), 1000);
          let result;
          try {
            result = await activities.acquireMedia(ref);
          } catch (error) {
            send({ type: 'activity-error', identity, pid: process.pid, instanceId, code: error.type ?? 'unknown' });
            throw error;
          } finally {
            clearInterval(timer);
          }
          const info = Context.current().info;
          Context.current().heartbeat({ adopted: true });
          send({
            type: 'acquired',
            identity,
            pid: process.pid,
            instanceId,
            attempt: info.attempt,
            workflowId: info.workflowExecution.workflowId,
            runId: info.workflowExecution.runId,
          });
          // Deliberately withhold only the first completion ACK after durable source work.
          if (message.holdAck) await new Promise(() => {});
          return result;
        },
      },
      shutdownGraceTime: '1 second',
      shutdownForceTime: '3 seconds',
    });
    running = worker.run();
    void running.catch(fail);
    const end = Date.now() + 10000;
    while (worker.getStatus().runState !== 'RUNNING') {
      if (Date.now() >= end) throw new Error();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    send({ type: 'ready', identity, pid: process.pid, instanceId });
  } catch {
    fail();
  }
});
process.on('message', async (message) => {
  if (message?.type !== 'stop' || Object.keys(message).length !== 1) return;
  const failures = [];
  for (const cleanup of [
    async () => {
      if (worker?.getStatus().runState === 'RUNNING') worker.shutdown();
      await running;
    },
    async () => connection?.close(),
    async () => clientConnection?.close(),
    async () => app && getFirestore(app).terminate(),
    async () => app && deleteApp(app),
    async () => Runtime.instance().shutdown(),
  ]) {
    try {
      await cleanup();
    } catch {
      failures.push(true);
    }
  }
  if (failures.length) fail();
  if (process.connected) process.disconnect();
});
