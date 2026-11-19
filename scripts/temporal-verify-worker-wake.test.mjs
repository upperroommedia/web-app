import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyWorkerWake } from './temporal-verify-worker-wake.mjs';

const operationId = '12345678-2222-4222-8222-222222222222';
const releaseId = '12345678-3333-4333-8333-333333333333';
const runId = '12345678-4444-4444-8444-444444444444';
const nonce = operationId.replaceAll('-', '');
const input = { projectId: 'urm-app-staging', buildId: 'a'.repeat(40), role: 'controls', nonce, delayMs: 300000 };
const workflowId = `worker-wake-${nonce}`;
const run = { workflowId, runId, input };
const attempt = { workflowId, input, attemptedAt: Date.now() - 1000 };
const plan = {
  schemaVersion: 1,
  operationId,
  releaseId,
  buildId: input.buildId,
  role: input.role,
  bindingDigest: 'b'.repeat(64),
  evidenceDigest: 'c'.repeat(64),
  protectionSHA256: 'd'.repeat(64),
};
const retryWait = { workflowId, runId, role: input.role, observedAt: Date.now() - 100, eligibleAt: Date.now() - 20 };
const proof = { workflowId, runId, timer: { role: 'orchestration' }, retry: { role: input.role } };

test('retains a lost start acknowledgement and reads only the original execution on resume', async () => {
  let saved,
    starts = 0,
    reconcile = 0;
  const options = {
    ...plan,
    assertAuthority: async () => {},
    beforeStart: async () => {},
    save: async (next) => {
      saved = next;
    },
    status: async () => 2,
    observeRetry: async () => {
      throw new Error('must not fabricate a pending retry');
    },
    collect: async () => {
      throw new Error('must not collect incomplete retry lineage');
    },
    start: async (request) => {
      assert.equal(request.nonce, nonce);
      if (request.saved) {
        assert.deepEqual(request.saved, attempt);
        reconcile++;
        return run;
      }
      starts++;
      await request.saveAttempt(attempt);
      throw new Error('ack lost');
    },
  };
  await assert.rejects(verifyWorkerWake(options), /ack lost/);
  assert.equal(saved.stage, 'attempted');
  await assert.rejects(verifyWorkerWake({ ...options, saved }), /WORKER_WAKE_RELEASE_UNCONFIRMED/);
  assert.equal(starts, 1);
  assert.equal(reconcile, 1);
  assert.equal(saved.stage, 'started');
});

test('joins only the saved original retry and run before writing the wake receipt', async () => {
  let saved = { plan, stage: 'retry-wait', attempt, run, retryWait };
  const result = await verifyWorkerWake({
    ...plan,
    saved,
    assertAuthority: async () => {},
    beforeStart: async () => assert.fail('processed original must resume'),
    save: async (next) => {
      saved = next;
    },
    status: async (original) => {
      assert.deepEqual(original, run);
      return 2;
    },
    observeRetry: async () => assert.fail('preserve original retry observation'),
    start: async () => assert.fail('do not restart a saved probe'),
    collect: async (evidence) => {
      assert.deepEqual(evidence.run, run);
      assert.deepEqual(evidence.retryWait, retryWait);
      assert.ok(evidence.from < evidence.to);
      return proof;
    },
  });
  assert.equal(result.stage, 'completed');
  assert.deepEqual(saved.proof, proof);
});
