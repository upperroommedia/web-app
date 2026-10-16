// Explicit emulator-only regression. Not part of the automatic *.test.mjs suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boundedRecoveryObservation,
  assertBoundedRecoveryIntent,
  RECOVERY_INTENT_MAX_BYTES,
} from '../temporal-recover-pinned-search.mjs';
import { proofDigest } from '../temporal-release-runtime.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const config = JSON.parse(readFileSync(resolve(root, 'firebase.test.json'), 'utf8'));
const projectId = 'demo-pinned-search-audit';
const exactLoopback = (value, port) =>
  value === `127.0.0.1:${port}` || value === `localhost:${port}` || value === `[::1]:${port}`;
// Validate dedicated test ports and a non-existent demo project BEFORE loading the SDK.
// There is no ADC, remote-host, project inference, or native Temporal fallback.
if (
  process.env.GCLOUD_PROJECT !== projectId ||
  !exactLoopback(process.env.FIRESTORE_EMULATOR_HOST, config.emulators.firestore.port) ||
  !exactLoopback(process.env.FIREBASE_EMULATOR_HUB, config.emulators.hub.port)
) {
  throw new Error('Dedicated firebase.test.json emulators:exec with --project demo-pinned-search-audit is required');
}
process.env.METADATA_SERVER_DETECTION = 'none';
const req = createRequire(resolve(root, 'package.json'));
const { Firestore, FieldValue } = req('firebase-admin/firestore');

test('client bounds reject full history before writes and real Firestore persists one immutable bounded audit', async (t) => {
  const db = new Firestore({
    projectId,
    databaseId: `pinned-search-audit-${randomUUID().replaceAll('-', '')}`,
    host: process.env.FIRESTORE_EMULATOR_HOST,
    ssl: false,
  });
  const audit = db.doc('_control/temporalPinnedSearchRecovery-fixture');
  const operation = db.doc('_control/temporalReleaseOperation');
  const authority = db.doc('_control/fixtureAuthority');
  const history = {
    events: Array.from({ length: 2540 }, (_, index) => ({
      eventId: String(index + 1),
      eventType: 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED',
      workflowTaskCompletedEventAttributes: { identity: `synthetic-worker-${index}-${'x'.repeat(720)}` },
    })),
  };
  const historyJSON = JSON.stringify(history);
  const observation = {
    jobIdentity: { jobId: 'job-synthetic-parent', workflowId: 'search:demo:synthetic-parent', runId: 'synthetic-run' },
    jobRevision: 7,
    intentDigest: 'a'.repeat(64),
    entityDigest: 'b'.repeat(64),
    history,
    historyBytes: Buffer.byteLength(historyJSON),
    historySha256: createHash('sha256').update(historyJSON).digest('hex'),
    heads: { synthetic: 'unbounded-native-state' },
    pendingActivities: [],
  };
  const identity = {
    action: 'recover-pinned-search',
    planSha256: 'c'.repeat(64),
    ...observation.jobIdentity,
    targetCommit: 'd'.repeat(40),
    targetImage: `example.invalid/fixture@sha256:${'e'.repeat(64)}`,
    args: ['workflow', 'update-options', '--workflow-id', observation.jobIdentity.workflowId],
    operator: { email: 'synthetic-operator@example.test' },
  };
  // String values alone exceed Firestore's 1 MiB document limit, independent of JSON overhead.
  const historyStringBytes = history.events.reduce(
    (total, event) => total + Buffer.byteLength(event.workflowTaskCompletedEventAttributes.identity),
    0
  );
  assert.ok(historyStringBytes > 1024 * 1024);
  try {
    await authority.create({ revision: 1 });
    // This client-side regression must pass even if an emulator does not enforce cloud quotas.
    assert.throws(() => assertBoundedRecoveryIntent({ ...identity, before: observation }), /RECOVERY_INTENT_TOO_LARGE/);
    assert.equal((await audit.get()).exists, false, 'Client-bound failure must not persist an intent');
    assert.equal((await operation.get()).exists, false, 'Client-bound failure must not acquire the operation');
    let oldFailure;
    try {
      await db.runTransaction(async (tx) => {
        const [gate, oldAudit, oldOperation] = await tx.getAll(authority, audit, operation);
        assert.equal(gate.get('revision'), 1);
        assert.equal(oldAudit.exists, false);
        assert.equal(oldOperation.exists, false);
        tx.create(audit, { ...identity, before: observation, createdAt: FieldValue.serverTimestamp() });
        tx.create(operation, { operationId: 'synthetic-old-audit' });
      });
    } catch (error) {
      oldFailure = error;
    }
    // Observe actual emulator behavior; never fabricate quota enforcement from a mocked error.
    if (oldFailure) {
      assert.match(String(oldFailure.message), /size|bytes|too large|maximum|limit/i);
      assert.equal((await audit.get()).exists, false, 'Rejected audit must not persist');
      assert.equal((await operation.get()).exists, false, 'Rejected transaction must not acquire the operation');
      t.diagnostic(`Actual oversized-document transaction rejected atomically: ${oldFailure.code}`);
    } else {
      t.diagnostic('Emulator accepted the oversized document; cloud quota enforcement is NOT proven by this run');
      await db.runTransaction(async (tx) => {
        await tx.getAll(audit, operation);
        tx.delete(audit);
        tx.delete(operation);
      });
    }

    const summary = boundedRecoveryObservation(observation);
    const bounded = assertBoundedRecoveryIntent({ ...identity, before: summary });
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= RECOVERY_INTENT_MAX_BYTES);
    const persist = () =>
      db.runTransaction(
        async (tx) => {
          // An operator retry reads authority and both records before scheduling any create.
          const [gate, existingAudit, existingOperation] = await tx.getAll(authority, audit, operation);
          assert.equal(gate.get('revision'), 1);
          if (existingAudit.exists) {
            assert.equal(existingOperation.get('operationId'), 'synthetic-bounded-audit');
            assert.equal(existingAudit.get('planSha256'), identity.planSha256);
            return existingAudit.data();
          }
          assert.equal(existingOperation.exists, false);
          tx.create(audit, { ...bounded, createdAt: FieldValue.serverTimestamp() });
          tx.create(operation, { operationId: 'synthetic-bounded-audit', planSha256: identity.planSha256 });
        },
        { maxAttempts: 3 }
      );
    await persist();
    const persisted = (await audit.get()).data();
    assert.deepEqual(await persist(), persisted, 'An operator retry must reuse its immutable audit');
    assert.ok(Buffer.byteLength(JSON.stringify(persisted)) <= RECOVERY_INTENT_MAX_BYTES);
    assert.deepEqual(persisted.before, summary);
    assert.deepEqual(persisted.before.jobIdentity, observation.jobIdentity);
    assert.equal(persisted.before.historySha256, observation.historySha256);
    assert.equal(persisted.before.historyBytes, observation.historyBytes);
    assert.equal(persisted.before.historyEventCount, history.events.length);
    assert.equal(persisted.before.observationDigest, proofDigest(observation));
    assert.equal(persisted.planSha256, identity.planSha256);
    assert.equal(persisted.targetCommit, identity.targetCommit);
    assert.ok(persisted.createdAt.toMillis() > 0);
    for (const field of ['history', 'heads', 'pendingActivities', 'drains'])
      assert.equal(field in persisted.before, false);
    assert.equal((await operation.get()).get('operationId'), 'synthetic-bounded-audit');
    await assert.rejects(
      db.runTransaction(async (tx) => {
        const existing = await tx.get(audit);
        assert.equal(existing.exists, true);
        tx.create(audit, { ...bounded, planSha256: 'f'.repeat(64) });
      }),
      (error) => error.code === 6
    );
    assert.deepEqual((await audit.get()).data(), persisted, 'An existing immutable audit must never be overwritten');
    assert.equal(
      (await db.collection('_control').get()).docs.filter((doc) => doc.id.startsWith('temporalPinnedSearchRecovery-'))
        .length,
      1
    );
  } finally {
    const cleanupErrors = [];
    try {
      await db.recursiveDelete(db.collection('_control'));
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await db.terminate();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Firestore test cleanup failed');
  }
});
