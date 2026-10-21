import { observeRestoredMediaPhaseProtection } from '../temporal-restored-media-protection.mjs';
import { restoredMediaProtectionFixture } from '../tests/fixtures/restored-media-protection.mjs';
import { observeRestoredMediaPhasePool } from '../temporal-restored-media-phase-pool.mjs';
import {
  readRestoredMediaActivationPool,
  readRestoredMediaActivationQuota,
} from '../temporal-restored-media-resources.mjs';
import { activateRestoredCloudRunMedia } from '../temporal-media-restored-activation.mjs';
import { saveRestoredMediaActivationCheckpoint } from '../temporal-media-restored-checkpoint.mjs';
import { restoredActivationFixture } from '../tests/fixtures/restored-media-activation.mjs';
import { observeMediaRecoveryProtection } from '../temporal-media-recovery-protection.mjs';
import {
  controlledRecoveryCapsuleFacts,
  controlledCapsuleOperatorIdentity,
} from '../tests/fixtures/media-recovery-capsule.mjs';
import { confirmCompletedMediaRecoveryCapsule } from '../temporal-media-recovery-capsule.mjs';
/** Actual Firestore checkpoint/authority; CONTROLLED Cloud/runtime protocol. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mediaRecoveryFixture } from '../tests/fixtures/media-recovery.mjs';
import { observeMediaRecoveryPhasePool } from '../temporal-media-recovery-phase-pool.mjs';
import {
  readRestoredMediaRecoveryOrigin,
  readRestoredMediaActivationAccess,
} from '../temporal-media-restored-origin.mjs';
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
  'capsule',
  'activation-access',
  'restored-activation',
  'restored-resources',
  'restored-phase-resources',
  'restored-startup',
  'restored-startup-phase',
  'restored-startup-phase-failure',
  'restored-startup-drain',
  'restored-startup-readback',
  'restored-startup-readback-expired',
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
          operatorIdentity: controlledCapsuleOperatorIdentity,
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
        if (
          identityState.stage === 'completed' &&
          identityState.recovery &&
          !identityState.recoveryFailed &&
          !identityState.neverStarted &&
          !(await db.doc(`_control/temporalMediaRecoveryCapsule-${base.operationId}`).get()).exists
        ) {
          const controlled = controlledRecoveryCapsuleFacts(identityState);
          for (const [kind, data] of Object.entries(controlled.facts)) {
            const ref = db.doc(`_control/temporalMediaRecovery${kind}-${base.operationId}`);
            await ref.set(data);
            if (!idlePrivate.some((r) => r.path === ref.path)) idlePrivate.push(ref);
          }
          await lockRef.update({ mediaRecoveryWorkflowStart: controlled.intent });
          ownedOperation = nativeSnapshotProof(await lockRef.get());
        }
        ownedOperation = await bounded(saveMediaRecoveryCheckpoint({ ...options(), identityState }));
        await fixtureSave(identityState);
        if (mode === 'capsule' && once && identityState.stage === 'completed') {
          once = false;
          throw Error('CONTROLLED_COMPLETION_ACK_LOST');
        }
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
      if (
        mode === 'normal' ||
        mode === 'capsule' ||
        ['activation-access', 'restored-activation', 'restored-resources', 'restored-phase-resources'].includes(mode) ||
        mode.startsWith('restored-startup') ||
        mode === 'phase-resource' ||
        ['idle-startup', 'idle-poller'].includes(mode)
      ) {
        cycleTask = runMediaRecoveryCycle(f.options);
        if (mode === 'capsule') {
          await assert.rejects(bounded(cycleTask), /CONTROLLED_COMPLETION_ACK_LOST/);
          const saved = (await lockRef.get()).get('cloudMediaRecovery');
          assert.equal(saved.stage, 'completed');
          assert.equal((await immutableReceipt.get()).get('identityState.stage'), 'completed');
          assert.equal(
            (await db.doc(`_control/temporalMediaRecoveryCapsule-${base.operationId}`).get()).get('kind'),
            'completed-media-recovery-provenance-only-v1'
          );
          cycleTask = runMediaRecoveryCycle({ ...f.options, saved });
        }
        const result = await bounded(cycleTask, mode === 'idle-poller' ? 90000 : 15000);
        assert.equal((await bounded(immutableReceipt.get())).get('identityState.stage'), 'completed');
        if (mode === 'capsule') {
          const proof = await confirmCompletedMediaRecoveryCapsule(options());
          assert.equal(proof.scope, 'historical-provenance-only-no-activation-authority');
          const ref = db.doc(`_control/temporalMediaRecoveryCapsule-${base.operationId}`),
            snapshot = await ref.get();
          const original = snapshot.data();
          await ref.delete();
          await assert.rejects(confirmCompletedMediaRecoveryCapsule(options()), /CAPSULE_UNCONFIRMED/);
          await assert.rejects(
            saveMediaRecoveryCheckpoint({ ...options(), identityState: result }),
            /CAPSULE_UNCONFIRMED/
          );
          assert.equal((await ref.get()).exists, false);
          assert.equal((await immutableReceipt.get()).exists, true);
          await ref.create(original);
          await lockRef.update({ action: 'activate-restored-cloud-run-media' });
          const current = nativeSnapshotProof(await lockRef.get());
          await assert.rejects(
            confirmCompletedMediaRecoveryCapsule({ ...options(), ownedOperation: current }),
            /CAPSULE_UNCONFIRMED/
          );
          await lockRef.update({ action: 'diagnose-cloud-run-media-recovery' });
          ownedOperation = nativeSnapshotProof(await lockRef.get());
          assert.equal((await confirmCompletedMediaRecoveryCapsule(options())).capsuleSHA256, proof.capsuleSHA256);
        }
        if (
          ['activation-access', 'restored-activation', 'restored-resources', 'restored-phase-resources'].includes(
            mode
          ) ||
          mode.startsWith('restored-startup')
        ) {
          const newId = randomUUID(),
            newBinding = 'e'.repeat(64);
          await lockRef.set({
            action: 'activate-restored-cloud-run-media',
            operationId: newId,
            releaseId: config.releaseId,
            bindingDigest: newBinding,
            operatorPrincipal: { email: base.operatorPrincipal.email, adcAndGcloudAccountMatch: true },
            operatorIdentity: controlledCapsuleOperatorIdentity,
          });
          const args = {
            ...f.options,
            ...options(),
            operationId: newId,
            bindingDigest: newBinding,
            recoveryOperationId: base.operationId,
            ownedOperation: nativeSnapshotProof(await lockRef.get()),
            releaseId: config.releaseId,
            role: 'media',
          };
          const proof = await readRestoredMediaActivationAccess(args);
          assert.equal(proof.pool.uid, result.restore.pool.uid);
          assert.equal(proof.pool.etag, result.restore.pool.etag);
          if (
            ['restored-activation', 'restored-resources', 'restored-phase-resources'].includes(mode) ||
            mode.startsWith('restored-startup')
          ) {
            const controlled = restoredActivationFixture();
            const origin = {
              ...controlled.origin,
              operationId: newId,
              recoveryOperationId: base.operationId,
              bindingDigest: newBinding,
              releaseId: config.releaseId,
              buildId: result.plan.buildId,
              image: result.plan.image,
              pool: proof.pool,
              capsuleSHA256: proof.capsuleSHA256,
              proofSHA256: hash(proof),
              observedAt: new Date().toISOString(),
            };
            controlled.replaceOrigin(origin);
            Object.assign(controlled.options, {
              operationId: newId,
              recoveryOperationId: base.operationId,
              bindingDigest: newBinding,
              releaseId: config.releaseId,
              evidenceDigest: result.plan.evidenceDigest,
              receipts: { ...f.options.receipts, recovery: (await immutableReceipt.get()).data() },
            });

            if (mode.startsWith('restored-startup')) {
              const service = require('ts-node').register({
                skipProject: true,
                transpileOnly: true,
                compilerOptions: {
                  module: 'CommonJS',
                  target: 'ES2022',
                  esModuleInterop: true,
                  moduleResolution: 'node',
                },
              });
              idleRuntime.compiler = service;
              const { fileURLToPath } = await import('node:url');
              const source = (p) =>
                require(fileURLToPath(new URL('../../apps/temporal-worker/src/runtime/' + p, import.meta.url)));
              const startup = source('restored-media-startup.ts'),
                kernelModule = source('media-kernel-supervisor.ts');
              const { MEDIA_ALLOCATION_PROGRAM_SHA256 } = source('media-capacity-allocation.ts');
              const { workerReadinessDigest: digest } = source('readiness-probe.ts');
              const auth = getAuth(app);
              idleActor = await auth.createUser({ email: base.operatorPrincipal.email });
              await auth.setCustomUserClaims(idleActor.uid, { role: 'admin' });
              const register = controlled.options.runtime.registration;
              controlled.options.runtime.registration = async (scope) => {
                const p = scope.plan;
                const parent = {
                  instanceId: randomUUID(),
                  buildId: p.buildId,
                  cloudRun: {
                    projectId: 'urm-app-staging',
                    region: 'us-central1',
                    pool: p.origin.pool.name.split('/').at(-1),
                    revision: p.origin.pool.revision.split('/').at(-1),
                    revisionUid: p.origin.pool.revisionUid,
                    serviceAccount: `tw-m-${p.buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com`,
                    imageDigest: p.image.split('@')[1],
                    instanceId: 'controlled-cloud-instance',
                  },
                };
                const cap = await startup.restoredMediaKernelContext(db, () => auth, parent);
                idleRuntime.restored = { startup, parent, auth };
                if (mode === 'restored-startup-phase-failure') {
                  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
                  const { join } = await import('node:path'),
                    { tmpdir } = await import('node:os');
                  const dir = await mkdtemp(join(tmpdir(), 'urm-restored-failed-'));
                  const childWitness = { ...parent, instanceId: randomUUID() },
                    entry = join(dir, 'failed-child.cjs');
                  const kernelRef = db.doc(`_control/temporalRestoredMediaKernel-${newId}`),
                    capacityRef = db.doc(`temporalRestoredMediaStartupCapacity/${newId}`);
                  idlePrivate.push(kernelRef, capacityRef);
                  await writeFile(
                    entry,
                    `require(${JSON.stringify(
                      require.resolve('ts-node')
                    )}).register({skipProject:true,transpileOnly:true,compilerOptions:{module:'CommonJS',target:'ES2022',esModuleInterop:true,moduleResolution:'node'}});const k=require(${JSON.stringify(
                      fileURLToPath(
                        new URL('../../apps/temporal-worker/src/runtime/media-kernel-supervisor.ts', import.meta.url)
                      )
                    )});(async()=>{await k.awaitMediaKernelLaunch();await k.reportMediaKernelWitness(${JSON.stringify(
                      childWitness
                    )});process.exitCode=1;process.disconnect();})().catch(()=>process.exit(2));`
                  );
                  try {
                    const close = await bounded(
                      kernelModule.superviseRestoredMediaKernel(db, cap, entry),
                      15000,
                      'actual failed child close'
                    );
                    assert.equal(close.code, 1);
                  } finally {
                    await rm(dir, { recursive: true, force: true });
                  }
                  const closed = (await kernelRef.get()).data();
                  assert.equal(closed.stage, 'closed');
                  assert.equal(closed.close.descendantsAbsent, true);
                  assert.throws(
                    () => process.kill(closed.birth.pid, 0),
                    (e) => e.code === 'ESRCH'
                  );
                  assert.equal((await capacityRef.get()).exists, false);
                  const collect = source('restored-media-collector.ts').collectRestoredMediaPhaseStartup;
                  const client = restoredMediaProtectionFixture().options.client;
                  const guard = async (phaseScope) => {
                    const resources = idleRuntime.restoredResources();
                    const resource = await observeRestoredMediaPhasePool({ ...resources, ...phaseScope });
                    const args = {
                      db,
                      auth,
                      operationId: newId,
                      bindingDigest: newBinding,
                      plan: phaseScope.plan,
                      pool: resource.pool,
                      expectedRootSHA256: resources.ownedOperation.dataDigest,
                      expectedControlSHA256: expectedAuthority.control.dataDigest,
                      expectedStateSHA256: expectedAuthority.state.dataDigest,
                      image: {
                        pythonSHA256: 'a'.repeat(64),
                        ffmpegSHA256: 'a'.repeat(64),
                        ffprobeSHA256: 'b'.repeat(64),
                      },
                    };
                    const phase = await collect(args);
                    assert.equal(phase.stage, 'closed');
                    assert.equal(phase.allowedPollerIdentity, null);
                    return observeRestoredMediaPhaseProtection({
                      ...resources,
                      ...phaseScope,
                      client,
                      phasePool: resource,
                      originalPlan: result.plan,
                      originalAuth: {},
                      readStartup: () => collect(args),
                    });
                  };
                  controlled.options.runtime.unused = async (scope) => {
                    await guard({ ...scope, key: 'stop', transition: scope.state.stop ?? null });
                    idleRuntime.restoredUnusedPassed = true;
                  };
                  const nativePhase = controlled.options.runtime.phase;
                  controlled.options.runtime.phase = async (scope) => {
                    if (scope.key === 'stop' || scope.key === 'stopped') await guard(scope);
                    return nativePhase(scope);
                  };
                  throw Error('CONTROLLED_PRE_CAPACITY_FAILURE');
                }

                assert.equal(cap.context.protocol, 'restored-normal-media-kernel-v1');
                assert.equal(cap.context.recoveryOperationId, base.operationId);
                const witness = { ...parent, instanceId: randomUUID() };
                const record = {
                  schemaVersion: 1,
                  stage: 'running',
                  context: cap.context,
                  intent: {
                    createdAt: new Date().toISOString(),
                    launchId: randomUUID(),
                    parentPid: process.pid + 100000,
                  },
                  birth: { nonce: randomUUID(), pid: process.pid, spawnedAt: new Date().toISOString() },
                  worker: witness,
                };
                const link = {
                  operationId: newId,
                  birthDigest: digest({
                    context: record.context,
                    intent: record.intent,
                    birth: record.birth,
                    worker: record.worker,
                  }),
                };
                const kernelRef = db.doc(`_control/temporalRestoredMediaKernel-${newId}`),
                  capacityRef = db.doc(`temporalRestoredMediaStartupCapacity/${newId}`);
                idlePrivate.push(kernelRef, capacityRef);

                if (mode === 'restored-startup-phase') {
                  const collect = source('restored-media-collector.ts').collectRestoredMediaPhaseStartup;
                  const snapshot = await lockRef.get();
                  const args = {
                    db,
                    auth,
                    operationId: newId,
                    bindingDigest: newBinding,
                    plan: p,
                    pool: scope.pool,
                    expectedRootSHA256: nativeSnapshotProof(snapshot).dataDigest,
                    expectedControlSHA256: expectedAuthority.control.dataDigest,
                    expectedStateSHA256: expectedAuthority.state.dataDigest,
                    image: {
                      pythonSHA256: 'a'.repeat(64),
                      ffmpegSHA256: 'a'.repeat(64),
                      ffprobeSHA256: 'b'.repeat(64),
                    },
                  };
                  const before = await collect(args);
                  assert.equal(before.stage, 'absent');
                  assert.equal(before.allowedPollerIdentity, null);
                  const { birth, worker, ...armed } = record;
                  await kernelRef.create({ ...armed, stage: 'armed' });
                  assert.equal((await collect(args)).stage, 'armed');
                  await kernelRef.set({ ...armed, birth, stage: 'born' });
                  assert.equal((await collect(args)).stage, 'born');
                  await kernelRef.set(record);
                  const pending = await collect(args);
                  assert.equal(pending.stage, 'running');
                  assert.equal(pending.allowedPollerIdentity, null);
                  idleRuntime.phaseStartup = { collect, args };
                } else await kernelRef.create(record);
                let calls = 0;
                const canary = async (_drain, _filesystem, _processing, authorize) => {
                  calls++;
                  await authorize();
                  const now = new Date().toISOString();
                  return {
                    schemaVersion: 3,
                    budgets: {
                      sourceBytes: 20 * 1024 ** 3,
                      outputBytes: 20 * 1024 ** 3,
                      workspaceBytes: 64 * 1024 ** 3,
                      headroomBytes: 16 * 1024 ** 3,
                    },
                    totalBytes: 100 * 1024 ** 3,
                    availableBytes: 90 * 1024 ** 3,
                    canaryBytes: 1024 * 1024,
                    writeReadFsync: true,
                    cleanupConfirmed: true,
                    reservationReleased: true,
                    observedAt: now,
                    allocation: {
                      schemaVersion: 1,
                      requestedBytes: 64 * 1024 ** 3,
                      allocatedBytes: 64 * 1024 ** 3,
                      pythonSHA256: 'a'.repeat(64),
                      programSHA256: MEDIA_ALLOCATION_PROGRAM_SHA256,
                      filesystemDevice: 2,
                      fileInode: 123,
                      availableBytesAfterAllocation: 32 * 1024 ** 3,
                      minimumAvailableBytesWhileHeld: 32 * 1024 ** 3,
                      startedAt: now,
                      releasedAt: now,
                      cleanupConfirmed: true,
                    },
                    processing: {
                      schemaVersion: 1,
                      ffmpegSHA256: 'a'.repeat(64),
                      ffprobeSHA256: 'b'.repeat(64),
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
                };
                let draining = false,
                  writeAttempts = 0;
                const input = {
                  firestore: db,
                  auth: () => auth,
                  buildId: p.buildId,
                  witness,
                  kernel: link,
                  canary,
                  isDraining: () => draining,
                };
                const nativeTx = db.runTransaction.bind(db);
                db.runTransaction = async (fn, opts) => {
                  const value = await nativeTx(fn, opts);
                  if (opts?.maxAttempts === 1) {
                    writeAttempts++;
                    if (mode === 'restored-startup-drain') {
                      draining = true;
                    } else {
                      const error = new Error('CONTROLLED_CAPACITY_COMMITTED_ACK_LOST');
                      error.code = 14;
                      throw error;
                    }
                  }
                  return value;
                };
                try {
                  if (mode === 'restored-startup-drain')
                    await assert.rejects(
                      startup.recordRestoredMediaStartupCapacity(input),
                      /RESTORED_MEDIA_STARTUP_UNCONFIRMED/
                    );
                  else assert.equal(await startup.recordRestoredMediaStartupCapacity(input), true);
                } finally {
                  db.runTransaction = nativeTx;
                }
                assert.equal(writeAttempts, 1);
                assert.equal((await capacityRef.get()).get('kind'), 'restored-normal-media-startup-capacity-v1');
                assert.equal((await db.doc(`temporalMediaStartupCapacity/${newId}`).get()).exists, false);
                assert.equal((await db.doc(`_control/temporalMediaKernel-${newId}`).get()).exists, false);
                assert.equal((await db.doc(`_control/temporalMediaRecoveryKernel-${newId}`).get()).exists, false);
                await auth.updateUser(idleActor.uid, { disabled: true });
                await assert.rejects(startup.restoredMediaKernelContext(db, () => auth, parent));
                await auth.updateUser(idleActor.uid, { disabled: false });
                await assert.rejects(
                  startup.restoredMediaKernelContext(db, () => auth, {
                    ...parent,
                    cloudRun: { ...parent.cloudRun, revisionUid: 'foreign' },
                  })
                );
                assert.equal(calls, 1);
                if (mode === 'restored-startup-phase') {
                  const { collect, args } = idleRuntime.phaseStartup;
                  const positive = await collect(args);
                  assert.equal(positive.allowedPollerIdentity, `media-restored-${witness.instanceId}`);
                  await assert.rejects(collect({ ...args, image: { ...args.image, ffmpegSHA256: 'f'.repeat(64) } }));
                  await auth.updateUser(idleActor.uid, { disabled: true });
                  await assert.rejects(collect(args));
                  await auth.updateUser(idleActor.uid, { disabled: false });
                }

                if (mode.startsWith('restored-startup-readback')) {
                  const { collectRestoredMediaStartup, collectRestoredMediaPhaseStartup } =
                    source('restored-media-collector.ts');
                  const readOptions = () => ({
                    db,
                    auth,
                    operationId: newId,
                    bindingDigest: newBinding,
                    plan: p,
                    pool: scope.pool,
                    expectedRootSHA256: nativeSnapshotProofFromCurrent().dataDigest,
                    expectedControlSHA256: expectedAuthority.control.dataDigest,
                    expectedStateSHA256: expectedAuthority.state.dataDigest,
                    image: {
                      pythonSHA256: 'a'.repeat(64),
                      ffmpegSHA256: 'a'.repeat(64),
                      ffprobeSHA256: 'b'.repeat(64),
                    },
                  });
                  const snapshot = await lockRef.get();
                  function nativeSnapshotProofFromCurrent() {
                    return nativeSnapshotProof(snapshot);
                  }
                  const positive = await collectRestoredMediaStartup(readOptions());
                  assert.equal(positive.identity, `media-restored-${witness.instanceId}`);
                  assert.equal(positive.scope, 'historical-startup-only-no-polling-or-registration-authority');
                  await assert.rejects(
                    collectRestoredMediaStartup({
                      ...readOptions(),
                      image: { ...readOptions().image, ffprobeSHA256: 'f'.repeat(64) },
                    })
                  );
                  await assert.rejects(
                    collectRestoredMediaStartup({ ...readOptions(), pool: { ...scope.pool, revisionUid: 'foreign' } })
                  );
                  await auth.setCustomUserClaims(idleActor.uid, { role: 'uploader' });
                  await assert.rejects(collectRestoredMediaStartup(readOptions()));
                  await auth.setCustomUserClaims(idleActor.uid, { role: 'admin' });
                  assert.equal((await collectRestoredMediaStartup(readOptions())).proofSHA256, positive.proofSHA256);
                  idleRuntime.restoredReadback = {
                    collect: collectRestoredMediaStartup,
                    phaseCollect: collectRestoredMediaPhaseStartup,
                    readOptions,
                    auth,
                    capacityRef,
                  };
                }

                // GET-only source birth reader cannot adopt a different action's path.
                await assert.rejects(
                  kernelModule.readMediaKernelBirth(db, newId, cap.context.intentSHA256, link, witness)
                );
                return register(scope);
              };
            }
            let currentOwned = args.ownedOperation;
            const ownReceipt = db.doc(`_control/temporalCloudRestoredMediaActivation-${newId}`);
            idlePrivate.push(ownReceipt);

            if (['restored-resources', 'restored-phase-resources', 'restored-startup-phase-failure'].includes(mode)) {
              const prefixes = {
                runner: 'temporalCloudIdentityPreparation',
                scaler: 'temporalCloudIdentityPreparation',
                pool: 'temporalCloudPoolPreparation',
                runnerScaler: 'temporalCloudScalerAccessPreparation',
                scalerTrust: 'temporalCloudScalerAccessPreparation',
                poolAccess: 'temporalCloudScalerAccessPreparation',
                firestore: 'temporalCloudFirestoreAccessPreparation',
                projectRole: 'temporalCloudRuntimeRolePreparation',
                projectAccess: 'temporalCloudRuntimeAccessPreparation',
                storageRole: 'temporalCloudRuntimeRolePreparation',
                storageAccess: 'temporalCloudRuntimeAccessPreparation',
                bootstrapCycle: 'temporalCloudMediaBootstrapCycle',
              };
              for (const [key, prefix] of Object.entries(prefixes)) {
                const ref = db.doc(`_control/${prefix}-${f.options.receipts[key].operationId}`);
                await ref.create(f.options.receipts[key]);
                idlePrivate.push(ref);
              }
              idleRuntime.restoredResourcePatches = 0;
              controlled.options.api = (...v) => {
                if (v[1] === 'PATCH') idleRuntime.restoredResourcePatches++;
                return f.options.api(...v);
              };
              const resources = () => ({
                ...args,
                receipts: controlled.options.receipts,
                ownedOperation: currentOwned,
                observeProtection: undefined,
              });
              idleRuntime.restoredResources = resources;
              if (mode === 'restored-phase-resources') {
                const controlledPhase = controlled.options.runtime.phase;
                idleRuntime.restoredPhaseSamples = [];
                controlled.options.runtime.phase = async (scope) => {
                  const proof = await observeRestoredMediaPhasePool({ ...resources(), ...scope });
                  idleRuntime.restoredPhaseSamples.push({
                    key: scope.key,
                    position: proof.position,
                    stage: proof.expectation.stage,
                  });
                  assert.equal(proof.scope, 'resource-only-no-namespace-or-mutation-authority');
                  if (scope.key === 'start' && scope.transition?.stage === 'attempted') {
                    let operationReads = 0;
                    await assert.rejects(
                      observeRestoredMediaPhasePool({
                        ...resources(),
                        ...scope,
                        api: async (...v) => {
                          if (v[0].includes('/operations/')) operationReads++;
                          const value = await resources().api(...v);
                          if (v[0] === `https://run.googleapis.com/v2/${scope.plan.origin.pool.name}`)
                            return {
                              ...value,
                              generation: String(BigInt(value.generation) + 1n),
                              observedGeneration: String(BigInt(value.generation) + 1n),
                              etag: 'CONTROLLED_UNKNOWN_SUCCESSOR',
                              scaling: { manualInstanceCount: 1 },
                            };
                          return value;
                        },
                      })
                    );
                    assert.equal(operationReads, 0);
                  }
                  if (scope.key === 'start' && scope.transition?.stage === 'acknowledged') {
                    const api = resources().api,
                      before = scope.transition.before;
                    const pending = async (...v) => {
                      const value = await api(...v);
                      if (v[0].includes('/operations/')) return { name: scope.transition.nativeOperation, done: false };
                      if (v[0] === `https://run.googleapis.com/v2/${before.name}`)
                        return {
                          ...value,
                          generation: before.generation,
                          observedGeneration: before.generation,
                          etag: before.etag,
                          scaling: { manualInstanceCount: 0 },
                        };
                      return value;
                    };
                    assert.equal(
                      (await observeRestoredMediaPhasePool({ ...resources(), ...scope, api: pending })).position,
                      'before'
                    );
                    await assert.rejects(
                      observeRestoredMediaPhasePool({
                        ...resources(),
                        ...scope,
                        api: async (...v) => (v[0].includes('/operations/') ? api(...v) : pending(...v)),
                      })
                    );
                    await assert.rejects(
                      observeRestoredMediaPhasePool({
                        ...resources(),
                        ...scope,
                        api: async (...v) => (v[0].includes('/operations/') ? pending(...v) : api(...v)),
                      })
                    );
                  }

                  return controlledPhase(scope); // Explicitly CONTROLLED namespace fixture; not production permission.
                };
              }

              controlled.options.runtime.readPool = (scope) =>
                readRestoredMediaActivationPool({ ...resources(), ...scope });
              controlled.options.runtime.quota = (scope) =>
                readRestoredMediaActivationQuota({ ...resources(), ...scope });
            }
            let completionAckLost = false;
            controlled.options.save = async (identityState) => {
              if (['restored-resources', 'restored-phase-resources', 'restored-startup-phase-failure'].includes(mode))
                await fixtureSave(identityState);
              currentOwned = await saveRestoredMediaActivationCheckpoint({
                ...args,
                config,
                operatorPrincipal: { email: base.operatorPrincipal.email, adcAndGcloudAccountMatch: true },
                ownedOperation: currentOwned,
                immutableReceipt: ownReceipt,
                identityState,
              });
              if (identityState.disposition === 'retained' && !completionAckLost) {
                completionAckLost = true;
                throw new Error('CONTROLLED_RETAINED_ACK_LOST');
              }
            };

            if (mode === 'restored-startup-phase-failure') {
              await assert.rejects(
                activateRestoredCloudRunMedia(controlled.options),
                /RESTORED_MEDIA_ACTIVATION_UNCONFIRMED/
              );
              const stopped = (await lockRef.get()).get('cloudRestoredMediaActivation');
              assert.equal(stopped.disposition, 'stopped');
              assert.equal(idleRuntime.restoredUnusedPassed, true);
              assert.equal(idleRuntime.restoredResourcePatches, 2);
              controlled.options.saved = stopped;
              assert.equal((await activateRestoredCloudRunMedia(controlled.options)).disposition, 'stopped');
              assert.equal(idleRuntime.restoredResourcePatches, 2);
              return;
            }
            await assert.rejects(activateRestoredCloudRunMedia(controlled.options), /CONTROLLED_RETAINED_ACK_LOST/);
            const retained = (await lockRef.get()).get('cloudRestoredMediaActivation');
            assert.equal(retained.disposition, 'retained');
            assert.equal(
              ['restored-resources', 'restored-phase-resources', 'restored-startup-phase-failure'].includes(mode)
                ? idleRuntime.restoredResourcePatches
                : controlled.patches,
              1
            );
            assert.equal((await ownReceipt.get()).get('identityState.disposition'), 'retained');
            const frozen = (await ownReceipt.get()).data();
            controlled.options.saved = retained;
            await activateRestoredCloudRunMedia(controlled.options);
            assert.equal(
              ['restored-resources', 'restored-phase-resources', 'restored-startup-phase-failure'].includes(mode)
                ? idleRuntime.restoredResourcePatches
                : controlled.patches,
              1
            );
            assert.equal(hash((await ownReceipt.get()).data()), hash(frozen));
            const bad = structuredClone(retained);
            bad.start.attemptedAt = new Date(Date.parse(bad.start.attemptedAt) + 1).toISOString();
            await assert.rejects(
              saveRestoredMediaActivationCheckpoint({
                ...args,
                config,
                operatorPrincipal: frozen.operatorPrincipal,
                ownedOperation: currentOwned,
                immutableReceipt: ownReceipt,
                identityState: bad,
              })
            );

            if (mode === 'restored-phase-resources') {
              assert.ok(idleRuntime.restoredPhaseSamples.some((p) => p.key === 'start' && p.position === 'before'));
              assert.ok(idleRuntime.restoredPhaseSamples.some((p) => p.key === 'start' && p.position === 'successor'));
              assert.ok(idleRuntime.restoredPhaseSamples.some((p) => p.key === 'retained' && p.position === 'exact'));
              const scope = {
                ...idleRuntime.restoredResources(),
                plan: retained.plan,
                state: retained,
                key: 'retained',
                transition: retained.start,
              };
              const api = scope.api;
              for (const field of ['etag', 'uid'])
                await assert.rejects(
                  observeRestoredMediaPhasePool({
                    ...scope,
                    api: async (...v) => {
                      const value = await api(...v);
                      return v[0] === `https://run.googleapis.com/v2/${retained.plan.origin.pool.name}`
                        ? { ...value, [field]: 'foreign' }
                        : value;
                    },
                  })
                );
              await assert.rejects(
                observeRestoredMediaPhasePool({
                  ...scope,
                  transition: { ...retained.start, attemptedAt: new Date().toISOString() },
                })
              );
              let calls = 0;
              await assert.rejects(
                observeRestoredMediaPhasePool({
                  ...scope,
                  api: async (...v) => {
                    const value = await api(...v);
                    if (++calls === 1) await new Promise((resolve) => setTimeout(resolve, 5100));
                    return value;
                  },
                })
              );
              const tx = db.runTransaction.bind(db);
              let nativeReads = 0;
              const delayed = new Proxy(db, {
                get(target, key) {
                  if (key === 'runTransaction')
                    return async (...v) => {
                      const value = await tx(...v);
                      if (++nativeReads === 9) await new Promise((resolve) => setTimeout(resolve, 5100));
                      return value;
                    };
                  const value = Reflect.get(target, key, target);
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              });
              await assert.rejects(observeRestoredMediaPhasePool({ ...scope, firestore: delayed }));
              assert.equal(nativeReads, 9);
              await new Promise((resolve) => setTimeout(resolve, 200));
            }

            if (mode === 'restored-startup-phase') {
              const { collect, args } = idleRuntime.phaseStartup;
              const current = { ...args, expectedRootSHA256: nativeSnapshotProof(await lockRef.get()).dataDigest };
              const auth = idleRuntime.restored.auth;
              await assert.rejects(
                collect({ ...current, auth: { app: auth.app, getUserByEmail: () => new Promise(() => {}) } })
              );
            }

            if (mode === 'restored-startup') {
              const { startup, parent, auth } = idleRuntime.restored;
              await assert.rejects(
                startup.restoredMediaKernelContext(
                  db,
                  () => ({
                    getUserByEmail: async (email) => {
                      await auth.getUserByEmail(email);
                      return new Promise(() => {});
                    },
                  }),
                  parent
                ),
                /RESTORED_MEDIA_STARTUP_UNCONFIRMED/
              );
              await assert.rejects(
                startup.restoredMediaKernelContext(
                  db,
                  () => ({
                    getUserByEmail: async (email) => {
                      const actor = await auth.getUserByEmail(email);
                      await new Promise((resolve) => setTimeout(resolve, 5100));
                      return actor;
                    },
                  }),
                  parent
                ),
                /RESTORED_MEDIA_STARTUP_UNCONFIRMED/
              );
              await new Promise((resolve) => setTimeout(resolve, 200));
            }

            if (mode === 'restored-resources') {
              const resources = idleRuntime.restoredResources();
              assert.equal(
                (await readRestoredMediaActivationPool({ ...resources, plan: retained.plan, count: 1 })).uid,
                retained.start.pool.uid
              );
              await assert.rejects(readRestoredMediaActivationPool({ ...resources, plan: retained.plan, count: 0 }));
              await assert.rejects(
                readRestoredMediaActivationPool({
                  ...resources,
                  plan: retained.plan,
                  count: 1,
                  nativeResponse: { foreign: true },
                })
              );
              const api = resources.api;
              await assert.rejects(
                readRestoredMediaActivationPool({
                  ...resources,
                  plan: retained.plan,
                  count: 1,
                  api: async (...v) => {
                    const value = await api(...v);
                    return v[0] === `https://run.googleapis.com/v2/${retained.plan.origin.pool.revision}`
                      ? { ...value, uid: 'foreign-revision' }
                      : value;
                  },
                })
              );
              const nativeTx = db.runTransaction.bind(db);
              let reads = 0;
              const delayed = new Proxy(db, {
                get(target, key) {
                  if (key === 'runTransaction')
                    return async (...v) => {
                      const result = await nativeTx(...v);
                      reads++;
                      if (reads === 4) await new Promise((resolve) => setTimeout(resolve, 5100));
                      return result;
                    };
                  const value = Reflect.get(target, key, target);
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              });
              await assert.rejects(
                readRestoredMediaActivationPool({ ...resources, firestore: delayed, plan: retained.plan, count: 1 })
              );
              assert.equal(reads, 4);
              await new Promise((resolve) => setTimeout(resolve, 200));
            }

            if (mode.startsWith('restored-startup-readback')) {
              const r = idleRuntime.restoredReadback,
                op = r.readOptions();
              op.expectedRootSHA256 = currentOwned.dataDigest;
              if (mode === 'restored-startup-readback-expired') {
                const attempted = Date.parse(
                  (await lockRef.get()).get('cloudRestoredMediaActivation.start.attemptedAt')
                );
                const remaining = Math.max(0, attempted + 120050 - Date.now());
                await new Promise((resolve) => setTimeout(resolve, remaining));
                const live = idleRuntime.restored;
                await assert.rejects(live.startup.restoredMediaKernelContext(db, () => live.auth, live.parent));
              }
              assert.equal((await r.collect(op)).operationId, newId);
              const historicalPhase = await r.phaseCollect(op);
              assert.equal(historicalPhase.stage, 'running');
              assert.ok(historicalPhase.allowedPollerIdentity);
              await assert.rejects(
                r.collect({
                  ...op,
                  auth: {
                    app: r.auth.app,
                    getUserByEmail: async (email) => {
                      await r.auth.getUserByEmail(email);
                      return new Promise(() => {});
                    },
                  },
                })
              );
              const receipt = await r.capacityRef.get();
              await r.capacityRef.update({ digest: '0'.repeat(64) });
              await r.capacityRef.update({ digest: receipt.get('digest') });
              await assert.rejects(r.collect(op));
            }
            args.ownedOperation = currentOwned;
          }

          await assert.rejects(readRestoredMediaActivationAccess({ ...args, recoveryOperationId: newId }));
          await assert.rejects(readRestoredMediaActivationAccess({ ...args, bindingDigest: base.bindingDigest }));
          const api = args.api;
          let late = false;
          const changed = {
            ...args,
            api: async (...v) => {
              const value = await api(...v);
              if (v[0] === `https://run.googleapis.com/v2/${result.plan.name}`) {
                late = true;
                return { ...value, etag: 'foreign-etag' };
              }
              return value;
            },
          };
          await assert.rejects(readRestoredMediaActivationAccess(changed));
          assert(late);
          const foreign = structuredClone(controlledCapsuleOperatorIdentity);
          foreign.runtimeCommit = '0'.repeat(40);
          await lockRef.update({ operatorIdentity: foreign });
          await assert.rejects(
            readRestoredMediaActivationAccess({ ...args, ownedOperation: nativeSnapshotProof(await lockRef.get()) })
          );
        }
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
        if (mode === 'activation-access') {
          const newId = randomUUID(),
            newBinding = 'e'.repeat(64);
          await lockRef.set({
            action: 'activate-restored-cloud-run-media',
            operationId: newId,
            releaseId: config.releaseId,
            bindingDigest: newBinding,
            operatorPrincipal: { email: base.operatorPrincipal.email, adcAndGcloudAccountMatch: true },
            operatorIdentity: controlledCapsuleOperatorIdentity,
          });
          const args = {
            ...f.options,
            ...options(),
            operationId: newId,
            bindingDigest: newBinding,
            recoveryOperationId: base.operationId,
            ownedOperation: nativeSnapshotProof(await lockRef.get()),
            releaseId: config.releaseId,
            role: 'media',
          };
          const proof = await readRestoredMediaActivationAccess(args);
          assert.equal(proof.pool.uid, result.restore.pool.uid);
          assert.equal(proof.pool.etag, result.restore.pool.etag);
          await assert.rejects(readRestoredMediaActivationAccess({ ...args, recoveryOperationId: newId }));
          await assert.rejects(readRestoredMediaActivationAccess({ ...args, bindingDigest: base.bindingDigest }));
          const api = args.api;
          let late = false;
          const changed = {
            ...args,
            api: async (...v) => {
              const value = await api(...v);
              if (v[0] === `https://run.googleapis.com/v2/${result.plan.name}`) {
                late = true;
                return { ...value, etag: 'foreign-etag' };
              }
              return value;
            },
          };
          await assert.rejects(readRestoredMediaActivationAccess(changed));
          assert(late);
          const foreign = structuredClone(controlledCapsuleOperatorIdentity);
          foreign.runtimeCommit = '0'.repeat(40);
          await lockRef.update({ operatorIdentity: foreign });
          await assert.rejects(
            readRestoredMediaActivationAccess({ ...args, ownedOperation: nativeSnapshotProof(await lockRef.get()) })
          );
        }
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
      if (idleRuntime.compiler) {
        idleRuntime.compiler.enabled(false);
        if (process[Symbol.for('ts-node.register.instance')] === idleRuntime.compiler)
          delete process[Symbol.for('ts-node.register.instance')];
      }
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
      {
        if (idleActor) await getAuth(app).deleteUser(idleActor.uid);
        for (const ref of idlePrivate) await ref.delete();
      }

      const failures = [];
      for (const cleanup of [
        ...[
          db.doc(`_control/temporalMediaRecoveryJournal-${f.options.operationId}`),
          db.doc(`_control/temporalMediaRecoveryDrain-${f.options.operationId}`),
          db.doc(`_control/temporalMediaRecoveryCapsule-${f.options.operationId}`),
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
