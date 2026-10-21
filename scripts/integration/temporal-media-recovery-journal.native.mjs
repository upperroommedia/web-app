/** Actual private Firestore ARMING journal; controlled Cloud-derived source plan.
 * No Workflow, Activity, worker, provider, image, Cloud Run or execution authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mediaRecoveryFixture } from '../tests/fixtures/media-recovery.mjs';
import { runMediaRecoveryCycle } from '../temporal-media-recovery-cycle.mjs';
import { prepareMediaRecoveryJournal, saveMediaRecoveryCheckpoint } from '../temporal-media-recovery-checkpoint.mjs';
import { nativeSnapshotProof } from '../temporal-release-runtime.mjs';
import { bounded } from './fixtures/owned-media-process.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const harness = require('./firebase.test.json');
if (process.env.FIRESTORE_EMULATOR_HOST !== `127.0.0.1:${harness.emulators.firestore.port}`)
  throw new Error('Dedicated emulator required');
for (const mode of [
  'normal',
  'missing-journal',
  'attempt-ack-loss',
  'create-ack-loss',
  'control-drift',
  'state-drift',
  'expired-after-attempt',
  'replacement',
  'attempt-timestamp-drift',
  'foreign-plan',
])
  test(`native media arming journal / ${mode}`, async () => {
    const fixture = await mediaRecoveryFixture();
    let plan;
    fixture.options.runtime.prepare = async (x) => {
      plan = x.plan;
      throw new Error('CONTROLLED_PLAN_CAPTURE');
    };
    await assert.rejects(runMediaRecoveryCycle(fixture.options), /CONTROLLED_PLAN_CAPTURE/);
    plan = structuredClone(plan);
    if (mode === 'expired-after-attempt') {
      plan.createdAt = new Date(Date.now() - 299500).toISOString();
      plan.expiresAt = Date.parse(plan.createdAt) + 300000;
    }
    const app = initializeApp({ projectId: 'urm-app-staging' }, `arming-${randomUUID()}`),
      db = getFirestore(app);
    const lockRef = db.doc('_control/temporalReleaseOperation'),
      controlRef = db.doc('_control/temporalRelease'),
      stateRef = db.doc('_control/temporalReleaseState'),
      journal = db.doc(`_control/temporalMediaRecoveryJournal-${plan.operationId}`);
    let writes = 0,
      creates = 0;
    const original = db.runTransaction.bind(db);
    const wrapped = {
      projectId: db.projectId,
      databaseId: db.databaseId,
      doc: db.doc.bind(db),
      runTransaction: async (fn, opts) => {
        const result = await original(async (tx) => {
          const proxy = new Proxy(tx, {
            get: (target, key) =>
              key === 'create'
                ? (...args) => {
                    creates++;
                    return target.create(...args);
                  }
                : typeof target[key] === 'function'
                ? target[key].bind(target)
                : target[key],
          });
          return fn(proxy);
        }, opts);
        if (!opts?.readOnly) {
          writes++;
          if (writes === 1) {
            if (mode === 'control-drift') await controlRef.update({ admission: 'open' });
            if (mode === 'state-drift') await stateRef.update({ phase: 'opened' });
            if (mode === 'expired-after-attempt') await new Promise((r) => setTimeout(r, 550));
          }
          if ((mode === 'attempt-ack-loss' && writes === 1) || (mode === 'create-ack-loss' && writes === 2))
            throw new Error('CONTROLLED_COMMIT_ACK_LOST');
        }
        return result;
      },
    };
    const getOptions = async () => ({
      firestore: wrapped,
      lockRef,
      controlRef,
      stateRef,
      plan,
      operationId: plan.operationId,
      bindingDigest: plan.bindingDigest,
      config: { releaseId: plan.releaseId },
      ownedOperation: nativeSnapshotProof(await bounded(lockRef.get())),
      expectedAuthority: {
        control: nativeSnapshotProof(await bounded(controlRef.get())),
        state: nativeSnapshotProof(await bounded(stateRef.get())),
      },
    });
    try {
      await bounded(
        lockRef.create({
          action: 'diagnose-cloud-run-media-recovery',
          operationId: plan.operationId,
          releaseId: plan.releaseId,
          bindingDigest: plan.bindingDigest,
          cloudMediaRecovery: { plan, stage: 'planned' },
        })
      );
      await bounded(
        controlRef.create({
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
      await bounded(stateRef.create({ releaseId: plan.releaseId, phase: 'provider-usage-ready' }));
      const options = await bounded(getOptions());
      if (mode === 'foreign-plan')
        options.plan = { ...plan, image: plan.image.slice(0, -1) + (plan.image.endsWith('9') ? '8' : '9') };
      if (mode === 'missing-journal') {
        await assert.rejects(
          bounded(
            saveMediaRecoveryCheckpoint({
              ...options,
              immutableReceipt: db.doc(`_control/temporalCloudMediaRecovery-${plan.operationId}`),
              operatorPrincipal: { email: 'controlled@example.test' },
              identityState: {
                plan,
                stage: 'prepared',
                prepared: {
                  operationId: plan.operationId,
                  bindingDigest: plan.bindingDigest,
                  buildId: plan.buildId,
                  image: plan.image,
                  kind: 'prepared',
                  proofSHA256: 'f'.repeat(64),
                },
              },
            })
          )
        );
        assert.equal((await bounded(lockRef.get())).get('cloudMediaRecovery.stage'), 'planned');
        return;
      }
      if (['normal', 'replacement', 'attempt-timestamp-drift'].includes(mode)) {
        const receipt = await bounded(prepareMediaRecoveryJournal(options));
        assert.equal(receipt.prepared.kind, 'prepared');
        assert.equal(creates, 1);
        assert.equal(writes, 2);
        assert.equal((await bounded(journal.get())).get('scope'), 'arming-only-no-execution-authority');
        const first = await bounded(journal.get());
        const again = await bounded(prepareMediaRecoveryJournal(await getOptions()));
        assert.deepEqual(again.prepared, receipt.prepared);
        assert.equal(creates, 1);
        assert.equal(writes, 2);
        assert.equal((await bounded(journal.get())).updateTime.isEqual(first.updateTime), true);
        if (mode === 'attempt-timestamp-drift') {
          const before = await bounded(lockRef.get());
          await bounded(
            lockRef.update({
              'mediaRecoveryJournalAttempt.attemptedAt': new Date(
                Date.parse(before.get('mediaRecoveryJournalAttempt.attemptedAt')) + 1
              ).toISOString(),
            })
          );
          await assert.rejects(bounded(prepareMediaRecoveryJournal(await getOptions())));
          assert.equal(creates, 1);
          assert.equal(writes, 2);
        }
        if (mode === 'replacement') {
          await bounded(journal.update({ scope: 'unauthorized' }));
          await assert.rejects(bounded(prepareMediaRecoveryJournal(await getOptions())));
          assert.equal(creates, 1);
          assert.equal(writes, 2);
        }
      } else {
        await assert.rejects(bounded(prepareMediaRecoveryJournal(options)));
        const writesBefore = writes,
          createsBefore = creates;
        if (mode === 'create-ack-loss') {
          assert.equal((await bounded(journal.get())).exists, true);
          await bounded(prepareMediaRecoveryJournal(await getOptions()));
        } else if (mode === 'foreign-plan') {
          assert.equal((await bounded(journal.get())).exists, false);
          assert.equal(writes, 0);
          assert.equal(creates, 0);
        } else {
          assert.equal((await bounded(journal.get())).exists, false);
          await assert.rejects(bounded(prepareMediaRecoveryJournal(await getOptions())));
        }
        assert.equal(writes, writesBefore);
        assert.equal(creates, createsBefore);
        if (mode === 'attempt-ack-loss') assert.equal(creates, 0);
      }
    } finally {
      const failures = [];
      for (const action of [
        () => journal.delete(),
        () => lockRef.delete(),
        () => controlRef.delete(),
        () => stateRef.delete(),
        () => db.terminate(),
        () => deleteApp(app),
      ])
        try {
          await bounded(action());
        } catch {
          failures.push(new Error('Owned arming journal cleanup failed'));
        }
      if (failures.length) throw new AggregateError(failures, 'Owned arming cleanup failed');
    }
  });
