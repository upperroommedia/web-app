// Explicit emulator-only integration entrypoint. Intentionally NOT named *.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSearchBootstrapStore,
  searchBootstrapIdentity,
  searchBootstrapEntityKey,
  runSearchBootstrap,
  confirmSearchBootstrapInTransaction,
  confirmAndWriteSearchReadiness,
  validateSearchBootstrapProof,
} from '../temporal-bootstrap-search.mjs';
import {
  STAGING_SEARCH_TARGET,
  STAGING_SEARCH_INSTANCES,
  stagingSearchSettingsPlan,
} from '../algolia-staging-search-schema.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const config = JSON.parse(readFileSync(resolve(root, 'firebase.test.json'), 'utf8'));
function exactLoopback(value, port) {
  return value === `127.0.0.1:${port}` || value === `localhost:${port}` || value === `[::1]:${port}`;
}
// Fail closed BEFORE loading Admin/Firestore. Never infer a host or fall back to ADC.
if (
  process.env.URM_SEARCH_BOOTSTRAP_EMULATOR_INTEGRATION !== '1' ||
  !exactLoopback(process.env.FIRESTORE_EMULATOR_HOST, config.emulators.firestore.port) ||
  !exactLoopback(process.env.FIREBASE_EMULATOR_HUB, config.emulators.hub.port) ||
  process.env.GCLOUD_PROJECT !== STAGING_SEARCH_TARGET.projectId
) {
  throw new Error(
    'Dedicated firebase.test.json emulators:exec, explicit staging project, and URM_SEARCH_BOOTSTRAP_EMULATOR_INTEGRATION=1 are required'
  );
}
const req = createRequire(resolve(root, 'package.json'));
req('ts-node').register({ project: resolve(root, 'functions/tsconfig.json'), transpileOnly: true });
req('tsconfig-paths').register({
  baseUrl: resolve(root, 'functions'),
  paths: {
    '@upperroom/contracts/*': ['../packages/contracts/*'],
    '@upperroom/orchestration/*': ['../packages/orchestration/src/*'],
    '@upperroom/shared/*': ['../packages/shared/*'],
  },
});
const { Firestore } = req('firebase-admin/firestore');
const { createDurableJobStore, durableEntityKey } = req(resolve(root, 'packages/orchestration/src/job-store.ts'));
const { validateStagingSearchReadiness } = req(resolve(root, 'packages/contracts/stagingSearchReadiness.ts'));

const now = Date.parse('2026-10-15T12:00:00.000Z');
const options = {
  projectId: STAGING_SEARCH_TARGET.projectId,
  releaseId: 'a801c079-a832-4bfa-a526-ec385e49d27f',
  commit: 'a'.repeat(40),
  controlRevision: 17,
  operationId: '99ef4e7e-fadf-4830-b631-68a82a20d82d',
  timeoutMs: 2000,
};
const databaseId = `search-bootstrap-integration-${randomUUID().replaceAll('-', '')}`;
// The real Firestore client recognizes FIRESTORE_EMULATOR_HOST and supplies its
// emulator owner identity without Admin app credential validation or ADC discovery.
// The validated host is also explicit so this constructor cannot select a cloud API.
const db = new Firestore({
  projectId: options.projectId,
  databaseId,
  host: process.env.FIRESTORE_EMULATOR_HOST,
  ssl: false,
});
const bootstrap = createSearchBootstrapStore(db, options, {
  createStore: createDurableJobStore,
  entityKey: durableEntityKey,
});
const durable = createDurableJobStore({ firestore: db, projectId: options.projectId });
const fixtureCollections = ['_control', 'durableJobs', 'durableJobIntents', 'durableJobOutbox', 'durableJobEntities'];
function initialBoundary() {
  return {
    temporalRelease: {
      schemaVersion: 1,
      releaseId: options.releaseId,
      revision: options.controlRevision,
      admission: 'paused',
      domains: Object.fromEntries(
        ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((domain) => [
          domain,
          { owner: 'temporal', admission: domain === 'search' ? 'paused' : 'open' },
        ])
      ),
    },
    temporalReleaseState: {
      releaseId: options.releaseId,
      controlRevision: options.controlRevision,
      compatibilityCommit: options.commit,
      phase: 'backend-ready',
      mode: 'initial-cutover',
      domains: ['search'],
      backendVerifiedAt: now - 1000,
    },
    temporalReleaseOperation: {
      operationId: options.operationId,
      releaseId: options.releaseId,
      action: 'bootstrap-search',
    },
  };
}
function settingsReceipt() {
  const updates = stagingSearchSettingsPlan({
    projectId: options.projectId,
    appId: STAGING_SEARCH_TARGET.appId,
    indexNames: STAGING_SEARCH_INSTANCES.map((row) => row.indexName),
  });
  return {
    projectId: options.projectId,
    appId: STAGING_SEARCH_TARGET.appId,
    mode: 'apply',
    usersPolicy: 'empty-private',
    updates,
    tasks: updates.map((row, index) => ({ indexName: row.indexName, taskID: index + 100, completed: true })),
    verifiedAt: new Date(now).toISOString(),
  };
}
async function reset() {
  // Only our randomized named database; never delete from the emulator's default DB.
  for (const name of fixtureCollections) await db.recursiveDelete(db.collection(name));
  const batch = db.batch();
  for (const [name, value] of Object.entries(initialBoundary())) batch.set(db.doc(`_control/${name}`), value);
  await batch.commit();
}
async function records() {
  const rows = [];
  for (const name of fixtureCollections) {
    const snapshot = await db.collection(name).get();
    for (const doc of snapshot.docs) rows.push({ path: doc.ref.path, data: doc.data(), updateTime: doc.updateTime });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
async function completeJobs() {
  for (const row of STAGING_SEARCH_INSTANCES) {
    const { ref } = searchBootstrapIdentity(options, row.instanceId);
    await durable.project(ref, { state: 'running' });
    await durable.project(ref, { state: 'succeeded', result: { count: row.instanceId === 'users-index' ? 0 : 3 } });
  }
}

async function convergedBootstrap() {
  let clock = now;
  return runSearchBootstrap(options, {
    ...bootstrap,
    now: () => clock,
    readSettings: async () => settingsReceipt(),
    sleep: async () => {
      clock += 100;
      await completeJobs();
    },
  });
}
async function admitLiveSync(jobId, generation) {
  const ref = { projectId: options.projectId, jobId };
  const entity = { type: 'maintenance', id: 'integration-live-document' };
  await db.runTransaction(async (tx) => {
    const head = db.doc(`durableJobEntities/${durableEntityKey(options.projectId, entity, 'search.sync')}`);
    await tx.get(head);
    durable.createInTransaction(tx, {
      ref,
      entity,
      kind: 'search.sync',
      actorUid: 'system:search',
      requestId: `integration-${jobId}`,
      payload: { instanceId: 'sermons-index', documentPath: 'sermons/integration-live' },
      generation,
      createdAt: now,
      dispatch: {
        ref,
        workflowId: `search:${options.projectId}:${jobId}`,
        workflowType: 'SearchDocument',
        taskQueue: 'urm-search',
        startArgs: { ref },
      },
    });
  });
  return { ref, head: db.doc(`durableJobEntities/${durableEntityKey(options.projectId, entity, 'search.sync')}`) };
}
async function advanceSearchReady(proof) {
  return db.runTransaction(async tx => {
    const controlRef = db.doc('_control/temporalRelease');
    const stateRef = db.doc('_control/temporalReleaseState');
    // Controller reads precede helper writes, just as in the real transition.
    await Promise.all([tx.get(controlRef), tx.get(stateRef)]);
    const marker = await confirmAndWriteSearchReadiness(db, tx, options, proof);
    tx.update(controlRef, { revision: options.controlRevision + 1 });
    tx.update(stateRef, { controlRevision: options.controlRevision + 1, phase: 'search-ready' });
    return marker;
  });
}
async function checkpointSnapshots() {
  return Promise.all(['temporalRelease', 'temporalReleaseState', 'temporalSearchReadiness'].map(async name => {
    const row = await db.doc(`_control/${name}`).get();
    return { name, exists: row.exists, data: row.data(), updateTime: row.updateTime };
  }));
}
const confirmFinal = (proof) => db.runTransaction((tx) => confirmSearchBootstrapInTransaction(db, tx, options, proof));

test('actual Firestore paused-search bootstrap transactions', { concurrency: false, timeout: 60000 }, async (t) => {
  try {
    await t.test(
      'five admissions create real jobs, immutable intents, dispatch outbox and scoped generations; concurrent retries are read-only',
      async () => {
        await reset();
        for (const row of STAGING_SEARCH_INSTANCES) {
          const proof = await bootstrap.submit(row.instanceId);
          assert.equal(validateSearchBootstrapProof(proof, options, row.instanceId, false), true);
        }
        for (const name of fixtureCollections.filter((name) => name !== '_control'))
          assert.equal((await db.collection(name).get()).size, 5, name);
        for (const row of STAGING_SEARCH_INSTANCES) {
          const { ref, payload } = searchBootstrapIdentity(options, row.instanceId);
          const [job, intent, outbox, entity] = await Promise.all([
            db.doc(`durableJobs/${ref.jobId}`).get(),
            db.doc(`durableJobIntents/${ref.jobId}`).get(),
            db.doc(`durableJobOutbox/${ref.jobId}`).get(),
            db.doc(`durableJobEntities/${searchBootstrapEntityKey(options, row.instanceId)}`).get(),
          ]);
          assert.equal(job.get('state'), 'queued');
          assert.equal(job.get('generation'), 1);
          assert.deepEqual(intent.get('payload'), payload);
          assert.equal(outbox.get('state'), 'pending');
          assert.equal(outbox.get('dispatch.workflowType'), 'SearchBackfill');
          assert.equal(outbox.get('dispatch.taskQueue'), 'urm-search');
          assert.deepEqual(outbox.get('dispatch.startArgs.ref'), ref);
          assert.equal(entity.get('activeJobId'), ref.jobId);
          assert.equal(entity.get('generation'), 1);
        }
        const before = await records();
        await Promise.all(
          STAGING_SEARCH_INSTANCES.flatMap((row) => [
            bootstrap.submit(row.instanceId),
            bootstrap.submit(row.instanceId),
          ])
        );
        assert.deepEqual(await records(), before, 'idempotency must preserve document values and update times');
      }
    );
    await t.test('replaced operation or control denies duplicate submission without writes', async () => {
      for (const [path, patch] of [
        ['_control/temporalReleaseOperation', { operationId: randomUUID() }],
        ['_control/temporalRelease', { revision: options.controlRevision + 1 }],
      ]) {
        await reset();
        await bootstrap.submit('sermons-index');
        await db.doc(path).update(patch);
        const before = await records();
        await assert.rejects(bootstrap.submit('sermons-index'), /SEARCH_BOOTSTRAP_AUTHORITY_CHANGED/);
        assert.deepEqual(await records(), before);
      }
    });
    await t.test('real transactional not-in query blocks unrelated active work before admission', async () => {
      await reset();
      await db
        .doc('durableJobs/unrelated-active')
        .set({ projectId: options.projectId, kind: 'sermon.publish', state: 'running' });
      const before = await records();
      await assert.rejects(bootstrap.submit('sermons-index'), /SEARCH_BOOTSTRAP_OTHER_WORK_NOT_DRAINED/);
      assert.deepEqual(await records(), before);
      await db.doc('durableJobs/unrelated-active').update({ state: 'succeeded' });
      await bootstrap.submit('sermons-index');
      assert.equal((await db.collection('durableJobOutbox').get()).size, 1, 'terminal unrelated job does not block');
    });
    await t.test(
      'real durable projections converge and final transaction rejects changed generation and authority',
      async () => {
        await reset();
        let clock = now,
          sleeps = 0;
        const proof = await runSearchBootstrap(options, {
          ...bootstrap,
          now: () => clock,
          readSettings: async () => settingsReceipt(),
          sleep: async () => {
            assert.equal(++sleeps, 1);
            clock += 100;
            await completeJobs();
          },
        });
        assert.equal(proof.result, 'passed');
        assert.equal(proof.jobIds.length, 5);
        assert.equal(sleeps, 1);
        assert.equal(proof.counts[STAGING_SEARCH_INSTANCES.findIndex((row) => row.instanceId === 'users-index')], 0);
        await db.runTransaction((tx) => confirmSearchBootstrapInTransaction(db, tx, options, proof));
        const entity = db.doc(`durableJobEntities/${searchBootstrapEntityKey(options, 'sermons-index')}`);
        await entity.update({ generation: 2 });
        await assert.rejects(
          db.runTransaction((tx) => confirmSearchBootstrapInTransaction(db, tx, options, proof)),
          /SEARCH_BOOTSTRAP_PROOF_CHANGED/
        );
        await entity.update({ generation: 1 });
        await db.doc('_control/temporalReleaseOperation').update({ operationId: randomUUID() });
        await assert.rejects(
          db.runTransaction((tx) => confirmSearchBootstrapInTransaction(db, tx, options, proof)),
          /SEARCH_BOOTSTRAP_AUTHORITY_CHANGED/
        );
      }
    );
    await t.test('fresh UI/open barrier rejects a newly pending live sync and a later owner replacement', async () => {
      await reset();
      const proof = await convergedBootstrap();
      await confirmFinal(proof);
      const live = await admitLiveSync('integration-live-pending', 1);
      await assert.rejects(confirmFinal(proof), /SEARCH_BOOTSTRAP_NOT_CONVERGED/);
      await durable.project(live.ref, { state: 'running' });
      await durable.project(live.ref, { state: 'succeeded' });
      await confirmFinal(proof);
      await db.doc('_control/temporalRelease').update({ 'domains.search.owner': 'legacy' });
      await assert.rejects(confirmFinal(proof), /SEARCH_BOOTSTRAP_AUTHORITY_CHANGED/);
    });
    await t.test(
      'failed and cancelled live sync require strictly newer successful canonical head in actual Firestore',
      async () => {
        for (const failedState of ['failed', 'cancelled']) {
          await reset();
          const proof = await convergedBootstrap();
          const old = await admitLiveSync(`integration-live-${failedState}`, 1);
          await durable.project(old.ref, { state: 'running' });
          await durable.project(old.ref, { state: failedState });
          await assert.rejects(confirmFinal(proof), /SEARCH_BOOTSTRAP_REQUIRES_REVIEW/);
          const current = await admitLiveSync(`integration-live-${failedState}-replacement`, 2);
          await assert.rejects(confirmFinal(proof), /SEARCH_BOOTSTRAP_REQUIRES_REVIEW/);
          await durable.project(current.ref, { state: 'running' });
          await durable.project(current.ref, { state: 'succeeded' });
          await confirmFinal(proof);
          const headValue = (await current.head.get()).data();
          const currentDoc = db.doc(`durableJobs/${current.ref.jobId}`);
          const jobValue = (await currentDoc.get()).data();
          // Mutations model persisted authority corruption and must never be accepted as repair.
          for (const patch of [{ generation: 1 }, { activeJobId: 'missing-live-head' }, { projectId: 'urm-app' }]) {
            await current.head.update(patch);
            await assert.rejects(confirmFinal(proof), /SEARCH_BOOTSTRAP_REQUIRES_REVIEW/);
            await current.head.set(headValue);
          }
          for (const patch of [{ projectId: 'urm-app' }, { kind: 'search.backfill' }, { generation: 1 }]) {
            await currentDoc.update(patch);
            await assert.rejects(confirmFinal(proof), /SEARCH_BOOTSTRAP_REQUIRES_REVIEW/);
            await currentDoc.set(jobValue);
          }
          await current.head.delete();
          await assert.rejects(confirmFinal(proof), /SEARCH_BOOTSTRAP_REQUIRES_REVIEW/);
          await current.head.set(headValue);
          await currentDoc.delete();
          await assert.rejects(confirmFinal(proof), /SEARCH_BOOTSTRAP_REQUIRES_REVIEW/);
          await currentDoc.set(jobValue);
          await confirmFinal(proof);
        }
      }
    );
    await t.test('search-ready atomically persists contract-valid private marker with control/state revision', async () => {
      await reset();
      const proof = await convergedBootstrap();
      const marker = await advanceSearchReady(proof);
      const [control, state, stored] = await checkpointSnapshots();
      assert.equal(control.data.revision, options.controlRevision + 1);
      assert.equal(state.data.controlRevision, options.controlRevision + 1);
      assert.equal(state.data.phase, 'search-ready');
      assert.deepEqual(stored.data, marker);
      assert.equal(marker.controlRevision, options.controlRevision + 1);
      assert.deepEqual(marker.jobIds, proof.jobIds);
      assert.deepEqual(marker.generations, proof.generations);
      assert.deepEqual(marker.counts, proof.counts);
      validateStagingSearchReadiness(control.data, stored.data);
      assert.ok(control.updateTime.isEqual(state.updateTime));
      assert.ok(control.updateTime.isEqual(stored.updateTime), 'marker and both controller docs share one commit');
    });
    await t.test('changed owner/operation or pending job cannot create or overwrite private readiness marker', async () => {
      for (const hasExistingMarker of [false, true]) {
        await reset();
        const proof = await convergedBootstrap();
        if (hasExistingMarker) {
          await advanceSearchReady(proof);
          // Model a later search checkpoint using the prior persisted marker.
          const batch = db.batch();
          for (const [name, value] of Object.entries(initialBoundary())) batch.set(db.doc(`_control/${name}`), value);
          await batch.commit();
        }
        for (const changed of ['owner', 'operation', 'pending']) {
          let live;
          if (changed === 'owner') await db.doc('_control/temporalRelease').update({ 'domains.search.owner': 'legacy' });
          if (changed === 'operation') await db.doc('_control/temporalReleaseOperation').update({ operationId: randomUUID() });
          if (changed === 'pending') live = await admitLiveSync(`integration-marker-pending-${hasExistingMarker}`, 1);
          const before = await checkpointSnapshots();
          await assert.rejects(advanceSearchReady(proof), changed === 'pending' ? /SEARCH_BOOTSTRAP_NOT_CONVERGED/ : /SEARCH_BOOTSTRAP_AUTHORITY_CHANGED/);
          assert.deepEqual(await checkpointSnapshots(), before, `${changed}: failed transition must not write marker/control/state`);
          assert.equal(before.find(row => row.name === 'temporalSearchReadiness').exists, hasExistingMarker);
          if (changed === 'owner') await db.doc('_control/temporalRelease').update({ 'domains.search.owner': 'temporal' });
          if (changed === 'operation') await db.doc('_control/temporalReleaseOperation').update({ operationId: options.operationId });
          if (live) {
            await durable.project(live.ref, { state: 'running' });
            await durable.project(live.ref, { state: 'succeeded' });
          }
        }
      }
    });
  } finally {
    for (const name of fixtureCollections) await db.recursiveDelete(db.collection(name));
    await db.terminate();
  }
});
