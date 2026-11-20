import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { bounded, groupAbsent, stopOwnedGroup } from './fixtures/owned-media-process.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
require(fileURLToPath(new URL('./fixtures/current-workspace-source.cjs', import.meta.url)));
require('ts-node').register({
  preferTsExts: true,
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { createDurableJobStore, durableEntityKey, DURABLE_COLLECTIONS } = require('@upperroom/orchestration/job-store');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { getDatabase } = require('firebase-admin/database');
const { Worker, Runtime, DefaultLogger } = require('@temporalio/worker');
const { computeProcessAudioRequestVersion } = require('@upperroom/contracts/processAudioQueue');
const { createLocalTestEnvironment } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/test-support/local-test-environment.ts', import.meta.url)
));
Runtime.install({ logger: new DefaultLogger('ERROR', () => undefined) });
const harness = require('./firebase.test.json');
const emulatorNames = [
  ['FIREBASE_AUTH_EMULATOR_HOST', harness.emulators.auth.port],
  ['FIRESTORE_EMULATOR_HOST', harness.emulators.firestore.port],
  ['FIREBASE_DATABASE_EMULATOR_HOST', harness.emulators.database.port],
  ['FIREBASE_STORAGE_EMULATOR_HOST', harness.emulators.storage.port],
];
for (const [name, port] of emulatorNames)
  if (process.env[name] !== `127.0.0.1:${port}`) throw new Error('Dedicated emulator required');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function launch(address, holdAck, remoteCase) {
  const child = fork(fileURLToPath(new URL('./fixtures/media-adoption-child.cjs', import.meta.url)), [], {
    detached: true,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'test',
      URM_MEDIA_REMOTE_ONLY: process.env.URM_MEDIA_REMOTE_ONLY,
      URM_MEDIA_REMOTE_CASE: remoteCase,
      FIREBASE_PROJECT_ID: 'urm-app-staging',
      GCLOUD_PROJECT: 'urm-app-staging',
      ...Object.fromEntries(emulatorNames.map(([key]) => [key, process.env[key]])),
    },
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  void exited.catch(() => {});
  const messages = [],
    waiters = [];
  child.on('message', (value) => {
    if (value?.type === 'error') {
      for (const waiter of waiters.splice(0))
        waiter.reject(
          new Error(
            `Owned media child failed / ${
              ['start', 'firebase', 'connection', 'worker', 'acquire'].includes(value.stage) ? value.stage : 'unknown'
            }`
          )
        );
      return;
    }
    if (
      !value ||
      value.pid !== child.pid ||
      !/^[a-f0-9-]{36}$/.test(value.instanceId) ||
      value.identity !== `owned-media-${child.pid}-${value.instanceId}`
    ) {
      for (const waiter of waiters.splice(0)) waiter.reject(new Error('Owned media child identity mismatch'));
      return;
    }
    messages.push(value);
    if (value.type === 'activity-error') {
      const code = [
        'INVALID_MEDIA_REQUEST',
        'MEDIA_ACQUISITION_FAILED',
        'MEDIA_STAGE_FAILED',
        'INVALID_MEDIA_REFERENCE',
        'INVALID_MEDIA_ARTIFACT',
        'PERMISSION_CHANGED',
      ].includes(value.code)
        ? value.code
        : 'unknown';
      for (const waiter of [...waiters]) {
        if (waiter.type !== 'acquired') continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.reject(new Error(`Owned source Activity failed / ${code}`));
      }
    }
    for (const waiter of [...waiters]) {
      if (waiter.type !== value.type) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(value);
    }
  });
  const next = (type) => {
    const saved = messages.find((value) => value.type === type);
    if (saved) return Promise.resolve(saved);
    return bounded(
      new Promise((resolve, reject) => {
        waiters.push({ type, resolve, reject });
        void exited.then(() => reject(new Error('Owned media child exited')), reject);
      }),
      30000
    );
  };
  const ready = next('ready');
  void ready.catch(() => {});
  child.send({ type: 'start', address, holdAck }, (error) => {
    if (error) child.kill('SIGKILL');
  });
  return { child, exited, ready, next };
}
function pcm() {
  const bytes = Buffer.alloc(32044);
  bytes.write('RIFF');
  bytes.writeUInt32LE(32036, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(32000, 40);
  for (let i = 0; i < 16000; i++) bytes.writeInt16LE(Math.round(10000 * Math.sin((i * Math.PI) / 20)), 44 + 2 * i);
  return bytes;
}

function loseCommitAcknowledgement(db, lostAt) {
  let commits = 0;
  return new Proxy(db, {
    get(target, key) {
      if (key === 'runTransaction')
        return async (...args) => {
          const result = await db.runTransaction(...args);
          if (++commits === lostAt) throw new Error('controlled lost commit acknowledgement');
          return result;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

if (process.env.URM_MEDIA_REMOTE_ONLY !== '1')
  test('render episode lost commit acknowledgement cannot publish an unauthorized head', async () => {
    const { prepareNativeYouTubeEpisode, readPreparedYouTubeEpisodeInTransaction } = require(fileURLToPath(
      new URL('../../apps/process-audio/src/temporal/hetzner-acquisition-episode.ts', import.meta.url)
    ));
    const { youtubeAcquisitionId } = require(fileURLToPath(
      new URL('../../apps/process-audio/src/temporal/hetzner-acquisition.ts', import.meta.url)
    ));
    const app = initializeApp({ projectId: 'urm-app-staging' }, `render-proposal-${randomUUID()}`);
    const db = getFirestore(app);
    const owned = [];
    try {
      for (const lostAt of [1, 2]) {
        const ref = {
          projectId: 'urm-app-staging',
          jobId: `job-${randomUUID()}`,
          sermonId: `sermon-${randomUUID()}`,
          requestVersion: 'a'.repeat(16),
          revision: 1,
        };
        const root = db.collection('temporalYouTubeAcquisitions').doc(youtubeAcquisitionId(ref));
        owned.push(root);
        const caller = {
          buildId: 'a'.repeat(40),
          serviceAccount: `tw-m-${'a'.repeat(20)}@urm-app-staging.iam.gserviceaccount.com`,
          instanceId: 'owned-fixture',
        };
        const invocation = { workflowId: randomUUID(), runId: randomUUID(), activityId: 'render', attempt: 1 };
        const input = { firestore: db, ref, caller, invocation, assertCurrent: async () => {}, render: true };
        await assert.rejects(
          prepareNativeYouTubeEpisode({ ...input, firestore: loseCommitAcknowledgement(db, lostAt) }),
          /controlled lost commit/
        );
        const proposals = await root.collection('renderProposals').get();
        assert.equal(proposals.size, 1);
        const proposedId = proposals.docs[0].id;
        const original = await root.get();
        assert.equal(original.exists, lostAt === 2);
        if (lostAt === 2) {
          assert.equal(original.get('preparedEpisode'), proposedId);
          assert.equal(
            (await root.collection('episodes').doc(proposedId).collection('facts').doc('authorized').get()).exists,
            true
          );
        }
        const selected = await prepareNativeYouTubeEpisode({
          ...input,
          invocation: { ...invocation, attempt: 2 },
        });
        assert.equal(selected === proposedId, lostAt === 2);
        const observed = await db.runTransaction((tx) =>
          readPreparedYouTubeEpisodeInTransaction(tx, {
            firestore: db,
            ref,
            render: true,
            verifiedCallerEmail: caller.serviceAccount,
          })
        );
        assert.equal(observed.episode.id, selected);
        assert.equal((await root.collection('episodes').get()).size, 1);
      }
    } finally {
      const cleanup = await Promise.allSettled(owned.map((root) => db.recursiveDelete(root)));
      await db.terminate();
      await deleteApp(app);
      assert(
        cleanup.every((row) => row.status === 'fulfilled'),
        'Owned proposal cleanup failed'
      );
    }
  });

if (process.env.URM_MEDIA_REMOTE_ONLY !== '1')
  test('render archive wait survives both lost commit acknowledgements', async (t) => {
    const {
      prepareNativeYouTubeEpisode,
      recordNativeYouTubeRenderArchiveWait,
      readPreparedYouTubeEpisodeInTransaction,
    } = require(fileURLToPath(
      new URL('../../apps/process-audio/src/temporal/hetzner-acquisition-episode.ts', import.meta.url)
    ));
    const { youtubeAcquisitionId } = require(fileURLToPath(
      new URL('../../apps/process-audio/src/temporal/hetzner-acquisition.ts', import.meta.url)
    ));
    const { MEDIA_ARCHIVE_RETRY_DELAYS } = require(fileURLToPath(
      new URL('../../apps/process-audio/src/temporal/types.ts', import.meta.url)
    ));
    const app = initializeApp({ projectId: 'urm-app-staging' }, `archive-proposal-${randomUUID()}`);
    const db = getFirestore(app);
    const owned = [];
    try {
      for (const lostAt of [1, 2]) {
        const ref = {
          projectId: 'urm-app-staging',
          jobId: `job-${randomUUID()}`,
          sermonId: `sermon-${randomUUID()}`,
          requestVersion: 'a'.repeat(16),
          revision: 1,
        };
        const operationId = youtubeAcquisitionId(ref);
        const root = db.collection('temporalYouTubeAcquisitions').doc(operationId);
        owned.push(root);
        const caller = {
          buildId: 'a'.repeat(40),
          serviceAccount: `tw-m-${'a'.repeat(20)}@urm-app-staging.iam.gserviceaccount.com`,
          instanceId: 'owned-fixture',
        };
        const invocation = { workflowId: randomUUID(), runId: randomUUID(), activityId: 'render', attempt: 1 };
        const assertCurrent = async () => {};
        const episodeId = await prepareNativeYouTubeEpisode({
          firestore: db,
          ref,
          caller,
          invocation,
          assertCurrent,
          render: true,
        });
        const render = root.collection('render');
        const startedAt = Date.now();
        const owner = { processId: 42 };
        await root.update({ renderClaim: episodeId });
        await render.doc('claim').create({ schemaVersion: 1, operationId, episodeId, ref, startedAt, owner });
        await render.doc('candidate').create({
          schemaVersion: 1,
          episodeId,
          ref,
          startedAt,
          owner,
          providerOutcome: 'waiting_archive',
        });
        const candidate = await render.doc('candidate').get();
        await render.doc('close').create({
          schemaVersion: 1,
          episodeId,
          ref,
          startedAt,
          owner,
          close: { processId: 42, outcome: 'completed', exitCode: 0, exitSignal: null, closedAt: Date.now() },
          ipcAttempted: true,
          candidateVersion: candidate.updateTime,
        });
        const scheduledAt = Date.now();
        const wait = { attempt: 1, scheduledAt, dueAt: scheduledAt + MEDIA_ARCHIVE_RETRY_DELAYS[0] };
        const projection = { ...invocation, activityId: 'archive-projection' };
        const input = {
          firestore: db,
          ref,
          wait,
          invocation: projection,
          sourceBuildId: caller.buildId,
          assertCurrent,
        };
        await assert.rejects(
          recordNativeYouTubeRenderArchiveWait({ ...input, firestore: loseCommitAcknowledgement(db, lostAt) }),
          /controlled lost commit/
        );
        const waitRef = render.doc('archiveWait');
        const authorityRef = render.doc('archiveWaitAuthorized');
        assert.equal((await waitRef.get()).exists, lostAt === 2);
        const first = await authorityRef.get();
        assert.equal(first.exists, lostAt === 2);
        assert.equal((await waitRef.collection('proposals').get()).size, 1);
        await recordNativeYouTubeRenderArchiveWait({
          ...input,
          invocation: { ...projection, attempt: 2 },
        });
        const current = await authorityRef.get();
        assert.equal(current.get('schemaVersion'), 2);
        if (lostAt === 2) assert(first.updateTime.isEqual(current.updateTime));
        assert.equal((await waitRef.collection('proposals').get()).size, lostAt === 1 ? 2 : 1);
        await recordNativeYouTubeRenderArchiveWait({
          ...input,
          invocation: { ...projection, attempt: 3 },
        });
        assert(current.updateTime.isEqual((await authorityRef.get()).updateTime));

        const clock = require(fileURLToPath(
          new URL('../../apps/process-audio/src/temporal/system-time.ts', import.meta.url)
        ));
        const now = Date.now();
        const advance = t.mock.method(clock, 'mediaWallTime', () => wait.dueAt + Date.now() - now);
        try {
          const selected = await prepareNativeYouTubeEpisode({
            firestore: db,
            ref,
            caller,
            assertCurrent,
            render: true,
            archiveResume: wait,
            invocation: { ...invocation, activityId: 'render-after-archive' },
          });
          assert.notEqual(selected, episodeId);
          const read = () =>
            db.runTransaction((tx) =>
              readPreparedYouTubeEpisodeInTransaction(tx, {
                firestore: db,
                ref,
                render: true,
                verifiedCallerEmail: caller.serviceAccount,
              })
            );
          const prepared = await read();
          assert.equal(prepared.episode.id, selected);
          assert.equal(prepared.episode.predecessor.id, episodeId);
          await waitRef.collection('proposals').doc(current.get('proposalId')).delete();
          await assert.rejects(read(), /YOUTUBE_EPISODE_UNCONFIRMED/);
        } finally {
          advance.mock.restore();
        }
      }
    } finally {
      const cleanup = await Promise.allSettled(owned.map((root) => db.recursiveDelete(root)));
      await db.terminate();
      await deleteApp(app);
      assert(
        cleanup.every((row) => row.status === 'fulfilled'),
        'Owned archive proposal cleanup failed'
      );
    }
  });

if (process.env.URM_MEDIA_REMOTE_ONLY !== '1')
  test('original render close reconciles a lost commit without releasing twice', async () => {
    const { prepareNativeYouTubeEpisode } = require(fileURLToPath(
      new URL('../../apps/process-audio/src/temporal/hetzner-acquisition-episode.ts', import.meta.url)
    ));
    const { recordCanonicalYouTubeRenderClose } = require(fileURLToPath(
      new URL('../../apps/process-audio/src/temporal/hetzner-render-driver.ts', import.meta.url)
    ));
    const { youtubeAcquisitionId } = require(fileURLToPath(
      new URL('../../apps/process-audio/src/temporal/hetzner-acquisition.ts', import.meta.url)
    ));
    const { readYouTubeRenderSlot, youtubeRenderSlot } = require(fileURLToPath(
      new URL('../../apps/process-audio/src/temporal/hetzner-render-slot.ts', import.meta.url)
    ));
    const app = initializeApp({ projectId: 'urm-app-staging' }, `render-close-${randomUUID()}`);
    const db = getFirestore(app);
    try {
      for (const mode of ['definite-abort', 'committed-ack-lost', 'uncommitted-ack-unknown']) {
        const ref = { projectId: 'urm-app-staging', jobId: `job-${randomUUID()}`,
          sermonId: `sermon-${randomUUID()}`, requestVersion: 'a'.repeat(16), revision: 1 };
        const root = db.collection('temporalYouTubeAcquisitions').doc(youtubeAcquisitionId(ref));
        const slot = (await db.runTransaction((tx) => readYouTubeRenderSlot(tx, db))).ref;
        const caller = { buildId: 'a'.repeat(40), serviceAccount: `tw-m-${'a'.repeat(20)}@urm-app-staging.iam.gserviceaccount.com`,
          instanceId: 'owned-fixture' };
        try {
          const episodeId = await prepareNativeYouTubeEpisode({ firestore: db, ref, caller, render: true, assertCurrent: async () => {},
            invocation: { workflowId: randomUUID(), runId: randomUUID(), activityId: 'render', attempt: 1 } });
          const startedAt = Date.now(), owner = { processId: 42 };
          const claim = { schemaVersion: 1, episodeId, operationId: root.id, ref, owner, startedAt,
            sourcePath: 'controlled-source', processedPath: 'controlled-processed', mergedPath: null };
          const close = { processId: 42, closedAt: startedAt + 1, outcome: 'cancelled', exitCode: null, exitSignal: 'SIGTERM' };
          await db.batch().update(root, { renderClaim: episodeId }).create(root.collection('render').doc('claim'), claim)
            .create(slot, youtubeRenderSlot(ref, episodeId)).commit();
          const fault = Object.assign(new Error('controlled close transaction outcome'), { code: mode === 'definite-abort' ? 10 : 4 });
          let writes = 0;
          const firestore = new Proxy(db, {
            get(target, key) {
              if (key === 'runTransaction') return async (callback, options) => {
                writes++;
                if (writes === 1 && mode === 'definite-abort') throw fault;
                const result = await db.runTransaction(async (tx) => {
                  const value = await callback(tx);
                  if (mode === 'uncommitted-ack-unknown') throw fault;
                  return value;
                }, options);
                if (mode === 'committed-ack-lost') throw fault;
                return result;
              };
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          const result = recordCanonicalYouTubeRenderClose({ firestore, ref, episodeId, verifiedCallerEmail: caller.serviceAccount,
            claim, close, ipcAttempted: true });
          if (mode === 'uncommitted-ack-unknown') await assert.rejects(result, fault);
          else await result;
          assert.equal(writes, mode === 'definite-abort' ? 2 : 1);
          const stored = await root.collection('render').doc('close').get();
          assert.equal(stored.exists, mode !== 'uncommitted-ack-unknown');
          assert.equal((await slot.get()).exists, mode === 'uncommitted-ack-unknown');
          if (stored.exists) assert.deepEqual(stored.get('close'), close);
        } finally {
          if ((await slot.get()).get('operationId') === root.id) await slot.delete();
          await db.recursiveDelete(root);
        }
      }
    } finally {
      await db.terminate();
      await deleteApp(app);
    }
  });

if (process.env.URM_MEDIA_REMOTE_ONLY !== '1')
  test('retained render reservation transfers once or closes on cancellation', async () => {
    const { reserveYouTubeRenderDispatch, retainedYouTubeRenderSlot, youtubeRenderSlot } = require(fileURLToPath(
      new URL('../../apps/process-audio/src/temporal/hetzner-render-slot.ts', import.meta.url)
    ));
    const { awaitYouTubeRenderDrain } = require(fileURLToPath(
      new URL('../../apps/process-audio/src/temporal/hetzner-render-drain.ts', import.meta.url)
    ));
    const app = initializeApp({ projectId: 'urm-app-staging' }, `retained-render-${randomUUID()}`);
    const db = getFirestore(app);
    const ref = {
      projectId: 'urm-app-staging',
      jobId: `job-${randomUUID()}`,
      sermonId: `sermon-${randomUUID()}`,
      requestVersion: 'a'.repeat(16),
      revision: 1,
    };
    const before = randomUUID();
    const after = randomUUID();
    const authId = randomUUID();
    const previousSlot = retainedYouTubeRenderSlot(ref, before, authId);
    const slot = db.collection('temporalYouTubeRenderHosts').doc('staging');
    const root = db.collection('temporalYouTubeAcquisitions').doc(previousSlot.operationId);
    const dispatch = root.collection('render').doc('dispatch');
    let ownsSlot = false;
    try {
      await slot.create(previousSlot);
      ownsSlot = true;
      const body = { schemaVersion: 1, ref, episodeId: after };
      const reserve = (transferFrom, firestore = db) =>
        reserveYouTubeRenderDispatch({
          firestore,
          signal: new AbortController().signal,
          assertCurrent: async () => {},
          read: async (tx) => ({
            dispatch: await tx.get(dispatch),
            body,
            slot: youtubeRenderSlot(ref, after),
            active: true,
            transferFrom,
          }),
        });
      assert.equal(await reserve(undefined), 'busy');
      assert.equal(await reserve(retainedYouTubeRenderSlot(ref, before, randomUUID())), 'busy');
      assert.equal(await reserve(previousSlot, loseCommitAcknowledgement(db, 1)), true);
      assert.equal(await reserve(previousSlot), false);
      assert.deepEqual((await slot.get()).data(), youtubeRenderSlot(ref, after));
      assert.deepEqual((await dispatch.get()).data(), body);
      // Separate closed-probe fixture exercises the cancellation path without
      // executing a live renderer or changing a real reservation.
      await slot.set(previousSlot);
      await dispatch.delete();
      await root.create({ ref, renderProtocol: 1, preparedEpisode: before });
      const auth = root.collection('render').doc('authentication');
      await auth.create({ id: authId });
      const facts = auth.collection('attempts').doc(authId).collection('facts');
      const owner = { processId: 42 };
      await facts.doc('claim').create({ id: authId, episodeId: before, owner, startedAt: 1 });
      const close = { processId: 42, closedAt: 2, outcome: 'completed', exitCode: 0, exitSignal: null };
      await db
        .batch()
        .create(facts.doc('completion'), { id: authId, owner, close, status: 'ready', retainedSlot: true })
        .create(facts.doc('drain'), { id: authId, owner, close })
        .commit();
      await awaitYouTubeRenderDrain({ firestore: db, ref, stop: true, polls: 1 });
      assert.equal((await slot.get()).exists, false);
      assert.equal((await root.get()).get('renderStopped'), true);

      // The same retained proof must also close if cancellation sees the
      // successor head before its first dispatch.
      const successor = root.collection('episodes').doc(after);
      await db
        .batch()
        .create(slot, previousSlot)
        .create(successor, { ref, predecessor: { id: before, authenticationGeneration: authId } })
        .create(successor.collection('runtime').doc('current'), { ref, operationId: root.id, preparedEpisode: after })
        .update(root, { headEpisode: after })
        .commit();
      await awaitYouTubeRenderDrain({ firestore: db, ref, stop: true, polls: 1 });
      assert.equal((await slot.get()).exists, false);
    } finally {
      if (ownsSlot && (await slot.get()).get('operationId') === previousSlot.operationId) await slot.delete();
      await db.recursiveDelete(root);
      await db.terminate();
      await deleteApp(app);
    }
  });

for (const mode of process.env.URM_MEDIA_REMOTE_ONLY === '1'
  ? (process.env.URM_MEDIA_REMOTE_CASES ?? 'remote-adopt').split(',')
  : ['adopt', 'replaced-generation', 'superseded', 'role-revoked', 'actor-disabled', 'canonical-owner-changed'])
  test(`real source media acquisition/OS replacement / ${mode}`, async () => {
    const id = `adoption-${randomUUID()}`,
      children = [],
      failures = [];
    let app,
      environment,
      workflowWorker,
      running,
      handle,
      stage = 'setup';
    const projectId = 'urm-app-staging';
    try {
      app = initializeApp(
        {
          projectId,
          storageBucket: mode.startsWith('remote-') ? `${projectId}.firebasestorage.app` : `${projectId}.appspot.com`,
          databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`,
        },
        id
      );
      const db = getFirestore(app),
        bucket = getStorage(app).bucket();
      const source = bucket.file(`sermons/${id}.wav`);
      await bounded(source.save(pcm(), { resumable: false, preconditionOpts: { ifGenerationMatch: 0 } }));
      const [metadata] = await bounded(source.getMetadata());
      const remote = mode.startsWith('remote-'),
        remoteRender = mode === 'remote-render-adopt',
        remoteNegative = remote && mode !== 'remote-adopt' && !remoteRender;
      const payload = remote
        ? { id, youtubeUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', startTime: 0, duration: 1 }
        : { id, storageFilePath: source.name, startTime: 0, duration: 1 };
      if (remote) {
        assert.equal((await db.doc('_control/temporalRelease').get()).exists, false);
        await db.doc('_control/temporalRelease').create({
          schemaVersion: 1,
          revision: 1,
          admission: 'open',
          domains: { media: { owner: 'temporal', admission: 'open' } },
          releaseId: id,
        });
      }
      const ref = {
        projectId,
        jobId: id,
        sermonId: id,
        revision: 1,
        requestVersion: computeProcessAudioRequestVersion(payload),
      };
      const request = db.doc(`temporalMediaRequests/${id}`);
      await bounded(
        request.create({
          ref,
          payload,
          sources: remote ? {} : { storage: { path: source.name, generation: String(metadata.generation) } },
        })
      );
      await bounded(db.doc(`temporalMediaState/${id}`).create({ owner: 'temporal', ref }));
      await bounded(getAuth(app).createUser({ uid: id }));
      await bounded(getAuth(app).setCustomUserClaims(id, { role: 'uploader' }));
      await bounded(
        db.doc(`sermons/${id}`).create({ uploaderId: id, status: { audioStatus: 'PENDING', subsplash: 'UPLOADED' } })
      );
      const store = createDurableJobStore({ firestore: db, projectId });
      await bounded(
        db.runTransaction(async (tx) => {
          await tx.get(db.doc(`sermons/${id}`));
          store.createInTransaction(tx, {
            ref: { projectId, jobId: id },
            kind: 'audio.process',
            entity: { type: 'sermon', id },
            actorUid: id,
            payload: remote ? { mediaRequestId: id } : payload,
            requestId: id,
            generation: 1,
            createdAt: Date.now(),
            dispatch: {
              ref,
              workflowId: id,
              workflowType: 'MediaArtifactAdoptionProbe',
              taskQueue: 'owned-media-adoption-workflow',
            },
          });
        })
      );
      environment = await createLocalTestEnvironment({
        server: { executable: { type: 'cached-download', version: 'v1.9.1' } },
      });
      workflowWorker = await bounded(
        Worker.create({
          connection: environment.nativeConnection,
          namespace: 'default',
          taskQueue: 'owned-media-adoption-workflow',
          workflowsPath: fileURLToPath(new URL('./fixtures/media-adoption-workflow.ts', import.meta.url)),
          shutdownGraceTime: '1 second',
          shutdownForceTime: '3 seconds',
        }),
        30000
      );
      running = workflowWorker.run();
      void running.catch(() => {});
      const first = launch(environment.address, !remoteNegative, mode);
      children.push(first);
      stage = 'first-ready';
      const before = await first.ready;
      stage = 'start-workflow';
      handle = await bounded(
        environment.client.connection.withDeadline(Date.now() + 10000, () =>
          environment.client.workflow.start('MediaArtifactAdoptionProbe', {
            workflowId: id,
            taskQueue: 'owned-media-adoption-workflow',
            args: [ref],
            workflowExecutionTimeout: '1 minute',
            workflowIdReusePolicy: 'REJECT_DUPLICATE',
            workflowIdConflictPolicy: 'FAIL',
          })
        )
      );
      if (remoteNegative) {
        stage = 'remote-adoption-authority-denial';
        await assert.rejects(
          bounded(handle.result(), 30000),
          (error) =>
            error.cause?.cause?.type ===
            (['remote-generation-drift', 'remote-checksum-drift'].includes(mode)
              ? 'INVALID_MEDIA_ARTIFACT'
              : 'PERMISSION_CHANGED')
        );
        const rejectedRequest = await request.get();
        assert.equal(rejectedRequest.get('artifacts.source'), undefined);
        assert.equal(rejectedRequest.get('artifacts.processed'), undefined);
        first.child.send({ type: 'stop' });
        await bounded(first.exited);
        await groupAbsent(first);
        return;
      }
      stage = 'first-acquired';
      const accepted = await first.next('acquired').catch(async (error) => {
        const diagnostic = await bounded(request.get());
        const sermon = await bounded(db.doc(`sermons/${id}`).get());
        throw new Error(
          `Owned acquisition diagnostic / source=${!!diagnostic.get('artifacts.source')} / processed=${!!diagnostic.get(
            'artifacts.processed'
          )} / stage=${
            ['downloading', 'transcoding'].includes(sermon.get('status.message'))
              ? sermon.get('status.message')
              : 'other'
          }`
        );
      });
      assert.equal(accepted.attempt, 1);
      if (remoteRender) assert.equal(accepted.renderAdoptionAcknowledgementLost, true);
      assert.equal(accepted.runId, handle.firstExecutionRunId);
      assert.equal(accepted.workflowId, id);
      const executions = await bounded(db.collection(DURABLE_COLLECTIONS.executions).where('jobId', '==', id).get());
      assert.equal(executions.size, 1);
      assert.equal(executions.docs[0].get('runId'), accepted.runId);
      assert.equal(executions.docs[0].get('worker.instanceId'), before.instanceId);
      assert.equal(executions.docs[0].get('activityType'), 'acquireMedia');
      assert.equal((await bounded(db.doc(`durableJobIntents/${id}`).get())).get('actorUid'), id);
      const persisted = await bounded(request.get()),
        artifact = persisted.get('artifacts.processed');
      assert.ok(artifact?.path && artifact?.generation && artifact.duration > 0);
      const [originalBytes] = await bounded(bucket.file(artifact.path, { generation: artifact.generation }).download());
      assert.ok(originalBytes.length > 0);
      const [objectsBefore] = await bounded(bucket.getFiles({ prefix: `workflow-audio/${id}/`, versions: true }));
      assert.equal(objectsBefore.length, 2);
      const inventory = (files) =>
        bounded(
          Promise.all(
            files.map(async (file) => {
              const [m] = await bounded(file.getMetadata());
              return {
                name: file.name,
                generation: String(m.generation),
                size: String(m.size),
                md5: m.md5Hash,
                crc32c: m.crc32c,
              };
            })
          )
        ).then((rows) => rows.sort((a, b) => a.name.localeCompare(b.name) || a.generation.localeCompare(b.generation)));
      const originalInventory = await inventory(objectsBefore);
      assert.ok(originalInventory.every((row) => row.md5 || row.crc32c));
      // The OS kill happens after actual source transcode/upload/transaction, before SDK completion ACK.
      first.child.kill('SIGKILL');
      assert.deepEqual(await bounded(first.exited), { code: null, signal: 'SIGKILL' });
      await groupAbsent(first);
      if (mode === 'replaced-generation')
        await bounded(
          bucket.file(artifact.path).save(Buffer.from('owned replacement'), {
            resumable: false,
            preconditionOpts: { ifGenerationMatch: artifact.generation },
          })
        );
      if (mode === 'superseded')
        await bounded(db.doc(`temporalMediaState/${id}`).update({ ref: { ...ref, jobId: `${id}-new`, revision: 2 } }));
      if (mode === 'role-revoked') await bounded(getAuth(app).setCustomUserClaims(id, { role: 'guest' }));
      if (mode === 'actor-disabled') await bounded(getAuth(app).updateUser(id, { disabled: true }));
      if (mode === 'canonical-owner-changed')
        await bounded(db.doc(`sermons/${id}`).update({ uploaderId: `foreign-${id}` }));
      const authorityDenied = ['role-revoked', 'actor-disabled', 'canonical-owner-changed'].includes(mode);
      const second = launch(environment.address, false, mode);
      children.push(second);
      stage = 'second-ready';
      const after = await second.ready;
      assert.notEqual(after.pid, before.pid);
      assert.notEqual(after.instanceId, before.instanceId);
      stage = 'second-acquired';
      if (mode === 'replaced-generation' || authorityDenied) {
        const rejected = await second.next('activity-error');
        const expectedFailure = authorityDenied ? 'PERMISSION_CHANGED' : 'INVALID_MEDIA_ARTIFACT';
        assert.equal(rejected.code, expectedFailure);
        await assert.rejects(bounded(handle.result()), (error) => error.cause?.cause?.type === expectedFailure);
      } else {
        const adopted = await second.next('acquired');
        assert.equal(adopted.attempt, 2);
        assert.equal(adopted.runId, accepted.runId);
        assert.equal(adopted.workflowId, id);
        assert.deepEqual(await bounded(handle.result()), {
          kind: mode === 'superseded' ? 'superseded' : 'ready',
          ...(remoteRender ? { hostBound: true } : {}),
        });
      }
      const final = await bounded(request.get());
      assert.deepEqual(final.data(), persisted.data());
      assert.equal(final.updateTime.toMillis(), persisted.updateTime.toMillis());
      const [objectsAfter] = await bounded(bucket.getFiles({ prefix: `workflow-audio/${id}/`, versions: true }));
      if (mode !== 'replaced-generation') {
        assert.deepEqual(await inventory(objectsAfter), originalInventory);
        for (const row of originalInventory) {
          const current = await inventory([bucket.file(row.name)]);
          assert.deepEqual(current, [row]);
        }
        const [afterBytes] = await bounded(bucket.file(artifact.path, { generation: artifact.generation }).download());
        assert.equal(digest(afterBytes), digest(originalBytes));
      } else {
        // The only mutation is our deliberate replacement, not a worker upload or artifact adoption.
        const [current] = await bounded(bucket.file(artifact.path).getMetadata());
        assert.notEqual(String(current.generation), artifact.generation);
        assert.equal(Number(current.size), Buffer.byteLength('owned replacement'));
        assert.ok(objectsAfter.every((file) => objectsBefore.some((old) => old.name === file.name)));
      }
      assert.equal((await bounded(db.doc(`sermons/${id}`).get())).get('status.subsplash'), 'UPLOADED');
      if (remote) {
        const { youtubeAcquisitionId } = require(fileURLToPath(
          new URL('../../apps/process-audio/src/temporal/hetzner-acquisition.ts', import.meta.url)
        ));
        const host = await db.doc(`temporalYouTubeAcquisitions/${youtubeAcquisitionId(ref)}`).get();
        assert.equal(host.get('ref.jobId'), id);
        if (remoteRender) {
          const episode = persisted.get('youtubeRenderEpisode');
          assert.equal(host.get('renderClaim'), episode);
          const facts = await host.ref.collection('render').get();
          assert.deepEqual(facts.docs.map((fact) => fact.id).sort(), [
            'candidate',
            'claim',
            'close',
            'dispatch',
            'dispatchSubmission',
          ]);
          const claim = facts.docs.find((fact) => fact.id === 'claim');
          const close = facts.docs.find((fact) => fact.id === 'close');
          assert.equal(claim.get('owner.processId'), before.pid);
          assert.deepEqual(close.get('owner'), claim.get('owner'));
          assert.deepEqual(persisted.get('artifacts.final'), persisted.get('artifacts.processed'));
          assert.equal((await db.doc('temporalYouTubeRenderHosts/staging').get()).exists, false);
        } else {
          assert.equal(host.get('status'), 'source');
          assert.equal((await request.get()).get('artifacts.source.path'), host.get('result.artifact.path'));
          assert.equal((await host.ref.collection('uploads').get()).size, 1);
        }
        assert.equal(
          (await bucket.getFiles({ prefix: `workflow-audio/${id}/${ref.requestVersion}/source-` }))[0].length,
          1
        );
      }

      const history = await bounded(handle.fetchHistory());
      assert.equal(history.events.filter((e) => e.workflowExecutionStartedEventAttributes).length, 1);
      assert.equal(history.events.filter((e) => e.activityTaskScheduledEventAttributes).length, 1);
      const start = history.events.find(
        (e) => e.activityTaskStartedEventAttributes
      )?.activityTaskStartedEventAttributes;
      assert.equal(start.attempt, 2);
      assert.equal(start.identity, after.identity);
      assert.equal(
        history.events.filter((e) => e.activityTaskCompletedEventAttributes).length,
        mode === 'replaced-generation' || authorityDenied ? 0 : 1
      );
      assert.equal(
        history.events.filter((e) => e.activityTaskFailedEventAttributes).length,
        mode === 'replaced-generation' || authorityDenied ? 1 : 0
      );
      assert.equal(
        history.events.some(
          (e) =>
            e.startChildWorkflowExecutionInitiatedEventAttributes || e.workflowExecutionContinuedAsNewEventAttributes
        ),
        false
      );
      second.child.send({ type: 'stop' });
      assert.deepEqual(await bounded(second.exited), { code: 0, signal: null });
      await groupAbsent(second);
    } catch (error) {
      const frame = String(error?.stack ?? '').match(/temporal-media-adoption\.native\.mjs:(\d+):\d+/);
      if (frame) error.fixtureLine = frame[1];
      error.safeFailure =
        error?.code === 'ERR_ASSERTION'
          ? error.message === 'Missing expected rejection.'
            ? 'unexpected-success'
            : 'assertion'
          : error instanceof Error && /^(Owned|Dedicated)/.test(error.message)
          ? error.message
          : 'other';
      failures.push(error);
    } finally {
      // Every owned cleanup runs independently; preserve the primary assertion failure.
      const cleanups = children.map((owned) => () => stopOwnedGroup(owned));
      cleanups.push(async () => {
        if (workflowWorker?.getStatus().runState === 'RUNNING') workflowWorker.shutdown();
        if (running) await bounded(running, 10000);
      });
      for (const cleanup of cleanups)
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      try {
        await environment?.teardown();
      } catch (error) {
        failures.push(error);
      }
      if (app) {
        if (mode.startsWith('remote-'))
          try {
            const db = getFirestore(app),
              control = db.doc('_control/temporalRelease'),
              value = await bounded(control.get());
            if (value.get('releaseId') === id) await bounded(control.delete());
            const records = await bounded(
              db.collection('temporalYouTubeAcquisitions').where('ref.jobId', '==', id).get()
            );
            for (const record of records.docs) await bounded(db.recursiveDelete(record.ref));
          } catch (error) {
            failures.push(error);
          }
        const db = getFirestore(app);
        for (const collection of [
          'temporalMediaRequests',
          'temporalMediaState',
          'durableJobs',
          'durableJobIntents',
          'durableJobOutbox',
          'sermons',
        ]) {
          try {
            await bounded(db.doc(`${collection}/${id}`).delete());
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          await bounded(getAuth(app).deleteUser(id));
          await bounded(
            db
              .doc(`durableJobEntities/${durableEntityKey(projectId, { type: 'sermon', id }, 'audio.process')}`)
              .delete()
          );
          for (const collection of [
            DURABLE_COLLECTIONS.executions,
            DURABLE_COLLECTIONS.stepExecutions,
            DURABLE_COLLECTIONS.drains,
          ]) {
            const records = await bounded(db.collection(collection).where('jobId', '==', id).get());
            for (const record of records.docs) await bounded(record.ref.delete());
          }
        } catch (error) {
          failures.push(error);
        }
        try {
          const artifacts = await bounded(db.collection('temporalMediaArtifacts').where('ownerJobId', '==', id).get());
          for (const artifact of artifacts.docs) await bounded(db.recursiveDelete(artifact.ref));
          await bounded(db.recursiveDelete(db.doc(`temporalMediaJobArtifacts/${id}`)));
        } catch (error) {
          failures.push(error);
        }
        try {
          await bounded(
            getStorage(app)
              .bucket()
              .deleteFiles({ prefix: `workflow-audio/${id}/`, force: true })
          );
        } catch (error) {
          failures.push(error);
        }
        try {
          await bounded(getStorage(app).bucket().file(`sermons/${id}.wav`).delete({ ignoreNotFound: true }));
        } catch (error) {
          failures.push(error);
        }
        try {
          await bounded(getDatabase(app).ref(`addIntroOutro/${id}`).remove());
        } catch (error) {
          failures.push(error);
        }
        try {
          await bounded(getFirestore(app).terminate());
          await bounded(deleteApp(app));
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures.map(
            (error) =>
              new Error(
                error instanceof Error && /^(Owned|Dedicated|Native)/.test(error.message)
                  ? error.message
                  : `Owned media adoption step failed / ${error?.code ?? error?.name ?? 'unknown'}`
              )
          ),
          `Native media adoption fixture failed / ${stage} / ${failures
            .map((error) =>
              error instanceof Error && /^(Owned|Dedicated)/.test(error.message)
                ? error.message
                : `assertion-or-cleanup-line-${error?.fixtureLine ?? 'unknown'}-${error?.safeFailure ?? 'cleanup'}`
            )
            .join('; ')}`
        );
    }
  });
