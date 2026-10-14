import { beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import {
  countPendingLegacyUploadAdmissions,
  assertLegacyDrainInTransaction,
  countPendingSeriesMetadataContinuations,
  assertPendingLegacyUploadsDrainedInTransaction,
  compatibilityLegacyAdmissionCutoffUpdate,
} from '../temporal-release-lib.mjs';

import {
  compatibilityCutoffUpdates,
  assertCompatibilitySettlingCheckpoint,
  assertCompatibilityGraceElapsed,
} from '../temporal-compatibility-cutoff.mjs';

const testConfig = JSON.parse(await readFile(new URL('../../firebase.test.json', import.meta.url), 'utf8'));
const emulator = process.env.FIRESTORE_EMULATOR_HOST && new URL(`http://${process.env.FIRESTORE_EMULATOR_HOST}`);
if (
  !emulator ||
  !['localhost', '127.0.0.1', '[::1]'].includes(emulator.hostname) ||
  Number(emulator.port) !== testConfig.emulators.firestore.port
)
  throw new Error('Run only with the dedicated firebase.test.json test emulator');
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'urm-app' }, 'legacy-upload-drain-test');
const db = getFirestore(app),
  controlRef = db.doc('_control/temporalRelease');
const control = {
  schemaVersion: 1,
  revision: 1,
  releaseId: 'legacy-upload-drain-test',
  admission: 'paused',
  domains: { media: { owner: 'legacy', admission: 'paused' }, publishing: { owner: 'legacy', admission: 'paused' } },
  updatedAt: 1,
};
beforeEach(async () => {
  for (const collection of ['sermons', 'legacyAdmissionLeases', 'seriesMetadataContinuations', 'legacyDrainTestMail'])
    await db.recursiveDelete(db.collection(collection));
  await controlRef.set(control);
});
after(async () => {
  await controlRef.delete();
  await deleteApp(app);
});
test('pending bytes and PROCESSING YouTube downloads block drain even without queues or leases', async () => {
  await db.doc('sermons/no-bytes').set({ status: { audioStatus: 'PENDING' }, uploaderId: 'owner' });
  await db.doc('sermons/youtube-download').set({
    status: { audioStatus: 'PROCESSING', message: 'Downloading YouTube Audio' },
    youtubeUrl: 'https://youtu.be/example',
  });
  await db.doc('sermons/complete').set({ status: { audioStatus: 'PROCESSED' } });
  assert.equal(await countPendingLegacyUploadAdmissions(db, control, ['media']), 2);
});
test('compatibility readiness establishes a server timestamp cutoff once rather than reusing initial freeze time', async () => {
  await db.doc('sermons/compatibility-window').create({ status: { audioStatus: 'PENDING' } });
  await db.runTransaction(async (tx) => {
    const current = await tx.get(controlRef);
    tx.update(
      controlRef,
      compatibilityLegacyAdmissionCutoffUpdate(current.data(), 'initial-cutover', () => FieldValue.serverTimestamp())
    );
  });
  const cutoff = (await controlRef.get()).get('legacyAdmissionCutoff');
  assert.equal(typeof cutoff.seconds, 'number');
  const created = (await db.doc('sermons/compatibility-window').get()).createTime;
  assert.ok(
    created.seconds < cutoff.seconds ||
      (created.seconds === cutoff.seconds && created.nanoseconds <= cutoff.nanoseconds)
  );
  assert.deepEqual(
    compatibilityLegacyAdmissionCutoffUpdate((await controlRef.get()).data(), 'initial-cutover', () => {
      throw new Error('must not reset');
    }),
    {}
  );
  await controlRef.update({ updatedAt: 9999999999999, revision: 2 });
  assert.ok((await controlRef.get()).get('legacyAdmissionCutoff').isEqual(cutoff));
});
test('actual transaction stamps both cutoff documents and readiness identically, with full server-derived grace', async () => {
  const stateRef = db.doc('_control/temporalCompatibilityCutoffTest');
  const config = { mode: 'initial-cutover', legacyExecutionGraceSeconds: 3600 };
  try {
    await stateRef.set({ mode: 'initial-cutover', phase: 'ui-frozen', maximumLegacyExecutionSeconds: 3570 });
    await db.runTransaction(async (tx) => {
      const current = await tx.get(controlRef);
      const updates = compatibilityCutoffUpdates(current.data(), 'initial-cutover', 3600, () =>
        FieldValue.serverTimestamp()
      );
      tx.update(controlRef, updates.controlUpdate);
      tx.update(stateRef, { ...updates.stateUpdate, phase: 'compatibility-ready' });
    });
    const [cs, ss] = await db.getAll(controlRef, stateRef);
    assert.ok(cs.get('legacyAdmissionCutoff').isEqual(ss.get('legacySettlingCutoff')));
    assert.ok(cs.get('legacyAdmissionCutoff').isEqual(ss.get('compatibilityVerifiedAt')));
    assert.equal(Object.hasOwn(ss.data(), 'legacySettlingDeadline'), false);
    const deadline = assertCompatibilitySettlingCheckpoint(cs.data(), ss.data(), config);
    assert.ok(deadline >= cs.get('legacyAdmissionCutoff').toMillis() + 3600000);
    assert.throws(() => assertCompatibilityGraceElapsed(cs.data(), ss.data(), config, cs.readTime), /full maximum/);
    assert.equal(cs.get('domains.media.owner'), 'legacy');
    assert.equal(cs.get('admission'), 'paused');
  } finally {
    await stateRef.delete();
  }
});
test('a client-shaped durable marker cannot hide a legacy pending admission', async () => {
  await db
    .doc('sermons/forged-marker')
    .set({ status: { audioStatus: 'PENDING' }, activeDurableJobs: { upload: { jobId: 'unverified' } } });
  assert.equal(await countPendingLegacyUploadAdmissions(db, control, ['media']), 1);
});
test('ownership change rechecks pending source work atomically and preserves the old owner', async () => {
  await db.doc('sermons/pending').set({ status: { audioStatus: 'PENDING' } });
  await assert.rejects(
    db.runTransaction(async (tx) => {
      const current = await tx.get(controlRef);
      await assertPendingLegacyUploadsDrainedInTransaction(tx, db, current.data(), ['media']);
      tx.update(controlRef, { 'domains.media.owner': 'temporal' });
    }),
    /previously admitted legacy uploads/i
  );
  assert.equal((await controlRef.get()).get('domains.media.owner'), 'legacy');
  assert.equal((await db.doc('sermons/pending').get()).get('status.audioStatus'), 'PENDING');
  await db.doc('sermons/pending').update({ 'status.audioStatus': 'PROCESSED' });
  await db.runTransaction(async (tx) => {
    const current = await tx.get(controlRef);
    await assertPendingLegacyUploadsDrainedInTransaction(tx, db, current.data(), ['media']);
    tx.update(controlRef, { 'domains.media.owner': 'temporal' });
  });
  assert.equal((await controlRef.get()).get('domains.media.owner'), 'temporal');
});
test('already Temporal-owned work or an unrelated domain release is not counted as legacy', async () => {
  await db.doc('sermons/durable-pending').set({ status: { audioStatus: 'PENDING' } });
  assert.equal(
    await countPendingLegacyUploadAdmissions(db, { ...control, domains: { media: { owner: 'temporal' } } }, ['media']),
    0
  );
  assert.equal(await countPendingLegacyUploadAdmissions(db, control, ['bundles']), 0);
});

test('private pending series facts and legacy mail block final drain; terminal facts remain preserved', async () => {
  const domains = ['media', 'publishing', 'emails'];
  const assertDrain = () =>
    db.runTransaction(async (tx) => {
      const current = await tx.get(controlRef);
      await assertLegacyDrainInTransaction(tx, db, current.data(), domains, 'legacyDrainTestMail');
      tx.update(controlRef, { revision: current.get('revision') + 1 });
    });
  await db.doc('seriesMetadataContinuations/pending').set({ state: 'pending', opaque: 'preserve' });
  assert.equal(await countPendingSeriesMetadataContinuations(db, control, domains), 1);
  await assert.rejects(assertDrain(), /series metadata continuations/i);
  await db.doc('seriesMetadataContinuations/pending').update({ state: 'completed' });
  await db.doc('legacyDrainTestMail/claimed').set({ delivery: { state: 'PROCESSING' } });
  await assert.rejects(assertDrain(), /Legacy mail/);
  await db.doc('legacyDrainTestMail/claimed').update({ 'delivery.state': 'SUCCESS' });
  await db.doc('legacyAdmissionLeases/native').set({ state: 'active', operation: 'native-audio-task' });
  await assert.rejects(assertDrain(), /legacy lease/);
  await db.doc('legacyAdmissionLeases/native').update({ state: 'needs_attention' });
  await assert.rejects(assertDrain(), /legacy lease/);
  await db.doc('legacyAdmissionLeases/native').update({ state: 'completed' });
  await assertDrain();
  assert.equal((await db.doc('seriesMetadataContinuations/pending').get()).get('opaque'), 'preserve');
  assert.equal((await controlRef.get()).get('revision'), 2);
});
for (const fixture of [
  {
    name: 'native legacy lease',
    path: 'legacyAdmissionLeases/concurrent',
    value: { state: 'active' },
    field: 'state',
    pending: 'active',
  },
  {
    name: 'SMTP claim',
    path: 'legacyDrainTestMail/concurrent',
    value: { delivery: { state: 'PROCESSING' } },
    field: 'delivery.state',
    pending: 'PROCESSING',
  },
  {
    name: 'private series fact',
    path: 'seriesMetadataContinuations/concurrent',
    value: { state: 'pending' },
    field: 'state',
    pending: 'pending',
  },
])
  test(
    `concurrent ${fixture.name} versus final drain cannot commit both pending work and a drained revision`,
    { timeout: 30000 },
    async () => {
      let releaseClaim, claimRead, drainRead;
      const mayCommit = new Promise((resolve) => {
        releaseClaim = resolve;
      });
      const hasClaimRead = new Promise((resolve) => {
        claimRead = resolve;
      });
      const hasDrainRead = new Promise((resolve) => {
        drainRead = resolve;
      });
      let claimAttempts = 0;
      const claim = db.runTransaction(async (tx) => {
        const current = await tx.get(controlRef);
        if (current.get('revision') !== 1) throw new Error('claim control revision changed');
        if (++claimAttempts === 1) {
          claimRead();
          await mayCommit;
        }
        tx.create(db.doc(fixture.path), fixture.value);
      });
      await hasClaimRead;
      let drainAttempts = 0;
      const drain = db.runTransaction(async (tx) => {
        const current = await tx.get(controlRef);
        await assertLegacyDrainInTransaction(tx, db, current.data(), ['media', 'publishing'], 'legacyDrainTestMail');
        if (++drainAttempts === 1) drainRead();
        tx.update(controlRef, { revision: current.get('revision') + 1, phase: 'legacy-drained' });
      });
      await hasDrainRead;
      releaseClaim();
      const results = await Promise.allSettled([claim, drain]);
      assert.ok(results.some((result) => result.status === 'rejected'));
      const [current, lease] = await db.getAll(controlRef, db.doc(fixture.path));
      assert.ok(!(current.get('phase') === 'legacy-drained' && lease.get(fixture.field) === fixture.pending));
    }
  );

test('already Temporal-owned private pending series facts remain durable work and do not block legacy drain', async () => {
  await controlRef.update({ 'domains.publishing.owner': 'temporal' });
  await db.doc('seriesMetadataContinuations/durable-pending').set({ state: 'pending', opaque: 'preserve' });
  const current = (await controlRef.get()).data();
  assert.equal(await countPendingSeriesMetadataContinuations(db, current, ['publishing']), 0);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(controlRef);
    await assertLegacyDrainInTransaction(tx, db, snapshot.data(), ['publishing'], 'legacyDrainTestMail');
    tx.update(controlRef, { revision: 2 });
  });
  assert.equal((await db.doc('seriesMetadataContinuations/durable-pending').get()).get('state'), 'pending');
  assert.equal((await controlRef.get()).get('revision'), 2);
});
test('original canonical admission stays drain-visible through source claim and native execution completion', async () => {
  const source = db.doc('sermons/source-handoff'),
    lease = db.doc('legacyAdmissionLeases/source-handoff');
  await source.create({ status: { audioStatus: 'PENDING' } });
  const drain = () =>
    db.runTransaction(async (tx) => {
      const current = await tx.get(controlRef);
      await assertLegacyDrainInTransaction(tx, db, current.data(), ['media'], 'legacyDrainTestMail');
      tx.update(controlRef, { revision: current.get('revision') + 1 });
    });
  await assert.rejects(drain(), /pending or processing/);
  await db.runTransaction(async (tx) => {
    await tx.get(controlRef);
    const current = await tx.get(source);
    assert.equal(current.get('status.audioStatus'), 'PENDING');
    tx.create(lease, { state: 'active', operation: 'native-audio-task' });
    tx.update(source, { 'status.audioStatus': 'PROCESSING' });
  });
  await assert.rejects(drain(), /pending or processing/);
  await source.update({ 'status.audioStatus': 'PROCESSED' });
  await assert.rejects(drain(), /legacy lease/);
  await lease.update({ state: 'completed' });
  await drain();
  assert.equal((await controlRef.get()).get('revision'), 2);
  assert.equal((await source.get()).get('status.audioStatus'), 'PROCESSED');
});
test('lost SMTP acknowledgements and historical ERROR remain drain blockers until explicit outcome evidence', async () => {
  const mail = db.doc('legacyDrainTestMail/uncertain');
  const drain = () =>
    db.runTransaction(async (tx) => {
      const current = await tx.get(controlRef);
      await assertLegacyDrainInTransaction(tx, db, current.data(), ['media'], 'legacyDrainTestMail');
      tx.update(controlRef, { revision: current.get('revision') + 1 });
    });
  await mail.create({ delivery: { state: 'ERROR', attempts: 0 } });
  await assert.rejects(drain(), /Legacy mail/);
  await mail.update({ 'delivery.smtpSubmissionState': 'unknown' });
  await assert.rejects(drain(), /Legacy mail/);
  await mail.update({ 'delivery.smtpSubmissionState': 'started' });
  await assert.rejects(drain(), /Legacy mail/);
  await mail.update({ 'delivery.smtpSubmissionState': 'not_submitted' });
  await drain();
  await mail.update({ 'delivery.smtpSubmissionState': 'accepted', 'delivery.state': 'SUCCESS' });
  await drain();
  assert.equal((await controlRef.get()).get('revision'), 3);
});
