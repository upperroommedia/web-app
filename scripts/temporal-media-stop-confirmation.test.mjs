import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaRecoveryFixture } from './tests/fixtures/media-recovery.mjs';
import { runMediaRecoveryCycle } from './temporal-media-recovery-cycle.mjs';
import {
  observeMediaRecoveryDiagnosticZeroPool,
  mediaDiagnosticNeverStartedProof,
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
async function neverStartedEvidence(o) {
  const before = await observeMediaRecoveryDiagnosticZeroPool(o);
  const observation = {
    schemaVersion: 1,
    operationId: o.operationId,
    planSHA256: hash(o.plan),
    poolSHA256: hash(o.pool),
    namespace: 'urm-app-staging.qwejt',
    observedAt: new Date().toISOString(),
    closureSHA256: hash({ kind: 'no-execution-facts', operationId: o.operationId }),
    protectionSHA256: 'b'.repeat(64),
    computeInventorySHA256: 'c'.repeat(64),
    versionCount: 0,
    partitionCount: 2,
  };
  const after = await observeMediaRecoveryDiagnosticZeroPool(o);
  return { before, observation, after };
}

test('exact diagnostic zero confirms only an original never-started observation', async () => {
  const { o } = await fixture();
  const { before, observation, after } = await neverStartedEvidence(o);
  assert.deepEqual(before.pool, o.pool);
  assert.equal(mediaDiagnosticNeverStartedProof(o, observation, before, after).kind, 'never-started');
  assert.throws(() =>
    mediaDiagnosticNeverStartedProof(
      o,
      {
        ...observation,
        closureSHA256: hash({ kind: 'closed-kernels', operationId: o.operationId }),
      },
      before,
      after
    )
  );
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
test('final awaited authority cannot retime stale, reordered or foreign observations', async () => {
  const { o } = await fixture();
  const { before, observation, after } = await neverStartedEvidence(o);
  for (const [first, seen, last] of [
    [{ ...before, sampledMonotonic: before.sampledMonotonic - 6000 }, observation, after],
    [before, { ...observation, observedAt: new Date(before.sampledAt - 1).toISOString() }, after],
    [before, { ...observation, observedAt: new Date(after.sampledAt + 1).toISOString() }, after],
    [before, observation, { ...after, ancestorsSHA256: '0'.repeat(64) }],
    [before, observation, { ...after, sampledMonotonic: before.sampledMonotonic - 1 }],
    [before, { ...observation, poolSHA256: '0'.repeat(64) }, after],
  ]) {
    assert.throws(() => mediaDiagnosticNeverStartedProof(o, seen, first, last));
  }
});

test('an incomplete never-started observation grants no confirmation', async () => {
  const { o } = await fixture();
  const { before, observation, after } = await neverStartedEvidence(o);
  const { observedAt, ...incomplete } = observation;
  assert.throws(() => mediaDiagnosticNeverStartedProof(o, incomplete, before, after));
});
