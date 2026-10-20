import { proofDigest, assertNativeSnapshot } from './temporal-release-runtime.mjs';
import { observeNamespaceComputeIsolation } from './temporal-compute-isolation.mjs';
const fail = () => {
  throw new Error('CLOUD_RUN_BOOTSTRAP_PROTECTION_UNCONFIRMED');
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const version = (x) => (x?.updateTime ? `${x.updateTime.seconds}:${x.updateTime.nanoseconds}` : fail());
/** Native observations under a still-paused original operation. Conservative:
 * any pending Activity, unversioned open run, active provider session/lock or
 * unresolved dispatch lease stops bootstrap. Never settles or edits old work.
 */
export async function observeBootstrapProtection(o) {
  const { client, firestore: db, platform, role, operationId, bindingDigest, expectedAuthority, releaseId } = o;
  if (
    role !== 'controls' ||
    db.projectId !== 'urm-app-staging' ||
    db.databaseId !== '(default)' ||
    client.options.namespace !== platform.temporalNamespace
  )
    fail();
  const binding = platform.roleBindings.find((x) => x.role === role),
    service = client.connection.workflowService,
    namespace = platform.temporalNamespace;
  const deadline = Date.now() + 60000;
  const rpc = (fn) => client.connection.withDeadline(Math.min(deadline, Date.now() + 5000), fn);
  // Read-only calls may settle late; a timeout never permits a subsequent write.
  const read = async (fn) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('BOOTSTRAP_READ_TIMEOUT')),
            Math.max(1, Math.min(5000, deadline - Date.now()))
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const scan = async () => {
    const docs = await read(() =>
      db.getAll(
        db.doc('_control/temporalReleaseOperation'),
        db.doc('_control/temporalRelease'),
        db.doc('_control/temporalReleaseState')
      )
    );
    const [p, c, s] = docs;
    assertNativeSnapshot(expectedAuthority.control, c);
    assertNativeSnapshot(expectedAuthority.state, s);
    if (
      p.get('operationId') !== operationId ||
      p.get('bindingDigest') !== bindingDigest ||
      p.get('releaseId') !== releaseId ||
      ![
        'bootstrap-stop-cloud-run-controls',
        'activate-cloud-run-controls-pool',
        'stop-cloud-run-controls-activation',
      ].includes(p.get('action')) ||
      c.get('releaseId') !== releaseId ||
      s.get('releaseId') !== releaseId ||
      c.get('admission') !== 'paused' ||
      s.get('phase') !== 'provider-usage-ready' ||
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
        (d) => c.get(`domains.${d}.admission`) !== 'paused'
      )
    )
      fail();
    const workflows = [],
      seen = new Set(),
      tokens = new Set();
    let nextPageToken;
    do {
      if (Date.now() >= deadline || workflows.length > 500) fail();
      const page = await rpc(() =>
        service.listWorkflowExecutions({
          namespace,
          pageSize: 100,
          query: 'ExecutionStatus = "Running"',
          ...(nextPageToken ? { nextPageToken } : {}),
        })
      );
      if (page.executions !== undefined && !Array.isArray(page.executions)) fail();
      for (const entry of page.executions ?? []) {
        const e = entry.execution;
        if (typeof e?.workflowId !== 'string' || !e.workflowId || !uuid.test(e.runId ?? '') || seen.has(e.runId))
          fail();
        seen.add(e.runId);
        const report = await rpc(() => service.describeWorkflowExecution({ namespace, execution: e })),
          info = report.workflowExecutionInfo,
          v = info?.versioningInfo;
        const pinned = v?.versioningOverride?.pinned;
        const deployed = pinned?.version ?? v?.deploymentVersion;
        if (
          info?.execution?.workflowId !== e.workflowId ||
          info.execution.runId !== e.runId ||
          info.status !== 1 ||
          (v?.versioningOverride && !pinned) ||
          (pinned ? pinned.behavior !== 1 : v?.behavior !== 1) ||
          !deployed?.deploymentName ||
          !deployed.buildId ||
          deployed.buildId === binding.buildId ||
          report.pendingActivities?.length ||
          report.pendingNexusOperations?.length
        )
          fail();
        const found = await rpc(() =>
          service.describeWorkerDeploymentVersion({ namespace, deploymentVersion: deployed })
        );
        if (
          found.workerDeploymentVersionInfo?.deploymentVersion?.deploymentName !== deployed.deploymentName ||
          found.workerDeploymentVersionInfo.deploymentVersion.buildId !== deployed.buildId ||
          !found.workerDeploymentVersionInfo.taskQueueInfos?.some((q) => q.name === info.taskQueue && q.type === 1)
        )
          fail();
        workflows.push({ executionSHA256: proofDigest(e), version: deployed, queue: info.taskQueue });
      }
      if (
        page.nextPageToken != null &&
        !(page.nextPageToken instanceof Uint8Array) &&
        !(Array.isArray(page.nextPageToken) && !page.nextPageToken.length)
      )
        fail();
      nextPageToken = page.nextPageToken?.length ? page.nextPageToken : undefined;
      if (nextPageToken) {
        const t = Buffer.from(nextPageToken).toString('base64');
        if (tokens.has(t) || tokens.size > 10) fail();
        tokens.add(t);
      }
    } while (nextPageToken);
    const rows = [];
    for (const collection of [
      'durableJobOutbox',
      'durableJobCommands',
      'durableJobCriticalSections',
      'durableActivityExecutions',
      'temporalProviderMutationSessions',
      'temporalProviderMutationLocks',
    ]) {
      let cursor;
      do {
        if (Date.now() >= deadline || rows.length > 3000) fail();
        let q = db.collection(collection).orderBy('__name__').limit(100);
        if (cursor) q = q.startAfter(cursor);
        const page = await read(() => q.get());
        for (const doc of page.docs) {
          if (
            collection === 'durableJobCriticalSections' ||
            collection === 'temporalProviderMutationLocks' ||
            (collection === 'temporalProviderMutationSessions' && doc.get('state') === 'active') ||
            (['durableJobOutbox', 'durableJobCommands'].includes(collection) &&
              (['pending', 'dispatching'].includes(doc.get('state')) ||
                (doc.get('leaseOwner') && doc.get('leaseExpiresAt') > 0))) ||
            doc.get('worker.buildId') === binding.buildId ||
            doc.get('execution.worker.buildId') === binding.buildId
          )
            fail();
          rows.push([doc.ref.path, version(doc)]);
        }
        cursor = page.size === 100 ? page.docs.at(-1) : undefined;
      } while (cursor);
    }
    let routing = null;
    try {
      const report = await rpc(() =>
        service.describeWorkerDeployment({ namespace, deploymentName: binding.deploymentName })
      );
      routing = report.workerDeploymentInfo?.routingConfig ?? null;
      if (
        routing?.currentDeploymentVersion?.buildId === binding.buildId ||
        routing?.rampingDeploymentVersion?.buildId === binding.buildId ||
        Number(routing?.rampingVersionPercentage ?? 0) !== 0
      )
        fail();
    } catch (error) {
      if (error?.code !== 5) throw error;
    }
    return {
      controlVersion: version(c),
      stateVersion: version(s),
      workflows: workflows.sort((a, b) => a.executionSHA256.localeCompare(b.executionSHA256)),
      rows: rows.sort((a, b) => a[0].localeCompare(b[0])),
      routing,
    };
  };
  try {
    const scanStartedAt = Date.now(),
      first = await scan(),
      second = await scan();
    const isolation = await observeNamespaceComputeIsolation(client, namespace);
    if (
      proofDigest(first) !== proofDigest(second) ||
      Date.now() >= deadline ||
      Date.now() - scanStartedAt > 5000 ||
      !Number.isFinite(Date.parse(isolation.observedAt)) ||
      Math.abs(Date.now() - Date.parse(isolation.observedAt)) > 5000
    )
      fail();
    return {
      schemaVersion: 1,
      namespace,
      role,
      buildId: binding.buildId,
      observedAt: new Date(scanStartedAt).toISOString(),
      computeObservedAt: isolation.observedAt,
      protectionSHA256: proofDigest(second),
      computeInventorySHA256: isolation.inventorySHA256,
      protectedRunCount: second.workflows.length,
      scope:
        'two stable paused native/Firestore observations; conservative pending-work denial; not cross-API exclusion, old-version drainage or readiness',
    };
  } catch {
    return fail();
  }
}
export async function observeBootstrapRegistration({ client, platform, role }) {
  const b = platform.roleBindings.find((x) => x.role === role),
    namespace = platform.temporalNamespace,
    service = client.connection.workflowService;
  if (role !== 'controls' || client.options.namespace !== namespace) fail();
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try {
      const version = await client.connection.withDeadline(Math.min(end, Date.now() + 5000), () =>
        service.describeWorkerDeploymentVersion({
          namespace,
          deploymentVersion: { deploymentName: b.deploymentName, buildId: b.buildId },
        })
      );
      const report = await client.connection.withDeadline(Math.min(end, Date.now() + 5000), () =>
        service.describeWorkerDeployment({ namespace, deploymentName: b.deploymentName })
      );
      const v = version.workerDeploymentVersionInfo,
        r = report.workerDeploymentInfo?.routingConfig;
      if (
        v?.deploymentVersion?.deploymentName === b.deploymentName &&
        v.deploymentVersion.buildId === b.buildId &&
        v.taskQueueInfos?.some((q) => q.name === 'urm-controls' && q.type === 2) &&
        r?.currentDeploymentVersion?.buildId !== b.buildId &&
        r?.rampingDeploymentVersion?.buildId !== b.buildId &&
        Number(r?.rampingVersionPercentage ?? 0) === 0
      )
        return {
          schemaVersion: 1,
          role,
          buildId: b.buildId,
          observedAt: new Date().toISOString(),
          registrationSHA256: proofDigest(version),
          routingSHA256: proofDigest(report),
          scope:
            'native non-current controls Activity queue registration only; no workflow start, promotion or readiness',
        };
    } catch (error) {
      if (error?.code !== 5) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return fail();
}
