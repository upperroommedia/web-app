import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { controlsBootstrapFixture } from './controls-bootstrap.mjs';
import { bootstrapStopCloudRunMediaPool } from '../../temporal-bootstrap-pool.mjs';
import { proofDigest as hash } from '../../temporal-release-runtime.mjs';
export async function mediaRecoveryFixture() {
  const f = controlsBootstrapFixture('media'),
    old = await bootstrapStopCloudRunMediaPool(f.options);
  let saved;
  const revisions = new Map([
    [
      f.pool.latestReadyRevision,
      { ...structuredClone(f.pool.template), name: f.pool.latestReadyRevision, uid: 'native-revision-original' },
    ],
  ]);
  const calls = [],
    operations = new Map(),
    api = f.options.api;
  const options = {
    ...f.options,
    operationId: randomUUID(),
    receipts: {
      ...f.options.receipts,
      bootstrapCycle: { operationId: old.plan.operationId, releaseId: f.options.releaseId, identityState: old },
    },
    authorizeMutation: async () => {},
    observeProtection: async ({ plan, phase }) => ({
      operationId: plan.operationId,
      phase,
      role: 'media',
      buildId: plan.buildId,
      namespace: f.options.platform.temporalNamespace,
      contractSHA256: hash(plan.contract),
      protectionSHA256: 'd'.repeat(64),
      computeInventorySHA256: 'e'.repeat(64),
      observedAt: new Date(Date.now()).toISOString(),
    }),
    save: async (next) => {
      saved = structuredClone(next);
    },
    api: async (url, method = 'GET', body, fence) => {
      if (method === 'PATCH') {
        if (fence) await fence();
        const key = body.template
          ? body.template.containers[0].env.some((v) => v.name === 'TEMPORAL_MEDIA_RECOVERY_OPERATION')
            ? 'diagnostic'
            : 'restore'
          : body.scaling.manualInstanceCount === 1
          ? 'start'
          : 'stop';
        assert.equal(saved[key]?.stage, 'attempted');
        assert.deepEqual(saved[key].request.body, body);
        assert.equal(body.etag, f.pool.etag);
        calls.push({ key, body: structuredClone(body) });
        const gen = String(BigInt(f.pool.generation) + 1n);
        f.pool = {
          ...f.pool,
          ...(body.template
            ? {
                template: structuredClone(body.template),
                latestCreatedRevision: `${f.pool.name}/revisions/native-${gen}`,
                latestReadyRevision: `${f.pool.name}/revisions/native-${gen}`,
              }
            : { scaling: body.scaling }),
          generation: gen,
          observedGeneration: gen,
          etag: `etag-${gen}`,
        };
        if (body.template)
          revisions.set(f.pool.latestReadyRevision, {
            ...structuredClone(body.template),
            name: f.pool.latestReadyRevision,
            uid: `native-revision-${gen}`,
          });
        const name = `projects/urm-app-staging/locations/us-central1/operations/recovery-${gen}`;
        operations.set(name, { name, done: true, response: structuredClone(f.pool) });
        return { name };
      }
      if (url.includes('/revisions/')) return structuredClone(revisions.get(url.split('/v2/')[1]));
      if (url.includes('/operations/recovery-')) return structuredClone(operations.get(url.split('/v2/')[1]));
      return api(url, method, body, fence);
    },
  };
  const p = (plan, kind) => ({
    kind,
    operationId: plan.operationId,
    bindingDigest: plan.bindingDigest,
    buildId: plan.buildId,
    image: plan.image,
    proofSHA256: 'f'.repeat(64),
  });
  options.runtime = {
    assertSupported: async () => {},
    prepare: async ({ plan }) => p(plan, 'prepared'),
    execute: async ({ plan }) => p(plan, 'recovery'),
    drain: async ({ plan, pool }) => {
      const observation = {
        schemaVersion: 1,
        operationId: plan.operationId,
        planSHA256: hash(plan),
        poolSHA256: hash(pool),
        namespace: 'urm-app-staging.qwejt',
        observedAt: new Date().toISOString(),
        closureSHA256: 'a'.repeat(64),
        protectionSHA256: 'b'.repeat(64),
        computeInventorySHA256: 'c'.repeat(64),
        versionCount: 1,
        partitionCount: 2,
      };
      return { ...p(plan, 'drained'), proofSHA256: hash(observation), observation };
    },
    confirmStopped: async ({ plan }) => p(plan, 'stopped'),
    confirmNeverStarted: async ({ plan }) => p(plan, 'never-started'),
  };
  return {
    f,
    options,
    calls,
    revisions,
    get saved() {
      return saved;
    },
  };
}
