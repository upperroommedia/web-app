import { createHash } from 'node:crypto';
import { observeWorkerCompute } from './temporal-attach-worker-compute.mjs';
const fail = () => { throw new Error('CLOUD_RUN_COMPUTE_ISOLATION_UNCONFIRMED'); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const name = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value);
function emptyCompute(value) {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'scalingGroups') ||
    (value.scalingGroups !== undefined && (value.scalingGroups === null || typeof value.scalingGroups !== 'object' ||
      Array.isArray(value.scalingGroups) || Object.keys(value.scalingGroups).length))) fail();
}
/** Read-only observation seam. Live callers construct their own authenticated native
 * secure SDK client; descriptors cannot supply this client or an affirmative result.
 * Conservative migration gate: ANY compute config in this namespace stops creation.
 */
export async function observeNamespaceComputeIsolation(client, namespace, { deadline = Date.now() + 60000, mediaPromotion = false } = {}) {
  const { result, end } = await observeCompute(client, namespace, deadline, new Map());
  if (Date.now() >= end) fail();
  return { schemaVersion: 1, namespace, observedAt: new Date().toISOString(), deploymentCount: result.deployments.length,
    versionCount: result.deployments.reduce((sum, item) => sum + item.versions.length, 0), inventorySHA256: digest(result.deployments),
    ...(mediaPromotion && { mediaPromotionSHA256: digest(result.deployments.map((entry) => {
      if (entry.deploymentName !== 'urm-worker-media-staging') return entry;
      const { routing, modifierIdentity: _modifierIdentity, ...stable } = entry;
      const { currentDeploymentVersion: _version, currentVersionChangedTime: _changedAt, ...remainingRouting } = routing ?? {};
      return { ...stable, routing: remainingRouting };
    })) }),
    scope: 'two stable native namespace inventories; no compute associations observed; not cross-API exclusion or activation readiness' };
}

/** Every attached peer must match its immutable settings. Only the one
 * in-progress version may move between absent and exact on reconciliation. */
export async function observeNamespaceWorkerCompute(client, namespace, { attached, target, deadline = Date.now() + 60000 }) {
  if (!Array.isArray(attached) || attached.length > 5 || !target) fail();
  const expected = new Map();
  for (const binding of [...attached, target]) {
    if (binding.namespace !== namespace || binding.buildId !== target.buildId || !name(binding.deploymentName) ||
      expected.has(binding.deploymentName)) fail();
    expected.set(binding.deploymentName, { binding, requireAttached: binding !== target });
  }
  const { result } = await observeCompute(client, namespace, deadline, expected);
  return { target: result.associations[target.deploymentName], observedAt: Date.now() };
}

async function observeCompute(client, namespace, deadline, expected) {
  if (namespace !== 'urm-app-staging.qwejt' || !Number.isSafeInteger(deadline)) fail();
  const end = Math.min(Date.now() + 60000, deadline);
  const rpc = callback => client.connection.withDeadline(Math.min(end, Date.now() + 10000), callback);
  const service = client.connection.workflowService;
  const scan = async () => {
    const deployments = [], tokens = new Set();
    let nextPageToken;
    do {
      if (Date.now() >= end || deployments.length > 100) fail();
      const page = await rpc(() => service.listWorkerDeployments({ namespace, pageSize: 100, ...(nextPageToken ? { nextPageToken } : {}) }));
      if (!Array.isArray(page.workerDeployments)) fail();
      for (const entry of page.workerDeployments) {
        if (!name(entry.name) || deployments.includes(entry.name)) fail();
        deployments.push(entry.name);
      }
      if (page.nextPageToken != null && !(page.nextPageToken instanceof Uint8Array) &&
        !(Array.isArray(page.nextPageToken) && page.nextPageToken.length === 0)) fail();
      nextPageToken = page.nextPageToken?.length ? page.nextPageToken : undefined;
      if (nextPageToken) {
        const token = Buffer.from(nextPageToken).toString('base64');
        if (tokens.has(token) || tokens.size >= 10) fail();
        tokens.add(token);
      }
    } while (nextPageToken);
    if (deployments.length > 100) fail();
    const result = [], associations = {};
    let versionCount = 0;
    for (const deploymentName of deployments.sort()) {
      const report = await rpc(() => service.describeWorkerDeployment({ namespace, deploymentName }));
      const info = report.workerDeploymentInfo;
      if (info?.name !== deploymentName || !Array.isArray(info.versionSummaries) || info.versionSummaries.length > 100) fail();
      const versions = [];
      const seen = new Set();
      for (const { deploymentVersion: version } of info.versionSummaries) {
        if (
          version?.deploymentName !== deploymentName ||
          !name(version.buildId) ||
          seen.has(version.buildId) ||
          ++versionCount > 300
        ) fail();
        seen.add(version.buildId);
        versions.push(version.buildId);
      }
      // The whole inventory is also used inside a five-second media protection
      // fence. Bound concurrency without inferring configuration from summaries.
      const batchSize = 4;
      for (let offset = 0; offset < versions.length; offset += batchSize) {
        if (Date.now() >= end) fail();
        await Promise.all(
          versions.slice(offset, offset + batchSize).map(async (buildId) => {
            const version = { deploymentName, buildId };
            const detail = await rpc(() =>
              service.describeWorkerDeploymentVersion({ namespace, deploymentVersion: version })
            );
            const native = detail.workerDeploymentVersionInfo;
            if (native?.deploymentVersion?.deploymentName !== deploymentName || native.deploymentVersion.buildId !== buildId) fail();
            const entry = expected.get(deploymentName);
            if (entry?.binding.buildId === buildId) {
              const state = observeWorkerCompute(native.computeConfig, entry.binding);
              if (entry.requireAttached && state !== 'exact') fail();
              associations[deploymentName] = state;
            } else {
              emptyCompute(native.computeConfig);
            }
          })
        );
      }
      result.push({ deploymentName, versions: versions.sort(), routing: info.routingConfig ?? null,
        managerIdentity: info.managerIdentity ?? '', modifierIdentity: info.lastModifierIdentity ?? '' });
    }
    if (Object.keys(associations).length !== expected.size) fail();
    return { deployments: result, associations: Object.fromEntries(Object.entries(associations).sort()) };
  };
  try {
    const first = await scan(), second = await scan();
    if (digest(first) !== digest(second) || Date.now() >= end) fail();
    return { result: first, end };
  } catch { return fail(); }
}
