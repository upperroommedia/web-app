// Dedicated DEMO SDK tests of bounded publication read-only SDK views. No ADC, real mail or workflow transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeSnapshotProof, proofDigest } from '../temporal-release-runtime.mjs';
import { OWNED_SMOKE_INCIDENT as incident } from '../temporal-owned-smoke-plan.mjs';
import { OWNED_SMOKE_ACTION } from '../temporal-owned-smoke-index-stage.mjs';
import { publicationReadonlyView } from '../temporal-owned-smoke-publication-evidence.mjs';
for (const name of [
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
])
  if (!/^127\.0\.0\.1:\d+$/.test(process.env[name] ?? '')) throw Error('DEDICATED_DEMO_EMULATORS_REQUIRED');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = createRequire(root + '/functions/package.json');
require('ts-node').register({ project: root + '/functions/tsconfig.json', transpileOnly: true });
require('tsconfig-paths').register({
  baseUrl: root + '/functions',
  paths: {
    '@upperroom/contracts/*': ['../packages/contracts/*'],
    '@upperroom/shared/*': ['../packages/shared/*'],
    '@upperroom/orchestration/*': ['../packages/orchestration/src/*'],
  },
});
const { createDurableJobStore, durableEntityKey } = require(root + '/packages/orchestration/src/job-store.ts');
const { initializeApp, deleteApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const projectId = 'demo-owned-smoke-publication';
const app = initializeApp({
  projectId,
  credential: cert({
    projectId,
    clientEmail: 'emulator-only@' + projectId + '.iam.gserviceaccount.com',
    privateKey: generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey,
  }),
});
const db = getFirestore(app);
const { Timestamp } = require('firebase-admin/firestore');
const path = 'readonlyFixture/a';
const allow = (p) => p === 'readonlyFixture' || p.startsWith('readonlyFixture/');
const reader = () => ({ get: (target) => target.get() });
async function fixture() {
  await db.recursiveDelete(db.collection('readonlyFixture'));
  await db.doc(path).set({ body: 'synthetic-private-body', marker: Timestamp.fromMillis(123456), count: 1 });
  await db.doc('readonlyFixture/b').set({ body: 'other-private-body', count: 2 });
}
try {
  await test('actual SDK snapshots and nested timestamps are content-only, cloned and native pinned', async () => {
    await fixture();
    await db.runTransaction(async (tx) => {
      const view = publicationReadonlyView(db, tx, allow);
      const snap = await view.tx.get(view.db.doc(path));
      assert.equal(snap.data().marker.toMillis(), 123456);
      assert.equal(snap.get('marker').toDate().getTime(), 123456);
      assert.equal(snap.ref.set, undefined);
      assert.equal(snap.ref.firestore, undefined);
      assert.equal(view.db.batch, undefined);
      assert.equal(view.tx.set, undefined);
      const data = snap.data();
      data.body = 'changed';
      assert.equal(snap.data().body, 'synthetic-private-body');
      const again = await snap.ref.get();
      assert.equal(again.data().body, 'synthetic-private-body');
      const proof = view.proof();
      assert.equal(proof.protectedDocuments.length, 1);
      assert.equal(proof.protectedDocuments[0].native.dataDigest, proofDigest((await tx.get(db.doc(path))).data()));
      assert(!JSON.stringify(proof).includes('synthetic-private-body'));
    });
  });
  await test('bounded query paging consumes inert snapshot cursors and records each native document once', async () => {
    await fixture();
    const view = publicationReadonlyView(db, reader(), allow);
    const q = view.db.collection('readonlyFixture').orderBy('__name__').limit(1);
    const first = await q.get();
    assert.equal(first.size, 1);
    assert.equal(first.docs[0].id, 'a');
    const second = await q.startAfter(first.docs[0]).get();
    assert.equal(second.docs[0].id, 'b');
    assert.equal((await q.startAfter(second.docs[0]).get()).size, 0);
    assert.equal(view.proof().protectedDocuments.length, 2);
    assert.equal(view.proof().queries.length, 3);
  });
  await test('unbounded, foreign or excessive reads stop without SDK mutation methods', async () => {
    await fixture();
    const view = publicationReadonlyView(db, reader(), allow);
    await assert.rejects(view.db.collection('readonlyFixture').get(), /PUBLICATION_QUERY_BOUND_REQUIRED/);
    assert.throws(() => view.db.collection('readonlyFixture').limit(401), /PUBLICATION_QUERY_BOUND_REQUIRED/);
    assert.throws(() => view.db.doc('foreign/a'), /PUBLICATION_READ_SCOPE/);
    await assert.rejects(view.tx.get(db.doc(path)), /PUBLICATION_FOREIGN_HANDLE/);
    const page = await view.db.collection('readonlyFixture').limit(2).get();
    assert.throws(
      () => view.db.collection('readonlyFixture').limit(2).startAfter({ ref: page.docs[0].ref }),
      /PUBLICATION_CURSOR_REQUIRED/
    );
  });
  await test('query.getAll/native absence proofs and document collection traversal are read only', async () => {
    await fixture();
    await db.doc(path + '/child/a').set({ marker: true });
    const view = publicationReadonlyView(db, reader(), allow);
    const [a, missing] = await view.tx.getAll(view.db.doc(path), view.db.doc('readonlyFixture/missing'));
    assert(a.exists);
    assert(!missing.exists);
    const child = await view.db.collection('readonlyFixture').doc('a').collection('child').doc('a').get();
    assert.equal(child.get('marker'), true);
    assert(view.proof().protectedDocuments.some((r) => r.path === 'readonlyFixture/missing' && r.exists === false));
  });
  await test('SDK references nested in private documents cannot escape through contents', async () => {
    await fixture();
    await db.doc(path).update({ hiddenRef: db.doc('readonlyFixture/b') });
    const view = publicationReadonlyView(db, reader(), allow);
    await assert.rejects(view.db.doc(path).get(), /PUBLICATION_SDK_VALUE_REJECTED/);
  });
  await test('changed native snapshot between nontransactional reads cannot be relabeled as one proof', async () => {
    await fixture();
    const view = publicationReadonlyView(db, reader(), allow);
    await view.db.doc(path).get();
    await db.doc(path).update({ count: 2 });
    await assert.rejects(view.db.doc(path).get(), /PUBLICATION_NATIVE_CHANGED/);
    assert.equal((await db.doc(path).get()).get('count'), 2);
  });
  await test('changed query membership cannot overwrite an earlier complete query proof', async () => {
    await fixture();
    const view = publicationReadonlyView(db, reader(), allow);
    const query = view.db.collection('readonlyFixture').orderBy('__name__').limit(3);
    assert.equal((await query.get()).size, 2);
    await db.doc('readonlyFixture/c').set({ count: 3 });
    await assert.rejects(query.get(), /PUBLICATION_QUERY_MEMBERSHIP_CHANGED/);
  });
} finally {
  await deleteApp(app);
}
