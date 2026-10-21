import { proofDigest as hash } from './temporal-release-runtime.mjs';
const namespace = 'urm-app-staging.qwejt';
const deploymentName = 'urm-worker-media-staging';
const queue = 'urm-media';
const fail = () => {
  throw new Error('RESTORED_MEDIA_QUEUE_PROTECTION_UNCONFIRMED');
};
const list = (v, max) => {
  if (!Array.isArray(v) || v.length > max) fail();
  return v;
};
const version = (v) =>
  v &&
  typeof v.deploymentName === 'string' &&
  typeof v.buildId === 'string' &&
  v.buildId.length > 0 &&
  v.buildId.length <= 200;
const route = (r, buildId) => {
  if (
    !r ||
    r.rampingDeploymentVersion?.buildId ||
    Number(r.rampingVersionPercentage ?? 0) !== 0 ||
    r.currentDeploymentVersion?.buildId === buildId
  )
    fail();
  const current = r.currentDeploymentVersion;
  if (current?.buildId && (!version(current) || current.deploymentName !== 'urm-worker-staging')) fail();
  return current?.buildId ? { deploymentName: current.deploymentName, buildId: current.buildId } : null;
};
/** Fixed normal Activity-only inventory. The canonical image/source collector,
 * never CLI input, supplies a verified startup witness. Returned owned pollers
 * are deliberately excluded from the stable original routing baseline. This
 * scan alone grants neither namespace protection nor registration authority. */
export async function scanRestoredMediaInventory({ client, plan, startup, rpc }) {
  if (!/^[a-f0-9]{40}$/.test(plan?.buildId)) fail();
  if (
    startup &&
    (startup.kind !== 'restored-media-startup-witness-v1' ||
      startup.operationId !== plan.operationId ||
      startup.planSHA256 !== hash(plan) ||
      !/^media-restored-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(startup.identity))
  )
    fail();
  const service = client.connection.workflowService;
  const report = await rpc(() => service.describeWorkerDeployment({ namespace, deploymentName }));
  const d = report.workerDeploymentInfo;
  if (d?.name !== deploymentName || route(d.routingConfig, plan.buildId)) fail();
  const versions = [],
    builds = new Set();
  for (const entry of list(d.versionSummaries, 100)) {
    const v = entry.deploymentVersion;
    if (!version(v) || v.deploymentName !== deploymentName || builds.has(v.buildId)) fail();
    builds.add(v.buildId);
    const detail = await rpc(() =>
      service.describeWorkerDeploymentVersion({ namespace, deploymentVersion: v, reportTaskQueueStats: true })
    );
    const info = detail.workerDeploymentVersionInfo;
    if (
      hash(info?.deploymentVersion) !== hash(v) ||
      info.currentSinceTime ||
      info.rampingSinceTime ||
      Number(info.rampPercentage ?? 0) !== 0 ||
      (info.computeConfig != null &&
        (typeof info.computeConfig !== 'object' ||
          Array.isArray(info.computeConfig) ||
          Object.keys(info.computeConfig).some((k) => k !== 'scalingGroups') ||
          (info.computeConfig.scalingGroups != null &&
            (typeof info.computeConfig.scalingGroups !== 'object' ||
              Array.isArray(info.computeConfig.scalingGroups) ||
              Object.keys(info.computeConfig.scalingGroups).length))))
    )
      fail();
    const queues = list(info.taskQueueInfos, 1),
      stats = list(detail.versionTaskQueues, 1);
    if (
      queues.length !== 1 ||
      queues[0].name !== queue ||
      queues[0].type !== 2 ||
      stats.length !== 1 ||
      stats[0].name !== queue ||
      stats[0].type !== 2 ||
      !stats[0].stats ||
      String(stats[0].stats.approximateBacklogCount) !== '0'
    )
      fail();
    versions.push({ buildId: v.buildId, type: 2, backlog: '0' });
  }
  if (startup && !builds.has(plan.buildId)) fail();
  const partitionReport = await rpc(() =>
    service.listTaskQueuePartitions({ namespace, taskQueue: { name: queue, kind: 1 } })
  );
  const partitions = [],
    ownedPollers = [],
    protectedPollers = [],
    peerVersions = new Map();
  for (const [type, rows] of [
    [1, partitionReport.workflowTaskQueuePartitions],
    [2, partitionReport.activityTaskQueuePartitions],
  ]) {
    const seen = new Set();
    for (const part of list(rows, 128)) {
      if (
        typeof part.key !== 'string' ||
        (part.key !== queue && !/^\/_sys\/urm-media\/[1-9][0-9]*$/.test(part.key)) ||
        seen.has(part.key)
      )
        fail();
      seen.add(part.key);
      const p = await rpc(() =>
        service.describeTaskQueue({
          namespace,
          taskQueue: { name: part.key, kind: 1 },
          taskQueueType: type,
          includeTaskQueueStatus: true,
        })
      );
      if (!p.taskQueueStatus || String(p.taskQueueStatus.backlogCountHint) !== '0') fail();
      const current = route(p.versioningInfo, plan.buildId);
      for (const poller of list(p.pollers, 1000)) {
        const v = poller.deploymentOptions;
        if (
          !version(v) ||
          v.workerVersioningMode !== 2 ||
          typeof poller.identity !== 'string' ||
          !poller.identity ||
          poller.identity.length > 500
        )
          fail();
        const item = {
          type,
          key: part.key,
          identity: poller.identity,
          deploymentName: v.deploymentName,
          buildId: v.buildId,
        };
        if (v.deploymentName === deploymentName) {
          if (type !== 2 || !startup || v.buildId !== plan.buildId || poller.identity !== startup.identity) fail();
          ownedPollers.push(item);
        } else {
          // Retained traditional pollers are protected only on the exact native
          // current shared version. Same-build or arbitrary historical peers
          // do not receive a blanket exception.
          if (!current || hash({ deploymentName: v.deploymentName, buildId: v.buildId }) !== hash(current)) fail();
          if (!peerVersions.has(v.buildId)) {
            const peer = await rpc(() =>
              service.describeWorkerDeployment({ namespace, deploymentName: 'urm-worker-staging' })
            );
            if (
              peer.workerDeploymentInfo?.name !== 'urm-worker-staging' ||
              hash(route(peer.workerDeploymentInfo.routingConfig, plan.buildId)) !== hash(current)
            )
              fail();
            const detail = await rpc(() =>
              service.describeWorkerDeploymentVersion({
                namespace,
                deploymentVersion: current,
                reportTaskQueueStats: true,
              })
            );
            if (hash(detail.workerDeploymentVersionInfo?.deploymentVersion) !== hash(current)) fail();
            peerVersions.set(v.buildId, hash({ deployment: peer.workerDeploymentInfo, version: detail }));
          }
          protectedPollers.push(item);
        }
      }
      partitions.push({ type, key: part.key, current, owner: part.ownerHostName ?? '' });
    }
    if (!seen.has(queue)) fail();
  }
  const sort = (rows) => rows.sort((a, b) => hash(a).localeCompare(hash(b)));
  return {
    protected: {
      versions: sort(versions.filter((v) => v.buildId !== plan.buildId)),
      partitions: sort(partitions),
      pollers: sort(protectedPollers),
      peers: [...peerVersions].sort(([a], [b]) => a.localeCompare(b)),
    },
    ownVersion: versions.find((v) => v.buildId === plan.buildId) ?? null,
    ownedPollers: sort(ownedPollers),
  };
}
