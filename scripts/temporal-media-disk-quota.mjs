import { proofDigest } from './temporal-release-runtime.mjs';
const fail = () => {
  throw new Error('CLOUD_RUN_MEDIA_DISK_QUOTA_UNCONFIRMED');
};
const base = 'projects/251680231116/locations/global/services/run.googleapis.com/quotaInfos/';
const quotas = [
  ['MaxPerInstanceEphemeralDiskSizePerProjectRegion', 'run.googleapis.com/max_per_instance_ephemeral_disk'],
  ['EphemeralDiskAllocPerProjectRegion', 'run.googleapis.com/ephemeral_disk_allocation'],
];
export function assertMediaDiskQuotaProof(proof) {
  if (!proof || !Array.isArray(proof.components) || proof.components.length !== 2) fail();
  for (let i = 0; i < quotas.length; i++) {
    const c = proof.components[i],
      [quotaId, metric] = quotas[i];
    if (
      c?.name !== base + quotaId ||
      c.quotaId !== quotaId ||
      c.metric !== metric ||
      c.region !== 'us-central1' ||
      typeof c.effectiveBytes !== 'string' ||
      !/^[1-9][0-9]{0,18}$/.test(c.effectiveBytes) ||
      BigInt(c.effectiveBytes) < 100n * 1024n ** 3n ||
      BigInt(c.effectiveBytes) > 9223372036854775807n ||
      !Number.isFinite(Date.parse(c.observedAt ?? ''))
    )
      fail();
  }
  if (proof.quotaSHA256 !== proofDigest(proof.components.map(({ observedAt: _time, ...value }) => value))) fail();
}
export function assertMediaDiskQuotaFresh(proof) {
  assertMediaDiskQuotaProof(proof);
  if (proof.components.some((c) => Math.abs(Date.now() - Date.parse(c.observedAt)) > 5000)) fail();
}
/** Effective limits only. Neither quota headroom/usage nor native allocation,
 * filesystem free space, availability or media execution is established here.
 */
export async function observeMediaDiskQuota({ role, body }, api) {
  const scratch = body?.template?.volumes?.find((v) => v.name === 'scratch'),
    container = body?.template?.containers?.[0];
  if (
    role !== 'media' ||
    typeof api !== 'function' ||
    scratch?.emptyDir?.medium !== 'DISK' ||
    scratch.emptyDir.sizeLimit !== '100Gi' ||
    container?.resources?.limits?.cpu !== '2' ||
    container.resources.limits.memory !== '4Gi'
  )
    fail();
  const sampledAt = Date.now(),
    sampledMonotonic = performance.now();
  const observedAt = new Date(sampledAt).toISOString();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('MEDIA_QUOTA_READ_DEADLINE')), 5000);
  });
  let limits;
  try {
    limits = await Promise.race([
      Promise.all(quotas.map(([quotaId]) => api(`https://cloudquotas.googleapis.com/v1/${base}${quotaId}`))),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (Date.now() < sampledAt || Date.now() - sampledAt >= 5000 || performance.now() - sampledMonotonic >= 5000) fail();
  const components = limits.map((value, index) => {
    const [quotaId, metric] = quotas[index];
    if (
      value?.name !== base + quotaId ||
      value.quotaId !== quotaId ||
      value.metric !== metric ||
      value.service !== 'run.googleapis.com' ||
      value.metricUnit !== 'By' ||
      !Array.isArray(value.dimensions) ||
      value.dimensions.length !== 1 ||
      value.dimensions[0] !== 'region' ||
      !Array.isArray(value.dimensionsInfos)
    )
      fail();
    const matches = value.dimensionsInfos.filter(
      (row) =>
        row?.dimensions?.region === 'us-central1' ||
        (Array.isArray(row?.applicableLocations) && row.applicableLocations.includes('us-central1'))
    );
    if (matches.length !== 1) fail();
    const row = matches[0];
    if (
      row.dimensions?.region !== 'us-central1' ||
      Object.keys(row.dimensions).join(',') !== 'region' ||
      !Array.isArray(row.applicableLocations) ||
      row.applicableLocations.length !== 1 ||
      row.applicableLocations[0] !== 'us-central1' ||
      typeof row.details?.value !== 'string' ||
      !/^[1-9][0-9]{0,18}$/.test(row.details.value) ||
      BigInt(row.details.value) < 100n * 1024n ** 3n ||
      BigInt(row.details.value) > 9223372036854775807n ||
      ![undefined, false].includes(row.details.rolloutInfo?.ongoingRollout)
    )
      fail();
    return {
      name: value.name,
      quotaId,
      metric,
      region: 'us-central1',
      effectiveBytes: row.details.value,
      observedAt,
    };
  });
  const quotaSHA256 = proofDigest(components.map(({ observedAt: _time, ...value }) => value));
  const proof = {
    quotaSHA256,
    components,
    scope: 'effective limit metadata only; not available capacity or filesystem proof',
  };
  assertMediaDiskQuotaFresh(proof);
  return proof;
}
