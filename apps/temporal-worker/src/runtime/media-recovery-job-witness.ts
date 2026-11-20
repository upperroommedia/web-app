import type { DurableMediaRecoveryJobIdentity } from '@upperroom/orchestration/job-store';
import { GoogleAuth } from 'google-auth-library';
import { readCloudRunMetadata } from './cloud-run-witness';
import { workerReadinessDigest as hash } from './readiness-probe';

const location = 'projects/urm-app-staging/locations/us-central1';
const projectNumber = '251680231116';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const platformFields = [
  'CLOUD_RUN_JOB',
  'CLOUD_RUN_EXECUTION',
  'CLOUD_RUN_TASK_INDEX',
  'CLOUD_RUN_TASK_ATTEMPT',
  'CLOUD_RUN_TASK_COUNT',
] as const;

type MediaRecoveryJobIdentity = DurableMediaRecoveryJobIdentity;
export type { MediaRecoveryJobIdentity };

export function hasCloudRunJobBinding(env: NodeJS.ProcessEnv) {
  return env.TEMPORAL_MEDIA_RECOVERY_COMPUTE !== undefined || platformFields.some((key) => env[key] !== undefined);
}

const deny = (): never => {
  throw new Error('MEDIA_RECOVERY_JOB_IDENTITY_UNCONFIRMED');
};
const normalize = (value: unknown) =>
  typeof value === 'string' ? value.replace(/^projects\/251680231116\//, 'projects/urm-app-staging/') : undefined;
const refersTo = (value: unknown, name: string) => normalize(value) === name || value === name.split('/').at(-1);

export function mediaRecoveryJobBinding(buildId: string, env: NodeJS.ProcessEnv) {
  const operationId = env.TEMPORAL_MEDIA_RECOVERY_OPERATION;
  const execution = env.CLOUD_RUN_EXECUTION;
  const job = operationId && 'urm-media-recovery-' + operationId.replaceAll('-', '');
  const image = env.TEMPORAL_WORKER_IMAGE;
  const runner = 'tw-m-' + buildId.slice(0, 20) + '@urm-app-staging.iam.gserviceaccount.com';
  if (
    !operationId ||
    !uuid.test(operationId) ||
    !/^[a-f0-9]{40}$/.test(buildId) ||
    env.TEMPORAL_MEDIA_RECOVERY_COMPUTE !== 'cloud-run-job-v1' ||
    env.FIREBASE_PROJECT_ID !== 'urm-app-staging' ||
    env.TEMPORAL_CLOUD_REGION !== 'us-central1' ||
    env.TEMPORAL_WORKER_HOSTING !== 'cloud-run' ||
    env.TEMPORAL_TASK_QUEUES !== 'urm-media-kernel-recovery' ||
    env.TEMPORAL_DEPLOYMENT_NAME !== 'urm-worker-media-recovery-staging' ||
    env.CLOUD_RUN_WORKER_POOL !== undefined ||
    env.CLOUD_RUN_REVISION !== undefined ||
    env.K_SERVICE !== undefined ||
    env.K_REVISION !== undefined ||
    env.CLOUD_RUN_JOB !== job ||
    !execution ||
    !execution.startsWith(job + '-') ||
    !/^[a-z0-9-]{1,63}$/.test(execution) ||
    env.CLOUD_RUN_TASK_INDEX !== '0' ||
    env.CLOUD_RUN_TASK_ATTEMPT !== '0' ||
    env.CLOUD_RUN_TASK_COUNT !== '1' ||
    env.TEMPORAL_CLOUD_RUN_SERVICE_ACCOUNT !== runner ||
    !image ||
    !/^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(image)
  )
    return deny();
  const jobPath = `${location}/jobs/${job}`;
  return { job: jobPath, execution: `${jobPath}/executions/${execution}`, operationId, buildId, runner, image };
}

type Binding = ReturnType<typeof mediaRecoveryJobBinding>;
type Metadata = { projectId: string; projectNumber: string; serviceAccount: string; instanceId: string };

function assertTaskSpec(template: any, binding: Binding) {
  const [worker] = template?.containers ?? [];
  if (
    template?.containers?.length !== 1 ||
    worker?.name !== 'worker' ||
    worker?.image !== binding.image ||
    worker?.command?.length ||
    worker?.args?.length ||
    template.serviceAccount !== binding.runner ||
    ![undefined, 0].includes(template.maxRetries) ||
    template.executionEnvironment !== 'EXECUTION_ENVIRONMENT_GEN2' ||
    template.timeout !== '300s' ||
    !Array.isArray(worker.env)
  )
    deny();
  const expected = {
    TEMPORAL_MEDIA_RECOVERY_COMPUTE: 'cloud-run-job-v1',
    TEMPORAL_MEDIA_RECOVERY_OPERATION: binding.operationId,
    TEMPORAL_BUILD_ID: binding.buildId,
    TEMPORAL_TASK_QUEUES: 'urm-media-kernel-recovery',
    TEMPORAL_DEPLOYMENT_NAME: 'urm-worker-media-recovery-staging',
  };
  for (const [name, value] of Object.entries(expected)) {
    const entries = worker.env.filter((entry: any) => entry?.name === name);
    if (entries.length !== 1 || entries[0].value !== value || entries[0].valueSource !== undefined) deny();
  }
  if (worker.env.some((entry: any) => (platformFields as readonly string[]).includes(entry?.name))) deny();
}

export function verifyMediaRecoveryJobIdentity(
  binding: Binding,
  metadata: Metadata,
  execution: any,
  inventory: any
): MediaRecoveryJobIdentity {
  if (
    metadata.projectId !== 'urm-app-staging' ||
    metadata.projectNumber !== projectNumber ||
    metadata.serviceAccount !== binding.runner ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(metadata.instanceId) ||
    normalize(execution?.name) !== binding.execution ||
    !uuid.test(execution?.uid) ||
    !refersTo(execution.job, binding.job) ||
    execution.taskCount !== 1 ||
    execution.parallelism !== 1 ||
    execution.deleteTime ||
    execution.completionTime ||
    ![undefined, 0].includes(execution.retriedCount) ||
    !Array.isArray(inventory?.tasks) ||
    inventory.tasks.length !== 1 ||
    inventory.nextPageToken
  )
    deny();
  const task = inventory.tasks[0];
  const taskName = normalize(task?.name);
  const prefix = binding.execution + '/tasks/';
  if (
    !taskName?.startsWith(prefix) ||
    !/^[a-z0-9-]{1,63}$/.test(taskName.slice(prefix.length)) ||
    !uuid.test(task.uid) ||
    !refersTo(task.execution, binding.execution) ||
    !refersTo(task.job, binding.job) ||
    ![undefined, 0].includes(task.index) ||
    ![undefined, 0].includes(task.retried) ||
    task.deleteTime ||
    task.completionTime ||
    task.lastAttemptResult
  )
    return deny();
  assertTaskSpec(execution.template, binding);
  assertTaskSpec(task, binding);
  return {
    projectId: 'urm-app-staging',
    region: 'us-central1',
    job: binding.job,
    execution: binding.execution,
    executionUid: execution.uid,
    task: taskName,
    taskUid: task.uid,
    serviceAccount: binding.runner,
    imageDigest: binding.image.split('@')[1],
    instanceId: metadata.instanceId,
  };
}

export async function loadMediaRecoveryJobIdentity(buildId: string, env: NodeJS.ProcessEnv) {
  const binding = mediaRecoveryJobBinding(buildId, env);
  try {
    const [projectId, projectNumber, serviceAccount, instanceId] = await Promise.all([
      readCloudRunMetadata('project/project-id'),
      readCloudRunMetadata('project/numeric-project-id'),
      readCloudRunMetadata('instance/service-accounts/default/email'),
      readCloudRunMetadata('instance/id'),
    ]);
    const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
    const read = (path: string) =>
      client.request({
        url: 'https://run.googleapis.com/v2/' + path,
        method: 'GET',
        timeout: 5000,
        retry: false,
      });
    const [execution, inventory] = await Promise.all([
      read(binding.execution),
      read(binding.execution + '/tasks?pageSize=2'),
    ]);
    return verifyMediaRecoveryJobIdentity(
      binding,
      { projectId, projectNumber, serviceAccount, instanceId },
      execution.data,
      inventory.data
    );
  } catch {
    return deny();
  }
}

/** The native worker can consume only the original operation's acknowledged
 * provider execution. An environment marker alone grants no authority. */
export function matchMediaRecoveryJobRun(job: MediaRecoveryJobIdentity, plan: any, native: any) {
  const run = native?.runIdentity;
  return !!(
    plan?.job?.name === job.job &&
    job.projectId === 'urm-app-staging' &&
    job.region === 'us-central1' &&
    job.serviceAccount === plan.runner &&
    job.imageDigest === plan.image?.split('@')[1] &&
    native?.jobPlanSHA256 === hash(plan.job) &&
    native.create?.stage === 'acknowledged' &&
    native.run?.stage === 'acknowledged' &&
    run?.stage === 'acknowledged' &&
    run.jobPlanSHA256 === native.jobPlanSHA256 &&
    run.operation === native.run.operation &&
    run.intentSHA256 === native.run.intentSHA256 &&
    run.attemptedAt === native.run.attemptedAt &&
    run.execution === job.execution &&
    run.executionUid === job.executionUid &&
    Number.isFinite(Date.parse(run.attemptedAt)) &&
    Date.parse(run.attemptedAt) >= Date.parse(plan.createdAt) &&
    Date.parse(run.attemptedAt) < plan.expiresAt
  );
}
