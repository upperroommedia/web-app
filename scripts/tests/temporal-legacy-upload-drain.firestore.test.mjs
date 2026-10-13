import { beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import {
  countPendingLegacyUploadAdmissions,
  assertPendingLegacyUploadsDrainedInTransaction,
  compatibilityLegacyAdmissionCutoffUpdate,
} from '../temporal-release-lib.mjs';

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
  domains: { media: { owner: 'legacy', admission: 'paused' } },
  updatedAt: 1,
};
beforeEach(async () => {
  await db.recursiveDelete(db.collection('sermons'));
  await controlRef.set(control);
});
after(async () => {
  await controlRef.delete();
  await deleteApp(app);
});
test('pending bytes and PROCESSING YouTube downloads block drain even without queues or leases', async () => {
  await db.doc('sermons/no-bytes').set({ status: { audioStatus: 'PENDING' }, uploaderId: 'owner' });
  await db
    .doc('sermons/youtube-download')
    .set({
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
