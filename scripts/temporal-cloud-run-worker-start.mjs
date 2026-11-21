import { isMediaRecoveryTaskIdentity, mediaRecoveryTaskIdentity } from './temporal-media-recovery-job.mjs';
import { createHash } from 'node:crypto';

const project = 'urm-app-staging';
const logName = `projects/${project}/logs/run.googleapis.com%2Fstdout`;
const legacyResourceType = 'cloud_run_workerpool';
const currentResourceType = 'cloud_run_worker_pool';
const safeLabel = /^[a-zA-Z0-9_.:-]{1,256}$/;
const identity =
  /^(?:cloud-run-[a-f0-9]{64}-|media-restored-)[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const recoveryIdentity = /^media-recovery-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const fail = () => {
  throw new Error('CLOUD_RUN_WORKER_START_UNCONFIRMED');
};

function poolResourceFilter(pool, revision) {
  return [
    'resource.labels.project_id = "urm-app-staging"',
    'resource.labels.location = "us-central1"',
    `((resource.type = "${currentResourceType}" AND resource.labels.worker_pool_name = "${pool}" AND resource.labels.revision_name = "${revision}") OR (resource.type = "${legacyResourceType}" AND resource.labels.workerpool_name = "${pool}"))`,
  ];
}

function matchesPoolResource(resource, pool, revision) {
  const labels = resource?.labels;
  if (labels?.project_id !== project || labels.location !== 'us-central1') return false;
  if (resource.type === currentResourceType)
    return labels.worker_pool_name === pool && labels.revision_name === revision;
  return (
    resource.type === legacyResourceType &&
    labels.workerpool_name === pool &&
    (labels.revision_name == null || labels.revision_name === revision)
  );
}

/** Join an opaque SDK poller identity to Cloud Logging's provider instance label.
 * A start marker describes its own instance, never the fate of an earlier one. */
export async function readCloudRunWorkerStart({
  api,
  pool,
  revision,
  revisionUid,
  buildId,
  taskQueue,
  workerIdentity,
  recovery,
  from,
  to,
}) {
  if (
    typeof api !== 'function' ||
    [pool, revision, revisionUid, taskQueue].some((value) => typeof value !== 'string' || !safeLabel.test(value)) ||
    typeof workerIdentity !== 'string' ||
    !(recovery === undefined ? identity : recoveryIdentity).test(workerIdentity) ||
    (recovery !== undefined &&
      (taskQueue !== 'urm-media-kernel-recovery' ||
        !uuid.test(recovery?.operationId ?? '') ||
        !['original', 'replacement'].includes(recovery?.child) ||
        !sha256.test(recovery?.startupSHA256 ?? ''))) ||
    !/^[a-f0-9]{40}$/.test(buildId ?? '') ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from <= 0 ||
    from >= to ||
    to > Date.now() ||
    to - from > 8 * 60 * 60 * 1000
  )
    fail();

  const payload = {
    event: recovery ? 'temporal_media_recovery_worker_started' : 'temporal_worker_started',
    workerIdentity,
    pool,
    revision,
    revisionUid,
    buildId,
    taskQueue,
    ...(recovery
      ? { operationId: recovery.operationId, child: recovery.child, startupSHA256: recovery.startupSHA256 }
      : {}),
  };
  const filter = [
    `logName = "${logName}"`,
    ...poolResourceFilter(pool, revision),
    `timestamp >= "${new Date(from).toISOString()}"`,
    `timestamp <= "${new Date(to).toISOString()}"`,
    `jsonPayload.event = "${payload.event}"`,
    `jsonPayload.workerIdentity = "${workerIdentity}"`,
    ...(recovery
      ? [`jsonPayload.operationId = "${recovery.operationId}"`, `jsonPayload.child = "${recovery.child}"`]
      : []),
  ].join(' AND ');
  const read = (pageToken) =>
    api('https://logging.googleapis.com/v2/entries:list', 'POST', {
      resourceNames: [`projects/${project}`],
      filter,
      pageSize: 50,
      ...(pageToken ? { pageToken } : {}),
    });
  const cursors = new Set();
  let observation;
  let token;
  do {
    const reply = await read(token);
    if (!reply || (reply.entries !== undefined && !Array.isArray(reply.entries))) fail();
    for (const entry of reply.entries ?? []) {
      const instanceId = entry.labels?.instanceId;
      const at = Date.parse(entry.timestamp);
      if (
        observation ||
        entry.logName !== logName ||
        !matchesPoolResource(entry.resource, pool, revision) ||
        Object.entries(payload).some(([name, value]) => entry.jsonPayload?.[name] !== value) ||
        !Number.isFinite(at) ||
        at < from ||
        at > to ||
        typeof instanceId !== 'string' ||
        !safeLabel.test(instanceId) ||
        typeof entry.insertId !== 'string' ||
        !safeLabel.test(entry.insertId)
      )
        fail();
      observation = { at, instanceId, insertId: entry.insertId, workerIdentity };
    }
    token = reply.nextPageToken ?? '';
    if (token !== '') {
      if (typeof token !== 'string' || token.length > 4096 || cursors.size >= 10 || cursors.has(token)) fail();
      cursors.add(token);
    }
  } while (token);
  return observation ?? null;
}

/** Join the validated capacity process to its independently labeled provider startup.
 * The metadata instance ID and the Cloud Logging label need not share a format. */
export async function readMediaBootstrapCloudOrigin({ api, binding, origin }) {
  const observedAt = Date.parse(origin.observedAt);
  const started = Date.now();
  const monotonic = performance.now();
  if (
    binding.role !== 'media' ||
    binding.taskQueue !== 'urm-media' ||
    !Number.isFinite(observedAt) ||
    observedAt > started + 5000 ||
    started - observedAt > 120000
  )
    fail();
  const live = () => Date.now() - started < 15000 && performance.now() - monotonic < 15000;
  const observe = async () => {
    while (live()) {
      const to = Date.now();
      const startup = await readCloudRunWorkerStart({
        api,
        pool: binding.poolName,
        revision: origin.revision,
        revisionUid: origin.revisionUid,
        buildId: binding.buildId,
        taskQueue: binding.taskQueue,
        workerIdentity: origin.identity,
        from: Math.min(started - 1, observedAt - 5000),
        to,
      });
      if (startup && live()) return startup;
      if (live()) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return fail();
  };
  let timer;
  try {
    return await Promise.race([
      observe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('CLOUD_RUN_WORKER_START_UNCONFIRMED')), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Both SDK children of the diagnostic must bind to the same provider log
 * instance. The platform label and runtime metadata have separate provenance. */
export async function readMediaRecoveryCloudOrigin({ api, plan, pool, origin }) {
  const { original, replacement } = origin ?? {};
  if (
    !original ||
    !replacement ||
    original.workerIdentity === replacement.workerIdentity ||
    typeof original.metadataInstanceId !== 'string' ||
    !safeLabel.test(original.metadataInstanceId) ||
    original.metadataInstanceId !== replacement.metadataInstanceId ||
    pool.name !== plan.name ||
    pool.uid !== plan.origin.uid ||
    !pool.revision.startsWith(`${plan.name}/revisions/`)
  )
    fail();
  const scope = {
    api,
    pool: plan.name.split('/').at(-1),
    revision: pool.revision.split('/').at(-1),
    revisionUid: pool.revisionUid,
    buildId: plan.buildId,
    taskQueue: 'urm-media-kernel-recovery',
  };
  const created = Date.parse(plan.createdAt);
  const [before, after] = await Promise.all(
    [
      ['original', original],
      ['replacement', replacement],
    ].map(([child, work]) => {
      const recorded = Date.parse(work.recordedAt);
      if (!Number.isFinite(recorded) || recorded < created || recorded >= plan.expiresAt) fail();
      return readCloudRunWorkerStart({
        ...scope,
        workerIdentity: work.workerIdentity,
        recovery: { operationId: plan.operationId, child, startupSHA256: work.startupSHA256 },
        from: Math.max(created, recorded - 5000),
        to: Math.min(Date.now(), recorded + 90_000),
      });
    })
  );
  if (!before || !after) return null;
  if (before.instanceId !== after.instanceId || before.at >= after.at || before.insertId === after.insertId) fail();
  return { original: before, replacement: after };
}

/** Observe the original instance's provider system log only. Text hints are
 * for investigation and never establish terminal state or recovery authority. */
export async function readCloudRunWorkerSystemEvents({ api, pool, revision, instanceId, from, to }) {
  if (
    typeof api !== 'function' ||
    [pool, revision, instanceId].some((value) => typeof value !== 'string' || !safeLabel.test(value)) ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from <= 0 ||
    to <= from ||
    to > Date.now() ||
    to - from > 8 * 60 * 60 * 1000
  )
    fail();

  const systemLog = `projects/${project}/logs/run.googleapis.com%2Fvarlog%2Fsystem`;
  const filter = [
    `logName = "${systemLog}"`,
    ...poolResourceFilter(pool, revision),
    `labels.instanceId = "${instanceId}"`,
    `timestamp >= "${new Date(from).toISOString()}"`,
    `timestamp <= "${new Date(to).toISOString()}"`,
  ].join(' AND ');
  const cursors = new Set(),
    found = new Map();
  let token = '';
  do {
    const reply = await api('https://logging.googleapis.com/v2/entries:list', 'POST', {
      resourceNames: [`projects/${project}`],
      filter,
      pageSize: 50,
      ...(token ? { pageToken: token } : {}),
    });
    if (!reply || (reply.entries !== undefined && !Array.isArray(reply.entries))) fail();
    for (const entry of reply.entries ?? []) {
      const at = Date.parse(entry.timestamp);
      const text = entry.textPayload;
      if (
        entry.logName !== systemLog ||
        !matchesPoolResource(entry.resource, pool, revision) ||
        entry.labels?.instanceId !== instanceId ||
        !Number.isFinite(at) ||
        at < from ||
        at > to ||
        typeof entry.insertId !== 'string' ||
        !safeLabel.test(entry.insertId) ||
        found.has(entry.insertId) ||
        found.size >= 250
      )
        fail();
      const lifecycleText =
        typeof text === 'string' &&
        /\b(?:terminat(?:e[ds]?|ion|ing)|shut(?:ting)?[ -]?down|exited|sigterm|sigkill)\b/i.test(text);
      const payload = JSON.stringify({ text, json: entry.jsonPayload, proto: entry.protoPayload });
      found.set(entry.insertId, {
        at,
        insertId: entry.insertId,
        lifecycleText,
        payloadSHA256: createHash('sha256').update(payload).digest('hex'),
      });
    }
    token = reply.nextPageToken ?? '';
    if (token !== '') {
      if (typeof token !== 'string' || token.length > 4096 || cursors.size >= 5 || cursors.has(token)) fail();
      cursors.add(token);
    }
  } while (token);
  return [...found.values()].sort((a, b) => a.at - b.at || a.insertId.localeCompare(b.insertId));
}

/** Join both supervised child startups to the original Cloud Run Job task's
 * provider labels. Task termination still requires native Execution/Task readback. */
export async function readMediaRecoveryJobOrigins({ api, plan, origin }) {
  const job = origin?.job;
  const jobName = job?.job?.split('/').at(-1);
  const execution = job?.execution?.split('/').at(-1);
  const children = ['original', 'replacement'];
  const jobs = `projects/${project}/locations/us-central1/jobs/`;
  const nativeTask=job?.taskCreateTime!==undefined;
  const executionLabel=nativeTask?'run.googleapis.com/execution_name':'execution_name';
  const indexLabel=nativeTask?'run.googleapis.com/task_index':'task_index';
  if (
    !uuid.test(plan?.operationId ?? '') ||
    !job ||
    job.job !== plan?.job?.name ||
    job.job !== jobs + 'urm-media-recovery-' + plan.operationId.replaceAll('-', '') ||
    !/^[a-z0-9-]{1,63}$/.test(execution ?? '') ||
    job.execution !== job.job + '/executions/' + execution ||
    !uuid.test(job.executionUid) ||
    !isMediaRecoveryTaskIdentity(mediaRecoveryTaskIdentity(job)) ||
    (nativeTask&&(typeof job.task!=='string'||!job.task.startsWith(job.execution+'/tasks/')||
      !/^[a-z0-9-]{1,63}$/.test(job.task.slice((job.execution+'/tasks/').length)))) ||
    !/^[a-f0-9]{40}$/.test(plan.buildId) ||
    children.some(
      (child) =>
        !recoveryIdentity.test(origin[child]?.workerIdentity) ||
        !sha256.test(origin[child]?.startupSHA256) ||
        !Number.isFinite(Date.parse(origin[child]?.recordedAt))
    )
  )
    fail();
  const from = Math.max(Date.parse(plan.createdAt), Date.parse(origin.original.recordedAt) - 5000);
  const to = Math.min(Date.now(), Date.parse(origin.replacement.recordedAt) + 90000);
  if (!Number.isFinite(from) || from >= to || to - from > 300000) fail();
  const filter = [
    `logName = "${logName}"`,
    'resource.type = "cloud_run_job"',
    `resource.labels.project_id = "${project}"`,
    'resource.labels.location = "us-central1"',
    `resource.labels.job_name = "${jobName}"`,
    `labels.${nativeTask?'"'+executionLabel+'"':executionLabel} = "${execution}"`,
    `labels.${nativeTask?'"'+indexLabel+'"':indexLabel} = "0"`,
    ...(nativeTask?['labels."run.googleapis.com/task_attempt" = "0"']:[]),
    `timestamp >= "${new Date(from).toISOString()}"`,
    `timestamp <= "${new Date(to).toISOString()}"`,
    'jsonPayload.event = "temporal_media_recovery_worker_started"',
    `jsonPayload.operationId = "${plan.operationId}"`,
  ].join(' AND ');
  const reply = await api('https://logging.googleapis.com/v2/entries:list', 'POST', {
    resourceNames: [`projects/${project}`],
    filter,
    pageSize: 50,
  });
  if (!reply || reply.nextPageToken || (reply.entries && !Array.isArray(reply.entries))) fail();
  const found = new Map();
  for (const entry of reply.entries ?? []) {
    const row = entry.jsonPayload;
    const child = row?.child;
    const at = Date.parse(entry.timestamp);
    const labels = entry.resource?.labels;
    const instanceId = entry.labels?.instanceId;
    if (
      !children.includes(child) ||
      found.has(child) ||
      entry.logName !== logName ||
      entry.resource?.type !== 'cloud_run_job' ||
      labels?.project_id !== project ||
      labels.location !== 'us-central1' ||
      labels.job_name !== jobName ||
      entry.labels?.[executionLabel] !== execution ||
      entry.labels?.[indexLabel] !== '0' ||
      (nativeTask&&entry.labels?.['run.googleapis.com/task_attempt']!=='0') ||
      !safeLabel.test(instanceId ?? '') ||
      !safeLabel.test(entry.insertId ?? '') ||
      !Number.isFinite(at) ||
      at < from ||
      at > to ||
      row.event !== 'temporal_media_recovery_worker_started' ||
      row.operationId !== plan.operationId ||
      row.taskQueue !== 'urm-media-kernel-recovery' ||
      row.buildId !== plan.buildId ||
      row.job !== job.job ||
      row.executionUid !== job.executionUid ||
      row.taskUid !== job.taskUid ||
      (nativeTask&&(row.task!==job.task||row.taskCreateTime!==job.taskCreateTime)) ||
      row.workerIdentity !== origin[child].workerIdentity ||
      row.startupSHA256 !== origin[child].startupSHA256
    )
      fail();
    found.set(child, { at, instanceId, insertId: entry.insertId, workerIdentity: row.workerIdentity });
  }
  const original = found.get('original'),
    replacement = found.get('replacement');
  if (!original || !replacement) return null;
  if (
    original.instanceId !== replacement.instanceId ||
    original.at >= replacement.at ||
    original.insertId === replacement.insertId ||
    original.workerIdentity === replacement.workerIdentity
  )
    fail();
  return { original, replacement };
}
