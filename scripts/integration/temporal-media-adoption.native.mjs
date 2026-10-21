import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { bounded, groupAbsent, stopOwnedGroup } from './fixtures/owned-media-process.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const { initializeApp, deleteApp } = require('firebase-admin/app');
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
  ['FIRESTORE_EMULATOR_HOST', harness.emulators.firestore.port],
  ['FIREBASE_DATABASE_EMULATOR_HOST', harness.emulators.database.port],
  ['FIREBASE_STORAGE_EMULATOR_HOST', harness.emulators.storage.port],
];
for (const [name, port] of emulatorNames)
  if (process.env[name] !== `127.0.0.1:${port}`) throw new Error('Dedicated emulator required');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function launch(address, holdAck) {
  const child = fork(fileURLToPath(new URL('./fixtures/media-adoption-child.cjs', import.meta.url)), [], {
    detached: true,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'test',
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

for (const mode of ['adopt', 'replaced-generation', 'superseded'])
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
          storageBucket: `${projectId}.appspot.com`,
          databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`,
        },
        id
      );
      const db = getFirestore(app),
        bucket = getStorage(app).bucket();
      const source = bucket.file(`sermons/${id}.wav`);
      await bounded(source.save(pcm(), { resumable: false, preconditionOpts: { ifGenerationMatch: 0 } }));
      const [metadata] = await bounded(source.getMetadata());
      const payload = { id, storageFilePath: source.name, startTime: 0, duration: 1 };
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
          sources: { storage: { path: source.name, generation: String(metadata.generation) } },
        })
      );
      await bounded(db.doc(`temporalMediaState/${id}`).create({ owner: 'temporal', ref }));
      await bounded(db.doc(`durableJobs/${id}`).create({ state: 'queued' }));
      await bounded(db.doc(`sermons/${id}`).create({ status: { audioStatus: 'PENDING', subsplash: 'UPLOADED' } }));
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
      const first = launch(environment.address, true);
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
      assert.equal(accepted.runId, handle.firstExecutionRunId);
      assert.equal(accepted.workflowId, id);
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
      const second = launch(environment.address, false);
      children.push(second);
      stage = 'second-ready';
      const after = await second.ready;
      assert.notEqual(after.pid, before.pid);
      assert.notEqual(after.instanceId, before.instanceId);
      stage = 'second-acquired';
      if (mode === 'replaced-generation') {
        const rejected = await second.next('activity-error');
        assert.equal(rejected.code, 'INVALID_MEDIA_ARTIFACT');
        await assert.rejects(
          bounded(handle.result()),
          (error) => error.cause?.cause?.type === 'INVALID_MEDIA_ARTIFACT'
        );
      } else {
        const adopted = await second.next('acquired');
        assert.equal(adopted.attempt, 2);
        assert.equal(adopted.runId, accepted.runId);
        assert.equal(adopted.workflowId, id);
        assert.deepEqual(await bounded(handle.result()), { kind: mode === 'superseded' ? 'superseded' : 'ready' });
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
        mode === 'replaced-generation' ? 0 : 1
      );
      assert.equal(
        history.events.filter((e) => e.activityTaskFailedEventAttributes).length,
        mode === 'replaced-generation' ? 1 : 0
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
        const db = getFirestore(app);
        for (const collection of ['temporalMediaRequests', 'temporalMediaState', 'durableJobs', 'sermons']) {
          try {
            await bounded(db.doc(`${collection}/${id}`).delete());
          } catch (error) {
            failures.push(error);
          }
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
                : 'assertion-or-cleanup'
            )
            .join('; ')}`
        );
    }
  });
