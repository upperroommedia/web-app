/** Actual Firestore checkpoint/authority; CONTROLLED Cloud/runtime protocol. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mediaRecoveryFixture } from '../tests/fixtures/media-recovery.mjs';
import { readRestoredMediaRecoveryOrigin } from '../temporal-media-restored-origin.mjs';
import { runMediaRecoveryCycle } from '../temporal-media-recovery-cycle.mjs';
import {
  saveMediaRecoveryCheckpoint,
  assertMediaRecoveryAuthority,
  prepareMediaRecoveryJournal,
} from '../temporal-media-recovery-checkpoint.mjs';
import { nativeSnapshotProof } from '../temporal-release-runtime.mjs';
import { bounded } from './fixtures/owned-media-process.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app'),
  { getFirestore } = require('firebase-admin/firestore');
const harness = require('./firebase.test.json');
if (process.env.FIRESTORE_EMULATOR_HOST !== `127.0.0.1:${harness.emulators.firestore.port}`)
  throw new Error('Dedicated emulator required');
for (const mode of [
  'normal',
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
      drainCalls = 0;
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
        operatorPrincipal: { email: 'controlled@example.test' },
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
      const api = f.options.api;
      f.options.api = (...args) => {
        if (denyQuota && args[0].includes('cloudquotas')) throw new Error('CONTROLLED_QUOTA_UNAVAILABLE');
        return api(...args);
      };
      if (mode === 'normal') {
        const result = await bounded(runMediaRecoveryCycle(f.options));
        assert.equal((await bounded(immutableReceipt.get())).get('identityState.stage'), 'completed');
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
