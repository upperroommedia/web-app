/** Actual LOCAL SDK + dedicated Auth/Firestore/Storage/RTDB + production source
 * admission and media factory. Cloud/revision witnesses and pool cycle are CONTROLLED.
 * No Cloud Run, final image, supervisor replacement or readiness acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { bounded } from './fixtures/owned-media-process.mjs';
import { mediaRecoveryFixture } from '../tests/fixtures/media-recovery.mjs';
import { runMediaRecoveryCycle } from '../temporal-media-recovery-cycle.mjs';
import { prepareMediaRecoveryJournal } from '../temporal-media-recovery-checkpoint.mjs';
import { nativeSnapshotProof, proofDigest as hash } from '../temporal-release-runtime.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
require(fileURLToPath(new URL('./fixtures/current-workspace-source.cjs', import.meta.url)));
require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  preferTsExts: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/workflows/media/resource-test-environment.cjs', import.meta.url)
));
process.env.FIREBASE_PROJECT_ID = 'urm-app-staging';
process.env.GCLOUD_PROJECT = 'urm-app-staging';
const { initializeApp, deleteApp } = require('firebase-admin/app'),
  { getAuth } = require('firebase-admin/auth'),
  { getFirestore } = require('firebase-admin/firestore'),
  { getStorage } = require('firebase-admin/storage'),
  { getDatabase } = require('firebase-admin/database');
const { Worker, Runtime, DefaultLogger } = require('@temporalio/worker'),
  { Client } = require('@temporalio/client');
const { ApplicationFailure } = require('@temporalio/common');
const { createLocalTestEnvironment } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/test-support/local-test-environment.ts', import.meta.url)
));
const { createMediaRecoveryWorkActivities } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/runtime/media-recovery-work.ts', import.meta.url)
));
const harness = require('./firebase.test.json');
for (const [key, port] of [
  ['FIREBASE_AUTH_EMULATOR_HOST', harness.emulators.auth.port],
  ['FIRESTORE_EMULATOR_HOST', harness.emulators.firestore.port],
  ['FIREBASE_DATABASE_EMULATOR_HOST', harness.emulators.database.port],
  ['FIREBASE_STORAGE_EMULATOR_HOST', harness.emulators.storage.port],
])
  if (process.env[key] !== `127.0.0.1:${port}`) throw new Error('Dedicated emulator required');
Runtime.install({ shutdownSignals: [], logger: new DefaultLogger('ERROR', () => undefined) });
test(
  'source-fixed private media producer and native pinned Workflow/Activity / original authority and no outbox',
  { timeout: 150000 },
  async () => {
    const projectId = 'urm-app-staging',
      namespace = `${projectId}.qwejt`,
      queue = 'urm-media-kernel-recovery';
    let app,
      db,
      bucket,
      auth,
      environment,
      worker,
      running,
      handle,
      current,
      stage = 'setup',
      primary;
    const users = [],
      owned = [];
    let ownsControls = false;
    let admissionCalls = 0,
      acquireCalls = 0,
      lostAck = false;
    try {
      app = initializeApp({
        projectId,
        storageBucket: `${projectId}.appspot.com`,
        databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`,
      });
      db = getFirestore(app);
      auth = getAuth(app);
      bucket = getStorage(app).bucket();
      bucket.storage.retryOptions.autoRetry = false;
      for (const name of ['temporalReleaseOperation', 'temporalRelease', 'temporalReleaseState'])
        assert.equal(
          (await bounded(db.doc(`_control/${name}`).get())).exists,
          false,
          'Fixture control must begin absent'
        );
      ownsControls = true;
      const { createRuntimeActivities } = require(fileURLToPath(
        new URL('../../apps/temporal-worker/src/runtime/activities.ts', import.meta.url)
      ));
      environment = await createLocalTestEnvironment({
        server: { executable: { type: 'cached-download', version: 'v1.9.1' } },
      });
      const rpc = (fn) => bounded(fn(), 20000);
      await rpc(() =>
        environment.client.workflowService.registerNamespace({
          namespace,
          workflowExecutionRetentionPeriod: { seconds: 86400 },
        })
      );
      const client = new Client({ connection: environment.client.connection, namespace });
      let version;
      for (const mode of [
        'normal',
        'admission-ack-loss',
        'actor-revoked-after-upload',
        'preexisting-native-run',
        'source-collision',
        'canonical-owner-collision',
        'auth-private-error',
        'storage-private-error',
        'firestore-private-error',
      ]) {
        stage = `${mode}/setup`;
        const f = await mediaRecoveryFixture();
        let cycle;
        f.options.runtime.execute = async () => {
          cycle = structuredClone(f.saved);
          throw new Error('CONTROLLED_CAPTURE');
        };
        await assert.rejects(runMediaRecoveryCycle(f.options));
        const plan = cycle.plan,
          op = plan.operationId,
          id = `media-recovery-${op}`,
          email = `${op}@example.test`,
          uid = `actor-${op}`,
          nonce = randomUUID();
        users.push(uid);
        owned.push({ op, id, releaseId: plan.releaseId });
        await bounded(auth.createUser({ uid, email }));
        await bounded(auth.setCustomUserClaims(uid, { role: 'admin' }));
        const lockRef = db.doc('_control/temporalReleaseOperation'),
          controlRef = db.doc('_control/temporalRelease'),
          stateRef = db.doc('_control/temporalReleaseState');
        await bounded(
          lockRef.set({
            action: 'diagnose-cloud-run-media-recovery',
            operationId: op,
            releaseId: plan.releaseId,
            bindingDigest: plan.bindingDigest,
            operatorPrincipal: { email, adcAndGcloudAccountMatch: true },
            cloudMediaRecovery: { plan, stage: 'planned' },
          })
        );
        await bounded(
          controlRef.set({
            releaseId: plan.releaseId,
            admission: 'paused',
            domains: Object.fromEntries(
              ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
                d,
                { admission: 'paused' },
              ])
            ),
          })
        );
        await bounded(stateRef.set({ releaseId: plan.releaseId, phase: 'provider-usage-ready' }));
        const prepared = await bounded(
          prepareMediaRecoveryJournal({
            firestore: db,
            lockRef,
            controlRef,
            stateRef,
            plan,
            operationId: op,
            bindingDigest: plan.bindingDigest,
            config: { releaseId: plan.releaseId },
            ownedOperation: nativeSnapshotProof(await bounded(lockRef.get())),
            expectedAuthority: {
              control: nativeSnapshotProof(await bounded(controlRef.get())),
              state: nativeSnapshotProof(await bounded(stateRef.get())),
            },
          })
        );
        cycle.prepared = prepared.prepared;
        cycle.start.pool.revision = `${plan.name}/revisions/${plan.name.split('/').at(-1)}-00001`;
        const input = { operationId: op, startNonce: nonce };
        await bounded(
          lockRef.update({
            cloudMediaRecovery: cycle,
            mediaRecoveryWorkflowStart: {
              stage: 'attempted',
              operationId: op,
              planSHA256: hash(plan),
              workflowId: id,
              workflowType: 'MediaRecoveryProbe',
              taskQueue: queue,
              inputSHA256: hash(input),
              nonce,
              deploymentVersion: { deploymentName: 'urm-worker-media-recovery-staging', buildId: plan.buildId },
              attemptedAt: new Date(Date.now() + (mode === 'preexisting-native-run' ? 5000 : 0)).toISOString(),
            },
          })
        );
        const witness = {
          instanceId: randomUUID(),
          buildId: plan.buildId,
          cloudRun: {
            projectId,
            region: 'us-central1',
            pool: plan.name.split('/').at(-1),
            revision: cycle.start.pool.revision.split('/').at(-1),
            revisionUid: cycle.start.pool.revisionUid,
            serviceAccount: plan.runner,
            imageDigest: plan.image.split('@')[1],
            instanceId: 'CONTROLLED_NATIVE_INSTANCE',
          },
        };
        const media = createRuntimeActivities(projectId, ['urm-media'], client, witness).queues['urm-media'];
        const originalFile = bucket.file.bind(bucket);
        let uploaded = false;
        const selected = Object.create(bucket);
        selected.file = (path, ...args) => {
          const file = originalFile(path, ...args);
          if (mode === 'storage-private-error' && path === `temporal-diagnostics/media/${op}/source.wav`)
            file.save = async () => {
              throw new Error('PRIVATE-NATIVE-SENTINEL-DO-NOT-EXPORT');
            };
          if (mode === 'actor-revoked-after-upload' && path === `temporal-diagnostics/media/${op}/source.wav`) {
            const save = file.save.bind(file);
            file.save = async (...xs) => {
              const value = await save(...xs);
              if (!uploaded) {
                uploaded = true;
                await auth.setCustomUserClaims(uid, {});
              }
              return value;
            };
          }
          return file;
        };
        if (mode === 'source-collision')
          await bounded(
            originalFile(`temporal-diagnostics/media/${op}/source.wav`).save(Buffer.from('foreign'), {
              resumable: false,
            })
          );
        if (mode === 'canonical-owner-collision')
          await bounded(db.doc(`sermons/${id}`).create({ uploaderId: 'foreign-owner', sentinel: 'retain' }));
        current = {
          producer: createMediaRecoveryWorkActivities({
            firestore:
              mode === 'firestore-private-error'
                ? new Proxy(db, {
                    get: (target, key) =>
                      key === 'runTransaction'
                        ? async () => {
                            throw new Error('PRIVATE-NATIVE-SENTINEL-DO-NOT-EXPORT');
                          }
                        : typeof target[key] === 'function'
                        ? target[key].bind(target)
                        : target[key],
                  })
                : db,
            auth:
              mode === 'auth-private-error'
                ? new Proxy(auth, {
                    get: (target, key) =>
                      key === 'getUserByEmail'
                        ? async () => {
                            throw new Error('PRIVATE-NATIVE-SENTINEL-DO-NOT-EXPORT');
                          }
                        : typeof target[key] === 'function'
                        ? target[key].bind(target)
                        : target[key],
                  })
                : auth,
            bucket: selected,
            client,
            witness,
          }),
          media,
          mode,
          id,
        };
        lostAck = false;
        admissionCalls = 0;
        acquireCalls = 0;
        if (!worker) {
          version = { deploymentName: 'urm-worker-media-recovery-staging', buildId: plan.buildId };
          worker = await rpc(() =>
            Worker.create({
              connection: environment.nativeConnection,
              namespace,
              taskQueue: queue,
              workflowsPath: fileURLToPath(
                new URL('../../apps/temporal-worker/src/workflows/verification/media-recovery.ts', import.meta.url)
              ),
              workerDeploymentOptions: { useWorkerVersioning: true, defaultVersioningBehavior: 'PINNED', version },
              activities: {
                admitMediaRecoveryWork: async (input) => {
                  admissionCalls++;
                  const value = await current.producer.admitMediaRecoveryWork(input);
                  if (current.mode === 'admission-ack-loss' && !lostAck) {
                    lostAck = true;
                    throw ApplicationFailure.retryable('Controlled completion ACK withheld', 'CONTROLLED_ACK_LOSS');
                  }
                  return value;
                },
                acquireMedia: async (ref) => {
                  acquireCalls++;
                  assert.equal(ref.jobId, current.id);
                  return current.media.acquireMedia(ref);
                },
              },
              shutdownGraceTime: '1 second',
              shutdownForceTime: '5 seconds',
            })
          );
          running = worker.run();
          void running.catch(() => {});
          const end = Date.now() + 15000;
          while (true) {
            try {
              const observed = await rpc(() =>
                client.workflowService.describeWorkerDeploymentVersion({ namespace, deploymentVersion: version })
              );
              if (observed.workerDeploymentVersionInfo?.taskQueueInfos?.length >= 2) break;
            } catch {}
            if (Date.now() > end) throw new Error('Owned diagnostic queues did not register');
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        assert.equal(version.buildId, plan.buildId);
        stage = `${mode}/native-start`;
        handle = await rpc(() =>
          client.workflow.start('MediaRecoveryProbe', {
            workflowId: id,
            taskQueue: queue,
            args: [input],
            versioningOverride: { pinnedTo: version },
            workflowExecutionTimeout: '2 minutes',
            workflowIdReusePolicy: 'REJECT_DUPLICATE',
            workflowIdConflictPolicy: 'FAIL',
          })
        );
        if (['normal', 'admission-ack-loss'].includes(mode)) {
          const result = await bounded(handle.result(), 45000);
          assert.equal(result.runId, handle.firstExecutionRunId);
          assert.equal(acquireCalls, 1);
          assert.equal(admissionCalls, mode === 'admission-ack-loss' ? 2 : 1);
          const record = await bounded(db.doc(`_control/temporalMediaRecoveryWork-${op}`).get());
          assert.equal(record.get('stage'), 'admitted');
          assert.equal(record.get('grant.runId'), handle.firstExecutionRunId);
          assert.equal(record.get('grant.actorUid'), uid);
          assert.equal((await bounded(db.doc(`durableJobOutbox/${id}`).get())).exists, false);
          assert.equal((await bounded(db.collection('durableJobCommands').where('jobId', '==', id).get())).empty, true);
          const request = await bounded(db.doc(`temporalMediaRequests/${id}`).get());
          assert(request.get('artifacts.source'));
          assert(request.get('artifacts.processed'));
          const versions = (
            await bounded(bucket.getFiles({ prefix: `temporal-diagnostics/media/${op}/source.wav`, versions: true }))
          )[0];
          assert.equal(versions.length, 1);
        } else {
          await assert.rejects(bounded(handle.result(), 30000));
          if (mode.endsWith('private-error')) {
            const h = await bounded(handle.fetchHistory());
            assert(!JSON.stringify(h).includes('PRIVATE-NATIVE-SENTINEL-DO-NOT-EXPORT'));
          }
          assert.equal(acquireCalls, 0);
          assert.equal((await bounded(db.doc(`durableJobs/${id}`).get())).exists, false);
          assert.equal((await bounded(db.doc(`durableJobOutbox/${id}`).get())).exists, false);
          if (mode === 'canonical-owner-collision')
            assert.equal((await bounded(db.doc(`sermons/${id}`).get())).get('sentinel'), 'retain');
          if (mode === 'preexisting-native-run')
            assert.equal((await bounded(db.doc(`_control/temporalMediaRecoveryWork-${op}`).get())).exists, false);
        }
        handle = undefined;
      }
    } catch (e) {
      const chain = [];
      let cause = e;
      for (let n = 0; cause && n < 4; n++, cause = cause.cause)
        chain.push({
          name: typeof cause.name === 'string' && /^[A-Za-z]+$/.test(cause.name) ? cause.name : 'unknown',
          type: [
            'MEDIA_RECOVERY_WORK_UNCONFIRMED',
            'INVALID_MEDIA_RECOVERY_PROBE',
            'INVALID_MEDIA_REQUEST',
            'MEDIA_RECOVERY_ACQUISITION_UNCONFIRMED',
          ].includes(cause.type)
            ? cause.type
            : 'unknown',
          code: Number.isInteger(cause.code) ? cause.code : null,
        });
      let evidence = {};
      if (handle) {
        try {
          const h = await bounded(handle.fetchHistory(), 5000),
            a = h.events?.[0]?.workflowExecutionStartedEventAttributes;
          const d = await bounded(handle.describe(), 5000);
          evidence = {
            events: h.events?.map((x) => Object.keys(x).find((k) => k.endsWith('EventAttributes'))),
            originalSame: a?.originalExecutionRunId === handle.firstExecutionRunId,
            firstSame: a?.firstExecutionRunId === handle.firstExecutionRunId,
            pin: d.raw.workflowExecutionInfo?.versioningInfo?.behavior,
            journalStage: current
              ? (
                  await bounded(
                    db.doc(`_control/temporalMediaRecoveryWork-${current.id.slice('media-recovery-'.length)}`).get()
                  )
                ).get('stage') ?? 'absent'
              : 'absent',
          };
        } catch {
          evidence = { inspection: 'unavailable' };
        }
      }
      primary = new Error(`Owned private media case failed / ${stage} / ${JSON.stringify({ chain, evidence })}`);

      throw primary;
    } finally {
      const failures = [];
      const cleanup = async (fn) => {
        try {
          await bounded(Promise.resolve().then(fn), 25000);
        } catch {
          failures.push(new Error('Owned private media cleanup failed'));
        }
      };
      if (handle) await cleanup(() => handle.terminate('Owned LOCAL fixture cleanup'));
      if (worker) await cleanup(() => worker.shutdown());
      if (running) await cleanup(() => running);
      if (environment) await cleanup(() => environment.teardown());
      for (const { op, id } of owned) {
        if (db) {
          for (const collection of [
            'temporalMediaRequests',
            'temporalMediaState',
            'durableJobs',
            'durableJobIntents',
            'durableJobOutbox',
            'sermons',
          ])
            await cleanup(() => db.doc(`${collection}/${id}`).delete());
          for (const name of [`temporalMediaRecoveryWork-${op}`, `temporalMediaRecoveryJournal-${op}`])
            await cleanup(() => db.doc(`_control/${name}`).delete());
          const { durableEntityKey, DURABLE_COLLECTIONS } = require('@upperroom/orchestration/job-store');
          await cleanup(() =>
            db
              .doc(`durableJobEntities/${durableEntityKey(projectId, { type: 'sermon', id }, 'audio.process')}`)
              .delete()
          );
          for (const collection of [
            DURABLE_COLLECTIONS.executions,
            DURABLE_COLLECTIONS.stepExecutions,
            DURABLE_COLLECTIONS.drains,
          ])
            await cleanup(async () => {
              const records = await bounded(db.collection(collection).where('jobId', '==', id).get());
              for (const record of records.docs) await bounded(record.ref.delete());
            });
          await cleanup(async () => {
            const artifacts = await bounded(
              db.collection('temporalMediaArtifacts').where('ownerJobId', '==', id).get()
            );
            for (const artifact of artifacts.docs) await bounded(db.recursiveDelete(artifact.ref));
          });
          await cleanup(() => db.recursiveDelete(db.doc(`temporalMediaJobArtifacts/${id}`)));
        }
        if (bucket)
          for (const prefix of [`temporal-diagnostics/media/${op}/`, `workflow-audio/${id}/`])
            await cleanup(async () => {
              const [files] = await bounded(bucket.getFiles({ prefix, versions: true }));
              for (const file of files) await bounded(file.delete());
            });
        if (app) await cleanup(() => getDatabase(app).ref(`addIntroOutro/${id}`).remove());
      }
      if (db && ownsControls)
        for (const name of ['temporalReleaseOperation', 'temporalRelease', 'temporalReleaseState'])
          await cleanup(async () => {
            const ref = db.doc(`_control/${name}`),
              snapshot = await bounded(ref.get());
            if (snapshot.exists) {
              assert.ok(
                owned.some(({ op, releaseId }) =>
                  name === 'temporalReleaseOperation'
                    ? snapshot.get('operationId') === op
                    : snapshot.get('releaseId') === releaseId
                )
              );
              await bounded(ref.delete());
            }
          });
      if (auth) for (const uid of users) await cleanup(() => auth.deleteUser(uid));
      if (db) await cleanup(() => db.terminate());
      if (app) await cleanup(() => deleteApp(app));
      if (failures.length) {
        if (primary) console.error('Owned private media secondary cleanup failed');
        else throw new AggregateError(failures, 'Owned private media cleanup failed');
      }
    }
  }
);
