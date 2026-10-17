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
const exports = {};
vm.runInNewContext(
  require('typescript').transpileModule(
    readFileSync(root + '/functions/src/temporal/publishing/providerReceipts.ts', 'utf8'),
    {
      compilerOptions: {
        module: require('typescript').ModuleKind.CommonJS,
        target: require('typescript').ScriptTarget.ES2022,
      },
    }
  ).outputText,
  {
    exports,
    Buffer,
    require: (name) => {
      if (name === 'node:crypto') return crypto;
      if (name === 'firebase-admin/firestore') return require(name);
      if (name === 'firebase-functions/v2/https')
        return {
          HttpsError: class extends Error {
            constructor(code, message) {
              super(message);
              this.code = code;
            }
          },
        };
      return {};
    },
  }
);
const source = exports;
const scope = { projectId: incident.projectId, jobId: incident.publicationJobId };
const permit = (p) =>
  ['temporalProviderReceipts', 'temporalProviderAcknowledgements'].some(
    (root) => p === root || p.startsWith(root + '/')
  );
try {
  await test('actual production receipt reader completes all 401 SDK rows with native FieldPath and inert cursors', async () => {
    await db.recursiveDelete(db.collection('temporalProviderReceipts'));
    await db.recursiveDelete(db.collection('temporalProviderAcknowledgements'));
    const batch = db.batch();
    for (let i = 0; i < 401; i++) {
      const operationKey = `durable:${scope.projectId}:${scope.jobId}:synthetic-${i}`;
      const step = 'synthetic-step';
      batch.set(db.doc('temporalProviderReceipts/' + source.providerReceiptId(operationKey, step)), {
        ...scope,
        operationKey,
        step,
        state: 'confirmed',
        result: { id: 'synthetic-' + i },
      });
    }
    await batch.commit();
    const view = publicationReadonlyView(db, reader(), permit);
    const rows = await source.listProviderReceiptsForJob(scope, view.db);
    assert.equal(rows.length, 401);
    assert.equal(view.proof().protectedDocuments.length, 401);
    assert.equal(view.proof().queries.length, 2);
    assert.equal((await source.listProviderAcknowledgementsForJob(scope, view.db)).length, 0);
    assert(!JSON.stringify(view.proof()).includes('operationKey'));
  });
  await test('actual production receipt reader rejects unknown routing without a write handle', async () => {
    await db.recursiveDelete(db.collection('temporalProviderReceipts'));
    await db
      .doc('temporalProviderReceipts/' + 'a'.repeat(64))
      .set({ ...scope, operationKey: 'wrong', step: 'synthetic', state: 'executing' });
    const view = publicationReadonlyView(db, reader(), permit);
    await assert.rejects(source.listProviderReceiptsForJob(scope, view.db), /inconsistent private routing/);
    assert.equal(view.db.runTransaction, undefined);
  });
} finally {
  await deleteApp(app);
}
