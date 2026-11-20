import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadNativeReleaseApplication } from './temporal-native-application.mjs';
import { proofDigest } from './temporal-release-runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const app = loadNativeReleaseApplication(root),
  require = createRequire(new URL('../package.json', import.meta.url));
const { releaseProvenanceDigest } = require(fileURLToPath(
  new URL('../apps/temporal-worker/src/runtime/media-recovery-history.ts', import.meta.url)
));
const { Timestamp } = require('firebase-admin/firestore');
test('operator/application native provenance hashes agree across actual Timestamp and nested snapshots', () => {
  for (const v of [
    new Timestamp(123, 456),
    { createdAt: new Timestamp(123, 456), nested: [{ a: undefined, t: new Timestamp(7, 8) }] },
    { seconds: 123, nanoseconds: 456 },
  ])
    assert.equal(releaseProvenanceDigest(v), proofDigest(v));
});
test('verified native application exposes fixed historical readers and releases owned compiler', () => {
  assert.equal(typeof app.collectCompletedMediaRecoveryExecution, 'function');
  assert.equal(typeof app.confirmCompletedMediaRecoveryProvenance, 'function');
  assert.equal(process[Symbol.for('ts-node.register.instance')], undefined);
});
test('new-parent collector denies same operation ID before any native SDK or document request', async () => {
  let calls = 0;
  const o = {
    db: {
      projectId: 'urm-app-staging',
      databaseId: '(default)',
      runTransaction: () => {
        calls++;
        throw Error('No request permitted');
      },
    },
    client: { options: { namespace: 'urm-app-staging.qwejt' } },
    recoveryOperationId: '11111111-1111-4111-8111-111111111111',
    activationOperationId: '11111111-1111-4111-8111-111111111111',
  };
  await assert.rejects(app.collectCompletedMediaRecoveryExecution(o), /COLLECTION_UNCONFIRMED/);
  await assert.rejects(app.confirmCompletedMediaRecoveryProvenance(o), /COLLECTION_UNCONFIRMED/);
  assert.equal(calls, 0);
});
