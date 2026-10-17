// Dedicated DEMO SDK only. Cloud Tasks/identity/source callbacks are synthetic, not live evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { nativeSnapshotProof, proofDigest } from '../temporal-release-runtime.mjs';
import { OWNED_SMOKE_INCIDENT as incident } from '../temporal-owned-smoke-plan.mjs';
import {
  currentLifecycleCoordinator,
  parseCurrentLifecycleReceipt,
} from '../temporal-retire-current-search-lifecycle.mjs';
import {
  currentLifecycleTransport,
  CURRENT_LIFECYCLE_CONTRACT as fixed,
  currentLifecycleExclusions,
} from '../temporal-current-search-lifecycle.mjs';
for (const key of [
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
])
  if (!/^127\.0\.0\.1:\d+$/.test(process.env[key] ?? '')) throw Error('DEDICATED_DEMO_REQUIRED');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url))),
  req = createRequire(root + '/functions/package.json');
req('ts-node').register({ project: root + '/functions/tsconfig.json', transpileOnly: true });
req('tsconfig-paths').register({
  baseUrl: root + '/functions',
  paths: {
    '@upperroom/contracts/*': ['../packages/contracts/*'],
    '@upperroom/shared/*': ['../packages/shared/*'],
    '@upperroom/orchestration/*': ['../packages/orchestration/src/*'],
  },
});
const { durableEntityKey } = req(root + '/packages/orchestration/src/job-store.ts'),
  { initializeApp, deleteApp, cert } = req('firebase-admin/app'),
  { getFirestore } = req('firebase-admin/firestore');
const projectId = 'demo-current-search-retirement';
const app = initializeApp({
  projectId,
  credential: cert({
    projectId,
    clientEmail: 'fixture@' + projectId + '.iam.gserviceaccount.com',
    privateKey: generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey,
  }),
});
const db = getFirestore(app),
  contract = JSON.parse(readFileSync(root + '/ops/temporal/owned-smoke-search-preservation.staging.json'));
const id = '819fd002-2222-4333-8444-555555555555',
  manifestSHA = 'a'.repeat(64);
let release, evidence, artifacts, tasks, live, deleted, queueIdentity;
async function fixture(extraCount = 5) {
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  release = {
    projectId: 'urm-app-staging',
    environment: 'staging',
    releaseId: '939dd424-7473-4cae-a7a8-ea8e2dcc9977',
    mode: 'durable-upgrade',
    domains: ['publishing', 'emails', 'search'],
    compatibilityCommit: fixed.applicationCommit,
    uiCommit: fixed.applicationCommit,
  };
  evidence = {
    descriptorSHA256: 'a'.repeat(64),
    operatorCommit: 'b'.repeat(40),
    operatorClosureDigest: 'c'.repeat(64),
    runtimeCommit: fixed.applicationCommit,
    resourceIdentityDigest: 'd'.repeat(64),
    principalDigest: 'e'.repeat(64),
  };
  artifacts = Array.from({ length: 4 }, (_, i) => ({
    path: '/synthetic/original-' + i,
    sha256: String(i + 1).repeat(64),
  }));
  const batch = db.batch();
  for (const p of contract.parents) {
    const jobId = p.jobPath.split('/')[1];
    batch.set(db.doc(p.jobPath), {
      projectId: release.projectId,
      jobId,
      kind: 'search.backfill',
      state: 'succeeded',
      generation: 2,
      entity: p.entity,
    });
    batch.set(db.doc(p.intentPath), {
      projectId: release.projectId,
      jobId,
      kind: 'search.backfill',
      generation: 2,
      entity: p.entity,
    });
    batch.set(db.doc(p.entityPath), {
      projectId: release.projectId,
      activeJobId: jobId,
      generation: 2,
      entity: p.entity,
    });
  }
  for (const [i, path] of contract.historicalSearchJobPaths.entries())
    batch.set(db.doc(path), {
      projectId: release.projectId,
      kind: 'search.sync',
      state: i === 0 ? 'succeeded' : 'queued',
    });
  for (let i = 0; i < extraCount; i++)
    batch.set(db.doc('durableJobs/new-search-' + String(i).padStart(3, '0')), {
      projectId: release.projectId,
      kind: 'search.sync',
      state: 'queued',
    });
  for (const path of [
    'durableJobs/' + incident.publicationJobId,
    'durableJobIntents/' + incident.publicationJobId,
    'durableJobCriticalSections/' + incident.publicationJobId,
    'durableJobs/' + incident.emailJobId,
    'durableJobIntents/' + incident.emailJobId,
    'mail/' + incident.mailId,
    'durableEmailReceipts/' + incident.emailJobId,
    '_mailSandboxCaptures/' + incident.captureId,
  ])
    batch.set(db.doc(path), {
      projectId: release.projectId,
      state: path === 'durableJobs/' + incident.emailJobId ? 'running' : 'needs_attention',
      privateValue: 'synthetic-do-not-export',
    });
  batch.set(db.doc('_control/temporalRelease'), {
    schemaVersion: 1,
    releaseId: release.releaseId,
    revision: 50,
    admission: 'paused',
    domains: Object.fromEntries(
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
        d,
        { owner: 'temporal', admission: release.domains.includes(d) ? 'paused' : 'open' },
      ])
    ),
  });
  batch.set(db.doc('_control/temporalReleaseState'), { ...release, controlRevision: 50, phase: 'compatibility-ready' });
  await batch.commit();
  queueIdentity = contract.queues.map((q) => ({ name: q.name, state: q.state }));
  live = new Map();
  deleted = [];
  tasks = ['images', 'lists', 'sermons', 'speakers', 'users'].map((instance, i) => {
    const queue = `projects/urm-app-staging/locations/us-central1/queues/kit-${instance}-index-executeFullIndexOperation`,
      name = queue + '/tasks/' + (9000000 + i),
      url = `https://kit-${instance}-index-executefullindexoperation-test.a.run.app`,
      httpRequest = {
        url,
        httpMethod: 'POST',
        body: 'eyJkYXRhIjp7fX0=',
        oidcToken: { serviceAccountEmail: 'firebase-fn-123@urm-app-staging.iam.gserviceaccount.com', audience: url },
      },
      common = {
        name,
        httpRequest,
        createTime: '2026-10-17T05:00:00Z',
        scheduleTime: '2026-10-17T05:00:00Z',
        dispatchDeadline: '600s',
      };
    const task = { ...common, view: 'FULL', dispatchCount: 0, responseCount: 0 };
    live.set(name, task);
    return {
      name,
      task,
      sourceSHA256: 'f'.repeat(64),
      requestLine: 10,
      responseLine: 12,
      deployment: {
        functionName: `projects/urm-app-staging/locations/us-central1/functions/kit-${instance}-index-executeFullIndexOperation`,
        applicationCommit: fixed.applicationCommit,
        patchLine: 1,
        completionLine: 3,
        patchAcknowledgementLine: 2,
        operationName: 'projects/urm-app-staging/locations/us-central1/operations/operation-fixture',
        requestedSourceDigest: 'f'.repeat(64),
        requestSourceKind: 'managed-upload',
        sourceDigest: 'f'.repeat(64),
        build: 'projects/123/locations/us-central1/builds/aabbcc',
        revision: 'synthetic-9094',
      },
      request: { task: { httpRequest } },
      response: { ...common, view: 'BASIC' },
    };
  });
}
function api(extra = {}) {
  return {
    inventory: async () => ({
      allQueuePages: true,
      responseView: 'FULL',
      queues: queueIdentity.map((q) => ({
        queue: q,
        allPages: true,
        responseView: 'FULL',
        tasks: [...live.values()].filter((t) => t.name.startsWith(q.name + '/tasks/')),
      })),
    }),
    getTask: async (name) => structuredClone(live.get(name) ?? null),
    deleteTask: async (name) => {
      deleted.push(name);
      assert(live.delete(name));
    },
    ...extra,
  };
}
function coordinator(database = db, transport = api()) {
  return currentLifecycleCoordinator({
    db: database,
    release,
    evidence,
    runtime: { durableEntityKey },
    sourceArtifacts: artifacts,
    assertSource: async () => {},
    api: transport,
  });
}
function loseTransactionAck(suffix) {
  let once = false;
  return new Proxy(db, {
    get(target, key) {
      if (key === 'runTransaction')
        return async (callback, ...args) => {
          let match = false;
          const result = await target.runTransaction(
            async (tx) =>
              callback(
                new Proxy(tx, {
                  get(t, k) {
                    const value = t[k];
                    if (k === 'create')
                      return (ref, ...rest) => {
                        if (ref.path.endsWith(suffix)) match = true;
                        return value.call(t, ref, ...rest);
                      };
                    return typeof value === 'function' ? value.bind(t) : value;
                  },
                })
              ),
            ...args
          );
          if (match && !once) {
            once = true;
            throw Error('SYNTHETIC_UNKNOWN_ACK');
          }
          return result;
        };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
try {
  await test('actual current-state collector preserves terminal historical jobs and all new queued pages; finite five retirement changes no business document', async () => {
    await fixture(205);
    const c = coordinator(),
      m = await c.inspect(tasks);
    assert.equal(m.searchPreservation.currentQueuedSearchPaths.length, 212);
    assert.equal(m.exclusions.length, 21);
    assert.equal(JSON.stringify(m).includes('synthetic-do-not-export'), false);
    assert.deepEqual(
      parseCurrentLifecycleReceipt(
        JSON.stringify({
          mode: 'inspect',
          noMutations: true,
          manifest: m,
          manifestDigest: proofDigest(m),
          cleanupCompleted: true,
        })
      ),
      m
    );
    await c.apply(m, id, manifestSHA);
    assert.equal(new Set(deleted).size, 5);
    assert(!(await db.doc('_control/temporalReleaseOperation').get()).exists);
    for (const row of m.protectedDocuments)
      assert.deepEqual(nativeSnapshotProof(await db.doc(row.path).get()), row.native);
  });
  await test('lost DELETE response reconciles 404 without repeating issued request; changed raw bytes reject', async () => {
    await fixture();
    let once = false;
    const transport = api({
        deleteTask: async (name) => {
          deleted.push(name);
          live.delete(name);
          if (!once) {
            once = true;
            throw Error('SYNTHETIC_UNKNOWN_ACK');
          }
        },
      }),
      c = coordinator(db, transport),
      m = await c.inspect(tasks);
    await assert.rejects(c.apply(m, id, manifestSHA), /SYNTHETIC_UNKNOWN_ACK/);
    await assert.rejects(c.apply(m, id, 'b'.repeat(64), true), /IDENTITY_CHANGED/);
    await c.apply(m, id, manifestSHA, true);
    assert.equal(deleted.length, 5);
    assert.equal(new Set(deleted).size, 5);
  });
  await test('lost final ACK resumes same completion and never reacquires or deletes again', async () => {
    await fixture();
    const m = await coordinator().inspect(tasks);
    await assert.rejects(
      coordinator(loseTransactionAck('-complete')).apply(m, id, manifestSHA),
      /SYNTHETIC_UNKNOWN_ACK/
    );
    assert(!(await db.doc('_control/temporalReleaseOperation').get()).exists);
    assert.equal((await coordinator().apply(m, id, manifestSHA, true)).reconciled, true);
    assert.equal(deleted.length, 5);
  });
  await test('unknown intent commit ACK with task present stops resume and never issues DELETE', async () => {
    await fixture();
    const m = await coordinator().inspect(tasks);
    await assert.rejects(coordinator(loseTransactionAck('-0')).apply(m, id, manifestSHA), /SYNTHETIC_UNKNOWN_ACK/);
    await assert.rejects(coordinator().apply(m, id, manifestSHA, true), /ISSUED_DELETE_STILL_PRESENT/);
    assert.equal(deleted.length, 0);
    assert((await db.doc('_control/temporalReleaseOperation').get()).exists);
  });
  await test('changed original entity, queued membership, historical native stamp and foreign operation stop before deletion', async () => {
    await fixture();
    const m = await coordinator().inspect(tasks);
    await db
      .doc('durableJobs/new-search-extra')
      .set({ projectId: release.projectId, kind: 'search.sync', state: 'queued' });
    await assert.rejects(coordinator().apply(m, id, manifestSHA), /QUEUED|PRESERV/);
    assert.equal(deleted.length, 0);
    await fixture();
    const current = await coordinator().inspect(tasks);
    const foreign = { operationId: 'foreign' };
    await db.doc('_control/temporalReleaseOperation').create(foreign);
    await assert.rejects(coordinator().apply(current, id, manifestSHA), /OPERATION_HELD/);
    assert.deepEqual((await db.doc('_control/temporalReleaseOperation').get()).data(), foreign);
    assert.equal(deleted.length, 0);
    await fixture();
    const before = await coordinator().inspect(tasks);
    await db.doc(contract.historicalSearchJobPaths[0]).update({ state: 'failed' });
    await assert.rejects(coordinator().apply(before, id, manifestSHA));
    assert.equal(deleted.length, 0);
  });
  await test('all 21 prior task names excluded, completed48 and unrelated queue work reject', async () => {
    await fixture();
    const m = await coordinator().inspect(tasks);
    const bad = structuredClone(m);
    bad.exclusions = bad.exclusions.slice(1);
    await assert.rejects(coordinator().apply(bad, id, manifestSHA), /MANIFEST_INVALID/);
    live.set('projects/urm-app-staging/locations/us-central1/queues/processaudiofiletask/tasks/123', {
      name: 'projects/urm-app-staging/locations/us-central1/queues/processaudiofiletask/tasks/123',
    });
    await assert.rejects(coordinator().apply(m, id, manifestSHA), /UNEXPECTED_TASK/);
    assert.equal(deleted.length, 0);
    await fixture();
    await db.doc('_control/temporalReleaseState').update({ phase: 'complete', controlRevision: 48 });
    await db.doc('_control/temporalRelease').update({ revision: 48, admission: 'open' });
    await assert.rejects(coordinator().inspect(tasks), /AUTHORITY_CHANGED/);
    assert.equal(currentLifecycleExclusions().length, 21);
  });
  await test('strict API rejects malformed/error/falsy pages and never follows redirected or duplicate task routes', async () => {
    for (const value of [
      { queues: false },
      { queues: null },
      { error: { code: 403 } },
      { queues: [], nextPageToken: false },
      { queues: [], nextPageToken: '' },
      { queues: [], extra: true },
      [],
    ]) {
      const transport = currentLifecycleTransport({
        credential: { getAccessToken: async () => ({ access_token: 'synthetic' }) },
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => value }),
      });
      await assert.rejects(transport.inventory(), /API_SHAPE/);
    }
  });
} finally {
  await deleteApp(app);
}
