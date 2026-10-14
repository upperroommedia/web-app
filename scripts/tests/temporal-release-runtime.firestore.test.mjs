// Real SDK adapters, isolated DEMO emulator project; no ADC or live API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  artifactProof,
  assertSameArtifact,
  confirmBundleProofInTransaction,
  nativeSnapshotProof,
  assertNativeSnapshot,
  pinReleaseCheckouts,
  loadVerifiedRuntimeApplication,
} from '../temporal-release-runtime.mjs';
const projectId = 'demo-release-runtime';
for (const name of [
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
])
  if (!/^127\.0\.0\.1:\d+$/.test(process.env[name] ?? '')) throw Error('DEDICATED_DEMO_EMULATORS_REQUIRED');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runtimeRoot = resolve(process.env.RELEASE_RUNTIME_TEST_ROOT ?? root);
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
const { durableEntityKey } = require(resolve(runtimeRoot, 'packages/orchestration/src/job-store.ts'));
const { initializeApp, deleteApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const app = initializeApp({
  projectId,
  storageBucket: projectId + '.appspot.com',
  credential: cert({
    projectId,
    clientEmail: 'only-emulator@' + projectId + '.iam.gserviceaccount.com',
    privateKey: generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey,
  }),
});
const db = getFirestore(app),
  bucket = getStorage(app).bucket();
const types = ['topics', 'subtitles', 'bible-chapters', 'sunday-homilies', 'holy-week', 'latest-list'];
const proof = { bundleTypes: types, jobIds: [], artifactProofs: [] };
async function seed() {
  for (const collection of ['durableJobEntities', 'durableJobs', '_durableBundlePointers', '_control'])
    await db.recursiveDelete(db.collection(collection));
  proof.jobIds = [];
  proof.artifactProofs = [];
  for (const [index, type] of types.entries()) {
    const jobId = 'job-' + createHash('sha256').update(type).digest('hex').slice(0, 48),
      path = `bundles/durable/${type}/${jobId}/abc.bin`;
    const pointer = { projectId, jobId, generation: 2, count: index, storagePath: path, publishedAt: 123 };
    const file = bucket.file(path);
    await file.save(Buffer.from('immutable-test-bundle'), {
      resumable: false,
      metadata: { contentType: 'application/octet-stream', metadata: { [`${type}-count`]: String(index) } },
    });
    const [head] = await file.getMetadata();
    const [pinned] = await bucket.file(path, { generation: head.generation }).getMetadata();
    assert.equal(String(pinned.generation), String(head.generation));
    proof.jobIds.push(jobId);
    proof.artifactProofs.push(artifactProof(type, pointer, pinned, bucket.name));
    await db
      .doc('durableJobEntities/' + durableEntityKey(projectId, { type: 'bundle', id: type }, 'bundle.regenerate'))
      .set({ projectId, entity: { type: 'bundle', id: type }, activeJobId: jobId, generation: 2 });
    await db.doc('durableJobs/' + jobId).set({
      projectId,
      jobId,
      kind: 'bundle.regenerate',
      entity: { type: 'bundle', id: type },
      state: 'succeeded',
      generation: 2,
    });
    await db.doc('_durableBundlePointers/' + type).set(pointer);
  }
  await db.doc('_control/release').set({ revision: 11, phase: 'backend-ready', stamp: FieldValue.serverTimestamp() });
}
try {
  await test('actual SDK six generation-pinned artifacts, scope key conformance and native timestamps pass final Firestore fence', async () => {
    await seed();
    const ref = db.doc('_control/release'),
      initial = await ref.get();
    const authority = nativeSnapshotProof(initial);
    await db.runTransaction(async (tx) => {
      assertNativeSnapshot(authority, await tx.get(ref));
      await confirmBundleProofInTransaction(tx, db, proof, projectId);
      tx.create(db.doc('_control/audit'), { proof, stamp: FieldValue.serverTimestamp() });
      tx.update(ref, { revision: 12, phase: 'bundles-ready' });
    });
    assert.equal((await ref.get()).get('revision'), 12);
    assert.equal((await db.doc('_control/audit').get()).get('proof.jobIds').length, 6);
  });
  await test('actual newer canonical pointer during final CAS cannot be certified from stale artifact proof', async () => {
    await seed();
    await db.doc('_durableBundlePointers/topics').update({ generation: 3 });
    await assert.rejects(
      db.runTransaction((tx) => confirmBundleProofInTransaction(tx, db, proof, projectId)),
      /PROOF_CHANGED/
    );
    assert.equal((await db.doc('_control/release').get()).get('revision'), 11);
  });
  await test('actual same-revision native checkpoint mutation is rejected by native full snapshot CAS', async () => {
    await seed();
    const ref = db.doc('_control/release'),
      authority = nativeSnapshotProof(await ref.get());
    await ref.update({ phase: 'unexpected' });
    await assert.rejects(
      db.runTransaction(async (tx) => {
        assertNativeSnapshot(authority, await tx.get(ref));
        await confirmBundleProofInTransaction(tx, db, proof, projectId);
      }),
      /AUTHORITY_CHANGED/
    );
  });
  await test('actual storage overwrite/new metadata cannot reuse prior generation/metageneration proof', async () => {
    await seed();
    const old = proof.artifactProofs[0],
      file = bucket.file(old.path);
    await file.save(Buffer.from('new-bytes'), {
      resumable: false,
      metadata: { contentType: 'application/octet-stream', metadata: { 'topics-count': '0' } },
    });
    const [current] = await file.getMetadata(),
      pointer = (await db.doc('_durableBundlePointers/topics').get()).data();
    assert.throws(
      () => assertSameArtifact(old, artifactProof('topics', pointer, current, bucket.name)),
      /ARTIFACT_CHANGED/
    );
    // Storage and Firestore are separate authorities; this test makes no cross-store atomicity claim.
  });
  await test('actual SDK control read and full frozen source guard reject dirty shared TS before any application load, then clean owned SDK', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, dirname } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const { runWithCleanup } = await import('../temporal-release-resources.mjs');
    const temporary = mkdtempSync(join(tmpdir(), 'release-preload-guard-'));
    let secondary,
      secondaryDb,
      loaded = false,
      closed = false;
    const git = (args) =>
      execFileSync('git', args, { cwd: temporary, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const entries = execFileSync('git', ['ls-files', 'scripts'], { cwd: runtimeRoot, encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter((p) => p.endsWith('.mjs'));
      for (const file of entries) {
        mkdirSync(dirname(join(temporary, file)), { recursive: true });
        writeFileSync(join(temporary, file), readFileSync(join(runtimeRoot, file)));
      }
      for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml'])
        writeFileSync(join(temporary, file), readFileSync(join(runtimeRoot, file)));
      for (const [file, bytes] of Object.entries({
        'package.json': '{}',
        'firebase.json': '{"functions":[{"source":"fixture-functions","codebase":"fixture"}]}',
        'functions/src/temporal/bridge.ts': 'export const fixture = true;',
        'packages/shared/firebase/firebaseAdmin.ts': 'throw new Error("APPLICATION_MUST_NOT_LOAD");',
      })) {
        mkdirSync(dirname(join(temporary, file)), { recursive: true });
        writeFileSync(join(temporary, file), bytes);
      }
      git(['init']);
      git(['add', '.']);
      git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'isolated source guard fixture',
      ]);
      const commit = git(['rev-parse', 'HEAD']).trim();
      writeFileSync(
        join(temporary, 'packages/shared/firebase/firebaseAdmin.ts'),
        'throw new Error("DIRTY_APPLICATION_EXECUTED");'
      );
      const config = { projectId, compatibilityCommit: commit, domains: ['bundles'] };
      const binding = pinReleaseCheckouts(temporary, temporary, config);
      secondary = initializeApp(
        {
          projectId,
          databaseURL: 'https://' + projectId + '-default-rtdb.firebaseio.com',
          credential: app.options.credential,
        },
        'preload-guard'
      );
      secondaryDb = getFirestore(secondary);
      await assert.rejects(
        runWithCleanup(
          () =>
            loadVerifiedRuntimeApplication(binding, config, secondaryDb, () => {
              loaded = true;
              throw Error('DIRTY_APPLICATION_EXECUTED');
            }),
          async () => {
            await secondaryDb.terminate();
            await deleteApp(secondary);
            secondary = undefined;
            closed = true;
          }
        ),
        /Deployment source differs from pinned commit.*firebaseAdmin/
      );
      assert.equal(loaded, false);
      assert.equal(closed, true);
      secondary = undefined;
    } finally {
      if (secondary) {
        await secondaryDb?.terminate();
        await deleteApp(secondary);
      }
      rmSync(temporary, { recursive: true, force: true });
    }
  });
} finally {
  await db.terminate();
  await deleteApp(app);
}
