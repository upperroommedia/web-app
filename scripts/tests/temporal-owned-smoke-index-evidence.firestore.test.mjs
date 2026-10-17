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
import { collectOwnedMirrorIndexPlan } from '../temporal-owned-smoke-index-evidence.mjs';
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
const runtime = { extractProviderResources, providerResourceKey, providerEdgeKey };
const aggregatePath = (resource) =>
  `temporalProviderUsage/${providerResourceKey(resource)}/epochs/${incident.originalEpoch}`;
async function seed(count = 1) {
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  const canonical = { subsplashId: incident.resources[1].remoteId, soundCloudTrackId: incident.resources[0].remoteId };
  const b = db.batch();
  b.set(db.doc('_control/temporalProviderUsage'), {
    schemaVersion: 1,
    projectId: incident.projectId,
    epoch: incident.originalEpoch,
    status: 'ready',
  });
  for (const path of ownedMirrorPaths()) b.set(db.doc(path), canonical);
  for (let i = 0; i < count; i++) b.set(db.doc('sermons/synthetic-' + i), canonical);
  for (const resource of incident.resources) {
    const path = aggregatePath(resource);
    b.set(db.doc(path), { ...resource, epoch: incident.originalEpoch, state: 'active', referenceCount: count });
    for (let i = 0; i < count; i++) {
      const canonicalPath = 'sermons/synthetic-' + i;
      b.set(db.doc(path + '/edges/' + providerEdgeKey(canonicalPath)), {
        canonicalPath,
        projectId: incident.projectId,
      });
    }
  }
  await b.commit();
}
const collect = () => db.runTransaction((tx) => collectOwnedMirrorIndexPlan({ db, tx, runtime }));
try {
  await test('production index collector obtains exact six-edge plan using actual extractors and complete existing native sources', async () => {
    await seed();
    const plan = await collect();
    assert.equal(plan.edgeCreates, 6);
    assert.equal(plan.countUpdates, 2);
    assert(plan.aggregates.every((g) => g.beforeCount === 1 && g.afterCount === 4 && g.canonicals.length === 4));
    assert(!JSON.stringify(plan).includes('soundCloudTrackId'));
  });
  await test('101 existing edges per resource cross complete pagination rather than a first-page proof', async () => {
    await seed(101);
    const plan = await collect();
    assert(
      plan.aggregates.every(
        (g) => g.beforeCount === 101 && g.existingEdges.length === 101 && g.canonicals.length === 104
      )
    );
  });
  await test('unknown canonical path, wrong routing and count mismatch fail before a plan', async () => {
    for (const mode of ['path', 'routing', 'count']) {
      await seed();
      const path = aggregatePath(incident.resources[0]);
      if (mode === 'count') await db.doc(path).update({ referenceCount: 2 });
      else if (mode === 'routing')
        await db
          .doc(path + '/edges/' + providerEdgeKey('sermons/synthetic-0'))
          .update({ canonicalPath: 'sermons/other' });
      else {
        await db.doc(path + '/edges/' + providerEdgeKey('sermons/synthetic-0')).delete();
        const canonicalPath = '_control/temporalRelease';
        await db
          .doc(path + '/edges/' + providerEdgeKey(canonicalPath))
          .set({ canonicalPath, projectId: incident.projectId });
      }
      await assert.rejects(
        collect(),
        /INDEX_CANONICAL_PATH_INVALID|INDEX_EDGE_ROUTING_CHANGED|FULL_EDGE_COUNT_REQUIRED/
      );
    }
  });
  await test('missing canonical mirror or cleanup-reserved aggregate stops without writes', async () => {
    await seed();
    await db.doc(ownedMirrorPaths()[0]).delete();
    await assert.rejects(collect(), /INDEX_SOURCE_MISSING/);
    await seed();
    await db.doc(aggregatePath(incident.resources[0])).update({ reservation: { synthetic: true } });
    await assert.rejects(collect(), /AGGREGATE_NOT_ORDINARY_ACTIVE/);
  });
} finally {
  await deleteApp(app);
}
