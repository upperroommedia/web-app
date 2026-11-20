import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { proofDigest as hash } from '../../temporal-release-runtime.mjs';
export function restoredActivationFixture() {
  const operationId = randomUUID(),
    recoveryOperationId = randomUUID(),
    releaseId = randomUUID(),
    bindingDigest = 'b'.repeat(64),
    buildId = 'a'.repeat(40),
    image = `us-central1-docker.pkg.dev/urm-app-staging/workers/temporal@sha256:${'c'.repeat(64)}`;
  const receipts = Object.fromEntries(
    'runner,scaler,pool,runnerScaler,scalerTrust,poolAccess,firestore,projectRole,projectAccess,storageRole,storageAccess,bootstrapCycle,recovery'
      .split(',')
      .map((k) => [k, { operationId: k === 'recovery' ? recoveryOperationId : randomUUID() }])
  );
  const initial = {
    name: `projects/urm-app-staging/locations/us-central1/workerPools/urm-worker-media-${buildId.slice(0, 20)}`,
    uid: 'pool-uid',
    generation: '7',
    revision: 'normal-revision',
    revisionUid: 'revision-uid',
    etag: 'etag7',
    desiredManualInstanceCount: 0,
  };
  let pool = structuredClone(initial),
    saved,
    patches = 0,
    originReads = 0,
    quotaReads = 0,
    observations = 0;
  let origin = {
    kind: 'restored-media-activation-origin-v1',
    operationId,
    recoveryOperationId,
    bindingDigest,
    releaseId,
    buildId,
    image,
    pool: initial,
    capsuleSHA256: 'd'.repeat(64),
    proofSHA256: 'e'.repeat(64),
    observedAt: new Date().toISOString(),
  };
  const calls = [];
  const quota = () => {
    const components = [
      ['MaxPerInstanceEphemeralDiskSizePerProjectRegion', 'run.googleapis.com/max_per_instance_ephemeral_disk'],
      ['EphemeralDiskAllocPerProjectRegion', 'run.googleapis.com/ephemeral_disk_allocation'],
    ].map(([quotaId, metric]) => ({
      name: `projects/251680231116/locations/global/services/run.googleapis.com/quotaInfos/${quotaId}`,
      quotaId,
      metric,
      region: 'us-central1',
      effectiveBytes: String(100 * 1024 ** 3),
      observedAt: new Date().toISOString(),
    }));
    return { components, quotaSHA256: hash(components.map(({ observedAt, ...c }) => c)) };
  };
  const options = {
    role: 'media',
    operationId,
    recoveryOperationId,
    releaseId,
    bindingDigest,
    evidenceDigest: 'f'.repeat(64),
    receipts,
    save: async (next) => {
      saved = structuredClone(next);
      calls.push(`save:${next.stage}:${next.start?.stage}:${next.stop?.stage}`);
    },
    api: async (url, method, body, fence) => {
      if (method === 'PATCH') {
        await fence();
        patches++;
        calls.push('PATCH');
        assert.equal(body.etag, pool.etag);
        pool = {
          ...pool,
          generation: String(BigInt(pool.generation) + 1n),
          etag: `etag${Number(pool.generation) + 1}`,
          desiredManualInstanceCount: body.scaling.manualInstanceCount,
        };
        return { name: `projects/urm-app-staging/locations/us-central1/operations/op${patches}` };
      }
      return { name: url.replace('https://run.googleapis.com/v2/', ''), done: true, response: { controlled: true } };
    },
    runtime: {
      assertSupported: async () => {},
      readOrigin: async () => {
        originReads++;
        return structuredClone(origin);
      },
      readPool: async () => structuredClone(pool),
      phase: async ({ plan, key }) => ({
        kind: 'restored-media-activation-phase-v1',
        operationId: plan.operationId,
        planSHA256: hash(plan),
        key,
        phaseSHA256: '1'.repeat(64),
        computeSHA256: '2'.repeat(64),
        observedAt: new Date().toISOString(),
      }),
      quota: async () => {
        quotaReads++;
        return quota();
      },
      registration: async ({ plan, pool }) => {
        observations++;
        return {
          kind: 'restored-media-normal-registration-v1',
          operationId: plan.operationId,
          planSHA256: hash(plan),
          pool,
          proofSHA256: '3'.repeat(64),
          observedAt: new Date().toISOString(),
        };
      },
      unused: async () => {},
    },
  };
  return {
    options,
    origin,
    calls,
    replaceOrigin(value) {
      origin = structuredClone(value);
      pool = structuredClone(value.pool);
    },
    get saved() {
      return structuredClone(saved);
    },
    get pool() {
      return pool;
    },
    get patches() {
      return patches;
    },
    get originReads() {
      return originReads;
    },
    get quotaReads() {
      return quotaReads;
    },
    get observations() {
      return observations;
    },
  };
}
