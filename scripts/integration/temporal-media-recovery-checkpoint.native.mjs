import { observeMediaRecoveryProtection } from '../temporal-media-recovery-protection.mjs';
/** Actual Firestore checkpoint/authority; CONTROLLED Cloud/runtime protocol. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mediaRecoveryFixture } from '../tests/fixtures/media-recovery.mjs';
import { observeMediaRecoveryPhasePool } from '../temporal-media-recovery-phase-pool.mjs';
import { readRestoredMediaRecoveryOrigin } from '../temporal-media-restored-origin.mjs';
import { runMediaRecoveryCycle } from '../temporal-media-recovery-cycle.mjs';
import {
  saveMediaRecoveryCheckpoint,
  assertMediaRecoveryAuthority,
  prepareMediaRecoveryJournal,
} from '../temporal-media-recovery-checkpoint.mjs';
import { nativeSnapshotProof, proofDigest as hash } from '../temporal-release-runtime.mjs';
import { bounded } from './fixtures/owned-media-process.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app'),
  { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const harness = require('./firebase.test.json');
if (process.env.FIRESTORE_EMULATOR_HOST !== `127.0.0.1:${harness.emulators.firestore.port}`)
  throw new Error('Dedicated emulator required');
for (const mode of [
  'normal',
  'phase-resource',
  'idle-startup',
  'idle-poller',
  'control-drift',
  'state-drift',
  'never-started',
  'never-started-checkpoint-ack-loss',
  'never-started-restore-ack-loss',
  'recovery-ack-loss',
  'drain-ack-loss',
  'start-checkpoint-ack-loss',
])
  test(`native recovery checkpoint / ${mode}`, async () => {
    const f = await mediaRecoveryFixture(),
      app = initializeApp({ projectId: 'urm-app-staging' }, `recovery-${randomUUID()}`),
      db = getFirestore(app);
    const lockRef = db.doc('_control/temporalReleaseOperation'),
      controlRef = db.doc('_control/temporalRelease'),
      stateRef = db.doc('_control/temporalReleaseState'),
      immutableReceipt = db.doc(`_control/temporalCloudMediaRecovery-${f.options.operationId}`);
    let ownedOperation,
      expectedAuthority,
      once = true,
      denyQuota = false,
      recoveryCalls = 0,
      drainCalls = 0,
      idleActor,
      idlePrivate = [],
      idleRuntime = { active: true };
    let cycleTask;
    const config = { releaseId: f.options.releaseId },
      base = {
        firestore: db,
        lockRef,
        controlRef,
        stateRef,
        immutableReceipt,
        config,
        operationId: f.options.operationId,
        bindingDigest: f.options.bindingDigest,
        operatorPrincipal: {
          email: 'controlled@example.test',
          ...(['idle-startup', 'idle-poller'].includes(mode) ? { adcAndGcloudAccountMatch: true } : {}),
        },
      };
    const options = () => ({ ...base, ownedOperation, expectedAuthority });
    try {
      await bounded(
        lockRef.create({
          operationId: f.options.operationId,
          releaseId: config.releaseId,
          bindingDigest: f.options.bindingDigest,
          action: 'diagnose-cloud-run-media-recovery',
          operatorPrincipal: base.operatorPrincipal,
        })
      );
      await bounded(
        controlRef.create({
          releaseId: config.releaseId,
          admission: 'paused',
          domains: Object.fromEntries(
            ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
              d,
              { admission: 'paused' },
            ])
          ),
        })
      );
      await bounded(stateRef.create({ releaseId: config.releaseId, phase: 'provider-usage-ready' }));
      ownedOperation = nativeSnapshotProof(await bounded(lockRef.get()));
      expectedAuthority = {
        control: nativeSnapshotProof(await bounded(controlRef.get())),
        state: nativeSnapshotProof(await bounded(stateRef.get())),
      };
      f.options.authorizeMutation = () => assertMediaRecoveryAuthority(options());
      f.options.runtime.prepare = async ({ plan }) => {
        const result = await bounded(prepareMediaRecoveryJournal({ ...options(), plan }));
        ownedOperation = result.ownedOperation;
        return result.prepared;
      };
      const drain = f.options.runtime.drain;
      f.options.runtime.drain = async (args) => {
        drainCalls++;
        return drain(args);
      };
      const execute = f.options.runtime.execute;
      f.options.runtime.execute = async (args) => {
        recoveryCalls++;
        return execute(args);
      };
      const fixtureSave = f.options.save;
      f.options.save = async (identityState) => {
        ownedOperation = await bounded(saveMediaRecoveryCheckpoint({ ...options(), identityState }));
        await fixtureSave(identityState);
        if (
          mode.startsWith('never-started') &&
          identityState.diagnostic?.stage === 'completed' &&
          !identityState.neverStarted
        )
          denyQuota = true;
        if (identityState.neverStarted) denyQuota = false;
        if (
          once &&
          ((mode === 'never-started-checkpoint-ack-loss' && identityState.neverStarted && !identityState.restore) ||
            (mode === 'never-started-restore-ack-loss' && identityState.restore?.stage === 'acknowledged'))
        ) {
          once = false;
          throw new Error('CONTROLLED_CHECKPOINT_ACK_LOSS');
        }
        if (
          once &&
          identityState.start?.stage === 'attempted' &&
          ['control-drift', 'state-drift', 'start-checkpoint-ack-loss'].includes(mode)
        ) {
          once = false;
          if (mode === 'start-checkpoint-ack-loss') throw new Error('CONTROLLED_CHECKPOINT_ACK_LOST');
          await bounded((mode === 'control-drift' ? controlRef : stateRef).update({ controlledDrift: true }));
        }
        if (once && mode === 'drain-ack-loss' && identityState.drained) {
          once = false;
          throw new Error('CONTROLLED_CHECKPOINT_ACK_LOST');
        }
        if (once && mode === 'recovery-ack-loss' && identityState.recovery) {
          once = false;
          throw new Error('CONTROLLED_CHECKPOINT_ACK_LOST');
        }
      };
      if (mode === 'phase-resource') {
        const baseline = f.options.observeProtection;
        f.options.observeProtection = async (scope) => {
          const observed = await bounded(observeMediaRecoveryPhasePool({ ...f.options, ...options(), ...scope }));
          assert.equal(observed.readOnly, true);
          return baseline(scope);
        };
      }
      if (['idle-startup', 'idle-poller'].includes(mode)) {
        const service = require('ts-node').register({
          skipProject: true,
          transpileOnly: true,
          compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
        });
        const { fileURLToPath } = await import('node:url');
        const source = (p) =>
          require(fileURLToPath(new URL('../../apps/temporal-worker/src/runtime/' + p, import.meta.url)));
        const { collectMediaRecoveryIdleStartup } = source('media-recovery-idle-startup.ts');
        const { mediaRecoveryKernelContext } = source('media-recovery-capability.ts');
        const { mediaStartupBudget } = source('media-startup-capacity.ts');
        const { MEDIA_ALLOCATION_PROGRAM_SHA256 } = source('media-capacity-allocation.ts');
        const auth = getAuth(app);
        idleActor = await auth.createUser({ email: base.operatorPrincipal.email });
        await auth.setCustomUserClaims(idleActor.uid, { role: 'admin' });
        const originalExecute = f.options.runtime.execute;
        f.options.runtime.execute = async (scope) => {
          const phasePool = await observeMediaRecoveryPhasePool({
            ...f.options,
            ...options(),
            plan: scope.plan,
            phase: 'start',
            pool: scope.plan ? f.saved.diagnostic.pool : null,
          });
          const image = {
            bundleSHA256: 'a'.repeat(64),
            tools: { pythonSHA256: 'b'.repeat(64), ffmpegSHA256: 'c'.repeat(64), ffprobeSHA256: 'd'.repeat(64) },
          };
          const readOptions = {
            db,
            auth,
            operationId: base.operationId,
            plan: scope.plan,
            phasePool,
            expectedRootSHA256: ownedOperation.dataDigest,
            expectedControlSHA256: expectedAuthority.control.dataDigest,
            expectedStateSHA256: expectedAuthority.state.dataDigest,
            image,
          };
          assert.equal((await collectMediaRecoveryIdleStartup(readOptions)).stage, 'absent');
          const before = f.saved.start.plan.before;
          const supervisor = {
            instanceId: randomUUID(),
            buildId: scope.plan.buildId,
            cloudRun: {
              projectId: 'urm-app-staging',
              region: 'us-central1',
              pool: scope.plan.name.split('/').at(-1),
              revision: before.revision.split('/').at(-1),
              revisionUid: before.revisionUid,
              imageDigest: scope.plan.image.split('@')[1],
              serviceAccount: scope.plan.runner,
              instanceId: 'CONTROLLED-container',
            },
          };
          const cap = await mediaRecoveryKernelContext(db, auth, supervisor, base.operationId);
          const kernelRef = db.doc(`_control/temporalMediaRecoveryKernel-${base.operationId}`),
            startupRef = db.doc(`_control/temporalMediaRecoveryStartup-${base.operationId}`);
          let k = {
            schemaVersion: 1,
            stage: 'armed',
            context: cap.context,
            intent: { launchId: randomUUID(), parentPid: 100, createdAt: new Date().toISOString() },
          };
          await kernelRef.create(k);
          idlePrivate.push(kernelRef);
          assert.equal((await collectMediaRecoveryIdleStartup(readOptions)).stage, 'armed');
          k = { ...k, stage: 'born', birth: { nonce: randomUUID(), pid: 101, spawnedAt: new Date().toISOString() } };
          await kernelRef.set(k);
          assert.equal((await collectMediaRecoveryIdleStartup(readOptions)).stage, 'born');
          k = { ...k, stage: 'running', worker: { ...supervisor, instanceId: randomUUID() } };
          await kernelRef.set(k);
          assert.equal((await collectMediaRecoveryIdleStartup(readOptions)).allowedPollerIdentity, null);
          const at = new Date().toISOString(),
            GiB = 1024 ** 3;
          const capacity = {
            schemaVersion: 3,
            budgets: mediaStartupBudget,
            totalBytes: 100 * GiB,
            availableBytes: 90 * GiB,
            canaryBytes: 1024 * 1024,
            writeReadFsync: true,
            cleanupConfirmed: true,
            reservationReleased: true,
            observedAt: at,
            allocation: {
              schemaVersion: 1,
              requestedBytes: 64 * GiB,
              allocatedBytes: 64 * GiB,
              pythonSHA256: image.tools.pythonSHA256,
              programSHA256: MEDIA_ALLOCATION_PROGRAM_SHA256,
              filesystemDevice: 2,
              fileInode: 123,
              availableBytesAfterAllocation: 26 * GiB,
              minimumAvailableBytesWhileHeld: 26 * GiB,
              startedAt: at,
              releasedAt: at,
              cleanupConfirmed: true,
            },
            processing: {
              schemaVersion: 1,
              ffmpegSHA256: image.tools.ffmpegSHA256,
              ffprobeSHA256: image.tools.ffprobeSHA256,
              sourceBytes: 32044,
              outputBytes: 32044,
              sampleRate: 16000,
              channels: 1,
              durationSeconds: 1,
              pcmSamplesVerified: 16000,
              progressBeforeCancellation: true,
              cancelledChildDrained: true,
              retryCompleted: true,
            },
          };
          const record = {
            schemaVersion: 1,
            kind: 'private-diagnostic-startup-only-no-recovery-proof',
            operationId: base.operationId,
            intentSHA256: cap.context.intentSHA256,
            worker: k.worker,
            kernel: {
              operationId: base.operationId,
              birthDigest: hash({ context: k.context, intent: k.intent, birth: k.birth, worker: k.worker }),
            },
            bundle: {
              schemaVersion: 1,
              buildId: scope.plan.buildId,
              bundleBytes: 100,
              bundleSHA256: image.bundleSHA256,
            },
            capacity,
            observedAt: at,
          };
          await startupRef.create(record);
          idlePrivate.push(startupRef);
          assert.equal(
            (await collectMediaRecoveryIdleStartup(readOptions)).allowedPollerIdentity,
            `media-recovery-${k.worker.instanceId}`
          );
          await assert.rejects(
            collectMediaRecoveryIdleStartup({ ...readOptions, image: { ...image, bundleSHA256: 'f'.repeat(64) } })
          );
          await startupRef.update({ 'kernel.birthDigest': 'f'.repeat(64) });
          await assert.rejects(collectMediaRecoveryIdleStartup(readOptions));
          await startupRef.set(record);
          const nativeTx = db.runTransaction.bind(db);
          let idleReads = 0;
          const delayedDB = new Proxy(db, {
            get(t, key) {
              if (key === 'runTransaction')
                return async (...args) => {
                  const v = await nativeTx(...args);
                  if (++idleReads === 4) await new Promise((r) => setTimeout(r, 5100));
                  return v;
                };
              const v = Reflect.get(t, key);
              return typeof v === 'function' ? v.bind(t) : v;
            },
          });
          await assert.rejects(
            bounded(collectMediaRecoveryIdleStartup({ ...readOptions, db: delayedDB }), 7000),
            /IDLE_STARTUP_UNCONFIRMED/
          );
          readOptions.phasePool = await observeMediaRecoveryPhasePool({
            ...f.options,
            ...options(),
            plan: scope.plan,
            phase: 'start',
            pool: f.saved.diagnostic.pool,
          });
          await auth.updateUser(idleActor.uid, { disabled: true });
          await assert.rejects(collectMediaRecoveryIdleStartup(readOptions));
          await auth.updateUser(idleActor.uid, { disabled: false });
          if (mode === 'idle-poller') {
            const { createLocalTestEnvironment } = require(fileURLToPath(
              new URL('../../apps/temporal-worker/src/test-support/local-test-environment.ts', import.meta.url)
            ));
            const { Client } = require('@temporalio/client'),
              { Worker, Runtime, DefaultLogger } = require('@temporalio/worker');
            Runtime.install({ shutdownSignals: [], logger: new DefaultLogger('ERROR', () => undefined) });
            idleRuntime.Runtime = Runtime;
            const env = await bounded(createLocalTestEnvironment({ testServer: { server: { extraArgs: [] } } }), 30000);
            idleRuntime.env = env;
            const namespace = 'urm-app-staging.qwejt',
              deploymentName = 'urm-worker-media-recovery-staging',
              queue = 'urm-media-kernel-recovery';
            const client = new Client({ connection: env.connection, namespace });
            const tracedService = new Proxy(env.connection.workflowService, {
              get(t, key) {
                const v = Reflect.get(t, key);
                return typeof v === 'function'
                  ? async (...args) => {
                      try {
                        // Server 1.32 has no Nexus visibility implementation.
                        // First prove raw native failure closes the gate; only
                        // the fixture may then supply an explicitly controlled
                        // empty Nexus inventory to exercise remaining joins.
                        if (key === 'listNexusOperationExecutions' && idleRuntime.controlledNexus)
                          return { operations: [] };
                        return await v.apply(t, args);
                      } catch (error) {
                        idleRuntime.lastNativeError = {
                          method: String(key),
                          code: Number.isInteger(error?.code) ? error.code : null,
                        };
                        throw error;
                      }
                    }
                  : v;
              },
            });
            const guardedClient = {
              options: client.options,
              connection: {
                workflowService: tracedService,
                withDeadline: env.connection.withDeadline.bind(env.connection),
              },
            };

            await bounded(
              client.workflowService.registerNamespace({
                namespace,
                workflowExecutionRetentionPeriod: { seconds: 86400 },
              })
            );
            const worker = await bounded(
              Worker.create({
                connection: env.nativeConnection,
                namespace,
                taskQueue: queue,
                identity: `media-recovery-${k.worker.instanceId}`,
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
                  version: { deploymentName, buildId: scope.plan.buildId },
                },
                shutdownGraceTime: '1 second',
                shutdownForceTime: '5 seconds',
              }),
              15000
            );
            idleRuntime.worker = worker;
            idleRuntime.running = worker.run();
            void idleRuntime.running.catch(() => {});
            let protection;
            const until = Date.now() + 15000;
            do {
              if (!idleRuntime.active) throw Error('Owned fixture cancelled');
              readOptions.phasePool = await observeMediaRecoveryPhasePool({
                ...f.options,
                ...options(),
                plan: scope.plan,
                phase: 'start',
                pool: f.saved.diagnostic.pool,
              });
              try {
                protection = await observeMediaRecoveryProtection({
                  ...f.options,
                  ...options(),
                  plan: scope.plan,
                  phase: 'start',
                  pool: f.saved.diagnostic.pool,
                  phasePool: readOptions.phasePool,
                  client: guardedClient,
                  readIdle: () => collectMediaRecoveryIdleStartup(readOptions),
                });
                break;
              } catch (error) {
                if (
                  !idleRuntime.controlledNexus &&
                  idleRuntime.lastNativeError?.method === 'listNexusOperationExecutions' &&
                  idleRuntime.lastNativeError.code === 12
                ) {
                  assert.match(String(error?.message), /PHASE_PROTECTION_UNCONFIRMED/);
                  idleRuntime.controlledNexus = true;
                  idleRuntime.lastNativeError = null;
                  console.error('OWNED_LOCAL_UNSUPPORTED_NEXUS_FAIL_CLOSED_CONTROLLED_EMPTY_FOR_REMAINING_FIXTURE');
                }
                if (Date.now() >= until) {
                  console.error(
                    'OWNED_IDLE_NATIVE_POLICY_FAILURE',
                    JSON.stringify(idleRuntime.lastNativeError ?? { method: 'policy-invariant', code: null })
                  );
                  throw error;
                }
                await new Promise((r) => setTimeout(r, 200));
              }
            } while (Date.now() < until);
            if (!protection)
              console.error(
                'OWNED_IDLE_NATIVE_POLICY_FAILURE',
                JSON.stringify(idleRuntime.lastNativeError ?? { method: 'policy-invariant', code: null })
              );
            assert(protection);
            assert.equal(protection.phase, 'start');
            await startupRef.delete();
            readOptions.phasePool = await observeMediaRecoveryPhasePool({
              ...f.options,
              ...options(),
              plan: scope.plan,
              phase: 'start',
              pool: f.saved.diagnostic.pool,
            });
            await assert.rejects(
              bounded(
                observeMediaRecoveryProtection({
                  ...f.options,
                  ...options(),
                  plan: scope.plan,
                  phase: 'start',
                  pool: f.saved.diagnostic.pool,
                  phasePool: readOptions.phasePool,
                  client: guardedClient,
                  readIdle: () => collectMediaRecoveryIdleStartup(readOptions),
                }),
                10000
              ),
              /PHASE_PROTECTION_UNCONFIRMED/
            );
            await startupRef.create(record);
            const h = await bounded(
              client.workflow.start('WorkerRestartProbe', {
                workflowId: `owned-idle-negative-${base.operationId}`,
                taskQueue: queue,
                args: [{}],
                versioningOverride: { pinnedTo: { deploymentName, buildId: scope.plan.buildId } },
              })
            );
            idleRuntime.handle = h;
            const visibleUntil = Date.now() + 10000;
            while (
              !(
                await client.workflowService.listWorkflowExecutions({
                  namespace,
                  pageSize: 100,
                  query: 'ExecutionStatus = "Running"',
                })
              ).executions.some((x) => x.execution.runId === h.firstExecutionRunId)
            ) {
              if (Date.now() >= visibleUntil) throw Error('Owned run visibility timeout');
              await new Promise((r) => setTimeout(r, 100));
            }
            readOptions.phasePool = await observeMediaRecoveryPhasePool({
              ...f.options,
              ...options(),
              plan: scope.plan,
              phase: 'start',
              pool: f.saved.diagnostic.pool,
            });
            await assert.rejects(
              bounded(
                observeMediaRecoveryProtection({
                  ...f.options,
                  ...options(),
                  plan: scope.plan,
                  phase: 'start',
                  pool: f.saved.diagnostic.pool,
                  phasePool: readOptions.phasePool,
                  client: guardedClient,
                  readIdle: () => collectMediaRecoveryIdleStartup(readOptions),
                }),
                10000
              ),
              /PHASE_PROTECTION_UNCONFIRMED/
            );
            await bounded(h.terminate('Owned LOCAL idle protection negative cleanup'));
            idleRuntime.handle = undefined;
            await assert.rejects(bounded(h.result()));
            worker.shutdown();
            await bounded(idleRuntime.running, 15000);
            idleRuntime.worker = undefined;
            await bounded(env.teardown(), 20000);
            idleRuntime.env = undefined;
            await bounded(Runtime.instance().shutdown(), 10000);
            idleRuntime.Runtime = undefined;
          }
          await startupRef.delete();
          await kernelRef.delete();
          const result = await originalExecute(scope);
          service.enabled(false);
          if (process[Symbol.for('ts-node.register.instance')] === service)
            delete process[Symbol.for('ts-node.register.instance')];
          return result;
        };
      }
      const api = f.options.api;
      f.options.api = (...args) => {
        if (denyQuota && args[0].includes('cloudquotas')) throw new Error('CONTROLLED_QUOTA_UNAVAILABLE');
        return api(...args);
      };
      if (mode === 'normal' || mode === 'phase-resource' || ['idle-startup', 'idle-poller'].includes(mode)) {
        cycleTask = runMediaRecoveryCycle(f.options);
        const result = await bounded(cycleTask, mode === 'idle-poller' ? 90000 : 15000);
        assert.equal((await bounded(immutableReceipt.get())).get('identityState.stage'), 'completed');
        if (mode === 'phase-resource') {
          const scope = { plan: result.plan, phase: 'completed', pool: result.restore.pool };
          const readOptions = { ...f.options, ...options(), ...scope };
          assert.equal((await bounded(observeMediaRecoveryPhasePool(readOptions))).position, 'exact');
          const api = f.options.api;
          await assert.rejects(
            bounded(
              observeMediaRecoveryPhasePool({
                ...readOptions,
                api: async (url, ...args) => {
                  const v = await api(url, ...args);
                  return url === `https://run.googleapis.com/v2/${result.plan.name}` ? { ...v, etag: 'foreign' } : v;
                },
              })
            ),
            /PHASE_POOL_UNCONFIRMED/
          );
          const tx = db.runTransaction.bind(db);
          let reads = 0;
          const delayed = new Proxy(db, {
            get(t, k) {
              if (k === 'runTransaction')
                return async (...args) => {
                  const v = await tx(...args);
                  if (++reads === 2) await new Promise((r) => setTimeout(r, 5100));
                  return v;
                };
              const v = Reflect.get(t, k);
              return typeof v === 'function' ? v.bind(t) : v;
            },
          });
          await assert.rejects(
            bounded(observeMediaRecoveryPhasePool({ ...readOptions, firestore: delayed }), 7000),
            /PHASE_POOL_UNCONFIRMED/
          );
        }

        await assert.rejects(
          saveMediaRecoveryCheckpoint({ ...options(), identityState: { ...result, stage: 'planned' } })
        );
        const altered = structuredClone(result);
        altered.diagnostic.request.body.etag = 'changed';
        await assert.rejects(saveMediaRecoveryCheckpoint({ ...options(), identityState: altered }));
      } else if (['never-started-checkpoint-ack-loss', 'never-started-restore-ack-loss'].includes(mode)) {
        await assert.rejects(bounded(runMediaRecoveryCycle(f.options)));
        const saved = (await bounded(lockRef.get())).get('cloudMediaRecovery');
        await assert.rejects(bounded(runMediaRecoveryCycle({ ...f.options, saved })));
        const final = (await bounded(lockRef.get())).get('cloudMediaRecovery');
        assert.equal(final.stage, 'completed');
        assert.equal(final.start, undefined);
        assert.deepEqual(
          f.calls.map((v) => v.key),
          ['diagnostic', 'restore']
        );
      } else if (mode === 'recovery-ack-loss' || mode === 'drain-ack-loss') {
        await assert.rejects(bounded(runMediaRecoveryCycle(f.options)));
        const saved = (await bounded(lockRef.get())).get('cloudMediaRecovery');
        assert.equal(saved.stage, mode === 'drain-ack-loss' ? 'drained' : 'recovered');
        if (mode === 'drain-ack-loss')
          assert.equal(
            (await bounded(db.doc(`_control/temporalMediaRecoveryDrain-${f.options.operationId}`).get())).get(
              'proof.proofSHA256'
            ),
            saved.drained.proofSHA256
          );
        assert.equal(recoveryCalls, 1);
        await bounded(runMediaRecoveryCycle({ ...f.options, saved }));
        assert.equal(recoveryCalls, 1);
        if (mode === 'drain-ack-loss') assert.equal(drainCalls, 1);
        assert.deepEqual(
          f.calls.map((v) => v.key),
          ['diagnostic', 'start', 'stop', 'restore']
        );
      } else {
        await assert.rejects(bounded(runMediaRecoveryCycle(f.options)));
        const saved = (await bounded(lockRef.get())).get('cloudMediaRecovery');
        if (mode === 'never-started') {
          assert.equal(saved.stage, 'completed');
          assert.equal(saved.neverStarted.kind, 'never-started');
          assert.equal(saved.stop, undefined);
          assert.deepEqual(
            f.calls.map((v) => v.key),
            ['diagnostic', 'restore']
          );
        } else {
          assert.equal(saved.start.stage, 'attempted');
          assert.equal(saved.neverStarted, undefined);
          assert.deepEqual(
            f.calls.map((v) => v.key),
            ['diagnostic']
          );
          if (mode === 'start-checkpoint-ack-loss') {
            await assert.rejects(
              saveMediaRecoveryCheckpoint({
                ...options(),
                identityState: { ...saved, stage: 'never-started', neverStarted: { kind: 'never-started' } },
              })
            );
          }
        }
      }
      if (mode === 'normal') {
        const originOptions = {
          ...f.options,
          ...options(),
          releaseId: config.releaseId,
          role: 'media',
          saved: undefined,
        };
        const origin = await bounded(readRestoredMediaRecoveryOrigin(originOptions), 35000);
        assert.equal(origin.kind, 'restored-media-normal-origin-v1');
        assert.notEqual(origin.pool.revision, f.saved.plan.origin.revision);
        assert.equal(origin.pool.desiredManualInstanceCount, 0);
        if (mode === 'phase-resource') {
          const baseline = f.options.observeProtection;
          f.options.observeProtection = async (scope) => {
            const observed = await bounded(observeMediaRecoveryPhasePool({ ...f.options, ...options(), ...scope }));
            assert.equal(observed.readOnly, true);
            return baseline(scope);
          };
        }
        const api = f.options.api;
        let sampled = false,
          drifted = false;
        const driftAPI = async (...args) => {
          const result = await api(...args);
          if (args[0] === `https://run.googleapis.com/v2/${f.saved.plan.name}`) sampled = true;
          else if (sampled && !drifted) {
            drifted = true;
            f.f.pool.etag = 'CONTROLLED-late-origin-drift';
          }
          return result;
        };
        await assert.rejects(
          bounded(readRestoredMediaRecoveryOrigin({ ...originOptions, api: driftAPI }), 35000),
          /RESTORED_MEDIA_ORIGIN_UNCONFIRMED/
        );
        f.f.pool.etag = f.saved.restore.pool.etag;
        let txCount = 0,
          normalReads = 0;
        const delayedDB = new Proxy(db, {
          get(t, k) {
            if (k === 'runTransaction')
              return async (...args) => {
                const value = await t.runTransaction(...args);
                if (++txCount === 2) await new Promise((r) => setTimeout(r, 4850));
                return value;
              };
            const v = Reflect.get(t, k);
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
        const delayedAPI = async (...args) => {
          const value = await api(...args);
          if (args[0] === `https://run.googleapis.com/v2/${f.saved.plan.name}`) normalReads++;
          if (normalReads >= 2 && args[0].includes('/revisions/')) await new Promise((r) => setTimeout(r, 350));
          return value;
        };
        await assert.rejects(
          bounded(readRestoredMediaRecoveryOrigin({ ...originOptions, firestore: delayedDB, api: delayedAPI }), 35000),
          /RESTORED_MEDIA_ORIGIN_UNCONFIRMED/
        );
        await bounded(db.doc(`_control/temporalMediaRecoveryDrain-${f.options.operationId}`).delete());
        await assert.rejects(
          bounded(readRestoredMediaRecoveryOrigin(originOptions), 35000),
          /RESTORED_MEDIA_ORIGIN_UNCONFIRMED/
        );
      }
    } finally {
      idleRuntime.active = false;
      if (cycleTask)
        await bounded(
          cycleTask.catch(() => undefined),
          20000
        );
      if (idleRuntime.handle) await bounded(idleRuntime.handle.terminate('Owned LOCAL cleanup'));
      if (idleRuntime.worker && idleRuntime.worker.getStatus().runState === 'RUNNING') idleRuntime.worker.shutdown();
      if (idleRuntime.running) await bounded(idleRuntime.running, 15000);
      if (idleRuntime.env) await bounded(idleRuntime.env.teardown(), 20000);
      if (idleRuntime.Runtime) await bounded(idleRuntime.Runtime.instance().shutdown(), 10000);
      if (['idle-startup', 'idle-poller'].includes(mode)) {
        if (idleActor) await getAuth(app).deleteUser(idleActor.uid);
        for (const ref of idlePrivate) await ref.delete();
      }

      const failures = [];
      for (const cleanup of [
        ...[
          db.doc(`_control/temporalMediaRecoveryJournal-${f.options.operationId}`),
          db.doc(`_control/temporalMediaRecoveryDrain-${f.options.operationId}`),
          immutableReceipt,
          lockRef,
          controlRef,
          stateRef,
        ].map((ref) => () => ref.delete()),
        () => db.terminate(),
        () => deleteApp(app),
      ]) {
        try {
          await bounded(cleanup());
        } catch {
          failures.push(new Error('Owned checkpoint cleanup failed'));
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Owned checkpoint cleanup failed');
    }
  });
