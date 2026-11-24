/** Real LOCAL SDK namespace/version/partition/poller inventories and dedicated
 * Firestore authority. Cloud pool, process closure and episode are CONTROLLED. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  observeMediaDiagnosticDrain,
  waitForMediaDiagnosticDrain,
  observeMediaDiagnosticStopped,
  observeMediaDiagnosticNeverStarted,
} from '../temporal-media-diagnostic-drain.mjs';
import { mediaDiagnosticNeverStartedProof } from '../temporal-media-stop-confirmation.mjs';
import { nativeSnapshotProof, proofDigest as hash } from '../temporal-release-runtime.mjs';
import { bounded } from './fixtures/owned-media-process.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const { createLocalTestEnvironment } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/test-support/local-test-environment.ts', import.meta.url)
));
const { initializeApp, deleteApp } = require('firebase-admin/app'),
  { getFirestore } = require('firebase-admin/firestore');
const { Client } = require('@temporalio/client'),
  { Worker, Runtime, DefaultLogger } = require('@temporalio/worker');
Runtime.install({ shutdownSignals: [], logger: new DefaultLogger('ERROR', () => undefined) });
const harness = require('./firebase.test.json');
if (process.env.FIRESTORE_EMULATOR_HOST !== `127.0.0.1:${harness.emulators.firestore.port}`)
  throw Error('Dedicated emulator required');
test(
  'native private drain denies older-version pollers and actual open work; no zero/config mutation',
  { timeout: 400000 },
  async () => {
    const namespace = 'urm-app-staging.qwejt',
      deploymentName = 'urm-worker-media-recovery-staging',
      queue = 'urm-media-kernel-recovery';
    let env,
      app,
      db,
      options,
      stage = 'setup';
    const workers = [],
      refs = [],
      handles = [],
      errors = [];
    const op = randomUUID(),
      buildId = 'a'.repeat(40),
      oldBuild = 'b'.repeat(40),
      releaseId = randomUUID();
    const rpc = (fn) => bounded(env.connection.withDeadline(Date.now() + 5000, fn), 6000);
    const launch = async (id) => {
      const worker = await bounded(
        Worker.create({
          connection: env.nativeConnection,
          namespace,
          taskQueue: queue,
          identity: `owned-drain-${op}-${id.slice(0, 1)}`,
          workflowsPath: fileURLToPath(
            new URL('../../apps/temporal-worker/src/workflows/verification/index.ts', import.meta.url)
          ),
          activities: {
            neverCalled: async () => {
              throw Error('Unexpected Activity');
            },
          },
          workerDeploymentOptions: {
            useWorkerVersioning: true,
            defaultVersioningBehavior: 'PINNED',
            version: { deploymentName, buildId: id },
          },
          shutdownGraceTime: '1 second',
          shutdownForceTime: '5 seconds',
        })
      );
      const running = worker.run();
      void running.catch(() => {});
      workers.push({ worker, running });
      const end = Date.now() + 15000;
      while (true) {
        try {
          const d = await rpc(() =>
            options.client.workflowService.describeWorkerDeploymentVersion({
              namespace,
              deploymentVersion: { deploymentName, buildId: id },
            })
          );
          if (d.workerDeploymentVersionInfo.taskQueueInfos.length === 2) return;
        } catch {}
        if (Date.now() > end) throw Error('Owned registration timeout');
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    try {
      env = await createLocalTestEnvironment({
        server: {
          executable: { type: 'cached-download', version: 'v1.9.1' },
          extraArgs: ['--dynamic-config-value', 'nexusoperation.enableStandalone=true'],
        },
      });
      const client = new Client({ connection: env.connection, namespace });
      await rpc(() =>
        client.workflowService.registerNamespace({ namespace, workflowExecutionRetentionPeriod: { seconds: 86400 } })
      );
      stage = 'native-nexus-inventory';
      await rpc(() => client.workflowService.listNexusOperationExecutions({ namespace, pageSize: 1 }));
      app = initializeApp({ projectId: 'urm-app-staging' }, `drain-${op}`);
      db = getFirestore(app);
      const lockRef = db.doc('_control/temporalReleaseOperation'),
        controlRef = db.doc('_control/temporalRelease'),
        stateRef = db.doc('_control/temporalReleaseState');
      for (const ref of [lockRef, controlRef, stateRef]) {
        assert.equal((await bounded(ref.get())).exists, false);
        refs.push(ref);
      }
      const plan = {
          operationId: op,
          role: 'media',
          buildId,
          releaseId,
          contract: { deploymentName, queue },
          name: `projects/urm-app-staging/locations/us-central1/workerPools/owned-${op}`,
          image: `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'c'.repeat(64)}`,
          runner: 'controlled@urm-app-staging.iam.gserviceaccount.com',
        },
        pool = {
          desiredManualInstanceCount: 1,
          uid: 'CONTROLLED-pool',
          generation: '10',
          etag: 'controlled10',
          revision: `${plan.name}/revisions/owned-revision`,
          revisionUid: 'CONTROLLED-revision',
        };
      await bounded(
        lockRef.create({
          action: 'diagnose-cloud-run-media-recovery',
          operationId: op,
          bindingDigest: 'c'.repeat(64),
          releaseId,
          cloudMediaRecovery: {
            stage: 'recovered',
            plan,
            start: { stage: 'completed', pool },
            recovery: { proofSHA256: 'd'.repeat(64) },
          },
        })
      );
      await bounded(
        controlRef.create({
          releaseId,
          admission: 'paused',
          domains: Object.fromEntries(
            ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((x) => [
              x,
              { admission: 'paused' },
            ])
          ),
        })
      );
      await bounded(stateRef.create({ releaseId, phase: 'provider-usage-ready' }));
      const parentWitnessId = randomUUID();
      for (const [kind, value] of [
        ['Kernel', { stage: 'closed', close: { signal: 'SIGKILL', descendantsAbsent: true } }],
        [
          'ReplacementKernel',
          {
            stage: 'closed',
            close: { code: 0, signal: null, descendantsAbsent: true },
            worker: { instanceId: randomUUID(), buildId },
          },
        ],
        ['ReplacementIntent', { scope: 'CONTROLLED-closed-only' }],
      ]) {
        if (kind === 'Kernel' || kind === 'ReplacementKernel') {
          const cloudRun = {
            projectId: 'urm-app-staging',
            region: 'us-central1',
            pool: plan.name.split('/').at(-1),
            revision: pool.revision.split('/').at(-1),
            revisionUid: pool.revisionUid,
            imageDigest: plan.image.split('@')[1],
            serviceAccount: plan.runner,
            instanceId: 'CONTROLLED-same-container',
          };
          value.schemaVersion = 1;
          value.worker = { instanceId: randomUUID(), buildId, cloudRun };
          value.context = {
            operationId: op,
            intentSHA256: 'e'.repeat(64),
            parent: { instanceId: parentWitnessId, buildId, cloudRun },
          };
        }
        const ref = db.doc(`_control/temporalMediaRecovery${kind}-${op}`);
        refs.push(ref);
        await bounded(ref.create(value));
      }
      options = {
        client,
        firestore: db,
        plan,
        pool,
        operationId: op,
        bindingDigest: 'c'.repeat(64),
        lockRef,
        controlRef,
        stateRef,
        ownedOperation: nativeSnapshotProof(await bounded(lockRef.get())),
        expectedAuthority: {
          control: nativeSnapshotProof(await bounded(controlRef.get())),
          state: nativeSnapshotProof(await bounded(stateRef.get())),
        },
      };
      stage = 'native-register';
      await launch(buildId);
      await launch(oldBuild);
      // A stopped candidate does not hide another version's actual pollers.
      workers[0].worker.shutdown();
      await bounded(workers[0].running, 10000);
      await assert.rejects(bounded(observeMediaDiagnosticDrain(options), 35000), /POLLERS_PRESENT|DRAIN_UNCONFIRMED/);
      const h = await rpc(() =>
        client.workflow.start('WorkerRestartProbe', {
          workflowId: `owned-drain-${op}`,
          taskQueue: queue,
          args: [{}],
          versioningOverride: { pinnedTo: { deploymentName, buildId: oldBuild } },
        })
      );
      handles.push(h);
      stage = 'native-open-work-started';
      const firstTaskDeadline = performance.now() + 15_000;
      while (!(await rpc(() => h.fetchHistory())).events?.some((event) => event.workflowTaskCompletedEventAttributes)) {
        if (performance.now() >= firstTaskDeadline)
          throw Error('Owned drain probe did not finish its first workflow task');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.deepEqual(await rpc(() => h.query('workerRestartProbe.status')), {
        state: 'waiting',
        runId: h.firstExecutionRunId,
      });
      // Real open private work blocks even after every SDK poller is stopped.
      workers[1].worker.shutdown();
      await bounded(workers[1].running, 10000);
      await assert.rejects(bounded(observeMediaDiagnosticDrain(options), 35000), /DRAIN_UNCONFIRMED|POLLERS_PRESENT/);
      await rpc(() => h.terminate('Owned LOCAL drain fixture cleanup'));
      await assert.rejects(bounded(h.result()));
      handles.length = 0;
      stage = 'native-empty-after-owned-shutdown';
      const observed = await bounded(waitForMediaDiagnosticDrain(options), 335000);
      assert.equal(observed.versionCount, 2);
      assert(observed.partitionCount >= 2);
      const lock = db.doc(`temporalProviderMutationLocks/${op}`);
      refs.push(lock);
      await bounded(lock.create({ state: 'active' }));
      await assert.rejects(bounded(observeMediaDiagnosticDrain(options), 35000), /DRAIN_UNCONFIRMED/);
      await bounded(lock.delete());
      stage = 'stopped-confirmation';
      const drained = {
        kind: 'drained',
        operationId: op,
        bindingDigest: options.bindingDigest,
        buildId,
        image: plan.image,
        proofSHA256: hash(observed),
        observation: observed,
      };
      const drainRef = db.doc(`_control/temporalMediaRecoveryDrain-${op}`);
      refs.push(drainRef);
      await bounded(
        drainRef.create({
          schemaVersion: 1,
          operationId: op,
          releaseId,
          bindingDigest: options.bindingDigest,
          planSHA256: hash(plan),
          proof: drained,
        })
      );
      const zero = { ...pool, desiredManualInstanceCount: 0, generation: '11', etag: 'controlled11' };
      const stoppedCycle = {
        ...(await bounded(lockRef.get())).get('cloudMediaRecovery'),
        stage: 'drained',
        drained,
        stop: { stage: 'completed', pool: zero },
      };
      await bounded(lockRef.update({ cloudMediaRecovery: stoppedCycle }));
      const stoppedOptions = {
        ...options,
        pool: zero,
        ownedOperation: nativeSnapshotProof(await bounded(lockRef.get())),
      };
      assert.equal((await bounded(observeMediaDiagnosticStopped(stoppedOptions), 35000)).poolSHA256, hash(zero));
      await bounded(drainRef.delete());
      await assert.rejects(bounded(observeMediaDiagnosticStopped(stoppedOptions), 35000), /STOP_UNCONFIRMED/);
      await bounded(
        drainRef.create({
          schemaVersion: 1,
          operationId: op,
          releaseId,
          bindingDigest: options.bindingDigest,
          planSHA256: hash(plan),
          proof: drained,
        })
      );
      stage = 'never-started-confirmation';
      // A DISTINCT operation has no source execution intent or private facts.
      // Historical closed runs/receipts belonging to the earlier op stay intact.
      const neverId = randomUUID(),
        neverPlan = { ...plan, operationId: neverId, ancestorsSHA256: 'a'.repeat(64) };
      await bounded(
        lockRef.update({
          operationId: neverId,
          cloudMediaRecovery: { stage: 'prepared', plan: neverPlan, diagnostic: { stage: 'completed', pool: zero } },
        })
      );
      const neverOptions = {
        ...options,
        operationId: neverId,
        plan: neverPlan,
        pool: zero,
        ownedOperation: nativeSnapshotProof(await bounded(lockRef.get())),
      };
      // Pool responses remain controlled. The proof must consume the original
      // native Temporal and Firestore observation within the two zero reads.
      const zeroSample = () => ({
        pool: zero,
        ancestorsSHA256: neverPlan.ancestorsSHA256,
        sampledAt: Date.now(),
        sampledMonotonic: performance.now(),
      });
      const before = zeroSample();
      const observation = await bounded(observeMediaDiagnosticNeverStarted(neverOptions), 35000);
      const after = zeroSample();
      assert.equal(mediaDiagnosticNeverStartedProof(neverOptions, observation, before, after).kind, 'never-started');
      const attempted = db.doc(`_control/temporalMediaRecoveryStartup-${neverId}`);
      refs.push(attempted);
      await bounded(attempted.create({ stage: 'attempted' }));
      await assert.rejects(
        bounded(observeMediaDiagnosticNeverStarted(neverOptions), 35000),
        /NEVER_STARTED_UNCONFIRMED/
      );
      await bounded(attempted.delete());
      // Restore the original owned fixture parent before its final drift probe.
      await bounded(lockRef.update({ operationId: op, cloudMediaRecovery: { ...stoppedCycle, stage: 'recovered' } }));
      const restored = await bounded(lockRef.get());
      const originalCycle = restored.get('cloudMediaRecovery');
      delete originalCycle.drained;
      delete originalCycle.stop;
      await bounded(lockRef.update({ cloudMediaRecovery: originalCycle }));
      options.ownedOperation = nativeSnapshotProof(await bounded(lockRef.get()));
      // Exact original authority must survive the final awaited transaction.
      const nativeTx = db.runTransaction.bind(db);
      let reads = 0;
      const driftDB = new Proxy(db, {
        get(t, k) {
          if (k === 'runTransaction')
            return async (...args) => {
              if (++reads === 3) await controlRef.update({ drift: true });
              return nativeTx(...args);
            };
          const v = Reflect.get(t, k);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      await assert.rejects(
        bounded(observeMediaDiagnosticDrain({ ...options, firestore: driftDB }), 35000),
        /DRAIN_UNCONFIRMED/
      );
      assert.equal((await bounded(lockRef.get())).get('cloudMediaRecovery.stage'), 'recovered');
    } catch (e) {
      console.error(
        'OWNED_DRAIN_STAGE',
        stage,
        e?.message === 'MEDIA_DIAGNOSTIC_DRAIN_UNCONFIRMED' ? e.message : e?.name ?? 'unknown'
      );
      errors.push(e);
      if (options && env) {
        try {
          const service = options.client.workflowService,
            meta = [];
          for (const id of [buildId, oldBuild]) {
            const r = await rpc(() =>
              service.describeWorkerDeploymentVersion({
                namespace,
                deploymentVersion: { deploymentName, buildId: id },
                reportTaskQueueStats: true,
              })
            );
            const v = r.workerDeploymentVersionInfo;
            console.log(
              'OWNED_NATIVE_VERSION_SHAPE',
              JSON.stringify({ keys: Object.keys(r), infoKeys: Object.keys(v ?? {}) })
            );
            meta.push({
              version: id.slice(0, 1),
              queues: v.taskQueueInfos?.map((q) => ({ name: q.name, type: q.type })),
              stats: r.versionTaskQueues?.map((q) => ({
                name: q.name,
                type: q.type,
                backlog: String(q.stats?.approximateBacklogCount),
              })),
              current: !!v.currentSinceTime,
              ramp: !!v.rampingSinceTime,
            });
          }
          const part = await rpc(() =>
            service.listTaskQueuePartitions({ namespace, taskQueue: { name: queue, kind: 1 } })
          );
          const routing = (await rpc(() => service.describeWorkerDeployment({ namespace, deploymentName })))
            .workerDeploymentInfo.routingConfig;
          const running = (
            await rpc(() =>
              service.listWorkflowExecutions({ namespace, pageSize: 100, query: 'ExecutionStatus = "Running"' })
            )
          ).executions?.length;
          console.log(
            'OWNED_NATIVE_DRAIN_SHAPES',
            JSON.stringify({
              meta,
              partitions: {
                workflow: part.workflowTaskQueuePartitions?.map((x) => x.key),
                activity: part.activityTaskQueuePartitions?.map((x) => x.key),
              },
              routing,
              running,
            })
          );
        } catch (err) {
          console.log(
            'OWNED_NATIVE_DRAIN_SHAPES_UNAVAILABLE',
            Number.isInteger(err?.code) ? err.code : err?.name ?? 'unknown'
          );
        }
      }
    } finally {
      for (const h of handles)
        try {
          await rpc(() => h.terminate('Owned LOCAL drain fixture cleanup'));
        } catch (e) {
          errors.push(e);
        }
      for (const w of workers)
        try {
          if (w.worker.getStatus().runState === 'RUNNING') w.worker.shutdown();
          await bounded(w.running, 12000);
        } catch (e) {
          errors.push(e);
        }
      for (const ref of refs.reverse())
        try {
          await bounded(ref.delete());
        } catch (e) {
          errors.push(e);
        }
      for (const fn of [
        () => db?.terminate(),
        () => app && deleteApp(app),
        () => env?.teardown(),
        () => Runtime.instance().shutdown(),
      ])
        try {
          await bounded(Promise.resolve().then(fn), 20000);
        } catch (e) {
          errors.push(e);
        }
    }
    if (errors.length) throw new AggregateError(errors, 'Owned native drain fixture failed');
  }
);
