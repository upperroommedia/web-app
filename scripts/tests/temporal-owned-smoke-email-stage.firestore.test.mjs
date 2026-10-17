// Dedicated DEMO SDK tests of the actual fixed job store. No ADC, real mail or workflow transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeSnapshotProof, proofDigest } from '../temporal-release-runtime.mjs';
import { OWNED_SMOKE_INCIDENT as incident } from '../temporal-owned-smoke-plan.mjs';
import { OWNED_SMOKE_ACTION } from '../temporal-owned-smoke-index-stage.mjs';
import { planOwnedEmailProjection, applyOwnedEmailStage } from '../temporal-owned-smoke-email-stage.mjs';
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
const projectId = 'demo-owned-smoke-email';
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
const db = getFirestore(app),
  ref = { projectId: incident.projectId, jobId: incident.emailJobId };
const jobPath = 'durableJobs/' + ref.jobId,
  entity = { type: 'mail', id: 'mail/' + incident.mailId };
const entityPath = 'durableJobEntities/' + durableEntityKey(incident.projectId, entity, 'email.deliver');
const native = {
  workflowId: incident.emailWorkflowId,
  runId: incident.emailRunId,
  latestRunId: incident.emailRunId,
  status: 'FAILED',
  failureType: 'EMAIL_STALE_JOB',
  pendingActivities: 0,
  terminalEventType: 'WORKFLOW_EXECUTION_FAILED',
  historyDigest: 'c'.repeat(64),
};
// These are synthetic already-validated public facts, NOT a fabricated private capture/provenance test.
const acceptedCapture = {
  mailId: incident.mailId,
  mailState: 'SUCCESS',
  receiptAccepted: true,
  captureId: incident.captureId,
  payloadSha256: incident.payloadSha256,
  payloadHashMatches: true,
  externalDelivery: false,
  profileId: 'urm-app-staging-mail-capture-v1',
  profileVersion: 1,
  projectId: incident.projectId,
};
const operationId = '21111111-2222-4333-8444-555555555555';
const auditPath = `_control/temporalOwnedSmoke-${operationId}-email`;
const collectEmailPlan = async (tx) => {
  const snapshot = await (tx ? tx.get(db.doc(jobPath)) : db.doc(jobPath).get());
  return planOwnedEmailProjection({
    job: { path: jobPath, data: snapshot.data(), native: nativeSnapshotProof(snapshot) },
    native,
    acceptedCapture,
  });
};
async function fixture() {
  for (const name of [
    '_control',
    'durableJobs',
    'durableJobIntents',
    'durableJobEntities',
    'durableJobCriticalSections',
    'durableJobOutbox',
    'mail',
  ])
    await db.recursiveDelete(db.collection(name));
  const store = createDurableJobStore({ firestore: db, projectId: incident.projectId, now: () => 100 });
  await db.runTransaction(async (tx) =>
    store.createInTransaction(tx, {
      ref,
      kind: 'email.deliver',
      entity,
      actorUid: 'system:email',
      payload: { mailPath: entity.id, payload: { syntheticPrivateFixture: true } },
      requestId: 'fixture-only',
      generation: incident.emailGeneration,
      createdAt: 100,
      dispatch: {
        workflowType: 'emailDeliveryWorkflow',
        workflowId: incident.emailWorkflowId,
        taskQueue: 'urm-email',
        ref,
      },
    })
  );
  await store.project(ref, {
    state: 'running',
    steps: [{ id: 'deliver', label: 'Delivery', state: 'succeeded', attempt: 1 }],
  });
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
  const protectedDocuments = [];
  for (const path of ['durableJobIntents/' + ref.jobId, entityPath, 'durableJobOutbox/' + ref.jobId]) {
    protectedDocuments.push({ path, native: nativeSnapshotProof(await db.doc(path).get()) });
  }
  protectedDocuments.push({ path: 'durableJobCriticalSections/' + ref.jobId, exists: false });
  const manifest = {
    schemaVersion: 1,
    incidentDigest: proofDigest(incident),
    runtimeCommit: incident.runtimeCommit,
    releaseId: release.releaseId,
    descriptorSHA256: 'a'.repeat(64),
    revision: 55,
    protectedDocuments,
    emailPlan: await collectEmailPlan(),
    authority: {
      control: nativeSnapshotProof(await db.doc('_control/temporalRelease').get()),
      state: nativeSnapshotProof(await db.doc('_control/temporalReleaseState').get()),
    },
  };
  const evidence = { syntheticDemoOnly: true };
  await db.doc('_control/temporalReleaseOperation').create({
    schemaVersion: 1,
    operationId,
    action: OWNED_SMOKE_ACTION,
    releaseId: release.releaseId,
    manifestDigest: proofDigest(manifest),
    manifestSHA256: 'f'.repeat(64),
    authority: manifest.authority,
    evidence,
  });
  return {
    release,
    manifest,
    operation: {
      manifestSHA256: 'f'.repeat(64),
      operationId,
      evidence,
      native: nativeSnapshotProof(await db.doc('_control/temporalReleaseOperation').get()),
    },
  };
}
const apply = (f, overrides = {}) =>
  applyOwnedEmailStage({
    db,
    ...f,
    createStore: createDurableJobStore,
    collectEmailPlan,
    assertSourceAndInventories: async () => {},
    describeOriginalEmail: async () => native,
    now: () => 200,
    ...overrides,
  });
const unchanged = async (f) => {
  for (const row of f.manifest.protectedDocuments) {
    const snapshot = await db.doc(row.path).get();
    if (row.exists === false) assert.equal(snapshot.exists, false);
    else assert.deepEqual(nativeSnapshotProof(snapshot), row.native);
  }
};
try {
  await test('manifest planner rejects private extras in capture, execution and nested native proof fields', async () => {
    await fixture();
    const snapshot = await db.doc(jobPath).get();
    const job = { path: jobPath, data: snapshot.data(), native: nativeSnapshotProof(snapshot) };
    for (const input of [
      { job, native, acceptedCapture: { ...acceptedCapture, recipient: 'synthetic-private@example.test' } },
      { job, native: { ...native, rawHistory: 'synthetic-task-token' }, acceptedCapture },
      { job: { ...job, native: { ...job.native, body: 'synthetic-private' } }, native, acceptedCapture },
      {
        job: { ...job, native: { ...job.native, updateTime: { ...job.native.updateTime, token: 'private' } } },
        native,
        acceptedCapture,
      },
    ])
      assert.throws(() => planOwnedEmailProjection(input), /EMAIL_PRIVATE_PROOF_REJECTED/);
    const caller = structuredClone(native);
    const copied = planOwnedEmailProjection({ job, native: caller, acceptedCapture });
    caller.historyDigest = 'changed';
    assert.equal(copied.native.historyDigest, native.historyDigest);
  });
  await test('real store projects accepted capture atomically with audit; original native failure and owned operation retained', async () => {
    const f = await fixture(),
      before = (await db.doc(jobPath).get()).data();
    const result = await apply(f),
      after = (await db.doc(jobPath).get()).data();
    assert.equal(result.originalNativeStatus, 'FAILED');
    assert.equal(result.operationRetained, true);
    assert.equal(after.state, 'succeeded');
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(after.steps, before.steps);
    assert.deepEqual(after.actions, []);
    assert.equal(after.result.externalDelivery, false);
    assert.equal(after.result.deliveryTransport.captureId, incident.captureId);
    assert.equal((await db.doc(auditPath).get()).get('emailSends'), 0);
    assert((await db.doc('_control/temporalReleaseOperation').get()).exists);
    await unchanged(f);
  });
  await test('unknown ACK after atomic projection resumes from audit without invoking store twice', async () => {
    const f = await fixture();
    let calls = 0;
    const adapter = {
      doc: db.doc.bind(db),
      collection: db.collection.bind(db),
      runTransaction: async (callback) => {
        const result = await db.runTransaction(callback);
        if (++calls === 1) throw Error('LOST_COMMIT_ACK');
        return result;
      },
    };
    await assert.rejects(apply(f, { db: adapter }), /LOST_COMMIT_ACK/);
    const proof = nativeSnapshotProof(await db.doc(jobPath).get());
    await apply(f, {
      resume: true,
      createStore: () => {
        throw Error('STORE_MUST_NOT_RUN');
      },
    });
    assert.deepEqual(nativeSnapshotProof(await db.doc(jobPath).get()), proof);
    await assert.rejects(apply(f), /EMAIL_AUDIT_CONFLICT/);
    await unchanged(f);
  });
  await test('unknown precommit ACK retains owner and resume projects once', async () => {
    const f = await fixture();
    const adapter = {
      doc: db.doc.bind(db),
      collection: db.collection.bind(db),
      runTransaction: async () => {
        throw Error('NO_COMMIT_ACK');
      },
    };
    await assert.rejects(apply(f, { db: adapter }), /NO_COMMIT_ACK/);
    assert.equal((await db.doc(jobPath).get()).get('state'), 'running');
    await apply(f, { resume: true });
    assert.equal((await db.doc(jobPath).get()).get('revision'), 3);
  });
  await test('native execution change before or after commit never unlocks or resends', async () => {
    let f = await fixture();
    await assert.rejects(
      apply(f, { describeOriginalEmail: async () => ({ ...native, pendingActivities: 1 }) }),
      /EMAIL_NATIVE_CHANGED/
    );
    assert(!(await db.doc(auditPath).get()).exists);
    f = await fixture();
    let n = 0;
    await assert.rejects(
      apply(f, { describeOriginalEmail: async () => (++n === 1 ? native : { ...native, latestRunId: 'replacement' }) }),
      /EMAIL_NATIVE_CHANGED/
    );
    assert.equal((await db.doc(jobPath).get()).get('state'), 'succeeded');
    assert((await db.doc('_control/temporalReleaseOperation').get()).exists);
  });
  await test('changed intent, critical marker or entity generation fails before projection', async () => {
    for (const [path, data] of [
      [entityPath, { generation: 2 }],
      ['durableJobIntents/' + ref.jobId, { payload: { changed: true } }],
      ['durableJobCriticalSections/' + ref.jobId, { generation: 1 }],
    ]) {
      const f = await fixture();
      await db.doc(path).set(data, { merge: true });
      await assert.rejects(apply(f));
      assert.equal((await db.doc(jobPath).get()).get('state'), 'running');
      assert(!(await db.doc(auditPath).get()).exists);
    }
  });
  await test('postprojection edit then restoration breaks native commit stamp on resume', async () => {
    const f = await fixture();
    await apply(f);
    const data = (await db.doc(jobPath).get()).data();
    await db.doc(jobPath).update({ syntheticTouch: true });
    await db.doc(jobPath).set(data);
    await assert.rejects(apply(f, { resume: true }), /EMAIL_POSTSTATE_CHANGED/);
  });
  await test('store seam cannot write an intent, extra field or start a second transaction', async () => {
    for (const factory of [
      ({ firestore }) => ({
        project: () =>
          firestore.runTransaction(async (tx) => {
            const snapshot = await tx.get(firestore.collection('durableJobs').doc(ref.jobId));
            return snapshot.ref.set({ unsafe: true });
          }),
      }),
      ({ firestore }) => ({ project: () => firestore.collection('durableJobs').doc(ref.jobId).set({ unsafe: true }) }),
      ({ firestore }) => ({
        project: () => firestore.runTransaction((tx) => tx.set(db.doc('durableJobIntents/' + ref.jobId), {})),
      }),
      ({ firestore }) => ({
        project: () => firestore.runTransaction((tx) => tx.set(db.doc(jobPath), { state: 'succeeded', unsafe: true })),
      }),
      ({ firestore }) => ({
        project: async () => {
          await firestore.runTransaction(async () => {});
          return firestore.runTransaction(async () => {});
        },
      }),
    ]) {
      const f = await fixture();
      await assert.rejects(apply(f, { createStore: factory }));
      assert.equal((await db.doc(jobPath).get()).get('state'), 'running');
      assert(!(await db.doc(auditPath).get()).exists);
    }
  });
} finally {
  await deleteApp(app);
}
