import { Timestamp } from 'firebase-admin/firestore';
import { releaseProvenanceDigest } from './release-provenance';
import { createDurableJobStore } from '@upperroom/orchestration/job-store';
import {
  hasCloudRunJobBinding,
  mediaRecoveryJobBinding,
  verifyMediaRecoveryJobIdentity,
} from './media-recovery-job-witness';

import { mediaRecoveryKernelContext } from './media-recovery-capability';
import { workerReadinessDigest as hash } from './readiness-probe';

const operationId = 'b61af63d-fd41-48a2-8627-0217c7b8c289';
const job = 'urm-media-recovery-' + operationId.replaceAll('-', '');
const env = {
  FIREBASE_PROJECT_ID: 'urm-app-staging',
  TEMPORAL_CLOUD_REGION: 'us-central1',
  TEMPORAL_WORKER_HOSTING: 'cloud-run',
  TEMPORAL_MEDIA_RECOVERY_OPERATION: operationId,
  TEMPORAL_MEDIA_RECOVERY_COMPUTE: 'cloud-run-job-v1',
  TEMPORAL_TASK_QUEUES: 'urm-media-kernel-recovery',
  TEMPORAL_DEPLOYMENT_NAME: 'urm-worker-media-recovery-staging',
  TEMPORAL_CLOUD_RUN_SERVICE_ACCOUNT: 'tw-m-' + 'a'.repeat(20) + '@urm-app-staging.iam.gserviceaccount.com',
  TEMPORAL_WORKER_IMAGE: 'us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:' + 'b'.repeat(64),
  CLOUD_RUN_JOB: job,
  CLOUD_RUN_EXECUTION: job + '-abcde',
  CLOUD_RUN_TASK_INDEX: '0',
  CLOUD_RUN_TASK_ATTEMPT: '0',
  CLOUD_RUN_TASK_COUNT: '1',
};
const buildId = 'a'.repeat(40);

function fixture() {
  const binding = mediaRecoveryJobBinding(buildId, env);
  const metadata = {
    projectId: 'urm-app-staging',
    projectNumber: '251680231116',
    serviceAccount: binding.runner,
    instanceId: 'native-sandbox-instance',
  };
  const template = {
    executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
    timeout: '300s',
    serviceAccount: binding.runner,
    maxRetries: 0,
    containers: [
      {
        name: 'worker',
        image: binding.image,
        env: [
          { name: 'TEMPORAL_MEDIA_RECOVERY_OPERATION', value: operationId },
          { name: 'TEMPORAL_MEDIA_RECOVERY_COMPUTE', value: 'cloud-run-job-v1' },
          { name: 'TEMPORAL_BUILD_ID', value: buildId },
          { name: 'TEMPORAL_TASK_QUEUES', value: env.TEMPORAL_TASK_QUEUES },
          { name: 'TEMPORAL_DEPLOYMENT_NAME', value: env.TEMPORAL_DEPLOYMENT_NAME },
        ],
      },
    ],
  };
  const execution = {
    name: binding.execution,
    uid: '9cafa935-4d92-4f95-9571-ddde13982295',
    job: binding.job,
    taskCount: 1,
    parallelism: 1,
    template,
  };
  const task = {
    containers: structuredClone(template.containers),
    serviceAccount: template.serviceAccount,
    timeout: template.timeout,
    name: binding.execution + '/tasks/' + env.CLOUD_RUN_EXECUTION + '-task0',
    createTime: '2026-11-21T04:53:47.660435Z',
    generation: '1',
    observedGeneration: '1',
    job: binding.job,
    execution: binding.execution,
    index: 0,
  };
  const directTask = { ...structuredClone(task), logUri: 'output-only-direct-field' };
  return { binding, metadata, execution, task, directTask };
}

test('Job configuration and native execution must identify its sole original task', () => {
  const { binding, metadata, execution, task, directTask } = fixture();
  expect(verifyMediaRecoveryJobIdentity(binding, metadata, execution, { tasks: [task] }, directTask)).toEqual({
    projectId: metadata.projectId,
    region: 'us-central1',
    job: binding.job,
    execution: binding.execution,
    executionUid: execution.uid,
    task: task.name,
    taskCreateTime: task.createTime,
    instanceId: metadata.instanceId,
    imageDigest: 'sha256:' + 'b'.repeat(64),
    serviceAccount: metadata.serviceAccount,
  });
});

test('retains an optional native UID only when both Task reads carry it', () => {
  const { binding, metadata, execution, task, directTask } = fixture();
  const uid = 'a716b9cb-8b7b-429c-b581-b0ac7d32877b';
  const result = verifyMediaRecoveryJobIdentity(binding, metadata, execution,
    { tasks: [{ ...task, uid }] }, { ...directTask, uid });
  expect(result.taskUid).toBe(uid);
  expect(result.taskCreateTime).toBe(task.createTime);
  for (const otherUid of [undefined, null, 'not-a-uuid', execution.uid]) {
    expect(() => verifyMediaRecoveryJobIdentity(binding, metadata, execution,
      { tasks: [{ ...task, uid }] }, { ...directTask, uid: otherUid })).toThrow('MEDIA_RECOVERY_JOB_IDENTITY_UNCONFIRMED');
  }
});

test('requires a complete listing and a matching independently read live Task', () => {
  const { binding, metadata, execution, task, directTask } = fixture();
  for (const changed of [
    { name: binding.execution + '/tasks/other' },
    { job: 'different-job' },
    { execution: 'different-execution' },
    { createTime: undefined },
    { createTime: '2026-11-21T04:53:47.660435001Z' },
    { createTime: '2026-11-21T04:53:47.660435000Z' },
    { generation: '2', observedGeneration: '2' },
    { observedGeneration: '2' },
    { index: 1 },
    { retried: 1 },
    { completionTime: task.createTime },
    { lastAttemptResult: { exitCode: 1 } },
    { containers: [{ ...task.containers[0], env: [...task.containers[0].env, { name: 'NEW', value: 'v' }] }] },
    { volumes: [{ name: 'other' }] },
    { executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN1' },
  ]) {
    expect(() => verifyMediaRecoveryJobIdentity(binding, metadata, execution, { tasks: [task] },
      { ...directTask, ...changed })).toThrow('MEDIA_RECOVERY_JOB_IDENTITY_UNCONFIRMED');
  }
  for (const changed of [
    { createTime: '2026-02-30T00:00:00Z' },
    { createTime: undefined },
    { generation: '0', observedGeneration: '0' },
    { observedGeneration: undefined },
    { uid: 'not-a-native-uuid' },
  ]) {
    expect(() => verifyMediaRecoveryJobIdentity(binding, metadata, execution,
      { tasks: [{ ...task, ...changed }] }, { ...directTask, ...changed })).toThrow('MEDIA_RECOVERY_JOB_IDENTITY_UNCONFIRMED');
  }
  for (const partial of [{ nextPageToken: 'more' }, { unreachable: ['us-central1'] }]) {
    expect(() => verifyMediaRecoveryJobIdentity(binding, metadata, execution,
      { tasks: [task], ...partial }, directTask)).toThrow('MEDIA_RECOVERY_JOB_IDENTITY_UNCONFIRMED');
  }
});

test('only the Task may inherit GEN2 from the exact Execution template', () => {
  const { binding, metadata, execution, task, directTask } = fixture();
  const gen2 = { executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2' };
  const observed = verifyMediaRecoveryJobIdentity(binding, metadata, execution,
    { tasks: [{ ...task, ...gen2 }] }, { ...directTask, ...gen2 });
  expect(observed.taskCreateTime).toBe(task.createTime);
  for (const executionEnvironment of [undefined, null, 'EXECUTION_ENVIRONMENT_GEN1']) {
    expect(() => verifyMediaRecoveryJobIdentity(binding, metadata,
      { ...execution, template: { ...execution.template, executionEnvironment } },
      { tasks: [{ ...task, ...gen2 }] }, { ...directTask, ...gen2 })).toThrow('MEDIA_RECOVERY_JOB_IDENTITY_UNCONFIRMED');
  }
});

test.each([
  { CLOUD_RUN_TASK_ATTEMPT: '1' },
  { CLOUD_RUN_TASK_COUNT: '2' },
  { CLOUD_RUN_TASK_INDEX: '1' },
  { TEMPORAL_MEDIA_RECOVERY_COMPUTE: undefined },
  { CLOUD_RUN_EXECUTION: 'unrelated-execution' },
  { CLOUD_RUN_WORKER_POOL: 'worker-pool' },
  { K_REVISION: 'service-revision' },
])('a partial or mixed Job identity cannot fall through to an ordinary worker %j', (patch) => {
  const input = { ...env, ...patch };
  expect(hasCloudRunJobBinding(input)).toBe(true);
  expect(() => mediaRecoveryJobBinding(buildId, input)).toThrow('MEDIA_RECOVERY_JOB_IDENTITY_UNCONFIRMED');
});

test('provider identity cannot be substituted by another project, task or command', () => {
  const { binding, metadata, execution, task, directTask } = fixture();
  for (const [m, e, inventory] of [
    [{ ...metadata, projectNumber: '1' }, execution, { tasks: [task] }],
    [{ ...metadata, serviceAccount: 'other' }, execution, { tasks: [task] }],
    [metadata, { ...execution, retriedCount: 1 }, { tasks: [task] }],
    [metadata, execution, { tasks: [task, { ...task }] }],
    [metadata, execution, { tasks: [{ ...task, name: binding.execution + '/tasks/../other' }] }],
    [metadata, execution, { tasks: [{ ...task, name: binding.execution + '/tasks/task?fields=name' }] }],
    [metadata, execution, { tasks: [{ ...task, execution: 'another-execution' }] }],
    [metadata, execution, { tasks: [{ ...task, completionTime: '2026-11-18T19:02:06.000Z' }] }],
    [metadata, execution, { tasks: [{ ...task, containers: [{ ...task.containers[0], args: ['wrong'] }] }] }],
  ] as const) {
    expect(() => verifyMediaRecoveryJobIdentity(binding, m, e, inventory, directTask)).toThrow(
      'MEDIA_RECOVERY_JOB_IDENTITY_UNCONFIRMED'
    );
  }
  expect(() => verifyMediaRecoveryJobIdentity(binding, metadata, execution, { tasks: [task] }, undefined)).toThrow(
    'MEDIA_RECOVERY_JOB_IDENTITY_UNCONFIRMED'
  );
});

test('the Job witness still needs the paused operation’s acknowledged original execution', async () => {
  const { binding, metadata, execution, task, directTask } = fixture();
  const job = verifyMediaRecoveryJobIdentity(binding, metadata, execution, { tasks: [task] }, directTask);
  const releaseId = 'staging-release';
  const bindingDigest = 'c'.repeat(64);
  const createdAt = new Date(Date.now() - 1000).toISOString();
  const contract = {
    deploymentName: 'urm-worker-media-recovery-staging',
    queue: 'urm-media-kernel-recovery',
    workflowType: 'MediaRecoveryProbe',
    protocol: 'owned-media-recovery-v1',
  };
  const normal = {
    containers: [
      {
        image: binding.image,
        env: [
          { name: 'TEMPORAL_TASK_QUEUES', value: 'urm-media' },
          { name: 'TEMPORAL_DEPLOYMENT_NAME', value: 'urm-worker-media-staging' },
        ],
      },
    ],
  };
  const diagnostic = structuredClone(normal);
  const vars = diagnostic.containers[0].env;
  vars[0].value = contract.queue;
  vars[1].value = contract.deploymentName;
  vars.push(
    {
      name: 'TEMPORAL_WORKFLOW_BUNDLE',
      value: '/workspace/apps/temporal-worker/lib/media-recovery-workflow-bundle.js',
    },
    { name: 'TEMPORAL_MEDIA_RECOVERY_OPERATION', value: operationId }
  );
  const plan = {
    schemaVersion: 1,
    role: 'media',
    operationId,
    releaseId,
    bindingDigest,
    buildId,
    name: 'projects/urm-app-staging/locations/us-central1/workerPools/urm-worker-media-' + buildId.slice(0, 20),
    job: { name: job.job },
    image: binding.image,
    runner: binding.runner,
    contract,
    createdAt,
    expiresAt: Date.parse(createdAt) + 300000,
    normalTemplate: normal,
    diagnosticTemplate: diagnostic,
  };
  const control = {
    releaseId,
    admission: 'paused',
    domains: Object.fromEntries(
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((key) => [
        key,
        { admission: 'paused' },
      ])
    ),
  };
  const state={releaseId,phase:'provider-usage-ready',providerUsage:{observedAt:new Timestamp(1795236188,810273000)}};
  expect(hash(state)).not.toBe(releaseProvenanceDigest(state));
  const time = { seconds: 1, nanoseconds: 0 };
  const stamp = (row: unknown) => ({ dataDigest: releaseProvenanceDigest(row), createTime: time, updateTime: time });
  const jobPlanSHA256 = hash(plan.job);
  const run = {
    stage: 'acknowledged',
    operation: 'original-operation',
    intentSHA256: 'd'.repeat(64),
    attemptedAt: createdAt,
  };
  const provider = {
    jobPlanSHA256,
    create: { stage: 'acknowledged' },
    run,
    runIdentity: { ...run, jobPlanSHA256, execution: job.execution, executionUid: job.executionUid },
  };
  const journal = {
    schemaVersion: 1,
    scope: 'arming-only-no-execution-authority',
    operationId,
    releaseId,
    bindingDigest,
    planSHA256: hash(plan),
    buildId,
    image: plan.image,
    runner: plan.runner,
    pool: plan.name,
    authority: { control: stamp(control), state: stamp(state) },
    contract,
    createdAt,
    expiresAt: plan.expiresAt,
    attemptedAt: createdAt,
  };
  let original = {
    action: 'diagnose-cloud-run-media-recovery',
    releaseId,
    bindingDigest,
    operationId,
    operatorPrincipal: { adcAndGcloudAccountMatch: true, email: 'fixture@example.test' },
    cloudMediaRecovery: {
      plan,
      stage: 'prepared',
      prepared: {
        operationId,
        bindingDigest,
        buildId,
        image: plan.image,
        kind: 'prepared',
        proofSHA256: hash(journal),
      },
    },
    mediaRecoveryJournalAttempt: {
      schemaVersion: 1,
      stage: 'completed',
      planSHA256: hash(plan),
      attemptedAt: createdAt,
      recordSHA256: hash(journal),
    },
    mediaRecoveryJobProvider: provider,
  };
  const begin = () => {
    const db = {
      projectId: 'urm-app-staging',
      databaseId: '(default)',
      doc: (path: string) => path,
      runTransaction: async (fn: (tx: any) => Promise<void>) =>
        fn({
          get: (path: string) => {
            const row = {
              '_control/temporalReleaseOperation': original,
              '_control/temporalRelease': control,
              '_control/temporalReleaseState': state,
              [`_control/temporalMediaRecoveryJournal-${operationId}`]: journal,
            }[path];
            return {
              exists: true,
              createTime: time,
              updateTime: time,
              data: () => row,
              get: (fields: string) => fields.split('.').reduce<any>((value, key) => value?.[key], row),
            };
          },
        }),
    };
    const auth = {
      getUserByEmail: async (email: string) => ({ email, uid: 'actor', customClaims: { role: 'admin' } }),
    };
    return mediaRecoveryKernelContext(
      db as never,
      auth as never,
      { instanceId: operationId, buildId, cloudRunJob: job },
      operationId
    );
  };
  expect((await begin()).context.parent.cloudRunJob?.taskCreateTime).toBe(task.createTime);
  original = {
    ...original,
    mediaRecoveryJobProvider: {
      ...provider,
      runIdentity: { ...provider.runIdentity, executionUid: 'd101a3d8-f85f-49de-8cbf-525740314b96' },
    },
  };
  await expect(begin()).rejects.toThrow('MEDIA_RECOVERY_CAPABILITY_UNCONFIRMED');
});

test('durable execution accepts this witness only for the private acquire Activity', async () => {
  const { binding, metadata, execution, task, directTask } = fixture();
  const job = verifyMediaRecoveryJobIdentity(binding, metadata, execution, { tasks: [task] }, directTask);
  const readSentinel = new Error('after shape validation');
  const store = createDurableJobStore({
    projectId: 'urm-app-staging',
    firestore: {
      runTransaction: async () => {
        throw readSentinel;
      },
    } as never,
  });
  const identity = {
    workflowId: 'media-recovery-' + operationId,
    runId: 'original-temporal-run',
    activityType: 'acquireMedia',
    activityId: 'media-recovery-acquire',
    temporalNamespace: 'urm-app-staging.qwejt',
    scheduledAt: 1000,
    attempt: 1,
    worker: { instanceId: operationId, buildId, cloudRunJob: job },
  };
  const ref = {} as never;
  await expect(store.registerActivityExecution(ref, identity)).rejects.toBe(readSentinel);
  for (const edit of [
    { workflowId: 'ordinary-media-workflow' },
    { activityType: 'publish' },
    { attempt: 3 },
    { temporalNamespace: 'urm-app.qwejt' },
    { worker: { ...identity.worker, podUid: 'not-a-job' } },
  ]) {
    await expect(store.registerActivityExecution(ref, { ...identity, ...edit })).rejects.toThrow(
      'Invalid or mixed private recovery Job identity'
    );
  }
});
