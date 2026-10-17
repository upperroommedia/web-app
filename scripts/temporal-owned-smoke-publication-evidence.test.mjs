import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import { validateOwnedAllocationClosure } from './temporal-owned-smoke-publication-evidence.mjs';
import { OWNED_SMOKE_INCIDENT as incident } from './temporal-owned-smoke-plan.mjs';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const exports = {};
// Production leaf functions only: imports stay inert; no SDK/config/transport initialization.
vm.runInNewContext(
  ts.transpileModule(
    readFileSync(new URL('../functions/src/temporal/publishing/providerReceipts.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }
  ).outputText,
  { exports, require: (name) => (name === 'node:crypto' ? crypto : {}), Buffer }
);
const runtime = exports;
function fixture() {
  const receipts = ['soundcloud-track', 'subsplash-audio', 'subsplash-transcode', 'subsplash-media-item'].map(
    (step) => {
      const family = step === 'soundcloud-track' ? 'soundcloud' : 'subsplash';
      const operationKey = `durable:${incident.projectId}:${incident.publicationJobId}:${incident.sermonId}:${family}-create`;
      const intentPayload = { title: 'Synthetic owned fixture', family };
      const receipt = {
        projectId: incident.projectId,
        jobId: incident.publicationJobId,
        operationKey,
        step,
        intentPayload,
        fingerprint: runtime.providerPayloadFingerprint(intentPayload),
        state: 'confirmed',
        owner: 'synthetic-attempt',
        revision: 3,
        providerExecutionProfile: { mode: 'sandbox', profileId: 'urm-app-staging-publishing-v1', version: 1 },
        providerAccount: {
          provider: family,
          account: family === 'soundcloud' ? 'soundcloud:users:9000000000001' : 'subsplash:app:9XTSHD',
        },
        result: { id: step + '-remote' },
      };
      return { receiptId: runtime.providerReceiptId(operationKey, step), receipt };
    }
  );
  const receipt = receipts[0].receipt;
  const fact = {
    schemaVersion: 1,
    projectId: receipt.projectId,
    jobId: receipt.jobId,
    receiptId: receipts[0].receiptId,
    step: receipt.step,
    attemptOwner: receipt.owner,
    claimRevision: 1,
    payloadFingerprint: receipt.fingerprint,
    providerAccount: receipt.providerAccount,
    providerExecutionProfile: receipt.providerExecutionProfile,
    remoteId: receipt.result.id,
    disposition: 'same_resource',
    acknowledgedAtMillis: 1,
  };
  return {
    receipts,
    acknowledgements: [
      {
        acknowledgementId: runtime.providerPayloadFingerprint([
          fact.receiptId,
          fact.attemptOwner,
          fact.claimRevision,
          fact.remoteId,
        ]),
        acknowledgement: fact,
      },
    ],
  };
}
test('exact four confirmed original allocations allow no late ACK facts or fully joined facts', () => {
  const f = fixture();
  validateOwnedAllocationClosure(f.receipts, [], runtime);
  validateOwnedAllocationClosure(f.receipts, f.acknowledgements, runtime);
});
for (const state of ['prepared', 'executing', 'needs_review'])
  test('rejects unresolved allocation ' + state, () => {
    const f = fixture();
    f.receipts[1].receipt.state = state;
    assert.throws(() => validateOwnedAllocationClosure(f.receipts, [], runtime), /PUBLICATION_ALLOCATION_UNRESOLVED/);
  });
test('rejects extra unresolved receipt even alongside the original complete set', () => {
  const f = fixture();
  f.receipts.push({ ...f.receipts[0], receipt: { ...f.receipts[0].receipt, step: 'other', state: 'executing' } });
  assert.throws(() => validateOwnedAllocationClosure(f.receipts, [], runtime), /PUBLICATION_ALLOCATION_BOUND/);
});
test('rejects extra same-resource acknowledgement that does not join an original confirmed receipt', () => {
  const f = fixture();
  f.acknowledgements[0].acknowledgement.remoteId = 'unexplained-remote';
  assert.throws(
    () => validateOwnedAllocationClosure(f.receipts, f.acknowledgements, runtime),
    /PUBLICATION_ACK_UNJOINED/
  );
});
test('rejects duplicate step, altered payload and mismatched operation identity', () => {
  for (const change of [
    (f) => (f.receipts[1].receipt.step = f.receipts[0].receipt.step),
    (f) => (f.receipts[1].receipt.intentPayload.title = 'Changed'),
    (f) => (f.receipts[1].receipt.operationKey += '-other'),
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => validateOwnedAllocationClosure(f.receipts, [], runtime), /PUBLICATION_ALLOCATION/);
  }
});
