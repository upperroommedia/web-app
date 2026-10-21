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
      storageBucket:
        process.env.URM_MEDIA_REMOTE_ONLY === '1'
          ? 'urm-app-staging.firebasestorage.app'
          : 'urm-app-staging.appspot.com',
      databaseURL: 'https://urm-app-staging-default-rtdb.firebaseio.com',
    });
    const db = getFirestore(app);
    stage = 'connection';
    connection = await NativeConnection.connect({ address: message.address });
    clientConnection = await Connection.connect({ address: message.address });
    const client = new Client({ connection: clientConnection, namespace: 'default' });
    const remoteMode = process.env.URM_MEDIA_REMOTE_ONLY === '1';
    if (remoteMode) {
      process.env.TEMPORAL_MEDIA_YOUTUBE_ACQUISITION = 'hetzner-v1';
      process.env.TEMPORAL_WORKER_HOSTING = 'cloud-run';
      const acquisition = require('../../../apps/process-audio/src/temporal/hetzner-acquisition.ts');
      const provider = require('../../../apps/process-audio/src/processYouTubeUrl.ts');
      provider.downloadYouTubeAudioToFile = async () => {
        throw Error('TEST_VENDOR_NETWORK_FORBIDDEN');
      };
      const { getStorage } = rootRequire('firebase-admin/storage'),
        { getAuth } = rootRequire('firebase-admin/auth'),
        { Readable } = require('node:stream');
      const {
        createYouTubeAcquisitionHostStore,
        YOUTUBE_ACQUISITIONS,
      } = require('../../../apps/process-audio/src/temporal/hetzner-acquisition-store.ts');
      const {
        readEligibleYouTubeAcquisition,
      } = require('../../../apps/process-audio/src/temporal/hetzner-acquisition-policy.ts');
      const { uploadYouTubeObject } = require('../../../apps/process-audio/src/temporal/hetzner-acquisition-upload.ts');
      acquisition.createHetznerAcquisitionTransport = () => async (method, request, signal) => {
        if (method !== 'GET') throw Error('Unexpected repeated remote admission');
        const record = db.doc(`${YOUTUBE_ACQUISITIONS}/${request.operationId}`),
          prepared = await record.get();
        if (prepared.get('status') === 'source')
          return { status: 'ready', operationId: request.operationId, artifact: prepared.get('result.artifact') };
        if (prepared.get('preparedBy.instanceId') !== `CONTROLLED_CLOUD_${instanceId}`)
          throw Error('Native preparer not bound');
        // CONTROLLED host identity and drain only. Real SDK Activity/actor/canonical
        // guard, private store/upload, actual emulator bytes and local tools below.
        const host = createYouTubeAcquisitionHostStore({
          firestore: db,
          projectId: 'urm-app-staging',
          owner: {
            bootId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            pidNamespace: 'pid:[1234]',
            processId: process.pid,
            startTicks: '100',
            buildId: 'b'.repeat(40),
          },
          assertEligible: async (tx, ref, purpose) => {
            const result = await readEligibleYouTubeAcquisition({
              firestore: db,
              auth: getAuth(app),
              transaction: tx,
              ref,
            });
            if (result.kind !== (purpose === 'source_available' ? 'source_available' : 'ready'))
              throw Error('Host canonical authority denied');
          },
        });
        if (!(await host.claim(request.ref, prepared.get('preparedBy.serviceAccount'))).launch)
          throw Error('Unexpected host claim');
        const [bytes] = await getStorage(app).bucket().file(`sermons/${request.ref.sermonId}.wav`).download();
        const journal = host.upload(request.ref, randomUUID());
        const artifact = await uploadYouTubeObject({
          journal,
          signal,
          start: async () => ({
            output: Readable.from([bytes]),
            completion: Promise.resolve('succeeded'),
            drain: async () => undefined,
          }),
        });
        await host.settle(request.ref, { kind: 'source', artifact }, async () => undefined);
        if (process.env.URM_MEDIA_REMOTE_CASE === 'remote-revoked')
          await getAuth(app).setCustomUserClaims(request.ref.jobId, { role: 'guest' });
        if (process.env.URM_MEDIA_REMOTE_CASE === 'remote-owner-changed')
          await db.doc(`sermons/${request.ref.sermonId}`).update({ uploaderId: 'CONTROLLED_FOREIGN_OWNER' });
        if (process.env.URM_MEDIA_REMOTE_CASE === 'remote-generation-drift')
          await getStorage(app)
            .bucket()
            .file(artifact.path)
            .save(Buffer.from('owned-generation-replacement'), {
              resumable: false,
              preconditionOpts: { ifGenerationMatch: artifact.generation },
            });
        if (process.env.URM_MEDIA_REMOTE_CASE === 'remote-checksum-drift')
          return { status: 'ready', operationId: request.operationId, artifact: { ...artifact, crc32c: 'AAAAAA==' } };
        return { status: 'ready', operationId: request.operationId, artifact };
      };
    }
    const { createRuntimeActivities } = require('../../../apps/temporal-worker/src/runtime/activities.ts');
    const activities = createRuntimeActivities('urm-app-staging', ['urm-media'], client, {
      instanceId,
      buildId: 'a'.repeat(40),
      ...(remoteMode
        ? {
            cloudRun: {
              projectId: 'urm-app-staging',
              region: 'us-central1',
              pool: 'controlled-media',
              revision: 'controlled-media-r1',
              revisionUid: 'CONTROLLED_REVISION_UID',
              imageDigest: 'sha256:' + 'a'.repeat(64),
              serviceAccount: 'tw-m-' + 'a'.repeat(20) + '@urm-app-staging.iam.gserviceaccount.com',
              instanceId: `CONTROLLED_CLOUD_${instanceId}`,
            },
          }
        : {}),
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
