import { observeNamespaceComputeIsolation } from './temporal-compute-isolation.mjs';
import { observeTraditionalWorkerHandoff, traditionalDeployment } from './temporal-traditional-worker-handoff.mjs';
import { proofDigest } from './temporal-release-runtime.mjs';

const namespace = 'urm-app-staging.qwejt';
const predecessor = 'b008afa426291ad2aa94cb8319d4bf06afdce1e0';
const controls = 'urm-worker-controls-staging';
const sha = /^[a-f0-9]{40}$/;

function fail() {
  throw new Error('STAGING_PREDECESSOR_TEMPORAL_UNCONFIRMED');
}

function traditional(version, successorBuildId) {
  return version?.deploymentName === traditionalDeployment && sha.test(version.buildId ?? '') &&
    version.buildId !== predecessor && version.buildId !== successorBuildId;
}

function versionText(version) {
  return version ? `${version.deploymentName}.${version.buildId}` : '';
}

function referencesBuild(value, buildId) {
  if (typeof value === 'string') return value === buildId || value.endsWith('.' + buildId);
  return value?.buildId === buildId;
}

function assertVersionSummary(summary, successorBuildId) {
  if (referencesBuild(summary?.deploymentVersion, successorBuildId) ||
    referencesBuild(summary?.version, successorBuildId)) fail();
}

// Visibility and Describe are independent views. Reject a successor in either,
// including the legacy fields still carried by the native workflow API.
function assertVisibilityExclusion(info, successorBuildId) {
  const v = info?.versioningInfo, override = v?.versioningOverride;
  const targets = [
    info?.assignedBuildId, info?.inheritedBuildId, info?.mostRecentWorkerVersionStamp,
    v?.deploymentVersion, v?.version, v?.deployment, v?.deploymentTransition?.deployment,
    v?.versionTransition?.deploymentVersion, v?.versionTransition?.version,
    override?.pinned?.version, override?.oneTime?.targetDeploymentVersion, override?.pinnedVersion, override?.deployment,
  ];
  if (targets.some(target => referencesBuild(target, successorBuildId))) fail();
}

function assertRoute(route, successorBuildId) {
  if (!route || route.rampingDeploymentVersion || (route.rampingVersion && route.rampingVersion !== '__unversioned__') ||
    Number(route.rampingVersionPercentage ?? 0) !== 0)
    fail();
  const current = route.currentDeploymentVersion;
  if ((current && !traditional(current, successorBuildId)) ||
    (route.currentVersion && route.currentVersion !== (current ? versionText(current) : '__unversioned__'))) fail();
}

function assertWorkflow(reply, successorBuildId) {
  const info = reply.workflowExecutionInfo;
  const v = info?.versioningInfo, last = v?.deploymentVersion, override = v?.versioningOverride;
  if (info?.taskQueue !== 'urm-orchestration' || !traditional(last, successorBuildId) || v.behavior !== 1 || v.versionTransition || v.deploymentTransition ||
    (v.version && v.version !== versionText(last)) ||
    (v.deployment && (v.deployment.seriesName !== traditionalDeployment || v.deployment.buildId !== last.buildId)) ||
    (info.assignedBuildId && info.assignedBuildId !== last.buildId) ||
    (info.inheritedBuildId && info.inheritedBuildId !== last.buildId) ||
    (info.mostRecentWorkerVersionStamp?.buildId && info.mostRecentWorkerVersionStamp.buildId !== last.buildId)) fail();
  if (override) {
    const pin = override.pinned;
    if (!pin || pin.behavior !== 1 || override.oneTime || override.autoUpgrade ||
      (override.override && override.override !== 'pinned') || (override.behavior && override.behavior !== 1) ||
      !traditional(pin.version, successorBuildId) || pin.version.buildId !== last.buildId ||
      (override.pinnedVersion && override.pinnedVersion !== versionText(last)) ||
      (override.deployment &&
        (override.deployment.seriesName !== traditionalDeployment || override.deployment.buildId !== last.buildId))) fail();
  }
  if (reply.pendingWorkflowTask || ['pendingActivities', 'pendingChildren', 'pendingNexusOperations'].some(key =>
    (reply[key] != null && (!Array.isArray(reply[key]) || reply[key].length !== 0)))) fail();
}

function assertStoppedControls(query, reply) {
  const info = reply.workerDeploymentVersionInfo;
  if (query.deploymentVersion.buildId !== predecessor) return;
  const queues = info?.taskQueueInfos, stats = reply.versionTaskQueues;
  if (query.deploymentVersion.deploymentName !== controls || info.currentSinceTime || info.rampingSinceTime ||
    Number(info.rampPercentage ?? 0) !== 0 || ![0, 1, 5, 6].includes(info.status ?? 0) ||
    !Array.isArray(queues) || queues.length !== 1 || queues[0].name !== 'urm-controls' || queues[0].type !== 2 ||
    !Array.isArray(stats) || stats.length !== 1 || stats[0].name !== 'urm-controls' || stats[0].type !== 2 ||
    stats[0].stats?.approximateBacklogCount?.toString() !== '0') fail();
}

/** The shared inventory collectors read the SDK through this limited surface.
 * Inspect fields on the original replies before either collector projects them away. */
function custodyClient(client, deadline, observed, successorBuildId) {
  const service = client.connection.workflowService;
  const read = async (method, query) => {
    if (query.namespace !== namespace || Date.now() >= deadline) fail();
    const response = await service[method](query);
    if (!response || Date.now() >= deadline) fail();
    return response;
  };
  async function visibility(method, field, query) {
    const result = await read(method, query);
    if (!Array.isArray(result[field])) fail();
    if (method === 'listWorkflowExecutions') {
      for (const info of result[field]) assertVisibilityExclusion(info, successorBuildId);
    }
    return result;
  }
  const checkedService = {
    async listWorkerDeployments(q) {
      const result = await read('listWorkerDeployments', q);
      for (const deployment of result.workerDeployments ?? []) {
        if (deployment.routingConfig) assertRoute(deployment.routingConfig, successorBuildId);
        for (const summary of [deployment.latestVersionSummary, deployment.currentVersionSummary, deployment.rampingVersionSummary])
          assertVersionSummary(summary, successorBuildId);
        observed.deployments.add(deployment.name);
      }
      return result;
    },
    listTaskQueuePartitions: q => read('listTaskQueuePartitions', q),
    listWorkflowExecutions: q => visibility('listWorkflowExecutions', 'executions', q),
    listActivityExecutions: q => visibility('listActivityExecutions', 'executions', q),
    listNexusOperationExecutions: q => visibility('listNexusOperationExecutions', 'operations', q),
    async describeWorkerDeployment(q) {
      const result = await read('describeWorkerDeployment', q);
      const info = result.workerDeploymentInfo;
      assertRoute(info?.routingConfig, successorBuildId);
      for (const summary of info.versionSummaries ?? []) assertVersionSummary(summary, successorBuildId);
      return result;
    },
    async describeWorkerDeploymentVersion(q) {
      if (referencesBuild(q.deploymentVersion, successorBuildId)) fail();
      const query = q.deploymentVersion.buildId === predecessor ? { ...q, reportTaskQueueStats: true } : q;
      const result = await read('describeWorkerDeploymentVersion', query);
      assertVersionSummary(result.workerDeploymentVersionInfo, successorBuildId);
      assertStoppedControls(query, result);
      if (query.deploymentVersion.buildId === predecessor) observed.stoppedControls = true;
      return result;
    },
    async describeTaskQueue(q) {
      const result = await read('describeTaskQueue', q);
      // Unused workflow-task partitions for the Activity-only queues can have
      // no versioning information. Their pollers and backlog must still be read.
      if (result.versioningInfo != null) assertRoute(result.versioningInfo, successorBuildId);
      if (!Array.isArray(result.pollers)) fail();
      for (const p of result.pollers) {
        const v = p.deploymentOptions, legacy = p.workerVersionCapabilities;
        if (!traditional(v, successorBuildId) || v.workerVersioningMode !== 2 ||
          (legacy?.buildId && legacy.buildId !== v.buildId)) fail();
      }
      return result;
    },
    async describeWorkflowExecution(q) {
      const result = await read('describeWorkflowExecution', q);
      assertVisibilityExclusion(result.workflowExecutionInfo, successorBuildId);
      assertWorkflow(result, successorBuildId);
      return result;
    },
  };
  return {
    options: { namespace },
    connection: {
      workflowService: checkedService,
      withDeadline: (end, callback) => client.connection.withDeadline(Math.min(deadline, end), callback),
    },
  };
}

/** Native read-only custody observation. Caller supplies the authenticated staging
 * SDK client, never a previously saved inventory or descriptor-provided proof. */
export async function observeStagingPredecessorTemporal(client, successorBuildId) {
  if (client?.options?.namespace !== namespace || typeof successorBuildId !== 'string' ||
    !sha.test(successorBuildId) || successorBuildId.slice(0, 20) === predecessor.slice(0, 20)) fail();
  const deadline = Date.now() + 60_000;
  const observed = { deployments: new Set(), stoppedControls: false };
  const checked = custodyClient(client, deadline, observed, successorBuildId);
  const [compute, handoff] = await Promise.all([
    observeNamespaceComputeIsolation(checked, namespace, { deadline }),
    observeTraditionalWorkerHandoff(checked),
  ]);
  const shared = handoff.routing.current;
  if (!traditional(shared, successorBuildId) || !observed.deployments.has(traditionalDeployment) || !observed.stoppedControls ||
    !compute.deploymentCount || !compute.versionCount ||
    handoff.standaloneActivities || handoff.standaloneNexus || Date.now() >= deadline) fail();
  const versions = new Map(handoff.versions.map(v => [v.buildId, v]));
  if (!versions.has(shared.buildId)) fail();
  for (const q of handoff.queueInventory) {
    const serving = q.type === 2 || q.name === 'urm-orchestration';
    if (q.count !== '0' || ((serving || q.current) && versionText(q.current) !== versionText(shared))) fail();
    for (const p of q.pollers) {
      if (!versions.get(p.worker.buildId)?.queues.some(info => info.name === q.name && info.type === q.type)) fail();
    }
  }
  for (const run of handoff.running) {
    if (!versions.get(run.latestWorker.buildId)?.queues.some(q => q.name === 'urm-orchestration' && q.type === 1)) fail();
  }
  return {
    schemaVersion: 1, namespace, excludedBuildId: predecessor, successorBuildId, sharedCurrent: shared,
    computeInventorySHA256: compute.inventorySHA256, handoffInventorySHA256: handoff.digest,
    partitionCount: handoff.queueInventory.length, pinnedTraditionalRuns: handoff.running.length,
    protectedRunsSHA256: proofDigest(handoff.running), observedAt: new Date().toISOString(),
  };
}
