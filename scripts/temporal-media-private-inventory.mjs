import { proofDigest as hash } from './temporal-release-runtime.mjs';
import {
  assertTraditionalRetirementWorkIdle,
  readReleaseCandidateWork,
  readTraditionalRetirementWork,
} from './temporal-retirement-work.mjs';
const namespace = 'urm-app-staging.qwejt',
  deploymentName = 'urm-worker-media-recovery-staging',
  queue = 'urm-media-kernel-recovery';
const fail = () => {
  throw new Error('MEDIA_DIAGNOSTIC_DRAIN_UNCONFIRMED');
};
const uuid = (x) => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const array = (v) => {
  if (!Array.isArray(v)) fail();
  return v;
};
const stamp = (s) => {
  if (!s.exists || !s.createTime || !s.updateTime) fail();
  return hash({ data: s.data(), created: s.createTime, updated: s.updateTime });
};
const emptyCompute = (v) => {
  if (
    v != null &&
    (typeof v !== 'object' ||
      Array.isArray(v) ||
      Object.keys(v).some((k) => k !== 'scalingGroups') ||
      (v.scalingGroups != null && Object.keys(v.scalingGroups).length))
  )
    fail();
};
const token = (v, seen) => {
  if (v != null && !(v instanceof Uint8Array) && !(Array.isArray(v) && !v.length)) fail();
  if (!v?.length) return undefined;
  const k = Buffer.from(v).toString('base64');
  if (seen.has(k) || seen.size >= 10) fail();
  seen.add(k);
  return v;
};
const durableCollections = [
  'durableJobOutbox',
  'durableJobCommands',
  'durableJobCriticalSections',
  'durableActivityExecutions',
  'temporalProviderMutationSessions',
  'temporalProviderMutationLocks',
];

function assertOwnedDiagnosticActivity(doc, operationId, auth) {
  const ready = auth.ready;
  const worker = auth.worker;
  if (
    !ready ||
    !worker ||
    doc.get('projectId') !== 'urm-app-staging' ||
    doc.get('jobId') !== `media-recovery-${operationId}` ||
    doc.get('workflowId') !== ready.workflowId ||
    doc.get('runId') !== ready.runId ||
    doc.get('activityId') !== ready.activityId ||
    doc.get('activityType') !== 'acquireMedia' ||
    doc.get('attempt') !== 2 ||
    hash(doc.get('worker')) !== hash(worker)
  )
    fail();
}

/** The finite Job can retain arbitrarily many terminal receipts. Exhaustive
 * idle counts and candidate-build filters run in one read-only transaction. */
async function readJobDurableInventory(db, plan, operationId, auth) {
  return db.runTransaction(
    async (tx) => {
      const work = await readTraditionalRetirementWork(db, tx);
      const idleSHA256 = assertTraditionalRetirementWorkIdle(work);
      const matches = await readReleaseCandidateWork(db, tx, plan.buildId);
      const candidateRows = matches.map(({ collection, doc }) => {
        if (collection !== 'durableActivityExecutions') fail();
        assertOwnedDiagnosticActivity(doc, operationId, auth);
        return { pathSHA256: hash(doc.ref.path), stamp: stamp(doc) };
      });
      return { idleSHA256, candidateRows };
    },
    { readOnly: true }
  );
}

/** Private diagnostic inventory mechanics only. Canonical callers authenticate
 * ownership before providing an exact idle identity. No ordinary role policy,
 * descriptor or CLI accepts callbacks/identity overrides for this module. */
export async function scanPrivateMediaInventory({
  client,
  db,
  plan,
  operationId,
  read,
  rpc,
  auth,
  allowAbsent = false,
  allowedPollerIdentity = null,
}) {
  const service = client.connection.workflowService,
    o = { operationId };
  const versions = [];
  let report;
  report = await rpc(async () => {
    try {
      return await service.describeWorkerDeployment({ namespace, deploymentName });
    } catch (error) {
      if (!allowAbsent || error?.code !== 5) throw error;
      return { workerDeploymentInfo: { name: deploymentName, routingConfig: {}, versionSummaries: [] } };
    }
  });
  const d = report.workerDeploymentInfo,
    r = d?.routingConfig;
  if (
    d?.name !== deploymentName ||
    r?.currentDeploymentVersion?.buildId ||
    r?.rampingDeploymentVersion?.buildId ||
    Number(r?.rampingVersionPercentage ?? 0) !== 0
  )
    fail();
  const summaries = array(d.versionSummaries);
  if ((!summaries.length && !allowAbsent) || summaries.length > 100) fail();
  for (const entry of summaries) {
    const v = entry.deploymentVersion;
    if (
      v?.deploymentName !== deploymentName ||
      typeof v.buildId !== 'string' ||
      !v.buildId ||
      v.buildId.length > 200 ||
      versions.some((x) => x.buildId === v.buildId)
    )
      fail();
    const detail = await rpc(() =>
      service.describeWorkerDeploymentVersion({ namespace, deploymentVersion: v, reportTaskQueueStats: true })
    );
    const info = detail.workerDeploymentVersionInfo;
    if (
      hash(info?.deploymentVersion) !== hash(v) ||
      info.currentSinceTime ||
      info.rampingSinceTime ||
      Number(info.rampPercentage ?? 0) !== 0
    )
      fail();
    emptyCompute(info.computeConfig);
    const infos = array(info.taskQueueInfos),
      seen = new Set();
    for (const q of infos) {
      if (q.name !== queue || ![1, 2].includes(q.type) || seen.has(q.type)) fail();
      seen.add(q.type);
    }
    if (seen.size !== 2) fail();
    const stats = array(detail.versionTaskQueues);
    if (stats.length !== 2) fail();
    const seenStats = new Set();
    for (const q of stats) {
      if (
        q.name !== queue ||
        ![1, 2].includes(q.type) ||
        seenStats.has(q.type) ||
        !q.stats ||
        String(q.stats.approximateBacklogCount) !== '0'
      )
        fail();
      seenStats.add(q.type);
    }
    versions.push({
      buildId: v.buildId,
      queues: [1, 2],
      statsSHA256: hash(
        stats
          .map((q) => ({ name: q.name, type: q.type, backlog: String(q.stats.approximateBacklogCount) }))
          .sort((a, b) => a.type - b.type)
      ),
    });
  }
  if (!allowAbsent && !versions.some((v) => v.buildId === plan.buildId)) fail();
  const partitions = await rpc(() =>
    service.listTaskQueuePartitions({ namespace, taskQueue: { name: queue, kind: 1 } })
  );
  const partitionRows = [],
    ownedPollers = [];
  for (const [type, rows] of [
    [1, partitions.workflowTaskQueuePartitions],
    [2, partitions.activityTaskQueuePartitions],
  ]) {
    const seen = new Set();
    for (const part of array(rows)) {
      if (
        typeof part.key !== 'string' ||
        (part.key !== queue && !/^\/_sys\/urm-media-kernel-recovery\/[1-9][0-9]*$/.test(part.key)) ||
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
      for (const poller of array(p.pollers)) {
        if (!allowedPollerIdentity) throw new Error('MEDIA_DIAGNOSTIC_POLLERS_PRESENT');
        if (
          poller.identity !== allowedPollerIdentity ||
          poller.deploymentOptions?.deploymentName !== deploymentName ||
          poller.deploymentOptions?.buildId !== plan.buildId ||
          poller.deploymentOptions?.workerVersioningMode !== 2
        )
          fail();
        ownedPollers.push({ type, key: part.key, identity: poller.identity });
      }
      const route = p.versioningInfo;
      if (
        route?.currentDeploymentVersion?.buildId ||
        route?.rampingDeploymentVersion?.buildId ||
        Number(route?.rampingVersionPercentage ?? 0) !== 0
      )
        fail();
      partitionRows.push({ type, key: part.key, owner: part.ownerHostName ?? '' });
    }
    if (!seen.has(queue) || seen.size > 128) fail();
  }
  // A standalone Activity/Nexus execution need not have a parent Workflow or
  // Firestore record. Unsupported/incomplete native enumeration fails closed.
  for (const method of ['listActivityExecutions', 'listNexusOperationExecutions']) {
    let cursor;
    const tokens = new Set();
    do {
      const page = await rpc(() =>
        service[method]({
          namespace,
          pageSize: 100,
          query: 'ExecutionStatus = "Running"',
          ...(cursor ? { nextPageToken: cursor } : {}),
        })
      );
      if (array(method === 'listNexusOperationExecutions' ? page.operations : page.executions).length) fail();
      cursor = token(page.nextPageToken, tokens);
    } while (cursor);
  }
  const workflows = [],
    tokens = new Set();
  let cursor;
  do {
    const page = await rpc(() =>
      service.listWorkflowExecutions({
        namespace,
        pageSize: 100,
        query: 'ExecutionStatus = "Running"',
        ...(cursor ? { nextPageToken: cursor } : {}),
      })
    );
    for (const e of array(page.executions)) {
      const x = e.execution;
      if (
        !uuid(x?.runId) ||
        typeof x.workflowId !== 'string' ||
        workflows.some((w) => w.runId === x.runId) ||
        workflows.length >= 500
      )
        fail();
      const native = await rpc(() => service.describeWorkflowExecution({ namespace, execution: x })),
        info = native.workflowExecutionInfo,
        v = info?.versioningInfo,
        version = v?.versioningOverride?.pinned?.version ?? v?.deploymentVersion;
      if (
        info?.status !== 1 ||
        hash(info.execution) !== hash(x) ||
        info.taskQueue === queue ||
        version?.deploymentName === deploymentName ||
        version?.buildId === plan.buildId ||
        !version?.deploymentName ||
        !version?.buildId ||
        (v?.versioningOverride && !v.versioningOverride.pinned) ||
        native.pendingActivities?.length ||
        native.pendingNexusOperations?.length ||
        native.pendingChildren?.length
      )
        fail();
      workflows.push({ runId: x.runId, executionSHA256: hash(x), nativeSHA256: hash(native) });
    }
    cursor = token(page.nextPageToken, tokens);
  } while (cursor);
  const jobWork = plan.job ? await read(() => readJobDurableInventory(db, plan, o.operationId, auth)) : undefined;
  const rows = [];
  if (!jobWork)
    for (const collection of durableCollections) {
      let after;
      do {
        let q = db.collection(collection).orderBy('__name__').limit(100);
        if (after) q = q.startAfter(after);
        const page = await read(() => q.get());
        for (const doc of page.docs) {
          if (
            rows.length >= 3000 ||
            collection === 'durableJobCriticalSections' ||
            collection === 'temporalProviderMutationLocks' ||
            (collection === 'temporalProviderMutationSessions' &&
              !['committed', 'aborted'].includes(doc.get('state'))) ||
            (['durableJobOutbox', 'durableJobCommands'].includes(collection) &&
              (!['dispatched', 'failed'].includes(doc.get('state')) ||
                doc.get('leaseOwner') ||
                doc.get('leaseExpiresAt') > 0))
          )
            fail();
          if (doc.get('worker.buildId') === plan.buildId || doc.get('execution.worker.buildId') === plan.buildId) {
            if (collection !== 'durableActivityExecutions') fail();
            assertOwnedDiagnosticActivity(doc, o.operationId, auth);
          }
          rows.push({ pathSHA256: hash(doc.ref.path), stamp: stamp(doc) });
        }
        after = page.size === 100 ? page.docs.at(-1) : undefined;
      } while (after);
    }
  return {
    versions: versions.sort((a, b) => a.buildId.localeCompare(b.buildId)),
    partitions: partitionRows.sort((a, b) => a.type - b.type || a.key.localeCompare(b.key)),
    workflows: workflows.sort((a, b) => a.runId.localeCompare(b.runId)),
    rows: rows.sort((a, b) => a.pathSHA256.localeCompare(b.pathSHA256)),
    ...(jobWork && { jobWork }),
    ownedPollers,
  };
}
