import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
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
const { recordMediaStartupCapacity, collectMediaStartupCapacity, mediaStartupBudget } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/runtime/media-startup-capacity.ts', import.meta.url)
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
      startup = db.doc(`temporalMediaStartupCapacity/${operationId}`);
    let sourceCalls = 0,
      canaryCalls = 0;
    try {
      await controlRef.create({
        releaseId,
        admission: 'paused',
        domains: {
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
      const nativeTransaction = db.runTransaction.bind(db);
      if (['lost-ack', 'rejected'].includes(drift))
        db.runTransaction = async (fn, opts) => {
          if (drift === 'rejected' && opts?.maxAttempts === 1) {
            sourceCalls++;
            throw Object.assign(new Error('Controlled rejected receipt create'), { code: 7 });
          }
          const value = await nativeTransaction(fn, opts);
          if (opts?.maxAttempts === 1) {
            sourceCalls++;
            throw new Error('Controlled lost commit acknowledgement');
          }
          return value;
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
        const record = () => recordMediaStartupCapacity({ firestore: db, buildId: b.buildId, witness, canary });
        if (drift !== 'delayed') await record();
        const parent = f.options.receipts.pool.identityState.plan.body.name;
        const readResource = async (name) =>
          name === parent
            ? {
                uid: 'native-pool',
                scaling: { manualInstanceCount: 1 },
                latestReadyRevision: `${parent}/revisions/original`,
              }
            : { uid: 'revision-uid' };
        const options = { firestore: db, binding: b, operationId, readResource, verifyPool: () => {} };
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
        if (drift === 'lost-ack') assert.equal(sourceCalls, 1);
        const existing = (await startup.get()).data();
        await assert.rejects(
          recordMediaStartupCapacity({
            firestore: db,
            buildId: b.buildId,
            witness: { ...witness, instanceId: randomUUID() },
            canary,
          })
        );
        assert.deepEqual((await startup.get()).data(), existing);
      } else {
        await assert.rejects(bootstrapStopCloudRunMediaPool({ ...f.options, save, observeRegistration: registration }));
        assert.equal(canaryCalls, 1);
        assert.equal((await startup.get()).exists, false);
      }
    } finally {
      const failures = [];
      for (const ref of [startup, immutableReceipt, creationReceipt, lockRef, controlRef, stateRef])
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
