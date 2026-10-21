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
import { startMediaRecoveryWorkflow } from '../temporal-media-recovery-start.mjs';
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
process.env.FIREBASE_STORAGE_BUCKET = 'urm-app-staging.firebasestorage.app';
const { initializeApp, deleteApp } = require('firebase-admin/app'),
  { getAuth } = require('firebase-admin/auth'),
  { getFirestore } = require('firebase-admin/firestore'),
  { getStorage } = require('firebase-admin/storage'),
  { getDatabase } = require('firebase-admin/database');
const { Worker, Runtime, DefaultLogger } = require('@temporalio/worker'),
  { Client, Connection } = require('@temporalio/client');
const { ApplicationFailure } = require('@temporalio/common');
const { createLocalTestEnvironment } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/test-support/local-test-environment.ts', import.meta.url)
));
const {
  createMediaRecoveryWorkActivities,
  mediaRecoveryNativeStart,
  mediaRecoveryPinnedVersion,
} = require(fileURLToPath(new URL('../../apps/temporal-worker/src/runtime/media-recovery-work.ts', import.meta.url)));
const { mediaRecoveryKernelContext } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/runtime/media-recovery-capability.ts', import.meta.url)
));
const { createMediaRecoveryRegistration } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/runtime/media-recovery-registration.ts', import.meta.url)
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
      mutationConnection,
      worker,
      running,
      handle,
      current,
      stage = 'setup',
      primary,
      supervised,
      supervisedSettled = false;
    const users = [],
      owned = [];
    let ownsControls = false;
    let admissionCalls = 0,
      acquireCalls = 0,
      productionCalls = 0,
      lostAck = false;
    try {
      app = initializeApp({
        projectId,
        storageBucket: `${projectId}.firebasestorage.app`,
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
      mutationConnection = await bounded(
        Connection.connect({
          address: environment.connection.options.address,
          connectTimeout: 5000,
          interceptors: [],
          channelArgs: { 'grpc.enable_retries': 0 },
        })
      );
      const client = new Client({ connection: mutationConnection, namespace });
      let version;
      for (const mode of [
        'joint-supervised-recovery',
        'joint-intent-ack-loss',
        'joint-control-drift-after-intent',
        'original-completion-held',
        'start-late-authority',
        'normal',
        'admission-ack-loss',
        'start-ack-loss',
        'start-receipt-ack-loss',
        'start-confirmed-ack-loss',
        'start-pool-drift',
        'intent-ack-loss',
        'start-control-drift',
        'start-state-drift',
        'start-definite-rejection',
        'start-unknown-unaccepted',
        'private-grant-drift',
        'private-birth-drift',
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
        if (mode === 'normal') {
          cycle.plan.createdAt = new Date(Date.now() - 290000).toISOString();
          cycle.plan.expiresAt = Date.parse(cycle.plan.createdAt) + 300000;
        }
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
        cycle.start.plan.before.revision = cycle.start.pool.revision;
        cycle.diagnostic.pool.revision = cycle.start.pool.revision;
        const input = { operationId: op, startNonce: nonce };
        await bounded(
          lockRef.update({
            cloudMediaRecovery: cycle,
            ...(mode === 'preexisting-native-run'
              ? {
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
                }
              : {}),
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
        if (
          [
            'normal',
            'admission-ack-loss',
            'original-completion-held',
            'start-ack-loss',
            'start-receipt-ack-loss',
            'start-confirmed-ack-loss',
            'private-grant-drift',
            'private-birth-drift',
          ].includes(mode)
        ) {
          const cap = await bounded(mediaRecoveryKernelContext(db, auth, witness, op));
          const context = { ...cap.context, parent: { ...witness, instanceId: randomUUID() } },
            intent = { parentPid: process.ppid, launchId: randomUUID(), createdAt: new Date().toISOString() },
            birth = { pid: process.pid, nonce: randomUUID(), spawnedAt: new Date().toISOString() };
          const value = { schemaVersion: 1, stage: 'running', context, intent, birth, worker: witness };
          await bounded(db.doc(`_control/temporalMediaRecoveryKernel-${op}`).create(value));
          const kernel = { operationId: op, birthDigest: hash({ context, intent, birth, worker: witness }) };
          const registered = await bounded(
            createMediaRecoveryRegistration({
              firestore: db,
              auth,
              bucket: selected,
              client,
              witness,
              operationId: op,
              kernel,
              acquire: async (ref) => {
                productionCalls++;
                return media.acquireMedia(ref);
              },
            })
          );
          assert.deepEqual(Object.keys(registered.activities).sort(), ['acquireMedia', 'admitMediaRecoveryWork']);
          current.producer = registered.activities;
          current.media = registered.activities;
          if (mode === 'original-completion-held') {
            process.env.TEMPORAL_MEDIA_RECOVERY_CHILD = 'original';
            const { holdOriginalMediaCompletion } = require(fileURLToPath(
              new URL('../../apps/temporal-worker/src/runtime/media-recovery-original-fault.ts', import.meta.url)
            ));
            current.media = {
              ...registered.activities,
              acquireMedia: holdOriginalMediaCompletion({
                db,
                bucket: selected,
                client,
                cap: registered.cap,
                birth: registered.birth,
                acquire: registered.activities.acquireMedia,
              }),
            };
          }
        }
        lostAck = false;
        admissionCalls = 0;
        acquireCalls = 0;
        productionCalls = 0;
        if (mode.startsWith('joint-')) {
          const { superviseMediaRecoveryReplacementCycle } = require(fileURLToPath(
            new URL('../../apps/temporal-worker/src/runtime/media-recovery-replacement.ts', import.meta.url)
          ));
          const cap = await bounded(mediaRecoveryKernelContext(db, auth, witness, op));
          process.env.URM_RECOVERY_TEST_ADDRESS = environment.address;
          process.env.URM_RECOVERY_TEST_OPERATION = op;
          process.env.URM_RECOVERY_TEST_PARENT = JSON.stringify(witness);
          const selectedDB = ['joint-intent-ack-loss', 'joint-control-drift-after-intent'].includes(mode)
            ? new Proxy(db, {
                get(target, key) {
                  if (key === 'runTransaction')
                    return async (fn, options) => {
                      let wrote = false;
                      const value = await target.runTransaction(
                        async (tx) =>
                          fn(
                            new Proxy(tx, {
                              get(t, k) {
                                if (k === 'create')
                                  return (r, v) => {
                                    if (r.path === `_control/temporalMediaRecoveryReplacementIntent-${op}`)
                                      wrote = true;
                                    return t.create(r, v);
                                  };
                                const x = Reflect.get(t, k);
                                return typeof x === 'function' ? x.bind(t) : x;
                              },
                            })
                          ),
                        options
                      );
                      if (wrote && mode === 'joint-control-drift-after-intent')
                        await controlRef.update({ ownedReplacementDrift: true });
                      if (wrote && mode === 'joint-intent-ack-loss')
                        throw new Error('CONTROLLED_COMMITTED_INTENT_ACK_LOSS');
                      return value;
                    };
                  const v = Reflect.get(target, key);
                  return typeof v === 'function' ? v.bind(target) : v;
                },
              })
            : db;
          supervisedSettled = false;
          supervised = superviseMediaRecoveryReplacementCycle(
            selectedDB,
            bucket,
            cap,
            fileURLToPath(new URL('./fixtures/media-recovery-supervised-child.cjs', import.meta.url)),
            client
          );
          void supervised
            .finally(() => {
              supervisedSettled = true;
            })
            .catch(() => {});
          version = { deploymentName: 'urm-worker-media-recovery-staging', buildId: plan.buildId };
          const end = Date.now() + 20000;
          while (true) {
            try {
              const d = await rpc(() =>
                client.workflowService.describeWorkerDeploymentVersion({ namespace, deploymentVersion: version })
              );
              if (d.workerDeploymentVersionInfo?.taskQueueInfos?.length === 2) break;
            } catch {}
            if (Date.now() >= end) throw new Error('Owned child registration timed out');
            await new Promise((r) => setTimeout(r, 50));
          }
        }
        if (!worker && !mode.startsWith('joint-')) {
          version = { deploymentName: 'urm-worker-media-recovery-staging', buildId: plan.buildId };
          worker = await rpc(() =>
            Worker.create({
              connection: environment.nativeConnection,
              namespace,
              taskQueue: queue,
              identity: `media-recovery-${witness.instanceId}`,
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
                  const op = current.id.slice('media-recovery-'.length);
                  if (current.mode === 'private-grant-drift')
                    await bounded(
                      db
                        .doc(`_control/temporalMediaRecoveryWork-${op}`)
                        .update({ 'grant.source.generation': '9999999999' })
                    );
                  if (current.mode === 'private-birth-drift')
                    await bounded(
                      db.doc(`_control/temporalMediaRecoveryKernel-${op}`).update({ 'worker.instanceId': randomUUID() })
                    );
                  return current.media.acquireMedia(ref);
                },
              },
              maxHeartbeatThrottleInterval: '1 second',
              defaultHeartbeatThrottleInterval: '1 second',
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
        let startCalls = 0,
          startOptions,
          episodeWait;
        if (mode === 'preexisting-native-run') {
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
        } else {
          const nativeTx = db.runTransaction.bind(db);
          let checkpointFault = false,
            lateAuthority = false,
            receiptFault = false,
            poolReads = 0;
          const writerDB = {
            projectId: db.projectId,
            databaseId: db.databaseId,
            doc: db.doc.bind(db),
            runTransaction: async (fn, opts) => {
              const result = await nativeTx(fn, opts);
              if (mode === 'start-late-authority' && opts?.readOnly && poolReads >= 2 && !lateAuthority) {
                lateAuthority = true;
                await new Promise((done) => setTimeout(done, 5100));
              }
              if (
                !opts?.readOnly &&
                !checkpointFault &&
                (await bounded(lockRef.get())).get('mediaRecoveryWorkflowStart')
              ) {
                checkpointFault = true;
                if (mode === 'intent-ack-loss') throw new Error('CONTROLLED_NATIVE_INTENT_ACK_LOST');
                if (mode === 'start-control-drift') await bounded(controlRef.update({ admission: 'open' }));
                if (mode === 'start-state-drift') await bounded(stateRef.update({ phase: 'opened' }));
              }
              if (!opts?.readOnly && !receiptFault) {
                const fact = (await bounded(db.doc(`_control/temporalMediaRecoveryStart-${op}`).get())).data();
                if (
                  (mode === 'start-receipt-ack-loss' && fact?.stage === 'acknowledged') ||
                  (mode === 'start-confirmed-ack-loss' && fact?.stage === 'confirmed')
                ) {
                  receiptFault = true;
                  throw new Error('CONTROLLED_NATIVE_RECEIPT_ACK_LOST');
                }
              }
              return result;
            },
          };
          const startClient = {
            connection: client.connection,
            workflowService: client.workflowService,
            workflow: {
              getHandle: (...args) => ({
                describe: async () => {
                  assert.equal(args[2]?.followRuns, false);
                  if (['normal', 'admission-ack-loss'].includes(mode)) {
                    const ack = (await bounded(db.doc(`_control/temporalMediaRecoveryStart-${op}`).get())).data();
                    assert.ok(['acknowledged', 'confirmed'].includes(ack?.stage));
                    assert.equal(args[1], ack.runId);
                  }
                  return client.workflow.getHandle(...args).describe();
                },
              }),
              start: async (...args) => {
                startCalls++;
                if (mode === 'start-definite-rejection')
                  throw Object.assign(new Error('PRIVATE-NATIVE-SENTINEL-DO-NOT-EXPORT'), { code: 7 });
                if (mode === 'start-unknown-unaccepted') throw new Error('PRIVATE-NATIVE-SENTINEL-DO-NOT-EXPORT');
                handle = await client.workflow.start(...args);
                if (mode === 'start-ack-loss') throw new Error('CONTROLLED_START_RESPONSE_LOST');
                return handle;
              },
            },
          };
          startOptions = {
            firestore: writerDB,
            client: startClient,
            application: { mediaRecoveryNativeStart, mediaRecoveryPinnedVersion },
            api: async (url) => {
              if (url.includes('/revisions/'))
                return {
                  ...structuredClone(plan.diagnosticTemplate),
                  name: cycle.start.pool.revision,
                  uid: cycle.start.pool.revisionUid,
                };
              poolReads++;
              return {
                name: plan.name,
                uid: mode === 'start-pool-drift' && poolReads === 2 ? 'foreign-uid' : cycle.start.pool.uid,
                generation: cycle.start.pool.generation,
                observedGeneration: cycle.start.pool.generation,
                etag: cycle.start.pool.etag,
                template: structuredClone(plan.diagnosticTemplate),
                scaling: { manualInstanceCount: 1 },
                terminalCondition: { state: 'CONDITION_SUCCEEDED' },
                latestCreatedRevision: cycle.start.pool.revision,
                latestReadyRevision: cycle.start.pool.revision,
              };
            },
            plan,
            pool: cycle.start.pool,
            prepared: cycle.prepared,
            lockRef,
            controlRef,
            stateRef,
            operationId: op,
            bindingDigest: plan.bindingDigest,
            config: { releaseId: plan.releaseId },
            ownedOperation: nativeSnapshotProof(await bounded(lockRef.get())),
            expectedAuthority: {
              control: nativeSnapshotProof(await bounded(controlRef.get())),
              state: nativeSnapshotProof(await bounded(stateRef.get())),
            },
          };
          if (
            [
              'normal',
              'admission-ack-loss',
              'start-ack-loss',
              'start-receipt-ack-loss',
              'start-confirmed-ack-loss',
            ].includes(mode)
          ) {
            const result = await bounded(startMediaRecoveryWorkflow(startOptions));
            assert.equal(result.start.runId, handle.firstExecutionRunId);
            assert.equal(result.start.stage, 'confirmed');
            const parent = (await bounded(lockRef.get())).data(),
              receipt = (await bounded(db.doc(`_control/temporalMediaRecoveryStart-${op}`).get())).data();
            const resumed = await bounded(
              startMediaRecoveryWorkflow({ ...startOptions, ownedOperation: result.ownedOperation })
            );
            assert.equal(resumed.start.runId, result.start.runId);
            assert.equal(startCalls, 1);
            assert.deepEqual((await bounded(lockRef.get())).data(), parent);
            assert.deepEqual(
              (await bounded(db.doc(`_control/temporalMediaRecoveryStart-${op}`).get())).data(),
              receipt
            );
          } else if (mode.startsWith('start-') || mode === 'intent-ack-loss') {
            await assert.rejects(bounded(startMediaRecoveryWorkflow(startOptions)));
            const noSend = [
              'intent-ack-loss',
              'start-control-drift',
              'start-state-drift',
              'start-pool-drift',
              'start-late-authority',
            ].includes(mode);
            assert.equal(startCalls, noSend ? 0 : 1);
            const updated = { ...startOptions, ownedOperation: nativeSnapshotProof(await bounded(lockRef.get())) };
            await assert.rejects(bounded(startMediaRecoveryWorkflow(updated)));
            assert.equal(startCalls, noSend ? 0 : 1);
            if (mode.startsWith('start-') || mode === 'intent-ack-loss') {
              assert.equal(acquireCalls, 0);
              assert.equal((await bounded(db.doc(`durableJobs/${id}`).get())).exists, false);
              if (mode === 'start-definite-rejection')
                assert.equal(
                  (await bounded(db.doc(`_control/temporalMediaRecoveryStart-${op}`).get())).get('stage'),
                  'rejected'
                );
              continue;
            }
          } else {
            try {
              await bounded(startMediaRecoveryWorkflow(startOptions));
            } catch {}
            assert.equal(startCalls, 1);
          }
        }
        if (mode === 'joint-supervised-recovery') {
          const { waitForMediaRecoveryEpisode } = require(fileURLToPath(
            new URL('../../apps/temporal-worker/src/runtime/media-recovery-collector.ts', import.meta.url)
          ));
          assert.equal(
            (await bounded(db.doc(`_control/temporalMediaRecoveryReplacementCompleted-${op}`).get())).exists,
            false
          );
          episodeWait = waitForMediaRecoveryEpisode({
            db,
            client,
            operationId: op,
            plan,
            runId: handle.firstExecutionRunId,
            expectedRootSHA256: nativeSnapshotProof(await bounded(lockRef.get())).dataDigest,
            expectedControlSHA256: nativeSnapshotProof(await bounded(controlRef.get())).dataDigest,
            expectedStateSHA256: nativeSnapshotProof(await bounded(stateRef.get())).dataDigest,
          });
          void episodeWait.catch(() => {});
        }
        if (['joint-intent-ack-loss', 'joint-control-drift-after-intent'].includes(mode)) {
          stage = 'joint-intent-ack-loss/no-second-birth';
          await assert.rejects(bounded(supervised, 45000));
          assert.equal((await bounded(db.doc(`_control/temporalMediaRecoveryOriginalDeath-${op}`).get())).exists, true);
          assert.equal(
            (await bounded(db.doc(`_control/temporalMediaRecoveryReplacementIntent-${op}`).get())).exists,
            true
          );
          assert.equal(
            (await bounded(db.doc(`_control/temporalMediaRecoveryReplacementKernel-${op}`).get())).exists,
            false
          );
          assert.equal(
            (await bounded(db.doc(`_control/temporalMediaRecoveryReplacementAdoption-${op}`).get())).exists,
            false
          );
          if ((await bounded(handle.describe())).raw.workflowExecutionInfo.status === 1)
            await bounded(handle.terminate('Owned LOCAL uncertain intent cleanup'));
          await assert.rejects(bounded(handle.result()));
          supervised = undefined;
          handle = undefined;
          continue;
        }
        if (mode === 'original-completion-held') {
          stage = 'original-completion-held/ready-wait';
          const end = Date.now() + 15000;
          let ready;
          while (Date.now() < end) {
            ready = (await bounded(db.doc(`_control/temporalMediaRecoveryOriginalReady-${op}`).get())).data();
            if (ready) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          stage = 'original-completion-held/ready-joined';
          assert.equal(ready?.runId, handle.firstExecutionRunId);
          assert.equal(ready?.inventory.objects.length, 2);
          assert.equal(productionCalls, 1);
          const h = await bounded(handle.fetchHistory());
          const acquireSchedule = h.events.find(
            (e) => e.activityTaskScheduledEventAttributes?.activityId === 'media-recovery-acquire'
          );
          assert(acquireSchedule);
          assert(
            !h.events.some(
              (e) =>
                String(e.activityTaskCompletedEventAttributes?.scheduledEventId) === String(acquireSchedule.eventId)
            )
          );
          assert.equal((await bounded(handle.describe())).raw.workflowExecutionInfo.status, 1);
          // Real heartbeat expiry advances beyond attempt1; the original-fault
          // observer must then refuse even the still-persisted ready receipt.
          stage = 'original-completion-held/real-expiry';
          await new Promise((r) => setTimeout(r, 17500));
          const { originalPendingAttempt } = require(fileURLToPath(
            new URL('../../apps/temporal-worker/src/runtime/media-recovery-original-fault.ts', import.meta.url)
          ));
          const originalCap = await bounded(mediaRecoveryKernelContext(db, auth, witness, op));
          stage = 'original-completion-held/deny-expired-attempt';
          await assert.rejects(bounded(originalPendingAttempt(client, originalCap, ready)));
          assert.equal(
            (await bounded(db.doc(`_control/temporalMediaRecoveryOriginalSignal-${op}`).get())).exists,
            false
          );
          stage = 'original-completion-held/owned-cleanup';
          if ((await bounded(handle.describe())).raw.workflowExecutionInfo.status === 1) {
            try {
              await bounded(handle.terminate('Owned LOCAL completion-hold fixture cleanup'));
            } catch {
              assert.notEqual((await bounded(handle.describe())).raw.workflowExecutionInfo.status, 1);
            }
          }
          await assert.rejects(bounded(handle.result()));
          delete process.env.TEMPORAL_MEDIA_RECOVERY_CHILD;
          handle = undefined;
          continue;
        }
        if (
          [
            'joint-supervised-recovery',
            'normal',
            'admission-ack-loss',
            'start-ack-loss',
            'start-receipt-ack-loss',
            'start-confirmed-ack-loss',
          ].includes(mode)
        ) {
          const result = await bounded(handle.result(), 45000);
          assert.equal(result.runId, handle.firstExecutionRunId);
          if (mode === 'normal') {
            await new Promise((done) => setTimeout(done, Math.max(0, plan.expiresAt - Date.now() + 25)));
            const historical = await bounded(
              startMediaRecoveryWorkflow({
                ...startOptions,
                ownedOperation: nativeSnapshotProof(await bounded(lockRef.get())),
              })
            );
            assert.equal(historical.start.runId, handle.firstExecutionRunId);
            assert.equal(historical.authorizationExpired, true);
            assert.equal(startCalls, 1);
          }

          if (mode === 'joint-supervised-recovery') {
            assert.deepEqual(await bounded(supervised, 30000), { code: 0, signal: null });
            assert.equal(
              (await bounded(db.doc(`_control/temporalMediaRecoveryReplacementKernel-${op}`).get())).get(
                'close.descendantsAbsent'
              ),
              true
            );
            assert.equal(
              (await bounded(db.doc(`_control/temporalMediaRecoveryReplacementAdoption-${op}`).get())).get('runId'),
              handle.firstExecutionRunId
            );
            assert.equal(
              (await bounded(db.doc(`_control/temporalMediaRecoveryReplacementAdoption-${op}`).get())).get('attempt'),
              2
            );
            await bounded(episodeWait, 30000);
            stage = 'joint-supervised-recovery/GET-only-collector';
            const { collectMediaRecoveryExecution } = require(fileURLToPath(
              new URL('../../apps/temporal-worker/src/runtime/media-recovery-collector.ts', import.meta.url)
            ));
            const collectorOptions = {
              db,
              client,
              operationId: op,
              plan,
              expectedRootSHA256: nativeSnapshotProof(await bounded(lockRef.get())).dataDigest,
              expectedControlSHA256: nativeSnapshotProof(await bounded(controlRef.get())).dataDigest,
              expectedStateSHA256: nativeSnapshotProof(await bounded(stateRef.get())).dataDigest,
              image: {
                bundleSHA256: 'e'.repeat(64),
                tools: { pythonSHA256: 'a'.repeat(64), ffmpegSHA256: 'b'.repeat(64), ffprobeSHA256: 'c'.repeat(64) },
              },
            };
            const collected = await bounded(collectMediaRecoveryExecution(collectorOptions), 25000);
            assert.equal(collected.runId, handle.firstExecutionRunId);
            assert.equal(collected.workflowId, id);
            assert.equal(collected.history.events.length, (await bounded(handle.fetchHistory())).events.length);
            assert.equal(
              (await bounded(collectMediaRecoveryExecution(collectorOptions), 25000)).evidenceSHA256,
              collected.evidenceSHA256
            );
            for (const [kind, mutate] of [
              [
                'Startup',
                (v) => {
                  v.bundle.bundleSHA256 = 'f'.repeat(64);
                },
              ],
              [
                'ReplacementStartup',
                (v) => {
                  v.capacity.allocation.pythonSHA256 = 'f'.repeat(64);
                },
              ],
              [
                'ReplacementStartup',
                (v) => {
                  v.capacity.schemaVersion = 2;
                },
              ],
              [
                'ReplacementKernel',
                (v) => {
                  v.close.observerFailed = true;
                },
              ],
              [
                'ReplacementStop',
                (v) => {
                  v.kernelSHA256 = 'f'.repeat(64);
                },
              ],
              [
                'ReplacementAdoption',
                (v) => {
                  v.inventorySHA256 = 'f'.repeat(64);
                },
              ],
              [
                'ReplacementCompleted',
                (v) => {
                  v.historyEvents += 1;
                },
              ],
            ]) {
              const ref = db.doc(`_control/temporalMediaRecovery${kind}-${op}`),
                original = (await bounded(ref.get())).data(),
                changed = structuredClone(original);
              mutate(changed);
              await bounded(ref.set(changed));
              await assert.rejects(
                bounded(collectMediaRecoveryExecution(collectorOptions), 25000),
                /^Error: MEDIA_RECOVERY_COLLECTION_UNCONFIRMED$/
              );
              await bounded(ref.set(original));
            }
            await assert.rejects(
              bounded(
                collectMediaRecoveryExecution({
                  ...collectorOptions,
                  image: { ...collectorOptions.image, bundleSHA256: 'f'.repeat(64) },
                }),
                25000
              )
            );
            // A mutation during external native/object reads must not be accepted
            // by combining separate consistent transaction snapshots.
            let reads = 0;
            const driftingDB = new Proxy(db, {
              get(t, key) {
                if (key === 'runTransaction')
                  return async (...args) => {
                    const result = await t.runTransaction(...args);
                    if (++reads === 1)
                      await t
                        .doc(`_control/temporalMediaRecoveryReplacementStop-${op}`)
                        .update({ kernelSHA256: 'f'.repeat(64) });
                    return result;
                  };
                const value = Reflect.get(t, key);
                return typeof value === 'function' ? value.bind(t) : value;
              },
            });
            await assert.rejects(
              bounded(collectMediaRecoveryExecution({ ...collectorOptions, db: driftingDB }), 25000)
            );
            supervised = undefined;
          } else assert.equal(acquireCalls, 1);
          if (mode !== 'joint-supervised-recovery') assert.equal(admissionCalls, mode === 'admission-ack-loss' ? 2 : 1);
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
        } else if (mode.startsWith('private-')) {
          await assert.rejects(bounded(handle.result(), 30000));
          assert.equal(acquireCalls, 1);
          assert.equal(productionCalls, 0);
          assert.equal((await bounded(db.doc(`durableJobs/${id}`).get())).exists, true);
          assert.equal((await bounded(db.doc(`temporalMediaRequests/${id}`).get())).get('artifacts'), undefined);
          assert.equal((await bounded(db.doc(`durableJobOutbox/${id}`).get())).exists, false);
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
      delete process.env.TEMPORAL_MEDIA_RECOVERY_CHILD;
      const failures = [];
      const cleanup = async (fn) => {
        try {
          await bounded(Promise.resolve().then(fn), 25000);
        } catch {
          failures.push(new Error('Owned private media cleanup failed'));
        }
      };
      if (supervised && !supervisedSettled) process.emit('SIGTERM');
      if (supervised) await cleanup(() => supervised);
      for (const key of ['URM_RECOVERY_TEST_ADDRESS', 'URM_RECOVERY_TEST_OPERATION', 'URM_RECOVERY_TEST_PARENT'])
        delete process.env[key];
      if (handle) await cleanup(() => handle.terminate('Owned LOCAL fixture cleanup'));
      if (worker) await cleanup(() => worker.shutdown());
      if (running) await cleanup(() => running);
      if (mutationConnection) await cleanup(() => mutationConnection.close());
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
          for (const name of [
            `temporalMediaRecoveryWork-${op}`,
            `temporalMediaRecoveryJournal-${op}`,
            `temporalMediaRecoveryStart-${op}`,
            `temporalMediaRecoveryKernel-${op}`,
            `temporalMediaRecoveryStartup-${op}`,
            `temporalMediaRecoveryOriginalReady-${op}`,
            ...[
              'OriginalSignal',
              'OriginalDeath',
              'ReplacementIntent',
              'ReplacementKernel',
              'ReplacementStartup',
              'ReplacementAdoption',
              'ReplacementCompleted',
              'ReplacementStop',
            ].map((k) => `temporalMediaRecovery${k}-${op}`),
          ])
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
