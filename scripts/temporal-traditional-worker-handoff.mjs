import { proofDigest } from './temporal-release-runtime.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';

export const traditionalDeployment = 'urm-worker-staging';
const namespace = 'urm-app-staging.qwejt';
const queues = ['urm-orchestration', 'urm-controls', 'urm-media', 'urm-email', 'urm-images', 'urm-search'];
const buildId = /^[a-f0-9]{40}$/;
const versionId = /^[A-Za-z0-9_.-]{1,200}$/;
const fail = () => {
  throw new Error('TRADITIONAL_WORKER_HANDOFF_UNCONFIRMED');
};
const optionalList = (value, limit) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > limit) return fail();
  return value;
};
const nativeTime = (value) => (value == null ? null : Number(value.seconds) * 1000 + Number(value.nanos ?? 0) / 1e6);
const backlog = (value) => {
  const text = value?.toString();
  if (!/^(?:0|[1-9][0-9]*)$/.test(text ?? '')) return null;
  return text;
};
const version = (value) => {
  if (value == null) return null;
  if (!versionId.test(value.deploymentName ?? '') || !versionId.test(value.buildId ?? '')) return fail();
  return { deploymentName: value.deploymentName, buildId: value.buildId };
};
async function mapBounded(items, callback) {
  const rows = [];
  for (let offset = 0; offset < items.length; offset += 4)
    rows.push(...(await Promise.all(items.slice(offset, offset + 4).map(callback))));
  return rows;
}

async function scan(client, deadline) {
  const service = client.connection.workflowService;
  const rpc = (callback) => {
    if (Date.now() >= deadline) return fail();
    return client.connection.withDeadline(Math.min(deadline, Date.now() + 5000), callback);
  };
  const { workerDeploymentInfo: shared } = await rpc(() =>
    service.describeWorkerDeployment({ namespace, deploymentName: traditionalDeployment })
  );
  if (shared?.name !== traditionalDeployment || !shared.routingConfig) return fail();
  const builds = optionalList(shared.versionSummaries, 100)
    .map(({ deploymentVersion }) => {
      if (deploymentVersion?.deploymentName !== traditionalDeployment || !buildId.test(deploymentVersion.buildId ?? ''))
        return fail();
      return deploymentVersion.buildId;
    })
    .sort();
  if (!builds.length || new Set(builds).size !== builds.length) return fail();
  const routing = {
    current: version(shared.routingConfig.currentDeploymentVersion),
    ramping: version(shared.routingConfig.rampingDeploymentVersion),
    rampPercentage: Number(shared.routingConfig.rampingVersionPercentage ?? 0),
  };
  if (!Number.isFinite(routing.rampPercentage)) return fail();
  const versions = await mapBounded(builds, async (id) => {
    const deploymentVersion = { deploymentName: traditionalDeployment, buildId: id };
    const detail = await rpc(() =>
      service.describeWorkerDeploymentVersion({
        namespace,
        deploymentVersion,
        reportTaskQueueStats: true,
      })
    );
    const info = detail.workerDeploymentVersionInfo;
    if (info?.deploymentVersion?.deploymentName !== traditionalDeployment || info.deploymentVersion.buildId !== id)
      return fail();
    const registered = optionalList(info.taskQueueInfos, 100).map(({ name, type }) => {
      if (!/^[a-z0-9][a-z0-9-]{0,199}$/.test(name ?? '') || ![1, 2].includes(type)) return fail();
      return { name, type };
    });
    const stats = optionalList(detail.versionTaskQueues, 100).map((q) => ({
      name: q.name,
      type: q.type,
      count: backlog(q.stats?.approximateBacklogCount),
    }));
    const keys = (items) => items.map((q) => `${q.name}/${q.type}`);
    const registeredKeys = keys(registered),
      statKeys = keys(stats);
    if (
      new Set(registeredKeys).size !== registeredKeys.length ||
      new Set(statKeys).size !== statKeys.length ||
      statKeys.some((key) => !registeredKeys.includes(key))
    )
      return fail();
    return {
      buildId: id,
      active: Boolean(info.currentSinceTime || info.rampingSinceTime || Number(info.rampPercentage ?? 0) !== 0),
      computeAttached: Object.keys(info.computeConfig?.scalingGroups ?? {}).length > 0,
      drainage: info.drainageInfo
        ? {
            status: info.drainageInfo.status,
            checkedAt: nativeTime(info.drainageInfo.lastCheckedTime),
          }
        : null,
      queues: registered.sort((a, b) => a.name.localeCompare(b.name) || a.type - b.type),
      stats: stats.sort((a, b) => a.name.localeCompare(b.name) || a.type - b.type),
    };
  });

  const observedQueues = [...new Set([...queues, ...versions.flatMap((v) => v.queues.map((q) => q.name))])].sort();
  if (observedQueues.length > 50) return fail();
  const partitions = (
    await mapBounded(observedQueues, async (name) => {
      const row = await rpc(() => service.listTaskQueuePartitions({ namespace, taskQueue: { name, kind: 1 } }));
      return [1, 2].flatMap((type) => {
        const parts = optionalList(type === 1 ? row.workflowTaskQueuePartitions : row.activityTaskQueuePartitions, 128);
        const keys = parts.map((part) => part.key);
        if (
          !keys.includes(name) ||
          new Set(keys).size !== keys.length ||
          keys.some((key) => key !== name && !new RegExp(`^/_sys/${name}/[1-9][0-9]*$`).test(key ?? ''))
        )
          return fail();
        return keys.sort().map((key) => ({ name, type, key }));
      });
    })
  ).flat();
  const queueInventory = await mapBounded(partitions, async (row) => {
    const description = await rpc(() =>
      service.describeTaskQueue({
        namespace,
        taskQueue: { name: row.key, kind: 1 },
        taskQueueType: row.type,
        includeTaskQueueStatus: true,
      })
    );
    const pollers = optionalList(description.pollers, 1000).map((p) => {
      if (typeof p.identity !== 'string' || !p.identity || p.identity.length > 500) return fail();
      const options = p.deploymentOptions;
      return { identity: p.identity, worker: options?.workerVersioningMode === 2 ? version(options) : null };
    });
    return {
      ...row,
      count: backlog(description.taskQueueStatus?.backlogCountHint),
      current: version(description.versioningInfo?.currentDeploymentVersion),
      ramping: version(description.versioningInfo?.rampingDeploymentVersion),
      rampPercentage: Number(description.versioningInfo?.rampingVersionPercentage ?? 0),
      pollers: pollers.sort((a, b) => proofDigest(a).localeCompare(proofDigest(b))),
    };
  });

  async function visible(method, field, limit) {
    const rows = [],
      cursors = new Set();
    let token;
    do {
      const page = await rpc(() =>
        service[method]({
          namespace,
          pageSize: 100,
          query: 'ExecutionStatus = "Running"',
          ...(token ? { nextPageToken: token } : {}),
        })
      );
      rows.push(...optionalList(page[field], limit));
      if (rows.length > limit) return fail();
      const next = page.nextPageToken;
      if (next != null && !(next instanceof Uint8Array) && !(Array.isArray(next) && !next.length)) return fail();
      token = next?.length ? next : undefined;
      if (token) {
        const key = Buffer.from(token).toString('base64');
        if (cursors.has(key) || cursors.size >= 10) return fail();
        cursors.add(key);
      }
    } while (token);
    return rows;
  }
  const [visibleRuns, activities, nexus] = await Promise.all([
    visible('listWorkflowExecutions', 'executions', 500),
    visible('listActivityExecutions', 'executions', 500),
    visible('listNexusOperationExecutions', 'operations', 500),
  ]);
  const runIds = new Set();
  const running = await mapBounded(visibleRuns, async ({ execution }) => {
    if (
      typeof execution?.workflowId !== 'string' ||
      !execution.workflowId ||
      !/^[a-f0-9-]{36}$/.test(execution.runId ?? '') ||
      runIds.has(execution.runId)
    )
      return fail();
    runIds.add(execution.runId);
    const row = await rpc(() => service.describeWorkflowExecution({ namespace, execution }));
    const info = row.workflowExecutionInfo;
    if (
      info?.execution?.workflowId !== execution.workflowId ||
      info.execution.runId !== execution.runId ||
      info.status !== 1
    )
      return fail();
    const versioning = info.versioningInfo;
    return {
      workflowId: execution.workflowId,
      runId: execution.runId,
      latestWorker: version(versioning?.deploymentVersion),
      requestedPin: version(versioning?.versioningOverride?.pinned?.version),
      pendingActivities: optionalList(row.pendingActivities, 500)
        .map((activity) => ({
          id: activity.activityId ?? '',
          worker: version(activity.lastDeploymentVersion),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      pendingNexus: optionalList(row.pendingNexusOperations, 500).length,
      pendingChildren: optionalList(row.pendingChildren, 500).length,
      pendingWorkflowTask: Boolean(row.pendingWorkflowTask),
    };
  });
  return {
    routing,
    versions,
    queueInventory,
    running: running.sort((a, b) => a.runId.localeCompare(b.runId)),
    standaloneActivities: activities.length,
    standaloneNexus: nexus.length,
  };
}

/** Native, read-only. A matching pair of scans still needs paused admission,
 * provider/dispatch lease exclusion and Kubernetes controller evidence. */
export async function observeTraditionalWorkerHandoff(client) {
  if (client.options.namespace !== namespace) return fail();
  const deadline = Date.now() + 60000;
  const before = await scan(client, deadline);
  const after = await scan(client, deadline);
  if (Date.now() >= deadline || proofDigest(before) !== proofDigest(after)) return fail();
  return { ...after, observedAt: Date.now(), digest: proofDigest(after) };
}

/** Before retirement, traditional polling is expected. Before WCI attachment,
 * any traditional or unknown poller causes denial. Pool and release checkpoint
 * receipts remain independent requirements for either mutation. */
export function assertTraditionalWorkerDrain(
  inventory,
  { builds, handoffAt, candidates, requireRetired = false, preHandoffInventory }
) {
  if (
    !Number.isSafeInteger(handoffAt) ||
    handoffAt <= 0 ||
    !Number.isSafeInteger(inventory.observedAt) ||
    inventory.observedAt < handoffAt ||
    Date.now() - inventory.observedAt > 30000 ||
    inventory.observedAt > Date.now() ||
    inventory.routing.ramping ||
    inventory.routing.rampPercentage !== 0 ||
    !Array.isArray(builds) ||
    !builds.length ||
    new Set(builds).size !== builds.length ||
    !Array.isArray(candidates) ||
    candidates.length !== queues.length ||
    new Set(candidates.map((c) => c.queue)).size !== queues.length ||
    inventory.standaloneActivities !== 0 ||
    inventory.standaloneNexus !== 0 ||
    (preHandoffInventory &&
      (!Number.isSafeInteger(preHandoffInventory.observedAt) ||
        preHandoffInventory.observedAt <= 0 ||
        preHandoffInventory.observedAt >= handoffAt ||
        !Array.isArray(preHandoffInventory.versions)))
  )
    return fail();

  const target = new Map(
    candidates.map((candidate) => {
      if (
        !queues.includes(candidate.queue) ||
        !buildId.test(candidate.buildId ?? '') ||
        candidate.deploymentName !==
          serverlessResourceNames(candidate.buildId, candidate.queue.slice(4)).deploymentName ||
        (candidate.managed === true
          ? !requireRetired ||
            !Array.isArray(candidate.identities) ||
            candidate.identities.length > 8 ||
            candidate.identities.some((identity) => typeof identity !== 'string' || !identity) ||
            new Set(candidate.identities).size !== candidate.identities.length
          : typeof candidate.identity !== 'string' || !candidate.identity)
      )
        return fail();
      return [candidate.queue, candidate];
    })
  );
  const matches = (worker, candidate) =>
    worker?.deploymentName === candidate.deploymentName && worker.buildId === candidate.buildId;
  const orchestration = target.get('urm-orchestration');
  if (
    !matches(inventory.routing.current, orchestration) ||
    candidates.some((candidate) => candidate.buildId !== orchestration.buildId) ||
    builds.includes(orchestration.buildId)
  )
    return fail();
  if (
    inventory.running.some(
      (run) =>
        !candidates.some((candidate) => matches(run.latestWorker, candidate)) ||
        (run.requestedPin && !candidates.some((candidate) => matches(run.requestedPin, candidate))) ||
        run.pendingActivities.length ||
        run.pendingNexus ||
        run.pendingChildren ||
        run.pendingWorkflowTask
    )
  )
    return fail();

  for (const retiringBuild of builds) {
    const version = inventory.versions.find((entry) => entry.buildId === retiringBuild);
    // Temporal does not keep advancing the check timestamp for a version
    // already drained. The original release must have saved its native
    // pre-handoff observation, and today the exact version must still agree.
    const prior = preHandoffInventory?.versions.find((entry) => entry.buildId === retiringBuild);
    const alreadyDrained =
      prior?.drainage?.checkedAt <= preHandoffInventory?.observedAt &&
      prior.drainage.checkedAt > 0 &&
      prior.active === false &&
      prior.computeAttached === false &&
      prior.drainage.status === 2 &&
      proofDigest(prior) === proofDigest(version ?? null);
    if (
      !version ||
      version.active ||
      version.computeAttached ||
      version.drainage?.status !== 2 ||
      !Number.isFinite(version.drainage.checkedAt) ||
      (version.drainage.checkedAt < handoffAt && !alreadyDrained) ||
      version.drainage.checkedAt > inventory.observedAt ||
      !version.queues.length ||
      version.queues.length !== version.stats.length ||
      version.stats.some((stat) => stat.count !== '0')
    )
      return fail();
  }
  const candidateQueues = new Set();
  for (const row of inventory.queueInventory) {
    if (row.count !== '0' || row.ramping || row.rampPercentage !== 0) return fail();
    const candidate = target.get(row.name);
    const serving = candidate && (row.type === 2 || row.name === 'urm-orchestration');
    if (
      serving
        ? !matches(row.current, candidate)
        : row.current && !candidates.some((current) => matches(row.current, current))
    )
      return fail();
    for (const poller of row.pollers) {
      if (
        serving &&
        matches(poller.worker, candidate) &&
        (candidate.managed === true
          ? candidate.identities.includes(poller.identity)
          : poller.identity === candidate.identity)
      ) {
        candidateQueues.add(`${row.name}/${row.type}`);
      } else if (
        requireRetired ||
        poller.worker?.deploymentName !== traditionalDeployment ||
        !builds.includes(poller.worker.buildId)
      )
        return fail();
    }
  }
  for (const queue of queues)
    if (
      target.get(queue).managed !== true &&
      (!candidateQueues.has(`${queue}/2`) || (queue === 'urm-orchestration' && !candidateQueues.has(`${queue}/1`)))
    )
      return fail();

  return {
    digest: inventory.digest,
    observedAt: inventory.observedAt,
    builds: [...builds].sort(),
    pollersGone: requireRetired,
  };
}
