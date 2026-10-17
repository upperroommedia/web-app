// Real Firestore transactions in a dedicated DEMO project. No ADC, live SDK or provider transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeSnapshotProof, proofDigest } from '../temporal-release-runtime.mjs';
import {
  OWNED_SMOKE_INCIDENT as incident,
  ownedMirrorPaths,
  planOwnedMirrorEdges,
} from '../temporal-owned-smoke-plan.mjs';
import { applyOwnedIndexStage, OWNED_SMOKE_ACTION } from '../temporal-owned-smoke-index-stage.mjs';
for (const name of [
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
])
  if (!/^127\.0\.0\.1:\d+$/.test(process.env[name] ?? '')) throw Error('DEDICATED_DEMO_EMULATORS_REQUIRED');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url))),
  require = createRequire(root + '/functions/package.json');
require('ts-node').register({ project: root + '/functions/tsconfig.json', transpileOnly: true });
require('tsconfig-paths').register({
  baseUrl: root + '/functions',
  paths: {
    '@upperroom/contracts/*': ['../packages/contracts/*'],
    '@upperroom/shared/*': ['../packages/shared/*'],
    '@upperroom/orchestration/*': ['../packages/orchestration/src/*'],
  },
});
const { extractProviderResources, providerResourceKey, providerEdgeKey } = require(root +
  '/packages/orchestration/src/provider-usage.ts');
const { initializeApp, deleteApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const projectId = 'demo-owned-smoke-stage';
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
const row = (snapshot) => ({ path: snapshot.ref.path, data: snapshot.data(), native: nativeSnapshotProof(snapshot) });
const markerPath = '_control/temporalProviderUsage';
const aggregatePath = (resource) =>
  `temporalProviderUsage/${providerResourceKey(resource)}/epochs/${incident.originalEpoch}`;
const operationId = '11111111-2222-4333-8444-555555555555';
const publicationPath = 'sermons/' + incident.sermonId;
async function collectIndexPlan(tx) {
  const get = (ref) => (tx ? tx.get(ref) : ref.get());
  const marker = row(await get(db.doc(markerPath))),
    groups = [];
  for (const resource of incident.resources) {
    const path = aggregatePath(resource),
      aggregate = row(await get(db.doc(path)));
    const edges = await get(db.collection(path + '/edges').limit(201));
    assert(edges.size < 201);
    const paths = [...new Set([...edges.docs.map((d) => d.get('canonicalPath')), ...ownedMirrorPaths()])];
    groups.push({
      resource,
      aggregate,
      edges: { allPages: true, rows: edges.docs.map(row) },
      canonicals: await Promise.all(paths.map(async (p) => row(await get(db.doc(p))))),
    });
  }
  return planOwnedMirrorEdges({ marker, groups, extractResources: extractProviderResources });
}
async function fixture() {
  for (const collection of ['_control', 'temporalProviderUsage', 'sermons', 'lists', 'durableJobs'])
    await db.recursiveDelete(db.collection(collection));
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
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((domain) => [
        domain,
        { owner: 'temporal', admission: release.domains.includes(domain) ? 'paused' : 'open' },
      ])
    ),
  };
  const state = { ...release, controlRevision: 55, phase: 'ownership-changed' };
  const canonical = { subsplashId: incident.resources[1].remoteId, soundCloudTrackId: incident.resources[0].remoteId };
  const batch = db.batch();
  batch.set(db.doc('_control/temporalRelease'), control);
  batch.set(db.doc('_control/temporalReleaseState'), state);
  batch.set(db.doc(markerPath), {
    schemaVersion: 1,
    projectId: incident.projectId,
    epoch: incident.originalEpoch,
    status: 'ready',
  });
  batch.set(db.doc(publicationPath), canonical);
  for (const path of ownedMirrorPaths()) batch.set(db.doc(path), canonical);
  for (const resource of incident.resources) {
    const path = aggregatePath(resource);
    batch.set(db.doc(path), { ...resource, epoch: incident.originalEpoch, state: 'active', referenceCount: 1 });
    batch.set(db.doc(path + '/edges/' + providerEdgeKey(publicationPath)), {
      canonicalPath: publicationPath,
      projectId: incident.projectId,
    });
  }
  batch.set(db.doc('durableJobs/fixture-protected-search'), {
    kind: 'search.sync',
    state: 'queued',
    projectId: incident.projectId,
  });
  await batch.commit();
  const manifest = {
    schemaVersion: 1,
    incidentDigest: proofDigest(incident),
    runtimeCommit: incident.runtimeCommit,
    releaseId: release.releaseId,
    descriptorSHA256: 'a'.repeat(64),
    revision: 55,
    indexPlan: await collectIndexPlan(),
    authority: {
      control: nativeSnapshotProof(await db.doc('_control/temporalRelease').get()),
      state: nativeSnapshotProof(await db.doc('_control/temporalReleaseState').get()),
    },
    protectedDocuments: [
      {
        path: 'durableJobs/fixture-protected-search',
        native: nativeSnapshotProof(await db.doc('durableJobs/fixture-protected-search').get()),
      },
    ],
  };
  const evidence = { syntheticDemoOnly: true, sourceReaders: 'actual-pinned-worktree-source-no-cloud' };
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
  const operation = {
    operationId,
    manifestSHA256: 'f'.repeat(64),
    evidence,
    native: nativeSnapshotProof(await db.doc('_control/temporalReleaseOperation').get()),
  };
  return { release, manifest, operation };
}
const apply = (f, options = {}) =>
  applyOwnedIndexStage({
    db,
    ...f,
    collectIndexPlan: (tx) => collectIndexPlan(tx),
    assertSourceAndInventories: async () => {},
    ...options,
  });
async function assertCounts(expected) {
  for (const resource of incident.resources) {
    const path = aggregatePath(resource);
    assert.equal((await db.doc(path).get()).get('referenceCount'), expected);
    assert.equal((await db.collection(path + '/edges').get()).size, expected);
  }
}
try {
  await test('actual SDK commits exactly six missing edges/two counts with immutable audit and retains ordinary operation', async () => {
    const f = await fixture();
    const result = await apply(f);
    assert.equal(result.operationRetained, true);
    await assertCounts(4);
    assert((await db.doc('_control/temporalReleaseOperation').get()).exists);
    assert.equal((await db.doc('_control/temporalRelease').get()).get('revision'), 55);
    assert.equal((await db.doc('durableJobs/fixture-protected-search').get()).get('state'), 'queued');
    assert.equal((await db.doc(result.auditPath).get()).get('edgeCreates'), 6);
  });
  await test('unknown commit ACK is reconciled from exact audit and native poststate without double counts', async () => {
    const f = await fixture();
    let calls = 0;
    const adapter = {
      doc: db.doc.bind(db),
      collection: db.collection.bind(db),
      runTransaction: async (callback) => {
        const result = await db.runTransaction(callback);
        if (++calls === 1) throw Error('SYNTHETIC_ACK_LOST_AFTER_COMMIT');
        return result;
      },
    };
    await assert.rejects(apply(f, { db: adapter }), /SYNTHETIC_ACK_LOST/);
    await assertCounts(4);
    assert((await db.doc('_control/temporalReleaseOperation').get()).exists);
    await apply(f, { resume: true });
    await assertCounts(4);
    await assert.rejects(apply(f), /INDEX_AUDIT_CONFLICT/);
    await assertCounts(4);
  });
  await test('unknown precommit outcome retains operation and resumes the still-uncommitted atomic stage once', async () => {
    const f = await fixture();
    const adapter = {
      doc: db.doc.bind(db),
      collection: db.collection.bind(db),
      runTransaction: async () => {
        throw Error('SYNTHETIC_BEFORE_COMMIT');
      },
    };
    await assert.rejects(apply(f, { db: adapter }), /SYNTHETIC_BEFORE_COMMIT/);
    await assertCounts(1);
    await apply(f, { resume: true });
    await assertCounts(4);
  });
  await test('canonical change then restoration after commit breaks native resume proof', async () => {
    const f = await fixture();
    await apply(f);
    const ref = db.doc(ownedMirrorPaths()[0]);
    const original = await ref.get(),
      data = original.data();
    // Firestore can optimize an identical set into a no-op. Force an actual version change,
    // then restore the exact data to prove the native stamp fence catches the intervening write.
    await ref.update({ smokeProofTouch: 1 });
    await ref.set(data);
    assert.notDeepEqual(nativeSnapshotProof(await ref.get()), nativeSnapshotProof(original));
    await assert.rejects(apply(f, { resume: true }), /NATIVE_AUTHORITY_CHANGED/);
    await assertCounts(4);
  });
  await test('changed protected search work rejects before any edge creation', async () => {
    const f = await fixture();
    await db.doc('durableJobs/fixture-protected-search').update({ state: 'succeeded' });
    await assert.rejects(apply(f), /NATIVE_AUTHORITY_CHANGED/);
    await assertCounts(1);
  });
  await test('foreign operation and count corruption cannot authorize a stage', async () => {
    let f = await fixture();
    await db.doc('_control/temporalReleaseOperation').update({ operationId: 'aaaaaaaa-2222-4333-8444-555555555555' });
    await assert.rejects(apply(f));
    await assertCounts(1);
    f = await fixture();
    await db.doc(aggregatePath(incident.resources[0])).update({ referenceCount: 2 });
    await assert.rejects(apply(f), /FULL_EDGE_COUNT_REQUIRED/);
    assert.equal((await db.doc(aggregatePath(incident.resources[1])).get()).get('referenceCount'), 1);
  });
} finally {
  await deleteApp(app);
}
