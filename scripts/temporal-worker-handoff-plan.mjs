import { isDeepStrictEqual } from 'node:util';
import { independentPromotionRoles } from './temporal-promotion-roles.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';

const stages = [
  'handoff-cloud-run-orchestration',
  'retire-traditional-staging-workers',
  'attach-cloud-run-worker-compute',
  'verify-cloud-run-worker-wake',
];
const readinessActions = ['workers-ready', 'take-ownership', 'open'];
const roles = ['controls', 'email', 'images', 'media', 'orchestration', 'search'];
const commit = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const providerId = /^[A-Za-z0-9_.:-]{1,256}$/;
const pollerIdentity =
  /^(?:cloud-run-[a-f0-9]{64}-|media-restored-)[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const vm =
  'https://compute.googleapis.com/compute/v1/projects/urm-app-staging/zones/us-central1-a/instances/urm-temporal-staging';
const fail = () => {
  throw new Error('STAGING_WORKER_HANDOFF_PLAN_UNCONFIRMED');
};
const keys = (value, expected) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...expected].sort().join(',');

export function workerHandoffInput(action, args, config, workerHosting) {
  const readiness = workerHosting === 'cloud-run' && readinessActions.includes(action);
  if (!readiness && !stages.includes(action)) return undefined;
  if (config.projectId !== 'urm-app-staging' || config.environment !== 'staging') fail();
  const read = (flag, pattern) => {
    const i = args.indexOf(flag);
    if (i < 0 || i !== args.lastIndexOf(flag) || !pattern.test(args[i + 1] ?? '')) fail();
    return args[i + 1];
  };
  return {
    ...(['attach-cloud-run-worker-compute', 'verify-cloud-run-worker-wake'].includes(action)
      ? { role: read('--worker-compute-role', /^(controls|email|images|media|orchestration|search)$/) }
      : {}),
    plan: read('--worker-handoff-plan', /^\/[^\x00\r\n]+$/),
    planDigest: read('--worker-handoff-plan-sha256', sha256),
    proof: read('--preparation-proof', /^\/[^\x00\r\n]+$/),
    evidenceDigest: read('--preparation-proof-sha256', sha256),
  };
}

/** The input carries references and immutable expectations. Native authority
 * and live matching are re-read by the release operation before mutation. */
export function validateWorkerHandoffPlan(value, config, platform, evidenceDigest) {
  if (
    !keys(value, [
      'schemaVersion',
      'releaseId',
      'buildId',
      'workerImage',
      'previousBuildId',
      'evidenceDigest',
      'promotionOperationIds',
      'pools',
      'traditionalCluster',
    ]) ||
    value.schemaVersion !== 1 ||
    !uuid.test(value.releaseId ?? '') ||
    value.releaseId !== config.releaseId ||
    config.projectId !== 'urm-app-staging' ||
    config.environment !== 'staging' ||
    platform.workerHosting !== 'cloud-run' ||
    platform.firebaseProjectId !== config.projectId ||
    platform.temporalNamespace !== 'urm-app-staging.qwejt' ||
    !commit.test(value.buildId ?? '') ||
    value.buildId !== platform.workerBuildId ||
    !commit.test(value.previousBuildId ?? '') ||
    value.previousBuildId === value.buildId ||
    value.workerImage !== platform.workerImage ||
    !sha256.test(value.evidenceDigest ?? '') ||
    value.evidenceDigest !== evidenceDigest ||
    !keys(value.promotionOperationIds, independentPromotionRoles) ||
    !keys(value.pools, roles) ||
    !Array.isArray(platform.workerRoles) ||
    [...platform.workerRoles].sort().join(',') !== roles.join(',')
  )
    fail();
  const promotionIds = Object.values(value.promotionOperationIds);
  if (new Set(promotionIds).size !== independentPromotionRoles.length || promotionIds.some((id) => !uuid.test(id)))
    fail();
  const instances = new Set();
  const identities = new Set();
  for (const role of roles) {
    const pool = value.pools[role];
    const { poolName } = serverlessResourceNames(value.buildId, role);
    if (
      !keys(pool, ['poolUid', 'revision', 'revisionUid', 'workerIdentity', 'instanceId', 'startedAt']) ||
      !providerId.test(pool.poolUid ?? '') ||
      !providerId.test(pool.revisionUid ?? '') ||
      !providerId.test(pool.instanceId ?? '') ||
      !pollerIdentity.test(pool.workerIdentity ?? '') ||
      typeof pool.revision !== 'string' ||
      pool.revision.length > 63 ||
      !pool.revision.startsWith(poolName) ||
      !/^(?:-[a-z0-9][a-z0-9-]*|\.[1-9][0-9]*)$/.test(pool.revision.slice(poolName.length)) ||
      !Number.isSafeInteger(pool.startedAt) ||
      pool.startedAt <= 1000 ||
      pool.startedAt > Date.now() ||
      instances.has(pool.instanceId) ||
      identities.has(pool.workerIdentity)
    )
      fail();
    instances.add(pool.instanceId);
    identities.add(pool.workerIdentity);
  }
  const cluster = value.traditionalCluster;
  if (
    !keys(cluster, ['context', 'clusterUid', 'nodeUid', 'nodeName', 'builds']) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,200}$/.test(cluster.context ?? '') ||
    !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(cluster.nodeName ?? '') ||
    !uuid.test(cluster.clusterUid ?? '') ||
    !uuid.test(cluster.nodeUid ?? '') ||
    !Array.isArray(cluster.builds) ||
    !cluster.builds.length ||
    cluster.builds.length > 10 ||
    new Set(cluster.builds).size !== cluster.builds.length ||
    !cluster.builds.includes(value.previousBuildId) ||
    cluster.builds.includes(value.buildId) ||
    cluster.builds.some((build) => !commit.test(build))
  )
    fail();
  return value;
}

/** Exact candidate selected by role promotion must be the worker pinned for the handoff. */
export function assertWorkerHandoffPromotion(role, completed, expected) {
  const pool = completed?.resources?.pool;
  const expectedVersion = {
    deploymentName: completed?.plan?.deploymentName,
    buildId: completed?.plan?.buildId,
  };
  if (
    !expected ||
    completed?.plan?.role !== role ||
    pool?.uid !== expected.poolUid ||
    pool?.revision?.split('/').at(-1) !== expected.revision ||
    !completed.observed?.queueRouting?.pollers?.some(
      ({ identity, deploymentOptions }) =>
        identity === expected.workerIdentity && isDeepStrictEqual(deploymentOptions, expectedVersion)
    ) ||
    (role === 'media' && !isDeepStrictEqual(completed.observed.mediaStartup, expected))
  )
    fail();
}

/** Corroborate the fixed legacy staging VM before reading its cluster. */
export async function verifyWorkerHandoffVm(api) {
  const instance = await api(vm);
  if (
    String(instance?.id) !== '6510989279221520106' ||
    instance.name !== 'urm-temporal-staging' ||
    instance.status !== 'RUNNING' ||
    !instance.zone?.endsWith('/us-central1-a') ||
    instance.networkInterfaces?.[0]?.networkIP !== '10.241.0.10' ||
    !instance.selfLink?.endsWith('/projects/urm-app-staging/zones/us-central1-a/instances/urm-temporal-staging')
  )
    fail();
}
