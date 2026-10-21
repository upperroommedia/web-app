// Real application media factory / private SDK surface under the production
// supervisor. Loopback/emulators/small budgets and Cloud witness are CONTROLLED.
const { createRequire } = require('node:module');
const rootRequire = createRequire(require('node:path').resolve(__dirname, '../../../package.json'));
require('./current-workspace-source.cjs');
rootRequire('ts-node').register({
  preferTsExts: true,
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const harness = require('../../../firebase.test.json');
for (const [key, port] of [
  ['FIREBASE_AUTH_EMULATOR_HOST', harness.emulators.auth.port],
  ['FIRESTORE_EMULATOR_HOST', harness.emulators.firestore.port],
  ['FIREBASE_DATABASE_EMULATOR_HOST', harness.emulators.database.port],
  ['FIREBASE_STORAGE_EMULATOR_HOST', harness.emulators.storage.port],
])
  if (process.env[key] !== `127.0.0.1:${port}`) throw new Error('Dedicated emulators required');
if (!/^(127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(process.env.URM_RECOVERY_TEST_ADDRESS ?? ''))
  throw new Error('Loopback SDK required');
require('../../../apps/temporal-worker/src/workflows/media/resource-test-environment.cjs');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = rootRequire('firebase-admin/app');
const { getFirestore } = rootRequire('firebase-admin/firestore');
const { getAuth } = rootRequire('firebase-admin/auth');
const { getStorage } = rootRequire('firebase-admin/storage');
const { Client, Connection } = rootRequire('@temporalio/client');
const { Runtime, DefaultLogger, NativeConnection, Worker } = rootRequire('@temporalio/worker');
const kernel = require('../../../apps/temporal-worker/src/runtime/media-kernel-supervisor.ts');
const {
  createMediaRecoveryRegistration,
  createMediaRecoveryReplacementRegistration,
} = require('../../../apps/temporal-worker/src/runtime/media-recovery-registration.ts');
const {
  holdOriginalMediaCompletion,
} = require('../../../apps/temporal-worker/src/runtime/media-recovery-original-fault.ts');
Runtime.install({ shutdownSignals: [], logger: new DefaultLogger('ERROR', () => undefined) });
let app,
  db,
  connection,
  native,
  worker,
  running,
  stopping = false,
  monitor,
  expiry;
let cleanup;
async function stop() {
  if (cleanup) return cleanup;
  stopping = true;
  cleanup = (async () => {
    clearInterval(monitor);
    clearTimeout(expiry);
    const errors = [];
    for (const fn of [
      async () => {
        if (worker && worker.getStatus().runState === 'RUNNING') worker.shutdown();
        await running;
      },
      async () => native?.close(),
      async () => connection?.close(),
      async () => db?.terminate(),
      async () => app && deleteApp(app),
      async () => Runtime.instance().shutdown(),
    ]) {
      try {
        await fn();
      } catch {
        errors.push(true);
      }
    }
    if (errors.length) process.exitCode = 1;
    if (process.connected) process.disconnect();
  })();
  return cleanup;
}
function requestStop() {
  stopping = true;
  try {
    if (worker?.getStatus().runState === 'RUNNING') worker.shutdown();
  } catch {
    process.exitCode = 1;
  }
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGUSR2']) process.on(sig, requestStop);
(async () => {
  await kernel.awaitMediaKernelLaunch();
  const operationId = process.env.URM_RECOVERY_TEST_OPERATION;
  const witness = { ...JSON.parse(process.env.URM_RECOVERY_TEST_PARENT), instanceId: randomUUID() };
  const link = await kernel.reportMediaKernelWitness(witness);
  if (stopping) return;
  app = initializeApp({
    projectId: 'urm-app-staging',
    storageBucket: 'urm-app-staging.firebasestorage.app',
    databaseURL: 'https://urm-app-staging-default-rtdb.firebaseio.com',
  });
  db = getFirestore(app);
  const auth = getAuth(app),
    bucket = getStorage(app).bucket();
  bucket.storage.retryOptions.autoRetry = false;
  connection = await Connection.connect({
    address: process.env.URM_RECOVERY_TEST_ADDRESS,
    interceptors: [],
    channelArgs: { 'grpc.enable_retries': 0 },
  });
  native = await NativeConnection.connect({ address: process.env.URM_RECOVERY_TEST_ADDRESS });
  const client = new Client({ connection, namespace: 'urm-app-staging.qwejt' });
  const { createRuntimeActivities } = require('../../../apps/temporal-worker/src/runtime/activities.ts');
  const production = createRuntimeActivities('urm-app-staging', ['urm-media'], client, witness).queues['urm-media'];
  const replacement = process.env.TEMPORAL_MEDIA_RECOVERY_CHILD === 'replacement';
  const r = await (replacement ? createMediaRecoveryReplacementRegistration : createMediaRecoveryRegistration)({
    firestore: db,
    auth,
    bucket,
    client,
    witness,
    operationId,
    kernel: link,
    acquire: production.acquireMedia,
  });
  const activities = replacement
    ? {
        ...r.activities,
        acquireMedia: async (ref) => {
          const info = rootRequire('@temporalio/activity').Context.current().info;
          const d = await client.workflow
            .getHandle(info.workflowExecution.workflowId, info.workflowExecution.runId, { followRuns: false })
            .describe();
          const a = d.raw.pendingActivities?.find((a) => a.activityId === 'media-recovery-acquire');
          const ms = (t) => Number(t?.seconds) * 1000 + Number(t?.nanos ?? 0) / 1e6;
          console.log(
            'OWNED_ATTEMPT2_PREVIOUS_HEARTBEAT',
            !!a?.lastHeartbeatTime && ms(a.lastHeartbeatTime) < ms(a.lastStartedTime)
          );
          return r.activities.acquireMedia(ref);
        },
      }
    : {
        ...r.activities,
        acquireMedia: holdOriginalMediaCompletion({
          db,
          bucket,
          client,
          cap: r.cap,
          birth: r.birth,
          acquire: r.activities.acquireMedia,
        }),
      };
  if (stopping) return;
  worker = await Worker.create({
    connection: native,
    namespace: 'urm-app-staging.qwejt',
    taskQueue: 'urm-media-kernel-recovery',
    identity: `media-recovery-${witness.instanceId}`,
    workflowsPath: require('node:path').resolve(
      __dirname,
      '../../../apps/temporal-worker/src/workflows/verification/media-recovery.ts'
    ),
    activities,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      defaultVersioningBehavior: 'PINNED',
      version: { deploymentName: 'urm-worker-media-recovery-staging', buildId: witness.buildId },
    },
    maxConcurrentActivityTaskExecutions: 1,
    maxHeartbeatThrottleInterval: '1 second',
    defaultHeartbeatThrottleInterval: '1 second',
    shutdownGraceTime: '1 second',
    shutdownForceTime: '5 seconds',
  });
  running = worker.run();
  if (stopping) requestStop();
  void running.catch(() => {
    process.exitCode = 1;
    requestStop();
  });
  expiry = setTimeout(requestStop, Math.max(0, r.cap.plan.expiresAt - Date.now()));
  monitor = setInterval(() => {
    void r.authorize().catch(requestStop);
  }, 2000);
  monitor.unref();
  await running;
})()
  .catch((e) => {
    process.exitCode = 1;
    const code =
      typeof e?.code === 'string' && /^[a-z-]+\/[a-z-]+$/.test(e.code)
        ? e.code
        : typeof e?.message === 'string' && /^[A-Z_]{1,100}$/.test(e.message)
        ? e.message
        : 'unclassified';
    console.error('Owned supervised recovery child failed / ' + code);
  })
  .finally(() => stop());
