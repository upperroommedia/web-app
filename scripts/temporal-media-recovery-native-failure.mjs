import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { hasCompletedMediaRecoveryJobAccess, renderMediaRecoveryJob } from './temporal-media-recovery-job.mjs';
import { scanPrivateMediaInventory } from './temporal-media-private-inventory.mjs';
import { observeNamespaceComputeIsolation } from './temporal-compute-isolation.mjs';

const location = 'projects/urm-app-staging/locations/us-central1';
const endpoint = 'https://run.googleapis.com/v2/';
const namespace = 'urm-app-staging.qwejt';
const jobType = 'type.googleapis.com/google.cloud.run.v2.Job';
const executionType = 'type.googleapis.com/google.cloud.run.v2.Execution';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const stableID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const operationName = /^projects\/urm-app-staging\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/;
const zero = (value) => value === 0 || value === undefined;
const time = (value) => (typeof value === 'string' ? Date.parse(value) : NaN);
const normal = (value) =>
  typeof value === 'string' ? value.replace(/^projects\/251680231116\//, 'projects/urm-app-staging/') : undefined;
const short = (value) => value.split('/').at(-1);
const refers = (value, target) => normal(value) === target || value === short(target);
const digest = (left, right) => proofDigest(left) === proofDigest(right);
const fail = () => {
  throw Error('STAGING_MEDIA_JOB_TERMINAL_FAILURE_UNCONFIRMED');
};
const check = (predicate) => {
  if (!predicate) fail();
};
const has = (value, key) => Object.hasOwn(value ?? {}, key);

function projected(actual, expected) {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => projected(actual[index], value))
    );
  if (expected && typeof expected === 'object')
    return (
      actual &&
      typeof actual === 'object' &&
      Object.entries(expected).every(([key, value]) =>
        key === 'maxRetries' && value === 0 ? zero(actual[key]) : projected(actual[key], value)
      )
    );
  return actual === expected;
}

function taskSpec(actual, expected) {
  return (
    projected(actual, expected) &&
    ['command', 'args'].every(
      (key) =>
        actual.containers[0][key] === undefined ||
        (Array.isArray(actual.containers[0][key]) && !actual.containers[0][key].length)
    )
  );
}

function settled(row, name) {
  return (
    normal(row?.name) === name &&
    /^[1-9][0-9]*$/.test(String(row.generation)) &&
    String(row.observedGeneration) === String(row.generation) &&
    !row.reconciling &&
    !row.deleteTime &&
    typeof row.etag === 'string' &&
    row.etag.length > 0
  );
}

function completeFailure(row) {
  const conditions = row?.conditions?.filter((condition) => condition.type === 'Completed');
  return (
    conditions?.length === 1 &&
    conditions[0].state === 'CONDITION_FAILED' &&
    conditions[0].executionReason === 'NON_ZERO_EXIT_CODE'
  );
}

function sole(page, key) {
  check(
    page &&
      !page.nextPageToken &&
      (page.unreachable === undefined || (Array.isArray(page.unreachable) && !page.unreachable.length)) &&
      Array.isArray(page[key]) &&
      page[key].length === 1
  );
  return page[key][0];
}

/** Exact terminal negative evidence; separate from the successful recovery verifier. */
function verifyFailedStagingMediaJob({
  plan,
  provider,
  job,
  createLRO,
  runLRO,
  execution,
  executions,
  task,
  tasks,
  now,
}) {
  const { create, run, runIdentity: identity, access } = provider;
  const jobName = plan.job.name,
    executionName = identity.execution;
  const taskName = executionName + '/tasks/' + short(executionName) + '-task0';
  const executionSpec = plan.job.template.template;
  const { executionEnvironment, ...taskProjection } = executionSpec;
  const from = time(run.attemptedAt);
  check(
    Number.isFinite(now) &&
      uuid.test(plan.operationId) &&
      isDeepStrictEqual(plan.job, renderMediaRecoveryJob(plan)) &&
      hasCompletedMediaRecoveryJobAccess(plan, access, identity.jobUid) &&
      [create, run, identity].every((record) => record?.stage === 'acknowledged') &&
      provider.jobPlanSHA256 === proofDigest(plan.job) &&
      identity.jobPlanSHA256 === provider.jobPlanSHA256 &&
      identity.operation === run.operation &&
      identity.intentSHA256 === run.intentSHA256 &&
      identity.attemptedAt === run.attemptedAt &&
      executionEnvironment === 'EXECUTION_ENVIRONMENT_GEN2' &&
      executionName.startsWith(jobName + '/executions/') &&
      stableID.test(executionName.slice((jobName + '/executions/').length))
  );
  check(
    normal(createLRO?.name) === create.operation &&
      createLRO.done === true &&
      !createLRO.error &&
      createLRO.response?.['@type'] === jobType &&
      settled(createLRO.response, jobName) &&
      createLRO.response.uid === identity.jobUid &&
      createLRO.response.etag === run.request.body.etag &&
      projected(createLRO.response.template, plan.job.template) &&
      taskSpec(createLRO.response.template.template, executionSpec) &&
      settled(job, jobName) &&
      job.uid === identity.jobUid &&
      job.uid === access.plan.jobUid &&
      projected(job.template, plan.job.template) &&
      taskSpec(job.template.template, executionSpec) &&
      job.executionCount === 1 &&
      refers(job.latestCreatedExecution?.name, executionName)
  );
  check(
    normal(runLRO?.name) === run.operation &&
      runLRO.done === true &&
      !runLRO.response &&
      runLRO.error?.code === 10 &&
      runLRO.error.message ===
        'Task ' + short(taskName) + ' failed with exit code: 1 and message: The container exited with an error.' &&
      runLRO.metadata?.['@type'] === executionType &&
      normal(runLRO.metadata.name) === executionName &&
      (!has(runLRO.metadata, 'uid') || runLRO.metadata.uid === identity.executionUid)
  );
  check(
    settled(execution, executionName) &&
      execution.uid === identity.executionUid &&
      refers(execution.job, jobName) &&
      execution.taskCount === 1 &&
      execution.parallelism === 1 &&
      execution.failedCount === 1 &&
      [execution.runningCount, execution.succeededCount, execution.retriedCount, execution.cancelledCount].every(
        zero
      ) &&
      completeFailure(execution) &&
      taskSpec(execution.template, executionSpec)
  );
  const listedExecution = sole(executions, 'executions');
  check(
    digest(Object.fromEntries(Object.keys(listedExecution).map((key) => [key, execution[key]])), listedExecution) &&
      normal(listedExecution.name) === executionName &&
      listedExecution.uid === identity.executionUid &&
      listedExecution.createTime === execution.createTime &&
      listedExecution.etag === execution.etag
  );
  const listedTask = sole(tasks, 'tasks');
  const listedProjection = ({ logUri, ...row }) => row;
  check(
    settled(listedTask, taskName) &&
      settled(task, taskName) &&
      String(task.generation) === '1' &&
      digest(listedProjection(listedTask), listedProjection(task)) &&
      refers(task.job, jobName) &&
      refers(task.execution, executionName) &&
      [task.index, task.retried, task.maxRetries].every(zero) &&
      (!has(task, 'uid') || uuid.test(task.uid)) &&
      (!has(task, 'executionEnvironment') || task.executionEnvironment === executionEnvironment) &&
      taskSpec(task, taskProjection) &&
      completeFailure(task) &&
      task.lastAttemptResult?.exitCode === 1 &&
      task.lastAttemptResult?.status?.code === 10 &&
      !has(task.lastAttemptResult, 'termSignal')
  );
  const chronology = [
    from,
    time(execution.createTime),
    time(task.createTime),
    time(task.startTime),
    time(task.completionTime),
    time(execution.completionTime),
    now,
  ];
  const executionStarted = time(execution.startTime);
  check(
    chronology.every(Number.isFinite) &&
      chronology.every((mark, index) => !index || mark >= chronology[index - 1]) &&
      Number.isFinite(executionStarted) &&
      executionStarted >= chronology[1] &&
      executionStarted <= chronology[3]
  );
  // The exact original provider projection omits Task UID. Never synthesize one.
  return {
    job: jobName,
    jobUid: job.uid,
    createOperation: create.operation,
    runOperation: run.operation,
    execution: executionName,
    executionUid: execution.uid,
    task: taskName,
    taskIndex: 0,
    taskCreateTime: task.createTime,
    taskCompletionTime: task.completionTime,
    executionCompletionTime: execution.completionTime,
    exitCode: 1,
    ...(has(task, 'uid') ? { taskUid: task.uid } : {}),
    observationsSHA256: proofDigest({ job, createLRO, runLRO, execution, executions, task, tasks }),
  };
}

/** The exact terminal Job and the complete native pending-operation inventory. */
export async function readStagingFailedJobNative(api, plan, provider) {
  const { create, run, runIdentity } = provider;
  const jobName = plan.job.name;
  const executionName = runIdentity.execution;
  check(
    uuid.test(plan.operationId) &&
      jobName === location + '/jobs/urm-media-recovery-' + plan.operationId.replaceAll('-', '') &&
      operationName.test(create?.operation) &&
      operationName.test(run?.operation) &&
      create.operation !== run.operation &&
      executionName.startsWith(jobName + '/executions/') &&
      stableID.test(short(executionName))
  );
  const taskName = executionName + '/tasks/' + short(executionName) + '-task0';
  const [job, createLRO, runLRO, execution, executions, task, tasks, pending] = await Promise.all(
    [
      jobName,
      create.operation,
      run.operation,
      executionName,
      jobName + '/executions?pageSize=100',
      taskName,
      executionName + '/tasks?pageSize=100',
      location + '/operations?filter=done%3Afalse&pageSize=1000',
    ].map((path) => api(endpoint + path))
  );
  check(
    pending &&
      typeof pending === 'object' &&
      !Array.isArray(pending) &&
      Object.keys(pending).every((key) => ['operations', 'nextPageToken', 'unreachable'].includes(key)) &&
      (pending.nextPageToken === undefined || pending.nextPageToken === '') &&
      ['operations', 'unreachable'].every(
        (key) => pending[key] === undefined || (Array.isArray(pending[key]) && !pending[key].length)
      )
  );
  const terminal = verifyFailedStagingMediaJob({
    plan,
    provider,
    job,
    createLRO,
    runLRO,
    execution,
    executions,
    task,
    tasks,
    now: Date.now(),
  });
  const { observationsSHA256: proofSHA256, ...identity } = terminal;
  return { kind: 'job-task-failed', ...identity, retried: 0, proofSHA256 };
}

/** A native terminal run and provider task must both close. A rejected or
 * unconfirmed START, a replacement run, or incomplete inventory cannot revoke. */
export async function observeClosedMediaDiagnosticFailure({
  api,
  application,
  client,
  db,
  plan,
  provider,
  intent,
  start,
  certificate,
  original,
  replacement,
}) {
  const workflowId = 'media-recovery-' + plan.operationId;
  const { runId } = start;
  check(
    plan.diagnosticStorage &&
      client.options.namespace === namespace &&
      intent?.workflowId === workflowId &&
      start.stage === 'confirmed' &&
      start.intentSHA256 === proofDigest(intent) &&
      start.jobRunSHA256 === proofDigest(provider.runIdentity) &&
      certificate.operationId === plan.operationId &&
      certificate.planSHA256 === proofDigest(plan) &&
      certificate.executionUid === provider.runIdentity.executionUid &&
      Date.now() > plan.expiresAt
  );
  const wall = Date.now(),
    mono = performance.now(),
    deadline = wall + 5000;
  const rpc = (fn) => client.connection.withDeadline(deadline, fn);
  const service = client.connection.workflowService;
  const execution = { workflowId, runId };
  const describe = (execution) => rpc(() => service.describeWorkflowExecution({ namespace, execution }));
  const [terminal, described, latest, page] = await Promise.all([
    readStagingFailedJobNative(api, plan, provider),
    describe(execution),
    describe({ workflowId }),
    rpc(() => service.getWorkflowExecutionHistory({ namespace, execution, maximumPageSize: 64 })),
  ]);
  check(
    !page.nextPageToken?.length &&
      Array.isArray(page.history?.events) &&
      page.history.events.length >= 2 &&
      page.history.events.length <= 64
  );
  const { workflowExecutionInfo: info } = described;
  const history = JSON.parse(application.historyToJSON(page.history));
  const first = page.history.events[0],
    last = history.events.at(-1);
  const failure = last.workflowExecutionFailedEventAttributes;
  const expected = { deploymentName: 'urm-worker-media-recovery-staging', buildId: plan.buildId };
  check(
    info?.status === 3 &&
      digest(info.execution, execution) &&
      digest(latest.workflowExecutionInfo?.execution, execution) &&
      latest.workflowExecutionInfo?.status === 3 &&
      !described.pendingWorkflowTask &&
      !described.pendingActivities?.length &&
      !described.pendingChildren?.length &&
      !described.pendingNexusOperations?.length &&
      info.taskQueue === 'urm-media-kernel-recovery' &&
      info.versioningInfo?.behavior === 1 &&
      digest(info.versioningInfo.deploymentVersion, expected) &&
      last.eventType === 'EVENT_TYPE_WORKFLOW_EXECUTION_FAILED' &&
      failure &&
      !failure.newExecutionRunId &&
      /^[1-9][0-9]*$/.test(last.eventId) &&
      terminal.task === certificate.task &&
      terminal.taskCreateTime === certificate.taskCreateTime &&
      (terminal.taskUid ?? null) === certificate.taskUid &&
      terminal.execution === certificate.execution
  );
  application.mediaRecoveryPinnedVersion(info.versioningInfo.versioningOverride, expected);
  check(
    application.mediaRecoveryNativeStart(
      first,
      intent,
      { operationId: plan.operationId, startNonce: intent.nonce },
      runId
    ) === start.nativeStartSHA256
  );
  const workers = {};
  for (const [attempt, kernel] of [
    [1, original],
    [2, replacement],
  ]) {
    if (!kernel) continue;
    const job = kernel.worker?.cloudRunJob;
    check(
      kernel.stage === 'closed' &&
        kernel.close?.descendantsAbsent === true &&
        job?.task === certificate.task &&
        job.taskCreateTime === certificate.taskCreateTime &&
        (job.taskUid ?? null) === certificate.taskUid &&
        job.executionUid === certificate.executionUid
    );
    workers[attempt] = kernel.worker;
  }
  check(workers[1]);
  const [inventory, compute] = await Promise.all([
    scanPrivateMediaInventory({
      client,
      db,
      plan,
      operationId: plan.operationId,
      read: (fn) => fn(),
      rpc,
      auth: { closedFailure: { workflowId, runId, workers } },
    }),
    observeNamespaceComputeIsolation(client, namespace, { deadline }),
  ]);
  check(
    inventory.ownedPollers.length === 0 &&
      Date.now() >= wall &&
      Date.now() < deadline &&
      performance.now() - mono < 5000
  );
  return {
    workflow: {
      workflowId,
      runId,
      status: 'FAILED',
      terminalEventId: last.eventId,
      closedAt: last.eventTime,
      historySHA256: proofDigest(history),
      noNewExecutionRunId: true,
    },
    jobTermination: terminal,
    closure: {
      kind: 'failed-episode-no-pending-work',
      workflowId,
      runId,
      job: terminal.job,
      executionUid: terminal.executionUid,
      task: terminal.task,
      inventorySHA256: proofDigest(inventory),
      durableWorkSHA256: proofDigest(inventory.jobWork),
      computeSHA256: compute.inventorySHA256,
      queuesEmpty: true,
      computeAbsent: true,
      noPendingOperations: true,
    },
  };
}
