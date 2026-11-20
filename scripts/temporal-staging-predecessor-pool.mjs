import { isDeepStrictEqual } from 'node:util';
import { verifyPreparedPoolMetadata } from './temporal-prepare-cloud-pool.mjs';
import { normalizeStagingResourceName as normalize } from './temporal-preparation-resources.mjs';
import { proofDigest } from './temporal-release-runtime.mjs';

// Canonical Firestore plan from the original unversioned attempt. This pins the
// release, operation, runner receipt, image, secret versions and full 100Gi body.
const originalPlanDigest = '18fabd0a94b40f31010730da3f647ab54d764243529c612c78189ae870e4ad22';
const poolId = 'urm-worker-media-b008afa426291ad2aa94';
const name = `projects/urm-app-staging/locations/us-central1/workerPools/${poolId}`;
const apiBase = 'https://run.googleapis.com/v2/';
const latest = 'INSTANCE_SPLIT_ALLOCATION_TYPE_LATEST';
const uid = /^[A-Za-z0-9_-]{1,256}$/;
const poolFields = new Set([
  'name', 'uid', 'etag', 'generation', 'observedGeneration', 'labels', 'annotations',
  'createTime', 'updateTime', 'creator', 'lastModifier', 'launchStage', 'template', 'scaling',
  'instanceSplits', 'instanceSplitStatuses', 'latestCreatedRevision', 'latestReadyRevision',
  'terminalCondition', 'conditions', 'reconciling',
]);
const revisionFields = new Set([
  'name', 'uid', 'etag', 'generation', 'observedGeneration', 'labels', 'annotations',
  'createTime', 'updateTime', 'creator', 'launchStage', 'conditions', 'reconciling', 'logUri',
  'serviceAccount', 'containers', 'volumes',
]);

function fail() {
  throw new Error('STAGING_PREDECESSOR_POOL_UNCONFIRMED');
}

function assertNativeIdentity(resource, fields) {
  if (!resource || Object.keys(resource).some(key => !fields.has(key)) ||
    typeof resource.uid !== 'string' || !uid.test(resource.uid) ||
    typeof resource.etag !== 'string' || !resource.etag.trim() ||
    String(resource.generation) !== '1' || String(resource.observedGeneration) !== '1' ||
    (resource.reconciling !== undefined && resource.reconciling !== false)) fail();
}

function assertDefaultSplit(pool, revision) {
  const desired = pool.instanceSplits === undefined ? [] : pool.instanceSplits;
  if (!Array.isArray(desired) || desired.length > 1 ||
    (desired.length && !isDeepStrictEqual(desired[0], { type: latest, percent: 100 }))) fail();
  const status = pool.instanceSplitStatuses;
  if (!Array.isArray(status) || status.length !== 1 || !status[0] ||
    Object.keys(status[0]).sort().join(',') !== 'percent,revision,type' ||
    status[0].type !== latest || status[0].percent !== 100 ||
    normalize(status[0].revision) !== revision) fail();
}

function checkPool(plan, resource) {
  assertNativeIdentity(resource, poolFields);
  const pool = verifyPreparedPoolMetadata(plan, resource);
  const prefix = name + '/revisions/' + poolId;
  const suffix = pool.revision?.slice(prefix.length);
  if (!pool.revision?.startsWith(prefix) || !/^(?:-[a-z0-9][a-z0-9-]*|\.[1-9][0-9]*)$/.test(suffix) ||
    poolId.length + suffix.length > 63 || resource.scaling?.scalingMode !== 'MANUAL' ||
    resource.launchStage !== plan.body.launchStage || !isDeepStrictEqual(resource.template, plan.body.template) ||
    !isDeepStrictEqual(resource.annotations, plan.body.annotations) ||
    !isDeepStrictEqual(resource.labels, plan.body.labels)) fail();
  assertDefaultSplit(resource, pool.revision);
  return pool;
}

/** GET-only, under the caller's independently checked original Firestore custody.
 * A late matching configuration proves neither execution count nor create causality. */
export async function observeStagingPredecessorPool({ plan, api }) {
  if (typeof api !== 'function' || plan?.body?.name !== name || proofDigest(plan) !== originalPlanDigest) fail();
  const base = { schemaVersion: 1, name, planSHA256: originalPlanDigest, createDisposition: 'unknown' };
  let sent = false, resource;
  try {
    resource = await api(apiBase + name, 'GET', undefined, () => { sent = true; });
  } catch (error) {
    if (sent && error?.status === 404)
      return { ...base, state: 'absent', observedAt: new Date().toISOString() };
    throw error;
  }
  if (!sent) fail();
  const pool = checkPool(plan, resource);
  const revision = await api(apiBase + pool.revision, 'GET');
  assertNativeIdentity(revision, revisionFields);
  const { containers, serviceAccount, volumes } = revision;
  const ready = Array.isArray(revision.conditions) && revision.conditions.filter(condition => condition?.type === 'Ready');
  if (normalize(revision.name) !== pool.revision || revision.uid === resource.uid ||
    !isDeepStrictEqual({ containers, serviceAccount, volumes }, plan.body.template) ||
    !ready || ready.length !== 1 || ready[0].state !== 'CONDITION_SUCCEEDED') fail();
  // Confirm that both GETs describe one stable first-generation resource.
  const reread = await api(apiBase + name, 'GET');
  if (!isDeepStrictEqual(checkPool(plan, reread), pool) || reread.etag !== resource.etag) fail();
  return {
    ...base, state: 'matching-manual-zero', pool, poolEtag: resource.etag,
    revisionUid: revision.uid, revisionEtag: revision.etag, observedAt: new Date().toISOString(),
  };
}
