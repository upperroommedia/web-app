import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { controlsBootstrapFixture } from '../tests/fixtures/controls-bootstrap.mjs';
import { bootstrapStopCloudRunMediaPool } from '../temporal-bootstrap-pool.mjs';
import { saveMediaBootstrapCycleCheckpoint } from '../temporal-preparation-checkpoint.mjs';
import { nativeSnapshotProof } from '../temporal-release-runtime.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const { MEDIA_ALLOCATION_PROGRAM_SHA256 } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/runtime/media-capacity-allocation.ts', import.meta.url)
));
const {
  mediaStartupIntent,
  recordMediaStartupCapacity,
  collectMediaStartupCapacity,
  mediaStartupBudget,
} = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/runtime/media-startup-capacity.ts', import.meta.url)
));
const { mediaKernelContext } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/runtime/media-kernel-supervisor.ts', import.meta.url)
));
const { workerReadinessDigest } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/runtime/readiness-probe.ts', import.meta.url)
));
const { initializeApp, deleteApp } = require('firebase-admin/app'),
  { getFirestore } = require('firebase-admin/firestore');
const harness = require(fileURLToPath(new URL('../../firebase.test.json', import.meta.url)));
if (process.env.FIRESTORE_EMULATOR_HOST !== `127.0.0.1:${harness.emulators.firestore.port}`)
  throw new Error('Dedicated emulator required');
for (const drift of [
  'none',
  'control',
  'state',
  'intent',
  'lost-ack',
  'delayed',
  'rejected',
  'old-receipt',
  'uncertain-child',
  'missing-allocation',
  'sparse-allocation',
  'low-allocation-headroom',
  'foreign-program',
  'old-audio-schema',
])
  test(`actual startup checkpoint/private receipt and native readback / ${drift}`, async () => {
    const f = controlsBootstrapFixture('media'),
      { operationId, releaseId, platform } = f.options,
      b = platform.roleBindings.find((b) => b.role === 'media');
    const app = initializeApp({ projectId: 'urm-app-staging' }, `capacity-${randomUUID()}`),
      db = getFirestore(app);
    const lockRef = db.doc('_control/temporalReleaseOperation'),
      controlRef = db.doc('_control/temporalRelease'),
      stateRef = db.doc('_control/temporalReleaseState');
    const immutableReceipt = db.doc(`_control/temporalCloudMediaBootstrapCycle-${operationId}`),
      creationReceipt = db.doc(`_control/temporalCloudMediaBootstrapActivation-${operationId}`),
      startup = db.doc(`temporalMediaStartupCapacity/${operationId}`),
      kernelRef = db.doc(`_control/temporalMediaKernel-${operationId}`);
    let kernel;
    let sourceCalls = 0,
      canaryCalls = 0;
    try {
      await controlRef.create({
        releaseId,
        admission: 'paused',
        domains: {
          media: { admission: 'paused' },
          images: { admission: 'paused' },
          accounts: { admission: 'paused' },
          bundles: { admission: 'paused' },
          publishing: { admission: 'paused' },
          emails: { admission: 'paused' },
          search: { admission: 'paused' },
        },
      });
      await stateRef.create({ releaseId, phase: 'provider-usage-ready' });
      await lockRef.create({
        operationId,
        releaseId,
        bindingDigest: 'e'.repeat(64),
        action: 'bootstrap-stop-cloud-run-media',
      });
      let ownedOperation = nativeSnapshotProof(await lockRef.get()),
        expectedAuthority = {
          control: nativeSnapshotProof(await controlRef.get()),
          state: nativeSnapshotProof(await stateRef.get()),
        };
      const save = async (identityState) => {
        try {
          ownedOperation = await saveMediaBootstrapCycleCheckpoint({
            firestore: db,
            lockRef,
            controlRef,
            stateRef,
            immutableReceipt,
            creationReceipt,
            ownedOperation,
            expectedAuthority,
            config: { releaseId, domains: ['publishing', 'emails', 'search'] },
            operationId,
            bindingDigest: 'e'.repeat(64),
            operatorPrincipal: { email: 'operator@example.test' },
            identityState,
          });
          await f.options.save(identityState);
        } catch {
          throw new Error('Owned checkpoint failed');
        }
      };
      const witness = {
        instanceId: randomUUID(),
        buildId: b.buildId,
        cloudRun: {
          projectId: b.projectId,
          region: b.region,
          pool: b.poolName,
          revision: 'original',
          revisionUid: 'revision-uid',
          imageDigest: b.image.split('@')[1],
          serviceAccount: b.runnerServiceAccount,
          instanceId: 'controlled-platform-instance',
        },
      };
      const canary = async (_draining, _processing, _allocation, assertAuthority) => {
        canaryCalls++;
        if (drift === 'control') await controlRef.update({ admission: 'open' });
        if (drift === 'state') await stateRef.update({ phase: 'changed' });
        if (drift === 'intent')
          await lockRef.update({
            'cloudMediaBootstrapCycle.start.attemptedAt': new Date(Date.now() - 1000).toISOString(),
          });
        await assertAuthority();
        const result = {
          schemaVersion: 3,
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
            startedAt: new Date().toISOString(),
            releasedAt: new Date().toISOString(),
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
          budgets: { ...mediaStartupBudget },
          totalBytes: 100 * 1024 ** 3,
          availableBytes: 90 * 1024 ** 3,
          canaryBytes: 1024 * 1024,
          writeReadFsync: true,
          cleanupConfirmed: true,
          reservationReleased: true,
          observedAt: new Date().toISOString(),
        };
        if (drift === 'old-receipt') {
          result.schemaVersion = 1;
          delete result.processing;
        }
        if (drift === 'missing-allocation') delete result.allocation;
        if (drift === 'sparse-allocation') result.allocation.allocatedBytes = 1024;
        if (drift === 'low-allocation-headroom') result.allocation.minimumAvailableBytesWhileHeld = 1024;
        if (drift === 'foreign-program') result.allocation.programSHA256 = 'f'.repeat(64);
        if (drift === 'old-audio-schema') result.schemaVersion = 2;
        if (drift === 'uncertain-child') result.processing.cancelledChildDrained = false;
        return result;
      };
      const registration = async () => {
        const owned = mediaStartupIntent((await lockRef.get()).data());
        const cap = await mediaKernelContext(db, { ...witness, instanceId: randomUUID() });
        assert(cap);
        await db.runTransaction(cap.authorize, { readOnly: true });
        cap.checkFresh();
        if (drift === 'none')
          await assert.rejects(
            mediaKernelContext(db, {
              ...witness,
              cloudRun: { ...witness.cloudRun, serviceAccount: 'foreign@example.test' },
            })
          );
        const body = {
          schemaVersion: 1,
          stage: 'running',
          context: cap.context,
          intent: { parentPid: process.pid + 1, launchId: randomUUID(), createdAt: new Date().toISOString() },
          birth: { pid: process.pid, nonce: randomUUID(), spawnedAt: new Date().toISOString() },
          worker: witness,
        };
        await kernelRef.create(body);
        kernel = {
          operationId,
          birthDigest: workerReadinessDigest({
            context: body.context,
            intent: body.intent,
            birth: body.birth,
            worker: body.worker,
          }),
        };
        const record = () => recordMediaStartupCapacity({ firestore: db, buildId: b.buildId, witness, canary, kernel });
        if (['lost-ack', 'rejected'].includes(drift)) {
          // Fault only the startup receipt transaction. The controller also
          // persists its own single-attempt checkpoints before and after startup.
          const nativeTransaction = db.runTransaction;
          db.runTransaction = async (fn, opts) => {
            if (opts?.maxAttempts !== 1) return nativeTransaction.call(db, fn, opts);
            sourceCalls++;
            if (drift === 'rejected') throw Object.assign(new Error('Controlled rejected receipt create'), { code: 7 });
            await nativeTransaction.call(db, fn, opts);
            throw new Error('Controlled lost commit acknowledgement');
          };
          try {
            await record();
          } finally {
            db.runTransaction = nativeTransaction;
          }
        } else if (drift !== 'delayed') await record();
        const parent = f.options.receipts.pool.identityState.plan.body.name;
        const readResource = async (name) =>
          name === parent
            ? {
                uid: 'native-pool',
                generation: '2',
                etag: 'pool-etag',
                scaling: { manualInstanceCount: 1 },
                latestReadyRevision: `${parent}/revisions/original`,
              }
            : { uid: 'revision-uid', generation: '1', etag: 'revision-etag' };
        const options = {
          firestore: db,
          binding: b,
          operationId,
          readResource,
          verifyPool: () => {},
          observePoller: async ({ identity, revision, revisionUid, observedAt }) => {
            const instanceHash = createHash('sha256').update(witness.cloudRun.instanceId).digest('hex');
            assert.equal(identity, `cloud-run-${instanceHash}-${witness.instanceId}`);
            assert.equal(revision, witness.cloudRun.revision);
            assert.equal(revisionUid, witness.cloudRun.revisionUid);
            assert.equal(observedAt, (await startup.get()).get('observedAt'));
          },
        };
        // Controlled Cloud metadata is deliberate; no native Cloud acceptance claim.

        let proof;
        if (drift === 'delayed') {
          const values = await Promise.allSettled([
            new Promise((resolve) => setTimeout(resolve, 250)).then(record),
            collectMediaStartupCapacity(options),
          ]);
          if (values.some((v) => v.status !== 'fulfilled')) throw new Error('Delayed original receipt failed');
          proof = values[1].value;
        } else proof = await collectMediaStartupCapacity(options);
        assert.match(proof.receiptSHA256, /^[a-f0-9]{64}$/);
        await assert.rejects(
          collectMediaStartupCapacity({
            ...options,
            readResource: async (n) => ({ ...(await readResource(n)), uid: 'replacement' }),
          }),
          /MEDIA_STARTUP_CAPACITY_UNCONFIRMED/
        );
        await collectMediaStartupCapacity(options);
        if (drift === 'none') {
          for (const changed of [
            { name: parent, fields: { scaling: { manualInstanceCount: 0 } } },
            { name: parent, fields: { generation: '3', etag: 'updated-pool-etag' } },
            { name: `${parent}/revisions/original`, fields: { uid: 'updated-revision' } },
          ]) {
            let pollerObserved = false;
            await assert.rejects(
              collectMediaStartupCapacity({
                ...options,
                observePoller: async () => {
                  pollerObserved = true;
                },
                readResource: async (name) => ({
                  ...(await readResource(name)),
                  ...(pollerObserved && name === changed.name ? changed.fields : {}),
                }),
              }),
              /MEDIA_STARTUP_CAPACITY_UNCONFIRMED/
            );
            assert.equal(pollerObserved, true);
          }
          for (const recreate of [false, true]) {
            await assert.rejects(
              collectMediaStartupCapacity({
                ...options,
                observePoller: async () => {
                  const evidence = (await startup.get()).data();
                  if (recreate) {
                    await startup.delete();
                    await startup.create(evidence);
                  } else {
                    // Force a new version even if Firestore optimizes same-value writes.
                    await startup.update({ digest: 'temporary-fixture-value' });
                    await startup.update({ digest: evidence.digest });
                  }
                  assert.deepEqual((await startup.get()).data(), evidence);
                },
              }),
              /MEDIA_STARTUP_CAPACITY_UNCONFIRMED/
            );
          }
        }
        return {
          role: 'media',
          buildId: b.buildId,
          registrationSHA256: 'c'.repeat(64),
          observedAt: new Date().toISOString(),
          mediaStartupCapacity: proof,
        };
      };
      if (['none', 'lost-ack', 'delayed'].includes(drift)) {
        const result = await bootstrapStopCloudRunMediaPool({ ...f.options, save, observeRegistration: registration });
        assert.equal(result.stage, 'completed');
        assert.equal(result.start.plan.target, 1);
        assert.equal(result.stop.plan.target, 0);
        assert.equal((await startup.get()).exists, true);
        assert.equal(canaryCalls, 1);
        const existing = (await startup.get()).data();
        await assert.rejects(
          recordMediaStartupCapacity({
            firestore: db,
            buildId: b.buildId,
            witness: { ...witness, instanceId: randomUUID() },
            canary,
            kernel,
          })
        );
        assert.deepEqual((await startup.get()).data(), existing);
      } else {
        await assert.rejects(bootstrapStopCloudRunMediaPool({ ...f.options, save, observeRegistration: registration }));
        assert.equal(canaryCalls, 1);
        assert.equal((await startup.get()).exists, false);
      }
      if (['lost-ack', 'rejected'].includes(drift)) {
        assert.equal(sourceCalls, 1);
        assert.deepEqual(
          f.calls.filter(({ method }) => method === 'PATCH').map(({ request }) => request.scaling.manualInstanceCount),
          [1, 0]
        );
      }
    } finally {
      const failures = [];
      for (const ref of [kernelRef, startup, immutableReceipt, creationReceipt, lockRef, controlRef, stateRef])
        try {
          await ref.delete();
        } catch {
          failures.push(new Error('Owned capacity fixture cleanup failed'));
        }
      try {
        await db.terminate();
      } catch {
        failures.push(new Error('Owned Firestore cleanup failed'));
      }
      try {
        await deleteApp(app);
      } catch {
        failures.push(new Error('Owned Firebase app cleanup failed'));
      }
      if (failures.length) throw new AggregateError(failures, 'Owned capacity fixture cleanup failed');
    }
  });

// A supervised child may never fall back to ordinary polling after parent loss.
test('kernel-linked startup rejects missing original parent before canary', async () => {
  const app = initializeApp({ projectId: 'urm-app-staging' }, `kernel-missing-${randomUUID()}`);
  const db = getFirestore(app);
  let calls = 0;
  try {
    const witness = { buildId: 'a'.repeat(40), instanceId: randomUUID(), cloudRun: null };
    const base = {
      firestore: db,
      buildId: witness.buildId,
      witness,
      canary: async () => {
        calls++;
      },
    };
    await assert.rejects(
      recordMediaStartupCapacity({ ...base, kernel: { operationId: randomUUID(), birthDigest: 'c'.repeat(64) } })
    );
    await recordMediaStartupCapacity(base);
    assert.equal(calls, 0);
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
});
