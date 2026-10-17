// Dedicated DEMO SDK tests of ordinary maintenance ownership. No ADC, real mail or workflow transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeSnapshotProof, proofDigest } from '../temporal-release-runtime.mjs';
import { OWNED_SMOKE_INCIDENT as incident } from '../temporal-owned-smoke-plan.mjs';
import { OWNED_SMOKE_ACTION } from '../temporal-owned-smoke-index-stage.mjs';
import { acquireOwnedSmokeOperation, finishOwnedSmokeOperation } from '../temporal-owned-smoke-operation.mjs';
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
const projectId = 'demo-owned-smoke-operation';
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
const operationId = '31111111-2222-4333-8444-555555555555';
const lockPath = '_control/temporalReleaseOperation';
const completionPath = `_control/temporalOwnedSmoke-${operationId}-complete`;
const indexPath = `_control/temporalOwnedSmoke-${operationId}-index`;
const emailPath = `_control/temporalOwnedSmoke-${operationId}-email`;
const publicPath = 'durableJobs/operation-component-synthetic-email';
const protectedPath = 'durableJobs/operation-component-synthetic-search';
const native = { status: 'FAILED', originalRunOnly: true, historyDigest: 'c'.repeat(64) };
async function fixture() {
  await db.recursiveDelete(db.collection('_control'));
  await db.recursiveDelete(db.collection('durableJobs'));
  const release = {
    environment: 'staging',
    projectId: incident.projectId,
    mode: 'durable-upgrade',
    compatibilityCommit: incident.runtimeCommit,
    uiCommit: incident.runtimeCommit,
    releaseId: '939dd424-7473-4cae-a7a8-ea8e2dcc9977',
    domains: ['publishing', 'emails', 'search'],
  };
  const control = {
    schemaVersion: 1,
    releaseId: release.releaseId,
    revision: 55,
    admission: 'paused',
    domains: Object.fromEntries(
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
        d,
        { owner: 'temporal', admission: release.domains.includes(d) ? 'paused' : 'open' },
      ])
    ),
  };
  await db.doc('_control/temporalRelease').set(control);
  await db.doc('_control/temporalReleaseState').set({ ...release, controlRevision: 55, phase: 'ownership-changed' });
  await db.doc(protectedPath).set({ projectId: incident.projectId, kind: 'search.sync', state: 'succeeded' });
  const manifest = {
    schemaVersion: 1,
    incidentDigest: proofDigest(incident),
    runtimeCommit: incident.runtimeCommit,
    releaseId: release.releaseId,
    revision: 55,
    descriptorSHA256: 'a'.repeat(64),
    emailPlan: { native },
    authority: {
      control: nativeSnapshotProof(await db.doc('_control/temporalRelease').get()),
      state: nativeSnapshotProof(await db.doc('_control/temporalReleaseState').get()),
    },
    protectedDocuments: [{ path: protectedPath, native: nativeSnapshotProof(await db.doc(protectedPath).get()) }],
  };
  return {
    release,
    manifest,
    operationId,
    manifestSHA256: 'f'.repeat(64),
    evidence: {
      descriptorSHA256: manifest.descriptorSHA256,
      operatorCommit: 'b'.repeat(40),
      operatorClosureDigest: 'c'.repeat(64),
      runtimeCommit: incident.runtimeCommit,
      runtimeTree: incident.runtimeTree,
      resourceIdentityDigest: 'd'.repeat(64),
      principalDigest: 'e'.repeat(64),
    },
  };
}
async function protectedState(f, tx) {
  const snapshot = await tx.get(db.doc(protectedPath));
  assert.deepEqual(nativeSnapshotProof(snapshot), f.manifest.protectedDocuments[0].native);
}
const acquire = (f, extra = {}) =>
  acquireOwnedSmokeOperation({
    db,
    ...f,
    validateManifest: async () => {},
    assertSourceAndInventories: async () => {},
    assertProtectedState: (tx) => protectedState(f, tx),
    now: () => 100,
    ...extra,
  });
async function syntheticStages() {
  // Lifecycle tests supply synthetic stage poststates, not a substitute for the real stage SDK tests.
  await db.doc(indexPath).create({ syntheticStage: 'index', finished: true });
  await db.doc(emailPath).create({ syntheticStage: 'email', originalNativeStatus: 'FAILED' });
  await db.doc(publicPath).set({ state: 'succeeded', externalDelivery: false });
}
async function finalState(tx) {
  const [index, email, job] = await Promise.all([indexPath, emailPath, publicPath].map((p) => tx.get(db.doc(p))));
  assert.equal(index.get('finished'), true);
  assert.equal(email.get('originalNativeStatus'), 'FAILED');
  assert.equal(job.get('state'), 'succeeded');
  return {
    indexAuditNative: nativeSnapshotProof(index),
    emailAuditNative: nativeSnapshotProof(email),
    publicEmailNative: nativeSnapshotProof(job),
    inventoryDigest: 'd'.repeat(64),
    protectedDigest: 'e'.repeat(64),
    nativeEmailHistoryDigest: native.historyDigest,
  };
}
const finish = (f, operation, extra = {}) =>
  finishOwnedSmokeOperation({
    db,
    ...f,
    operation,
    validateManifest: async () => {},
    assertSourceAndInventories: async () => {},
    assertProtectedState: (tx) => protectedState(f, tx),
    describeOriginalEmail: async () => native,
    verifyFinalState: finalState,
    now: () => 200,
    ...extra,
  });
function lostAcknowledgement(after) {
  let calls = 0;
  return {
    doc: db.doc.bind(db),
    collection: db.collection.bind(db),
    runTransaction: async (callback) => {
      if (!after && ++calls === 1) throw Error('LOST_ACK_BEFORE_COMMIT');
      const result = await db.runTransaction(callback);
      if (after && ++calls === 1) throw Error('LOST_ACK_AFTER_COMMIT');
      return result;
    },
  };
}
try {
  await test('private evidence and nested authority extras are rejected before acquisition', async () => {
    for (const change of [
      (f) => (f.evidence.recipient = 'private@example.test'),
      (f) => (f.evidence.operatorCommit = 'not-a-commit'),
      (f) => (f.manifest.authority.control.body = 'private'),
      (f) => (f.manifest.authority.state.updateTime.token = 'private'),
    ]) {
      const f = await fixture();
      change(f);
      await assert.rejects(acquire(f), /SAFE_/);
      assert(!(await db.doc(lockPath).get()).exists);
    }
  });
  await test('ordinary acquisition and final audit-release are atomic; control and protected native stamps preserved', async () => {
    const f = await fixture(),
      operation = await acquire(f);
    assert((await db.doc(lockPath).get()).exists);
    assert.equal((await db.doc(lockPath).get()).get('action'), OWNED_SMOKE_ACTION);
    await syntheticStages();
    const result = await finish(f, operation);
    assert.equal(result.completed, true);
    assert.equal(result.originalNativeEmailStatus, 'FAILED');
    assert(!(await db.doc(lockPath).get()).exists);
    assert((await db.doc(completionPath).get()).exists);
    assert.deepEqual(nativeSnapshotProof(await db.doc('_control/temporalRelease').get()), f.manifest.authority.control);
    const auditNative = nativeSnapshotProof(await db.doc(completionPath).get());
    await finish(f, operation, { resume: true });
    assert.deepEqual(nativeSnapshotProof(await db.doc(completionPath).get()), auditNative);
  });
  await test('unknown acquisition ACK requires explicit resume and never creates a second owner', async () => {
    const f = await fixture();
    await assert.rejects(acquire(f, { db: lostAcknowledgement(true) }), /LOST_ACK_AFTER_COMMIT/);
    const owned = nativeSnapshotProof(await db.doc(lockPath).get());
    await assert.rejects(acquire(f), /OPERATION_HELD/);
    const operation = await acquire(f, { resume: true });
    assert.deepEqual(operation.native, owned);
    const wrong = { ...f, evidence: { ...f.evidence, principalDigest: 'f'.repeat(64) } };
    await assert.rejects(acquire(wrong, { resume: true }), /OPERATION_IDENTITY_CHANGED/);
  });
  await test('uncommitted acquisition cannot be resumed by silently reacquiring', async () => {
    const f = await fixture();
    await assert.rejects(acquire(f, { db: lostAcknowledgement(false) }), /LOST_ACK_BEFORE_COMMIT/);
    assert(!(await db.doc(lockPath).get()).exists);
    await assert.rejects(acquire(f, { resume: true }), /OWNED_OPERATION_MISSING/);
  });
  await test('lost final ACK after commit reconciles audit without acquiring or deleting another lock', async () => {
    const f = await fixture(),
      operation = await acquire(f);
    await syntheticStages();
    await assert.rejects(finish(f, operation, { db: lostAcknowledgement(true) }), /LOST_ACK_AFTER_COMMIT/);
    assert(!(await db.doc(lockPath).get()).exists);
    const audit = nativeSnapshotProof(await db.doc(completionPath).get());
    await assert.rejects(acquire(f, { resume: true }), /OPERATION_ALREADY_COMPLETED/);
    await finish(f, operation, { resume: true });
    assert.deepEqual(nativeSnapshotProof(await db.doc(completionPath).get()), audit);
    await db.doc(lockPath).create({ foreign: true });
    await assert.rejects(finish(f, operation, { resume: true }), /COMPLETION_AUDIT_CONFLICT/);
    assert.deepEqual((await db.doc(lockPath).get()).data(), { foreign: true });
  });
  await test('lost final ACK before commit preserves owner; exact resume commits once', async () => {
    const f = await fixture(),
      operation = await acquire(f);
    await syntheticStages();
    await assert.rejects(finish(f, operation, { db: lostAcknowledgement(false) }), /LOST_ACK_BEFORE_COMMIT/);
    assert((await db.doc(lockPath).get()).exists);
    assert(!(await db.doc(completionPath).get()).exists);
    await finish(f, operation, { resume: true });
    assert(!(await db.doc(lockPath).get()).exists);
  });
  await test('native/source/protected/phase changes fail closed without release', async () => {
    let f = await fixture();
    await assert.rejects(
      acquire(f, {
        assertSourceAndInventories: async () => {
          throw Error('SOURCE_CHANGED');
        },
      }),
      /SOURCE_CHANGED/
    );
    assert(!(await db.doc(lockPath).get()).exists);
    f = await fixture();
    let operation = await acquire(f);
    await syntheticStages();
    await assert.rejects(
      finish(f, operation, { describeOriginalEmail: async () => ({ ...native, status: 'RUNNING' }) }),
      /EMAIL_NATIVE_CHANGED/
    );
    assert((await db.doc(lockPath).get()).exists);
    await db.doc(protectedPath).update({ state: 'failed' });
    await assert.rejects(finish(f, operation));
    assert((await db.doc(lockPath).get()).exists);
    f = await fixture();
    await db.doc('_control/temporalReleaseState').update({ phase: 'complete' });
    await assert.rejects(acquire(f), /OWNERSHIP_CHANGED_AUTHORITY_REQUIRED/);
  });
  await test('altered stage poststate and private final proof extras cannot certify completion', async () => {
    const f = await fixture(),
      operation = await acquire(f);
    await syntheticStages();
    await assert.rejects(
      finish(f, operation, { verifyFinalState: async (tx) => ({ ...(await finalState(tx)), recipient: 'private' }) }),
      /FINAL_PROOF_REQUIRED/
    );
    assert(!(await db.doc(completionPath).get()).exists);
    assert((await db.doc(lockPath).get()).exists);
    await finish(f, operation);
    await db.doc(publicPath).update({ state: 'failed' });
    await assert.rejects(finish(f, operation, { resume: true }));
    assert(!(await db.doc(lockPath).get()).exists);
  });
} finally {
  await deleteApp(app);
}
