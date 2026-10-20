import { createHash } from 'node:crypto';
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
export async function observeNamespaceComputeIsolation(client, namespace) {
  if (namespace !== 'urm-app-staging.qwejt') fail();
  const end = Date.now() + 60000;
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
    const result = [];
    let versionCount = 0;
    for (const deploymentName of deployments.sort()) {
      const report = await rpc(() => service.describeWorkerDeployment({ namespace, deploymentName }));
      const info = report.workerDeploymentInfo;
      if (info?.name !== deploymentName || !Array.isArray(info.versionSummaries) || info.versionSummaries.length > 100) fail();
      const versions = [];
      for (const summary of info.versionSummaries) {
        const version = summary.deploymentVersion;
        if (version?.deploymentName !== deploymentName || !name(version.buildId) || versions.includes(version.buildId) || ++versionCount > 300) fail();
        // Summary is not a substitute for the full configuration read below.
        const detail = await rpc(() => service.describeWorkerDeploymentVersion({ namespace, deploymentVersion: version }));
        const native = detail.workerDeploymentVersionInfo;
        if (native?.deploymentVersion?.deploymentName !== deploymentName || native.deploymentVersion.buildId !== version.buildId) fail();
        emptyCompute(native.computeConfig);
        versions.push(version.buildId);
      }
      result.push({ deploymentName, versions: versions.sort(), routing: info.routingConfig ?? null,
        managerIdentity: info.managerIdentity ?? '', modifierIdentity: info.lastModifierIdentity ?? '' });
    }
    return result;
  };
  try {
    const first = await scan(), second = await scan();
    if (digest(first) !== digest(second) || Date.now() >= end) fail();
    return { schemaVersion: 1, namespace, observedAt: new Date().toISOString(), deploymentCount: first.length,
      versionCount: first.reduce((sum, item) => sum + item.versions.length, 0), inventorySHA256: digest(first),
      scope: 'two stable native namespace inventories; no compute associations observed; not cross-API exclusion or activation readiness' };
  } catch { return fail(); }
}
