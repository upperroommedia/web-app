// Source Activity under a real SDK worker, with dedicated local Firebase only.
const { createRequire } = require('node:module');
const rootRequire = createRequire(require('node:path').resolve(__dirname, '../../../package.json'));
rootRequire('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const { NativeConnection, Worker, Runtime, DefaultLogger } = rootRequire('@temporalio/worker');
const { Context } = rootRequire('@temporalio/activity');
const { initializeApp, deleteApp } = rootRequire('firebase-admin/app');
const { getFirestore } = rootRequire('firebase-admin/firestore');
const { getStorage } = rootRequire('firebase-admin/storage');
const { getDatabase } = rootRequire('firebase-admin/database');
const { randomUUID } = require('node:crypto');
const harness = require('../../../firebase.test.json');
for (const [name, port] of [
  ['FIRESTORE_EMULATOR_HOST', harness.emulators.firestore.port],
  ['FIREBASE_DATABASE_EMULATOR_HOST', harness.emulators.database.port],
  ['FIREBASE_STORAGE_EMULATOR_HOST', harness.emulators.storage.port],
])
  if (process.env[name] !== `127.0.0.1:${port}`) throw new Error('Dedicated emulator required');
// Fixture byte budgets apply only to this isolated process, before source import.
require('../../../apps/temporal-worker/src/workflows/media/resource-test-environment.cjs');
const { createMediaActivities } = require('../../../apps/process-audio/src/temporal/activities.ts');
Runtime.install({ shutdownSignals: [], logger: new DefaultLogger('ERROR', () => undefined) });
let connection,
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
    app = initializeApp(
      {
        projectId: 'urm-app-staging',
        storageBucket: 'urm-app-staging.appspot.com',
        databaseURL: 'https://urm-app-staging-default-rtdb.firebaseio.com',
      },
      `adoption-${instanceId}`
    );
    const db = getFirestore(app);
    const activities = createMediaActivities({
      projectId: 'urm-app-staging',
      firestore: db,
      bucket: getStorage(app).bucket(),
      database: getDatabase(app),
      ytdlpPath: 'forbidden',
      // Controlled eligibility authority; no Cloud credential or provider proof.
      assertAuthorized: async () => {},
      checkAuthenticatedMedia: async () => {
        throw new Error('Provider forbidden');
      },
      projectJob: async (ref, projection) => db.doc(`durableJobs/${ref.jobId}`).update(projection),
    });
    stage = 'connection';
    connection = await NativeConnection.connect({ address: message.address });
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
  try {
    if (worker?.getStatus().runState === 'RUNNING') worker.shutdown();
    await running;
    await Promise.all([connection?.close(), app && deleteApp(app)]);
    await Runtime.instance().shutdown();
    process.disconnect();
  } catch {
    fail();
  }
});
