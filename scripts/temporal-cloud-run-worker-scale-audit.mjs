const project = 'urm-app-staging';
const projectNumber = '251680231116';
const logName = `projects/${project}/logs/cloudaudit.googleapis.com%2Factivity`;
const method = 'google.cloud.run.v2.WorkerPools.UpdateWorkerPool';
const fail = () => {
  throw new Error('CLOUD_RUN_WORKER_SCALE_AUDIT_UNCONFIRMED');
};

export async function readCloudRunWorkerScaleAudit({ api, pool, invoker, allowedDelegates, from, to }) {
  if (
    typeof api !== 'function' ||
    typeof pool !== 'string' ||
    !/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(pool) ||
    typeof invoker !== 'string' ||
    !/^ts-[ocmeis]-[a-f0-9]{20}@urm-app-staging\.iam\.gserviceaccount\.com$/.test(invoker) ||
    !Array.isArray(allowedDelegates) ||
    !allowedDelegates.length ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from <= 0 ||
    from >= to ||
    to > Date.now() ||
    to - from > 8 * 60 * 60 * 1000
  )
    fail();

  const name = `projects/${project}/locations/us-central1/workerPools/${pool}`;
  const numeric = name.replace(`projects/${project}/`, `projects/${projectNumber}/`);
  const v1Names = [project, projectNumber].map((id) => `namespaces/${id}/workerpools/${pool}`);
  const v2Name = (value) => value === name || value === numeric;
  const allNames = [name, numeric, ...v1Names];
  const filter = [
    `logName = "${logName}"`,
    'protoPayload.serviceName = "run.googleapis.com"',
    `(${allNames.map((value) => `protoPayload.resourceName = "${value}"`).join(' OR ')})`,
    `timestamp >= "${new Date(from).toISOString()}"`,
    `timestamp <= "${new Date(to).toISOString()}"`,
  ].join(' AND ');
  const cursors = new Set();
  const insertIds = new Set();
  const rows = [];
  let token = '';
  do {
    const reply = await api('https://logging.googleapis.com/v2/entries:list', 'POST', {
      resourceNames: [`projects/${project}`],
      filter,
      pageSize: 100,
      ...(token ? { pageToken: token } : {}),
    });
    if (!reply || (reply.entries !== undefined && !Array.isArray(reply.entries))) fail();
    for (const entry of reply.entries ?? []) {
      const at = Date.parse(entry.timestamp);
      const audit = entry.protoPayload;
      const request = audit?.request;
      const mask = request?.updateMask;
      const workerPool = request?.workerPool;
      if (
        !Number.isFinite(at) ||
        at < from ||
        at > to ||
        typeof entry.insertId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,256}$/.test(entry.insertId) ||
        insertIds.has(entry.insertId) ||
        rows.length >= 500 ||
        entry.logName !== logName ||
        audit?.serviceName !== 'run.googleapis.com' ||
        !allNames.includes(audit.resourceName)
      )
        fail();
      insertIds.add(entry.insertId);
      const count = workerPool?.scaling?.manualInstanceCount;
      const scaleOnly =
        ['scaling', 'scaling.manualInstanceCount', 'scaling.manual_instance_count'].includes(mask) ||
        (Array.isArray(mask?.paths) &&
          mask.paths.length === 1 &&
          ['scaling', 'scaling.manual_instance_count'].includes(mask.paths[0]));
      // Keep every update attempt in the checked interval. A foreign, rejected
      // or redacted entry must not disappear from the proof.
      const delegation = audit.authenticationInfo?.serviceAccountDelegationInfo;
      const delegate = delegation?.[0]?.firstPartyPrincipal?.principalEmail;
      const verified =
        audit.methodName === method &&
        v2Name(audit.resourceName) &&
        audit.authenticationInfo?.principalEmail === invoker &&
        Array.isArray(delegation) &&
        delegation.length === 1 &&
        allowedDelegates.includes(`serviceAccount:${delegate}`) &&
        (audit.status?.code == null || audit.status.code === 0) &&
        scaleOnly &&
        v2Name(workerPool?.name) &&
        Object.keys(workerPool?.scaling ?? {}).join(',') === 'manualInstanceCount' &&
        (request.validateOnly === undefined || request.validateOnly === false) &&
        (request.allowMissing === undefined || request.allowMissing === false) &&
        (request.forceNewRevision === undefined || request.forceNewRevision === false) &&
        Number.isSafeInteger(count) &&
        count >= 0;
      rows.push({
        at,
        insertId: entry.insertId,
        count: verified ? count : null,
        ...(verified ? { invoker, delegate } : {}),
      });
    }
    token = reply.nextPageToken ?? '';
    if (token !== '') {
      if (typeof token !== 'string' || token.length > 4096 || cursors.size >= 10 || cursors.has(token)) fail();
      cursors.add(token);
    }
  } while (token);
  return rows.sort((a, b) => a.at - b.at);
}
