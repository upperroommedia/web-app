import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaRecoveryFixture } from './tests/fixtures/media-recovery.mjs';
import { runMediaRecoveryCycle } from './temporal-media-recovery-cycle.mjs';
import {
  observeMediaRecoveryDiagnosticZeroPool,
  mediaDiagnosticConfirmationProof,
} from './temporal-media-stop-confirmation.mjs';
import { proofDigest as hash } from './temporal-release-runtime.mjs';
async function fixture() {
  const f = await mediaRecoveryFixture(),
    cycle = await runMediaRecoveryCycle(f.options),
    pool = cycle.stop.pool,
    plan = cycle.plan;
  const resource = {
    ...structuredClone(f.f.pool),
    template: structuredClone(plan.diagnosticTemplate),
    scaling: { manualInstanceCount: 0 },
    generation: pool.generation,
    observedGeneration: pool.generation,
    latestCreatedRevision: pool.revision,
    latestReadyRevision: pool.revision,
    etag: pool.etag,
  };
  const api = f.options.api;
  const o = {
    ...f.options,
    config: { ...f.options.config, releaseId: f.options.releaseId },
    plan,
    pool,
    api: async (url, ...args) =>
      url === `https://run.googleapis.com/v2/${plan.name}` ? structuredClone(resource) : api(url, ...args),
  };
  return { o, resource, f };
}
test('exact diagnostic zero is a fresh separate native configuration sample', async () => {
  const { o } = await fixture(),
    sample = await observeMediaRecoveryDiagnosticZeroPool(o);
  assert.deepEqual(sample.pool, o.pool);
  const observation = {
    operationId: o.operationId,
    planSHA256: hash(o.plan),
    poolSHA256: hash(o.pool),
    observedAt: new Date().toISOString(),
  };
  const proof = mediaDiagnosticConfirmationProof(o, 'stopped', observation, sample, sample);
  assert.equal(proof.kind, 'stopped');
  assert.equal(proof.image, o.plan.image);
});
for (const mode of ['etag', 'revision', 'desired-one', 'changed-ancestors'])
  test(`zero confirmation denies ${mode}`, async () => {
    const { o, resource } = await fixture();
    if (mode === 'etag') resource.etag = 'unknown';
    if (mode === 'revision') o.pool = { ...o.pool, revisionUid: 'foreign' };
    if (mode === 'desired-one') resource.scaling.manualInstanceCount = 1;
    if (mode === 'changed-ancestors') o.plan = { ...o.plan, ancestorsSHA256: '0'.repeat(64) };
    await assert.rejects(observeMediaRecoveryDiagnosticZeroPool(o), /ZERO_POOL_UNCONFIRMED/);
  });
test('final awaited authority cannot retime a stale native zero or native observation', async () => {
  const { o } = await fixture(),
    sample = await observeMediaRecoveryDiagnosticZeroPool(o);
  const observation = {
    operationId: o.operationId,
    planSHA256: hash(o.plan),
    poolSHA256: hash(o.pool),
    observedAt: new Date().toISOString(),
  };
  assert.throws(() =>
    mediaDiagnosticConfirmationProof(
      o,
      'stopped',
      observation,
      { ...sample, sampledMonotonic: sample.sampledMonotonic - 6000 },
      sample
    )
  );
  assert.throws(() =>
    mediaDiagnosticConfirmationProof(
      o,
      'stopped',
      { ...observation, observedAt: new Date(Date.now() - 6000).toISOString() },
      sample,
      sample
    )
  );
  assert.throws(() =>
    mediaDiagnosticConfirmationProof(o, 'never-started', observation, sample, {
      ...sample,
      ancestorsSHA256: '0'.repeat(64),
    })
  );
});

test('invalid native observation timestamp never grants a confirmation', async () => {
  const { o } = await fixture(),
    sample = await observeMediaRecoveryDiagnosticZeroPool(o);
  assert.throws(() =>
    mediaDiagnosticConfirmationProof(
      o,
      'stopped',
      { operationId: o.operationId, planSHA256: hash(o.plan), poolSHA256: hash(o.pool) },
      sample,
      sample
    )
  );
});
