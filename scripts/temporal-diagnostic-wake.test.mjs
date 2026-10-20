import test from 'node:test';
import assert from 'node:assert/strict';
import { pulseDiagnosticOutbox, pulseDiagnosticWake } from './temporal-diagnostic-wake.mjs';
import { proofDigest } from './temporal-release-runtime.mjs';
function fixture(expired = true, surface = 'outbox') {
  const operationId = '11111111-2222-4333-8444-555555555555',
    releaseId = '22222222-2222-4333-8444-555555555555';
  const activationReceipt = { identityState: { stage: 'completed' } };
  const m = {
    operationId,
    releaseId,
    bindingDigest: 'a'.repeat(64),
    nonce: 'b'.repeat(32),
    controlVersion: '1:0',
    stateVersion: '2:0',
    expiresAt: Date.now() + (expired ? -1000 : 300000),
    activationDigest: proofDigest(activationReceipt),
  };
  const creation = {
    operationId,
    releaseId,
    bindingDigest: m.bindingDigest,
    identityState: { stage: 'completed', plan: { operationId, surface: `${surface}-trigger` }, resource: { uid: 'controlled-owned-trigger' } },
  };
  const pulse = { operationId, nonce: m.nonce, creationReceiptDigest: proofDigest(creation) };
  const parent = {
    action: 'prepare-cloud-run-dispatch-diagnostic',
    operationId,
    releaseId,
    bindingDigest: m.bindingDigest,
    cloudDispatchDiagnostic: m,
    [surface === 'outbox' ? 'cloudDispatchDiagnosticWake' : 'cloudDispatchDiagnosticCommandsWake']: { stage: 'completed', creationState: creation.identityState },
  };
  const journal = { manifestDigest: proofDigest(m), [`${surface}Pulse`]: pulse },
    record = { state: 'diagnostic', manifestDigest: proofDigest(m), diagnosticPulse: pulse };
  const values = {
    '_control/temporalReleaseOperation': parent,
    '_control/temporalRelease': {
      releaseId,
      admission: 'paused',
      domains: Object.fromEntries(
        ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
          d,
          { admission: 'paused' },
        ])
      ),
    },
    '_control/temporalReleaseState': { releaseId, phase: 'provider-usage-ready' },
    [`_control/temporalDispatchDiagnosticAuthorization-${operationId}`]: m,
    [`_control/temporalDispatchDiagnostic-${operationId}`]: journal,
    [`${surface === 'outbox' ? 'durableJobOutbox' : 'durableJobCommands'}/diagnostic-${operationId}-${surface}`]: record,
    [`_control/temporalDispatchDiagnosticWakeCreation-${operationId}-${surface}`]: creation,
  };
  let writes = 0,
    transactions = 0;
  const firestore = {
    doc: (path) => ({ path }),
    runTransaction: async (fn) => {
      transactions++;
      return fn({
        get: async (ref) => ({
          exists: true,
          data: () => values[ref.path],
          get: (key) => key.split('.').reduce((v, k) => v?.[k], values[ref.path]),
          updateTime: { seconds: ref.path === '_control/temporalRelease' ? 1 : 2, nanoseconds: 0 },
          readTime: { toMillis: () => Date.now() },
        }),
        update: () => {
          writes++;
          throw new Error('Unexpected write');
        },
      });
    },
  };
  return {
    diagnostic: { firestore, manifest: m, activationReceipt },
    parent,
    creation,
    journal,
    record,
    m,
    get writes() {
      return writes;
    },
    get transactions() {
      return transactions;
    },
  };
}
test('expired original pulse remains GET-only after cleanup; expiry cannot emit a new event', async () => {
  const f = fixture();
  await pulseDiagnosticOutbox(f.diagnostic);
  assert.equal(f.writes, 0);
  f.parent.cloudDispatchDiagnosticWake.stage = 'created';
  delete f.journal.outboxPulse;
  delete f.record.diagnosticPulse;
  await assert.rejects(pulseDiagnosticOutbox(f.diagnostic));
  assert.equal(f.writes, 0);
});
test('a pre-pulse start/lease cannot be retroactively given a native-trigger pulse', async () => {
  const f = fixture(false);
  f.parent.cloudDispatchDiagnosticWake.stage = 'created';
  delete f.journal.outboxPulse;
  delete f.record.diagnosticPulse;
  f.record.startAttemptedAt = Date.now();
  await assert.rejects(pulseDiagnosticOutbox(f.diagnostic));
  assert.equal(f.writes, 0);
});
test('parent binding drift between preliminary read and pulse transaction cannot write', async () => {
  const f = fixture(false),
    run = f.diagnostic.firestore.runTransaction;
  f.diagnostic.firestore.runTransaction = async (fn) => {
    const r = await run(fn);
    if (f.transactions === 1) f.parent.bindingDigest = 'f'.repeat(64);
    return r;
  };
  await assert.rejects(pulseDiagnosticOutbox(f.diagnostic));
  assert.equal(f.writes, 0);
});

for (const surface of ['outbox', 'commands']) test(`${surface} cannot inherit the other surface pulse or receipt`, async () => {
  const f = fixture(false, surface), other = surface === 'outbox' ? 'commands' : 'outbox';
  await pulseDiagnosticWake(f.diagnostic, `${surface}-trigger`);
  const original = f.journal[`${surface}Pulse`];
  delete f.journal[`${surface}Pulse`]; f.journal[`${other}Pulse`] = original;
  await assert.rejects(pulseDiagnosticWake(f.diagnostic, `${surface}-trigger`));
  f.journal[`${surface}Pulse`] = original;
  f.creation.identityState.plan.surface = `${other}-trigger`;
  await assert.rejects(pulseDiagnosticWake(f.diagnostic, `${surface}-trigger`));
  assert.equal(f.writes, 0);
});
test('Scheduler cannot acquire a creation/pulse capability', async () => {
  const f = fixture(false);
  await assert.rejects(pulseDiagnosticWake(f.diagnostic, 'scheduler'));
  assert.equal(f.transactions, 0);
});
