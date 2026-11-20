const containerCount = 'run.googleapis.com/container/containers';
const instanceCount = 'run.googleapis.com/container/instance_count';
const resourceType = 'cloud_run_worker_pool';
const projectId = 'urm-app-staging';
const location = 'us-central1';
const sourceName = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;
const fail = () => {
  throw new Error('CLOUD_RUN_WORKER_COUNT_UNCONFIRMED');
};

/** Read raw provider gauge samples. Empty/sparse series never imply zero. */
export function readCloudRunWorkerCount(scope) {
  return readCloudRunCount(scope, containerCount, true);
}

/** Read the whole worker-pool revision's documented instance gauge. It
 * excludes container-specific filters and carries no per-instance identity. */
export function readCloudRunRevisionInstanceCount(scope) {
  return readCloudRunCount(scope, instanceCount, false);
}

async function readCloudRunCount({ api, pool, revision, from, to }, metricType, workerContainer) {
  if (
    typeof api !== 'function' ||
    typeof pool !== 'string' ||
    !sourceName.test(pool) ||
    typeof revision !== 'string' ||
    revision.length > 63 ||
    !revision.startsWith(pool) ||
    !/^(?:-[a-z0-9][a-z0-9-]*|\.[1-9][0-9]*)$/.test(revision.slice(pool.length)) ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from <= 0 ||
    from >= to ||
    to > Date.now() ||
    to - from > 8 * 60 * 60 * 1000
  )
    fail();

  const labels = { project_id: projectId, location, worker_pool_name: pool, revision_name: revision };
  const filter = [
    `metric.type = "${metricType}"`,
    `resource.type = "${resourceType}"`,
    ...Object.entries(labels).map(([key, value]) => `resource.labels.${key} = "${value}"`),
    ...(workerContainer ? ['metric.labels.container_name = "worker"'] : []),
  ].join(' AND ');
  const params = new URLSearchParams({
    filter,
    'interval.startTime': new Date(from).toISOString(),
    'interval.endTime': new Date(to).toISOString(),
    view: 'FULL',
    pageSize: '500',
  });
  const cursors = new Set();
  const byState = new Map();
  const configurations = new Map();

  for (;;) {
    const reply = await api(`https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries?${params}`);
    if (
      !reply ||
      reply.executionErrors?.length ||
      reply.unreachable?.length ||
      (reply.timeSeries !== undefined && !Array.isArray(reply.timeSeries))
    )
      fail();

    for (const series of reply.timeSeries ?? []) {
      const state = series.metric?.labels?.state;
      const configuration = series.resource?.labels?.configuration_name ?? '';
      if (
        series.metric?.type !== metricType ||
        (workerContainer
          ? series.metric?.labels?.container_name !== 'worker'
          : Object.keys(series.metric?.labels ?? {}).join(',') !== 'state') ||
        !['active', 'idle'].includes(state) ||
        series.metricKind !== 'GAUGE' ||
        series.valueType !== 'INT64' ||
        series.resource?.type !== resourceType ||
        Object.entries(labels).some(([key, value]) => series.resource?.labels?.[key] !== value) ||
        typeof configuration !== 'string' ||
        !Array.isArray(series.points) ||
        !series.points.length
      )
        fail();

      const existing = byState.get(state) ?? new Map();
      if (configurations.has(state) && configurations.get(state) !== configuration) fail();
      configurations.set(state, configuration);
      for (const point of series.points) {
        const at = Date.parse(point.interval?.endTime);
        const stored = point.value?.int64Value;
        const count = Number(stored);
        if (
          !Number.isFinite(at) ||
          at <= from ||
          at > to ||
          (point.interval?.startTime != null && Date.parse(point.interval.startTime) !== at) ||
          typeof stored !== 'string' ||
          !/^(?:0|[1-9][0-9]*)$/.test(stored) ||
          !Number.isSafeInteger(count) ||
          existing.has(at)
        )
          fail();
        existing.set(at, count);
      }
      byState.set(state, existing);
    }

    const token = reply.nextPageToken;
    if (token == null || token === '') break;
    if (typeof token !== 'string' || token.length > 4096 || cursors.has(token) || cursors.size >= 10) fail();
    cursors.add(token);
    params.set('pageToken', token);
  }

  // Worker pools do not idle. Reject contradictory reports instead of hiding
  // an instance in a state the documented pool lifecycle does not support.
  if ([...(byState.get('idle')?.values() ?? [])].some((count) => count !== 0)) fail();
  return [...(byState.get('active') ?? [])].sort(([a], [b]) => a - b).map(([at, count]) => ({ at, count }));
}
