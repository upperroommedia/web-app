// Actual Firestore SDK transactions + unchanged trusted server admission, isolated emulators only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRecoveryStore,
  makeRecoveryPlan,
  recoverBundleBootstrap,
  originalSpecs,
  digest,
  OPERATION,
} from '../temporal-bundle-bootstrap-recovery.mjs';
import { bootstrapRequestId } from '../temporal-bootstrap-bundles.mjs';
for (const key of [
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
])
  if (!process.env[key]) throw Error('Dedicated firebase.test.json emulators required');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url))),
  runtimeRoot = resolve(process.env.BUNDLE_RECOVERY_TEST_RUNTIME_ROOT ?? root);
for (const key of ['FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT'])
  process.env[key] = 'urm-app-staging';
delete process.env.FIREBASE_CONFIG;
process.env.NODE_ENV = 'production';
process.env.TASK_ORCHESTRATOR_BUNDLES = 'temporal';
const require = createRequire(resolve(runtimeRoot, 'functions/package.json'));
require('ts-node').register({ project: resolve(runtimeRoot, 'functions/tsconfig.json'), transpileOnly: true });
require('tsconfig-paths').register({
  baseUrl: resolve(runtimeRoot, 'functions'),
  paths: {
    '@upperroom/contracts/*': ['../packages/contracts/*'],
    '@upperroom/shared/*': ['../packages/shared/*'],
    '@upperroom/orchestration/*': ['../packages/orchestration/src/*'],
  },
});
const { initializeApp, getApps, deleteApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const app = initializeApp({
  projectId: 'urm-app-staging',
  databaseURL: 'https://urm-app-staging-default-rtdb.firebaseio.com',
  storageBucket: 'urm-app-staging.firebasestorage.app',
  credential: cert({
    projectId: 'urm-app-staging',
    clientEmail: 'emulator-only@urm-app-staging.iam.gserviceaccount.com',
    privateKey: generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey,
  }),
});
const db = getFirestore(app);
const { submitServerDurableJob } = require(resolve(runtimeRoot, 'functions/src/temporal/bridge.ts'));
const config = {
  projectId: 'urm-app-staging',
  releaseId: '12345678-1234-4123-8123-123456789abc',
  compatibilityCommit: 'a'.repeat(40),
  uiCommit: 'a'.repeat(40),
  mode: 'initial-cutover',
  controlRevision: 11,
  domains: ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles'],
};
const operator = {
  email: 'emulator-operator@example.test',
  verified: true,
  authority: 'google-adc-and-target-firestore-iam',
};
const store = createRecoveryStore({ db, config, serverTimestamp: () => FieldValue.serverTimestamp() });
async function seed() {
  for (const collection of [
    '_control',
    'durableJobs',
    'durableJobIntents',
    'durableJobEntities',
    'durableAdmissionReceipts',
    'durableJobOutbox',
    'legacyAdmissionLeases',
    'durableActivityExecutions',
    'durableJobCriticalSections',
  ])
    await db.recursiveDelete(db.collection(collection));
  const cutoff = Timestamp.now();
  await db
    .doc('_control/temporalRelease')
    .set({
      schemaVersion: 1,
      releaseId: config.releaseId,
      revision: 11,
      admission: 'paused',
      updatedAt: Date.now(),
      legacyAdmissionCutoff: cutoff,
      domains: Object.fromEntries(
        [...config.domains, 'search'].map((d) => [
          d,
          { owner: d === 'search' ? 'legacy' : 'temporal', admission: 'paused' },
        ])
      ),
    });
  await db
    .doc('_control/temporalReleaseState')
    .set({
      releaseId: config.releaseId,
      controlRevision: 11,
      phase: 'backend-ready',
      mode: config.mode,
      domains: config.domains,
      compatibilityCommit: config.compatibilityCommit,
      uiCommit: config.uiCommit,
      compatibilityVerifiedAt: cutoff,
      legacySettlingCutoff: cutoff,
    });
  await db
    .doc('_control/temporalProviderUsage')
    .set({
      schemaVersion: 1,
      projectId: config.projectId,
      releaseId: config.releaseId,
      epoch: 'emulator-epoch',
      status: 'ready',
    });
  for (const spec of originalSpecs(config)) {
    const receipt = await submitServerDurableJob({
      kind: 'bundle.regenerate',
      entity: { type: 'bundle', id: spec.bundleType },
      actorUid: 'system:firebase-event',
      requestId: bootstrapRequestId(config.releaseId, spec.bundleType),
      payload: { bundleType: spec.bundleType },
      continuation: true,
      expectedReleaseControl: { releaseId: config.releaseId, revision: 11 },
    });
    assert.equal(receipt.jobId, spec.jobId);
    await db
      .doc(`durableJobs/${receipt.jobId}`)
      .update({
        state: 'failed',
        revision: 3,
        actions: [],
        error: { code: 'WORKFLOW_FAILED', message: 'Fixture exhausted retries', retryable: false },
      });
    await db.doc(`durableJobOutbox/${receipt.jobId}`).update({ state: 'dispatched' });
  }
  const observation = await store.observe();
  return makeRecoveryPlan(
    config,
    observation,
    operator,
    'Emulator verified OAuth repair',
    'test:actual-source-bridge',
    { runtimeRoot, runtimeCommit: config.compatibilityCommit }
  );
}
try {
  await test('actual source API admits one new generation per type, preserves all failed originals and final native CAS audit', async () => {
    const plan = await seed(),
      before = await store.observe();
    const result = await recoverBundleBootstrap(
      { config, plan, operator },
      { ...store, submit: submitServerDurableJob }
    );
    assert.equal(result.result, 'recovery-admissions-verified');
    assert.equal(result.claimsBundlesConverged, false);
    assert.equal(result.decisions.length, 6);
    assert.equal((await db.doc(OPERATION).get()).exists, false);
    const after = await store.observe();
    assert.equal(digest(before.authority.control), digest(after.authority.control));
    assert.equal(digest(before.authority.state), digest(after.authority.state));
    for (let i = 0; i < 6; i++) {
      assert.equal(digest(before.originals[i].job), digest(after.originals[i].job));
      assert.equal(digest(before.originals[i].intent), digest(after.originals[i].intent));
      assert.equal(digest(before.originals[i].receipt), digest(after.originals[i].receipt));
      assert.equal(digest(before.originals[i].outbox), digest(after.originals[i].outbox));
      assert.equal(after.originals[i].current.entity.generation, 2);
      assert.equal(after.originals[i].current.job.state, 'queued');
    }
    assert.equal((await db.collection('durableJobs').count().get()).data().count, 12);
    await assert.rejects(
      recoverBundleBootstrap(
        { config, plan, operator },
        { ...store, submit: () => assert.fail('no duplicate API call') }
      ),
      /ALREADY_COMPLETED/
    );
  });
  await test('actual lost acknowledgement keeps exact native operation; explicit resume reuses receipt without generation3', async () => {
    const plan = await seed();
    let first = true,
      calls = 0;
    const operationId = '12345678-1234-4123-8123-123456789abc';
    const submit = async (args) => {
      calls++;
      const result = await submitServerDurableJob(args);
      if (first) {
        first = false;
        throw Error('emulator lost acknowledgement');
      }
      return result;
    };
    await assert.rejects(
      recoverBundleBootstrap({ config, plan, operationId, operator }, { ...store, submit }),
      /lost acknowledgement/
    );
    const retained = await db.doc(OPERATION).get();
    assert.equal(retained.get('operationId'), operationId);
    await assert.rejects(
      recoverBundleBootstrap({ config, plan, operationId: 'different', resume: true, operator }, { ...store, submit }),
      /RESUME_IDENTITY_CHANGED/
    );
    await recoverBundleBootstrap({ config, plan, operationId, resume: true, operator }, { ...store, submit });
    assert.equal(calls, 6);
    assert.equal((await db.collection('durableJobs').count().get()).data().count, 12);
    assert(
      (await store.observe()).originals.every((r) => r.current.entity.generation === 2 && r.job.state === 'failed')
    );
  });
  await test('actual source API fails wrong release/revision/generation and ordinary paused administrator before new work', async () => {
    const plan = await seed(),
      request = plan.requests[0].args;
    await assert.rejects(
      submitServerDurableJob({
        ...request,
        requestId: 'wrong-release',
        expectedReleaseControl: { releaseId: 'other', revision: 11 },
      }),
      /release/i
    );
    await assert.rejects(
      submitServerDurableJob({
        ...request,
        requestId: 'wrong-revision',
        expectedReleaseControl: { releaseId: config.releaseId, revision: 12 },
      }),
      /release/i
    );
    await assert.rejects(
      submitServerDurableJob({ ...request, requestId: 'wrong-generation', expectedGeneration: 99 }),
      /Entity changed/
    );
    const auth = require('firebase-admin/auth').getAuth(app);
    await auth.createUser({ uid: 'emulator-admin' });
    await auth.setCustomUserClaims('emulator-admin', { role: 'admin' });
    await assert.rejects(
      submitServerDurableJob({
        ...request,
        actorUid: 'emulator-admin',
        requestId: 'ordinary-admin',
        expectedReleaseControl: undefined,
      }),
      (e) => e.code === 'unavailable'
    );
    assert.equal((await db.collection('durableJobs').count().get()).data().count, 6);
  });
  await test('actual acquisition rejects unsettled execution witness, foreign operation and changed checkpoint without job writes', async () => {
    const plan = await seed();
    await db
      .doc('durableActivityExecutions/missing-witness')
      .set({
        projectId: config.projectId,
        jobId: plan.originals[0].jobId,
        workflowId: 'w',
        runId: 'r',
        activityId: 'a',
        activityType: 'regenerateBundle',
        scheduledAt: 1,
        attempt: 1,
        worker: { instanceId: 'test' },
        executionId: 'invalid',
      });
    await assert.rejects(store.acquire(plan, 'operation', false, operator), /EXECUTION_INVALID/);
    assert.equal((await db.doc(OPERATION).get()).exists, false);
    await db.doc('durableActivityExecutions/missing-witness').delete();
    await db.doc(OPERATION).set({ operationId: 'foreign', action: 'other' });
    await assert.rejects(store.acquire(plan, 'operation', false, operator), /EXPLICIT_RESUME_REQUIRED/);
    assert.equal((await db.doc(OPERATION).get()).get('operationId'), 'foreign');
    await db.doc(OPERATION).delete();
    await db.doc('_control/temporalReleaseState').update({ changed: true });
    await assert.rejects(store.acquire(plan, 'operation', false, operator), /AUTHORITY_CHANGED/);
    assert.equal((await db.collection('durableJobs').count().get()).data().count, 6);
  });
} finally {
  getDatabase(app).goOffline();
  await db.terminate();
  await Promise.all(getApps().map((a) => deleteApp(a)));
}
