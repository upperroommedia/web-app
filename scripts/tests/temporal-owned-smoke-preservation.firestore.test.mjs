// Dedicated DEMO SDK tests of bounded publication read-only SDK views. No ADC, real mail or workflow transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeSnapshotProof, proofDigest } from '../temporal-release-runtime.mjs';
import { OWNED_SMOKE_INCIDENT as incident } from '../temporal-owned-smoke-plan.mjs';
import { OWNED_SMOKE_ACTION } from '../temporal-owned-smoke-index-stage.mjs';
import {
  collectOwnedSearchPreservation,
  assertOwnedSearchPreservation,
  collectOwnedEmptyQueueInventory,
} from '../temporal-owned-smoke-preservation.mjs';
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
const runtime = { durableEntityKey };
const contract = JSON.parse(readFileSync(root + '/ops/temporal/owned-smoke-search-preservation.staging.json', 'utf8'));
async function seed() {
  for (const collection of await db.listCollections()) await db.recursiveDelete(collection);
  const batch = db.batch();
  for (const p of contract.parents) {
    const jobId = p.jobPath.split('/')[1],
      entity = p.entity;
    batch.set(db.doc(p.jobPath), {
      projectId: contract.projectId,
      jobId,
      kind: 'search.backfill',
      generation: 2,
      state: 'succeeded',
      entity,
    });
    batch.set(db.doc(p.intentPath), {
      projectId: contract.projectId,
      jobId,
      kind: 'search.backfill',
      generation: 2,
      entity,
    });
    batch.set(db.doc(p.entityPath), { projectId: contract.projectId, activeJobId: jobId, generation: 2, entity });
  }
  for (const [i, path] of contract.historicalSearchJobPaths.entries())
    batch.set(db.doc(path), {
      projectId: contract.projectId,
      kind: 'search.sync',
      state: i % 2 ? 'succeeded' : 'queued',
      privateFixture: 'synthetic-sensitive-payload',
    });
  await batch.commit();
}
try {
  await test('fresh fixed23 and complete queued-search set preserve historical CURRENT states and native pins', async () => {
    await seed();
    await db
      .doc('durableJobs/new-current-search')
      .set({ projectId: contract.projectId, kind: 'search.sync', state: 'queued' });
    const proof = await db.runTransaction((tx) => collectOwnedSearchPreservation({ db, tx, runtime }));
    assert.equal(proof.protectedDocuments.length, 24);
    assert.equal(proof.currentQueuedSearchPaths.length, 5);
    assert(!JSON.stringify(proof).includes('synthetic-sensitive-payload'));
    await db.runTransaction((tx) => assertOwnedSearchPreservation({ db, tx, runtime, expected: proof }));
    await db.doc(contract.historicalSearchJobPaths[1]).update({ state: 'superseded' });
    await assert.rejects(
      db.runTransaction((tx) => assertOwnedSearchPreservation({ db, tx, runtime, expected: proof })),
      /PRESERVED_SEARCH_SET_CHANGED/
    );
  });
  await test('complete queued pagination includes 101 new jobs rather than a first-page claim', async () => {
    await seed();
    const b = db.batch();
    for (let i = 0; i < 101; i++)
      b.set(db.doc('durableJobs/new-' + String(i).padStart(3, '0')), {
        projectId: contract.projectId,
        kind: 'search.sync',
        state: 'queued',
      });
    await b.commit();
    const proof = await db.runTransaction((tx) => collectOwnedSearchPreservation({ db, tx, runtime }));
    assert.equal(proof.currentQueuedSearchPaths.length, 105);
    assert.equal(proof.protectedDocuments.length, 124);
  });
  await test('queued membership changes and nonsearch queued work stop preservation', async () => {
    await seed();
    const expected = await db.runTransaction((tx) => collectOwnedSearchPreservation({ db, tx, runtime }));
    await db
      .doc('durableJobs/new-current-search')
      .set({ projectId: contract.projectId, kind: 'search.sync', state: 'queued' });
    await assert.rejects(
      db.runTransaction((tx) => assertOwnedSearchPreservation({ db, tx, runtime, expected })),
      /PRESERVED_SEARCH_SET_CHANGED/
    );
    await db.doc('durableJobs/new-current-search').update({ kind: 'email.deliver' });
    await assert.rejects(
      db.runTransaction((tx) => collectOwnedSearchPreservation({ db, tx, runtime })),
      /QUEUED_SEARCH_SET_INVALID/
    );
  });
  await test('original parent generation/entity or missing historical sources stop before writes', async () => {
    await seed();
    await db.doc(contract.parents[0].entityPath).update({ generation: 3 });
    await assert.rejects(
      db.runTransaction((tx) => collectOwnedSearchPreservation({ db, tx, runtime })),
      /ORIGINAL_GEN2_PARENT_CHANGED/
    );
    await seed();
    const p = contract.parents[0];
    const foreign = { type: 'maintenance', id: 'foreign-instance' };
    for (const path of [p.jobPath, p.intentPath, p.entityPath]) await db.doc(path).update({ entity: foreign });
    await assert.rejects(
      db.runTransaction((tx) => collectOwnedSearchPreservation({ db, tx, runtime })),
      /ORIGINAL_GEN2_PARENT_CHANGED/
    );
    await seed();
    await db.doc(contract.historicalSearchJobPaths[0]).delete();
    await assert.rejects(
      db.runTransaction((tx) => collectOwnedSearchPreservation({ db, tx, runtime })),
      /PRESERVED_SEARCH_DOCUMENT_MISSING/
    );
  });
  await test('all13 FULL queues and every task page are read without exposing queue payloads', async () => {
    const calls = [];
    const getJSON = async (path) => {
      calls.push(path);
      if (path.startsWith('projects/' + contract.projectId + '/locations/us-central1/queues?'))
        return path.includes('pageToken=')
          ? { queues: contract.queues.slice(6) }
          : { queues: contract.queues.slice(0, 6), nextPageToken: 'second' };
      return {};
    };
    const proof = await collectOwnedEmptyQueueInventory({ getJSON });
    assert.equal(proof.queues.length, 13);
    assert.equal(calls.length, 15);
    assert(calls.filter((p) => p.includes('/tasks?')).every((p) => p.includes('responseView=FULL')));
  });
  await test('extra, changed, unknown-task and cyclic queue pages fail closed', async () => {
    const parent = 'projects/' + contract.projectId + '/locations/us-central1/queues?';
    for (const mode of ['extra', 'state', 'task', 'cycle'])
      await assert.rejects(
        collectOwnedEmptyQueueInventory({
          getJSON: async (path) => {
            if (path.startsWith(parent)) {
              if (mode === 'cycle') return { queues: [], nextPageToken: 'same' };
              const queues = structuredClone(contract.queues);
              if (mode === 'extra') queues.push({ name: 'other', state: 'PAUSED' });
              if (mode === 'state') queues[0].state = 'DISABLED';
              return { queues };
            }
            return mode === 'task'
              ? { tasks: [{ name: 'unknown-task', httpRequest: { body: 'synthetic-private-body' } }] }
              : {};
          },
        }),
        /EXACT_QUEUE_SET_REQUIRED|QUEUE_STATE_CHANGED|QUEUE_NOT_DRAINED|QUEUE_CURSOR_INVALID/
      );
  });
  await test('malformed task arrays, API errors and invalid pagination tokens never certify empty queues', async () => {
    for (const bad of [
      { tasks: null },
      { tasks: false },
      { tasks: 0 },
      { tasks: '' },
      { error: { code: 403 } },
      { tasks: [], nextPageToken: false },
      { tasks: [], nextPageToken: 0 },
      { tasks: [], nextPageToken: null },
      [],
    ]) {
      await assert.rejects(
        collectOwnedEmptyQueueInventory({
          getJSON: async (path) => (path.includes('/tasks?') ? bad : { queues: contract.queues }),
        }),
        /QUEUE_RESPONSE_INVALID/
      );
    }
  });
} finally {
  await deleteApp(app);
}
