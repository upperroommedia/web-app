import test from 'node:test';
import assert from 'node:assert/strict';
import {
  observeMediaDiskQuota,
  assertMediaDiskQuotaFresh,
  assertMediaDiskQuotaProof,
} from './temporal-media-disk-quota.mjs';
const plan = {
  role: 'media',
  body: {
    template: {
      volumes: [{ name: 'scratch', emptyDir: { medium: 'DISK', sizeLimit: '100Gi' } }],
      containers: [{ resources: { limits: { cpu: '2', memory: '4Gi' } } }],
    },
  },
};
function fixture() {
  const calls = [];
  return {
    calls,
    api: async (url) => {
      calls.push(url);
      return {
        name: url.split('/v1/')[1],
        quotaId: url.split('/').at(-1),
        metric: url.endsWith('MaxPerInstanceEphemeralDiskSizePerProjectRegion')
          ? 'run.googleapis.com/max_per_instance_ephemeral_disk'
          : 'run.googleapis.com/ephemeral_disk_allocation',
        service: 'run.googleapis.com',
        metricUnit: 'By',
        dimensions: ['region'],
        dimensionsInfos: [
          {
            dimensions: { region: 'us-central1' },
            applicableLocations: ['us-central1'],
            details: { value: '107374182400' },
          },
        ],
      };
    },
  };
}
test('two exact effective quotas preserve original component timestamps and stable metadata digest', async () => {
  const f = fixture(),
    proof = await observeMediaDiskQuota(plan, f.api);
  assert.equal(f.calls.length, 2);
  assertMediaDiskQuotaFresh(proof);
  const old = structuredClone(proof);
  old.components[0].observedAt = new Date(Date.now() - 6000).toISOString();
  assertMediaDiskQuotaProof(old);
  assert.throws(() => assertMediaDiskQuotaFresh(old));
  const forged = structuredClone(proof);
  forged.components[0].effectiveBytes = '214748364800';
  assert.throws(() => assertMediaDiskQuotaProof(forged));
});
test('both native limits share one freshness window even when regional allocation returns first', async () => {
  const f = fixture();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const read = observeMediaDiskQuota(plan, async (url) => {
    const response = await f.api(url);
    if (url.endsWith('MaxPerInstanceEphemeralDiskSizePerProjectRegion')) await held;
    return response;
  });
  try {
    assert.equal(f.calls.length, 2);
  } finally {
    release();
  }
  const proof = await read;
  assert.equal(proof.components[0].observedAt, proof.components[1].observedAt);
  assert.equal(proof.components[0].quotaId, 'MaxPerInstanceEphemeralDiskSizePerProjectRegion');
  assert.equal(proof.components[1].quotaId, 'EphemeralDiskAllocPerProjectRegion');
});

for (const bad of [
  'name',
  'metric',
  'unit',
  'region',
  'ambiguous',
  'desired',
  'small',
  'rollout',
  'malformed-rollout',
  'numeric',
  'overflow',
])
  test(`quota ${bad} is not source authority`, async () => {
    const f = fixture();
    await assert.rejects(
      observeMediaDiskQuota(plan, async (url) => {
        const v = await f.api(url),
          r = v.dimensionsInfos[0];
        if (bad === 'name') v.name = v.name.replace('251680231116', '123');
        if (bad === 'metric') v.metric = 'other';
        if (bad === 'unit') v.metricUnit = 'GiBy';
        if (bad === 'region') r.dimensions.region = 'us-east1';
        if (bad === 'ambiguous') v.dimensionsInfos.push(structuredClone(r));
        if (bad === 'desired') {
          delete r.details.value;
          r.details.desiredValue = '107374182400';
        }
        if (bad === 'small') r.details.value = '10737418240';
        if (bad === 'rollout') r.details.rolloutInfo = { ongoingRollout: true };
        if (bad === 'malformed-rollout') r.details.rolloutInfo = { ongoingRollout: 'false' };
        if (bad === 'numeric') r.details.value = 107374182400;
        if (bad === 'overflow') r.details.value = '9999999999999999999';
        return v;
      })
    );
  });
for (const [key, value] of [
  ['medium', 'MEMORY'],
  ['sizeLimit', '10Gi'],
])
  test(`media ${key} cannot silently lower budgets`, async () => {
    const p = structuredClone(plan);
    p.body.template.volumes[0].emptyDir[key] = value;
    const f = fixture();
    await assert.rejects(observeMediaDiskQuota(p, f.api));
    assert.equal(f.calls.length, 0);
  });
