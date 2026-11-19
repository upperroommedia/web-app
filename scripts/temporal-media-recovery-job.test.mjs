import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';
import {
  advanceMediaRecoveryJob,
  observeMediaRecoveryJobTermination,
  observeMediaRecoveryJobActive,
  readCompletedMediaRecoveryJob,
  renderMediaRecoveryJob,
} from './temporal-media-recovery-job.mjs';

import { readMediaRecoveryJobJournal, saveMediaRecoveryJobJournal } from './temporal-media-recovery-checkpoint.mjs';

import { startMediaRecoveryWorkflow } from './temporal-media-recovery-start.mjs';

function fixture() {
  const location = 'projects/urm-app-staging/locations/us-central1';
  const operationId = 'f2fd6b36-e319-4450-8336-7fe67b4cb79a';
  const jobName = `${location}/jobs/urm-media-recovery-${operationId.replaceAll('-', '')}`;
  const execution = jobName + '/executions/recovery-run';
  const task = execution + '/tasks/recovery-run-0';
  const operation = location + '/operations/Foo_owned-1';
  const buildId = 'b'.repeat(40);
  const runner = `tw-m-${buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com`;
  const image = 'us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:' + 'a'.repeat(64);
  const plan = {
    operationId,
    buildId,
    runner,
    image,
    diagnosticTemplate: {
      serviceAccount: runner,
      containers: [
        {
          name: 'worker',
          image,
          resources: { limits: { cpu: '2', memory: '4Gi' } },
          startupProbe: { httpGet: { path: '/healthz', port: 8080 } },
          volumeMounts: [{ name: 'scratch', mountPath: '/tmp' }],
          env: Object.entries({
            TEMPORAL_TASK_QUEUES: 'urm-media-kernel-recovery',
            TEMPORAL_MEDIA_RECOVERY_OPERATION: operationId,
            TEMPORAL_BUILD_ID: buildId,
            TEMPORAL_WORKER_HOSTING: 'cloud-run',
            TEMPORAL_DISPATCHER_ENABLED: 'false',
          }).map(([name, value]) => ({ name, value })),
        },
      ],
      volumes: [{ name: 'scratch', emptyDir: { medium: 'DISK', sizeLimit: '100Gi' } }],
    },
  };
  plan.job = renderMediaRecoveryJob(plan);
  const taskSpec = plan.job.template.template;
  const time = Date.now() - 10000;
  const at = (ms) => new Date(time + ms).toISOString();
  const run = {
    stage: 'acknowledged',
    operation,
    execution,
    jobUid: 'b07aac6e-38d5-4aa1-9d93-06716f03cfaa',
    executionUid: 'c0955201-39d5-4d1b-aef9-dfe2319a9a78',
    jobPlanSHA256: proofDigest(plan.job),
    intentSHA256: 'c'.repeat(64),
    attemptedAt: at(0),
  };
  const taskIdentity = { name: task, uid: 'bb2f210c-42a5-4efb-a105-99c0d6717406' };
  const stable = { generation: '1', observedGeneration: '1' };
  const conditions = [{ type: 'Completed', state: 'CONDITION_SUCCEEDED' }];
  const maps = {
    job: { ...stable, ...plan.job, uid: run.jobUid },
    operation: { name: operation, done: true, response: { name: execution, uid: run.executionUid } },
    execution: {
      ...stable,
      name: execution,
      uid: run.executionUid,
      job: jobName,
      ...plan.job.template,
      conditions,
      startTime: at(500),
      completionTime: at(5700),
      succeededCount: 1,
    },
    task: {
      ...stable,
      ...taskSpec,
      name: task,
      uid: taskIdentity.uid,
      job: jobName,
      execution,
      conditions,
      startTime: at(700),
      completionTime: at(5500),
      lastAttemptResult: { status: {}, exitCode: 0 },
    },
  };
  const paths = new Map([
    [jobName, 'job'],
    [operation, 'operation'],
    [execution, 'execution'],
    [task, 'task'],
  ]);
  const reads = [];
  const api = async (url, method) => {
    assert.equal(method, undefined);
    const target = paths.get(url.replace(/^https:\/\/run.googleapis.com\/v2\//, ''));
    assert.ok(target, 'only exact owned resources may be queried');
    reads.push(target);
    return structuredClone(maps[target]);
  };
  return {
    maps,
    reads,
    options: { plan, run, taskIdentity, api, custody: { originalClosedAt: at(2000), replacementClosedAt: at(5000) } },
  };
}

test('the job carrier keeps the reviewed image, runner and scratch with a finite single task', () => {
  const {
    options: { plan },
  } = fixture();
  const { template } = renderMediaRecoveryJob(plan);
  assert.equal(template.taskCount, 1);
  assert.equal(template.parallelism, 1);
  assert.equal(template.template.maxRetries, 0);
  assert.equal(template.template.timeout, '300s');
  assert.equal(template.template.containers[0].image, plan.image);
  assert.equal(template.template.containers[0].startupProbe, undefined);
  assert.ok(plan.diagnosticTemplate.containers[0].startupProbe);
  assert.equal(template.template.volumes[0].emptyDir.sizeLimit, '100Gi');
  assert.equal(template.template.serviceAccount, plan.runner);
});

test('the original single un-retried task must be complete and joined to the exact acknowledged RUN', async () => {
  const { reads, options } = fixture();
  const result = await observeMediaRecoveryJobTermination(options);
  assert.equal(result.kind, 'job-task-terminated');
  assert.equal(result.taskUid, options.taskIdentity.uid);
  assert.match(result.proofSHA256, /^[a-f0-9]{64}$/);
  assert.deepEqual(reads, ['job', 'operation', 'execution', 'task', 'execution']);
});

test('completed Job readback requires both sealed child closures and the original terminal provider facts', async () => {
  const { maps, reads, options } = fixture();
  options.plan.origin = { uid: 'unchanged-normal-pool' };
  const terminal = await observeMediaRecoveryJobTermination(options);
  const { plan, run, custody } = options;
  const recovery = { plan, jobTermination: terminal, jobDrain: { terminationSHA256: terminal.proofSHA256 } };
  const rows = [
    ['Kernel', custody.originalClosedAt],
    ['ReplacementKernel', custody.replacementClosedAt],
  ].map(([kind, observedAt]) => {
    const stamp = { seconds: 1, nanoseconds: 2, toDate: () => new Date(1000) };
    return {
      ref: { path: `_control/temporalMediaRecovery${kind}-${plan.operationId}` },
      createTime: stamp,
      updateTime: stamp,
      data: () => ({ close: { observedAt } }),
      get: (field) => {
        assert.equal(field, 'close.observedAt');
        return observedAt;
      },
    };
  });
  const capsule = {
    schemaVersion: 2,
    kind: 'completed-media-recovery-job-provenance-v2',
    operationId: plan.operationId,
    restoredPool: plan.origin,
    originalParent: {
      cloudMediaRecovery: recovery,
      mediaRecoveryJobProvider: { create: { stage: 'acknowledged' }, run, runIdentity: run },
    },
    facts: rows.map((row) => {
      const { dataDigest, createTime, updateTime } = nativeSnapshotProof(row);
      return { path: row.ref.path, dataSHA256: dataDigest, createTime, updateTime };
    }),
  };
  const input = {
    api: options.api,
    firestore: {
      doc: (path) => path,
      getAll: async (...paths) => {
        assert.deepEqual(
          paths,
          rows.map((row) => row.ref.path)
        );
        return rows;
      },
    },
    read: (fn) => fn(),
    capsule,
    recovery,
  };
  assert.deepEqual(await readCompletedMediaRecoveryJob(input), terminal);

  reads.length = 0;
  const originalStamp = rows[0].updateTime;
  rows[0].updateTime = { ...originalStamp, nanoseconds: 3 };
  await assert.rejects(() => readCompletedMediaRecoveryJob(input), /MEDIA_RECOVERY_JOB_TERMINATION_UNCONFIRMED/);
  assert.deepEqual(reads, []);
  rows[0].updateTime = originalStamp;

  maps.task.lastAttemptResult.exitCode = 1;
  await assert.rejects(() => readCompletedMediaRecoveryJob(input), /MEDIA_RECOVERY_JOB_TERMINATION_UNCONFIRMED/);
});

for (const [label, vary] of [
  [
    'a substituted job plan',
    ({ options }) => {
      options.plan.job.template.template.timeout = '600s';
      options.run.jobPlanSHA256 = proofDigest(options.plan.job);
    },
  ],
  [
    'overridden task command',
    ({ maps }) => {
      maps.task.containers = maps.task.containers.map((worker) => ({ ...worker, args: ['wrong'] }));
    },
  ],
  [
    'unacknowledged RUN',
    ({ options }) => {
      options.run.stage = 'attempted';
    },
  ],
  [
    'in-flight RUN',
    ({ maps }) => {
      maps.operation.done = false;
    },
  ],
  [
    'different RUN response',
    ({ maps }) => {
      maps.operation.response.uid = maps.job.uid;
    },
  ],
  [
    'foreign task UID',
    ({ maps }) => {
      maps.task.uid = maps.job.uid;
    },
  ],
  [
    'retry',
    ({ maps }) => {
      maps.task.retried = 1;
    },
  ],
  [
    'failed execution',
    ({ maps }) => {
      maps.execution.succeededCount = 0;
    },
  ],
  [
    'killed attempt',
    ({ maps }) => {
      maps.task.lastAttemptResult = { status: {}, termSignal: 9 };
    },
  ],
  [
    'task terminated before the replacement child close',
    ({ options, maps }) => {
      options.custody.replacementClosedAt = maps.execution.completionTime;
    },
  ],
  [
    'inconsistent time',
    ({ maps }) => {
      maps.task.completionTime = maps.execution.startTime;
    },
  ],
  [
    'provider still reconciling',
    ({ maps }) => {
      maps.task.reconciling = true;
    },
  ],
  [
    'unowned runner',
    ({ maps }) => {
      maps.task.serviceAccount = 'another@urm-app-staging.iam.gserviceaccount.com';
    },
  ],
  [
    'changed execution at readback',
    ({ maps, options, reads }) => {
      const api = options.api;
      options.api = async (url) => {
        if (reads.length === 4) maps.execution.updateTime = new Date().toISOString();
        return api(url);
      };
    },
  ],
]) {
  test(`diagnostic task termination rejects ${label}`, async () => {
    const f = fixture();
    vary(f);
    await assert.rejects(observeMediaRecoveryJobTermination(f.options), /TERMINATION_UNCONFIRMED/);
  });
}

function controllerFixture() {
  const {
    options: { plan, run },
    maps,
  } = fixture();
  plan.createdAt = new Date(Date.now() - 1000).toISOString();
  plan.expiresAt = Date.parse(plan.createdAt) + 300000;
  maps.job.etag = 'created-job-fingerprint';
  const endpoint = 'https://run.googleapis.com/v2/';
  const createOperation = 'projects/urm-app-staging/locations/us-central1/operations/owned-create';
  const mutation = [];
  let state;
  let present = false;
  let running = false;
  let foreignExecution = false;
  let createReady = true;
  let throwAck;
  let failSaveStage;
  let revokeAfterAttempt;
  let epoch = 0;
  let policy = { etag: 'empty-job-policy' };
  const ownState = () => structuredClone(state);
  const options = {
    plan,
    api: async (url, method, body, authorize) => {
      if (method === 'POST') {
        await authorize();
        if (url === endpoint + plan.job.name + ':setIamPolicy') {
          assert.equal(state.access.stage, 'attempted');
          assert.equal(body.policy.etag, policy.etag);
          assert.equal(body.updateMask, 'bindings,etag');
          assert.deepEqual(body.policy.bindings, [
            {
              role: 'roles/run.viewer',
              members: [`serviceAccount:${plan.runner}`],
            },
          ]);
          mutation.push('access');
          policy = { ...structuredClone(body.policy), etag: 'owned-job-policy' };
          if (throwAck === 'access') throw new Error('Original provider ACK lost');
          return structuredClone(policy);
        }
        const key = url.endsWith(':run') ? 'run' : 'create';
        assert.equal(state[key].stage, 'attempted');
        assert.deepEqual(body, state[key].request.body);
        mutation.push(key);
        if (key === 'create') present = true;
        else {
          running = true;
          epoch += 1;
        }
        if (throwAck === key) throw new Error('Original provider ACK lost');
        return { name: key === 'create' ? createOperation : run.operation };
      }
      switch (url) {
        case endpoint + plan.job.name + ':getIamPolicy?options.requestedPolicyVersion=3':
          assert.ok(present);
          return structuredClone(policy);
        case endpoint + plan.job.name:
          if (!present) throw Object.assign(new Error('absent'), { status: 404 });
          return { ...maps.job, ...(epoch && { etag: 'after-runtime-created' }) };
        case endpoint + plan.job.name + '/executions?pageSize=2':
          return { executions: foreignExecution ? [{}] : [] };
        case endpoint + createOperation:
          return {
            name: createOperation,
            done: createReady,
            ...(createReady && {
              response: { ...maps.job, '@type': 'type.googleapis.com/google.cloud.run.v2.Job' },
            }),
          };
        case endpoint + run.operation:
          assert.equal(running, true);
          return {
            name: run.operation,
            metadata: {
              '@type': 'type.googleapis.com/google.cloud.run.v2.Execution',
              name: run.execution,
              uid: run.executionUid,
            },
          };
        case endpoint + run.execution:
          return maps.execution;
        default:
          assert.fail('Unexpected Cloud Run read');
      }
    },
    save: async (next) => {
      state = structuredClone(next);
      if (failSaveStage && state.create?.stage === failSaveStage) throw new Error('Firestore response lost');
    },
    fence: async (expected) => {
      assert.deepEqual(expected, state ?? expected);
      if (revokeAfterAttempt && state?.create?.stage === 'attempted') throw new Error('release authority changed');
    },
  };
  return {
    mutation,
    ownState,
    options,
    launch: () => advanceMediaRecoveryJob({ ...options, saved: ownState() }),
    loseProviderAck: (key) => {
      throwAck = key;
    },
    loseSaveAck: (stage) => {
      failSaveStage = stage;
    },
    setCreateReady: (ready) => {
      createReady = ready;
    },
    existingExecution: () => {
      foreignExecution = true;
    },
    revoke: () => {
      revokeAfterAttempt = true;
    },
    replacePolicy: (next) => {
      policy = next;
    },
  };
}

test('an acknowledged CREATE can resume through exact native RUN identity with one send per mutation', async () => {
  const f = controllerFixture();
  f.setCreateReady(false);
  assert.equal((await f.launch()).create.stage, 'acknowledged');
  assert.deepEqual(f.mutation, ['create']);
  f.setCreateReady(true);
  const complete = await f.launch();
  assert.equal(complete.runIdentity.execution, f.ownState().runIdentity.execution);
  assert.deepEqual(await f.launch(), complete);
  assert.deepEqual(f.mutation, ['create', 'access', 'run']);
});

for (const key of ['create', 'run']) {
  test(`lost ${key.toUpperCase()} provider acknowledgement cannot authorize another request`, async () => {
    const f = controllerFixture();
    f.loseProviderAck(key);
    await assert.rejects(f.launch(), /Original provider ACK lost/);
    const calls = f.mutation.slice();
    await assert.rejects(f.launch(), /OPERATION_UNCONFIRMED/);
    assert.deepEqual(f.mutation, calls);
  });
}

test('an unacknowledged Job policy write stays observe-only and cannot authorize RUN', async () => {
  const f = controllerFixture();
  f.loseProviderAck('access');
  await assert.rejects(f.launch(), /OPERATION_UNCONFIRMED/);
  assert.equal(f.ownState().access.outcome, 'desired-policy-observed-after-unconfirmed-write');
  await assert.rejects(f.launch(), /OPERATION_UNCONFIRMED/);
  assert.deepEqual(f.mutation, ['create', 'access']);
});

test('native Job policy drift blocks resumption of the acknowledged job', async () => {
  const f = controllerFixture();
  await f.launch();
  f.replacePolicy({ etag: 'independent-policy' });
  await assert.rejects(f.launch(), /OPERATION_UNCONFIRMED/);
  assert.deepEqual(f.mutation, ['create', 'access', 'run']);
});

test('a new Job with an unexpected direct principal cannot receive a grant or be run', async () => {
  const f = controllerFixture();
  f.replacePolicy({
    etag: 'foreign-policy',
    bindings: [{ role: 'roles/run.viewer', members: ['user:other@example.com'] }],
  });
  await assert.rejects(f.launch(), /FENCED_POLICY_GRANT_UNCONFIRMED/);
  assert.deepEqual(f.mutation, ['create']);
  assert.equal(f.ownState().run, undefined);
});

test('unknown durable intent ACK and revocation at the final fence prevent the first send', async () => {
  for (const change of [(f) => f.loseSaveAck('attempted'), (f) => f.revoke()]) {
    const f = controllerFixture();
    change(f);
    await assert.rejects(f.launch(), /Firestore response lost|release authority changed/);
    assert.deepEqual(f.mutation, []);
    await assert.rejects(f.launch(), /OPERATION_UNCONFIRMED/);
  }
});

test('CREATE can be acknowledged while a foreign existing execution prevents RUN', async () => {
  const f = controllerFixture();
  f.existingExecution();
  await assert.rejects(f.launch(), /FENCED_POLICY_GRANT_UNCONFIRMED/);
  assert.deepEqual(f.mutation, ['create']);
  assert.equal(f.ownState().run, undefined);
});

test('the paused release journal accepts one immutable stage successor and rejects a concurrent parent write', async () => {
  const {
    options: { plan },
  } = controllerFixture();
  plan.releaseId = 'release';
  plan.bindingDigest = 'd'.repeat(64);
  const configure = (drift) => {
    let version = 0;
    let pending;
    let row = {
      action: 'diagnose-cloud-run-media-recovery',
      operationId: plan.operationId,
      releaseId: plan.releaseId,
      bindingDigest: plan.bindingDigest,
      cloudMediaRecovery: { plan, stage: 'prepared', prepared: { kind: 'prepared' } },
    };
    const control = {
      releaseId: plan.releaseId,
      admission: 'paused',
      domains: Object.fromEntries(
        ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((name) => [
          name,
          { admission: 'paused' },
        ])
      ),
    };
    const release = { releaseId: plan.releaseId, phase: 'provider-usage-ready' };
    const stamp = (nanoseconds) => ({
      seconds: 1,
      nanoseconds,
      toDate() {
        return new Date(1000);
      },
    });
    const snapshot = (value, changed = 0) => ({
      exists: true,
      createTime: stamp(0),
      updateTime: stamp(changed),
      data: () => structuredClone(value),
      get: (path) => path.split('.').reduce((result, name) => result?.[name], value),
    });
    const lockRef = { get: async () => snapshot(row, version) };
    const controlRef = { get: async () => snapshot(control) };
    const stateRef = { get: async () => snapshot(release) };
    const firestore = {
      runTransaction: async (fn, config) => {
        const result = await fn({
          get: (ref) => ref.get(),
          update: (ref, fields) => {
            assert.equal(ref, lockRef);
            assert.deepEqual(config, { maxAttempts: 1 });
            pending = fields;
          },
        });
        if (pending) {
          row = { ...row, ...pending, ...(drift && { unrelated: 'after commit' }) };
          version++;
          pending = undefined;
        }
        return result;
      },
    };
    return {
      config: { releaseId: plan.releaseId },
      operationId: plan.operationId,
      bindingDigest: plan.bindingDigest,
      plan,
      firestore,
      lockRef,
      controlRef,
      stateRef,
      ownedOperation: nativeSnapshotProof(snapshot(row)),
      expectedAuthority: {
        control: nativeSnapshotProof(snapshot(control)),
        state: nativeSnapshotProof(snapshot(release)),
      },
    };
  };
  const good = configure(false);
  const jobPlanSHA256 = proofDigest(plan.job);
  const request = {
    method: 'POST',
    url:
      'https://run.googleapis.com/v2/projects/urm-app-staging/locations/us-central1/jobs?jobId=' +
      plan.job.name.split('/').at(-1),
    body: plan.job,
  };
  const attemptedAt = new Date().toISOString();
  const next = {
    jobPlanSHA256,
    create: {
      stage: 'attempted',
      request,
      attemptedAt,
      intentSHA256: proofDigest({ key: 'create', request, jobPlanSHA256, attemptedAt }),
    },
  };

  assert.equal(await readMediaRecoveryJobJournal(good), undefined);
  await assert.rejects(
    saveMediaRecoveryJobJournal(good, undefined, {
      ...next,
      create: { stage: 'acknowledged' },
    }),
    /CHECKPOINT_UNCONFIRMED/
  );
  good.ownedOperation = await saveMediaRecoveryJobJournal(good, undefined, next);
  assert.deepEqual(await readMediaRecoveryJobJournal(good), next);
  await assert.rejects(saveMediaRecoveryJobJournal(good, undefined, next), /CHECKPOINT_UNCONFIRMED/);
  await assert.rejects(saveMediaRecoveryJobJournal(configure(true), undefined, next), /AUTHORITY_CHANGED/);
});

test('Temporal START can only see the exact active acknowledged Job execution', async () => {
  const { options, maps } = fixture();
  maps.job.etag = 'native-etag';
  maps.operation = {
    name: options.run.operation,
    metadata: {
      '@type': 'type.googleapis.com/google.cloud.run.v2.Execution',
      name: options.run.execution,
      uid: options.run.executionUid,
    },
  };
  delete maps.execution.completionTime;
  maps.execution.runningCount = 1;
  await observeMediaRecoveryJobActive({ api: options.api, plan: options.plan, run: options.run });
  for (const drift of [
    () => {
      maps.operation.done = true;
    },
    () => {
      maps.execution.retriedCount = 1;
    },
    () => {
      maps.execution.uid = '62ae72cd-0b97-43af-87d9-ed52458fd638';
    },
  ]) {
    const savedOperation = structuredClone(maps.operation);
    const savedExecution = structuredClone(maps.execution);
    drift();
    await assert.rejects(
      observeMediaRecoveryJobActive({ api: options.api, plan: options.plan, run: options.run }),
      /OPERATION_UNCONFIRMED/
    );
    maps.operation = savedOperation;
    maps.execution = savedExecution;
  }
});

test('the real START producer persists Job binding before the sole Temporal RPC and holds an unknown response', async () => {
  const { options, maps } = fixture();
  const { plan, run } = options;
  const now = Date.now();
  plan.createdAt = new Date(now - 30000).toISOString();
  plan.expiresAt = Date.parse(plan.createdAt) + 300000;
  plan.releaseId = 'release';
  plan.bindingDigest = 'd'.repeat(64);
  plan.role = 'media';
  plan.contract = {
    deploymentName: 'urm-worker-media-recovery-staging',
    queue: 'urm-media-kernel-recovery',
    workflowType: 'MediaRecoveryProbe',
    protocol: 'owned-media-recovery-v1',
  };
  plan.name =
    'projects/urm-app-staging/locations/us-central1/workerPools/urm-worker-media-' + plan.buildId.slice(0, 20);
  plan.normalTemplate = { containers: [{ name: 'worker', image: plan.image }] };
  plan.origin = {
    uid: 'normal-uid',
    generation: '1',
    etag: 'reviewed-etag',
    revision: plan.name + '/revisions/normal-revision',
    revisionUid: 'original-revision-uid',
  };
  const stamp = (n) => ({ seconds: 1, nanoseconds: n, toDate: () => new Date(1000) });
  let version = 0;
  const snapshot = (data, update = 0) => ({
    exists: data !== undefined,
    createTime: stamp(0),
    updateTime: stamp(update),
    data: () => structuredClone(data),
    get: (path) => path.split('.').reduce((value, key) => value?.[key], data),
  });
  const control = {
    releaseId: plan.releaseId,
    admission: 'paused',
    domains: Object.fromEntries(
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((domain) => [
        domain,
        { admission: 'paused' },
      ])
    ),
  };
  const state = { releaseId: plan.releaseId, phase: 'provider-usage-ready' };
  const expectedAuthority = {
    control: nativeSnapshotProof(snapshot(control)),
    state: nativeSnapshotProof(snapshot(state)),
  };
  const journal = {
    schemaVersion: 1,
    scope: 'arming-only-no-execution-authority',
    planSHA256: proofDigest(plan),
    operationId: plan.operationId,
    releaseId: plan.releaseId,
    bindingDigest: plan.bindingDigest,
    buildId: plan.buildId,
    image: plan.image,
    runner: plan.runner,
    pool: plan.name,
    contract: plan.contract,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    authority: expectedAuthority,
    attemptedAt: plan.createdAt,
  };
  const prepared = {
    kind: 'prepared',
    operationId: plan.operationId,
    bindingDigest: plan.bindingDigest,
    buildId: plan.buildId,
    image: plan.image,
    proofSHA256: proofDigest(journal),
  };
  let parent = {
    action: 'diagnose-cloud-run-media-recovery',
    operationId: plan.operationId,
    bindingDigest: plan.bindingDigest,
    releaseId: plan.releaseId,
    cloudMediaRecovery: { plan, stage: 'prepared', prepared },
    mediaRecoveryJournalAttempt: {
      stage: 'completed',
      planSHA256: proofDigest(plan),
      recordSHA256: proofDigest(journal),
      attemptedAt: journal.attemptedAt,
    },
    mediaRecoveryJobProvider: { create: { stage: 'acknowledged' }, run, runIdentity: run },
  };
  const lockRef = { path: '_control/temporalReleaseOperation', get: async () => snapshot(parent, version) };
  const controlRef = { path: '_control/temporalRelease', get: async () => snapshot(control) };
  const stateRef = { path: '_control/temporalReleaseState', get: async () => snapshot(state) };
  const firestore = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    doc: (path) => ({ get: async () => snapshot(path.includes('Journal-') ? journal : undefined) }),
    runTransaction: async (fn, settings) => {
      let update;
      const result = await fn({
        get: (ref) => ref.get(),
        update: (ref, fields) => {
          assert.equal(ref, lockRef);
          assert.deepEqual(settings, { maxAttempts: 1 });
          update = fields;
        },
      });
      if (update) {
        parent = { ...parent, ...update };
        version++;
      }
      return result;
    },
  };
  maps.job.etag = 'job-etag';
  maps.operation = {
    name: run.operation,
    metadata: {
      '@type': 'type.googleapis.com/google.cloud.run.v2.Execution',
      name: run.execution,
      uid: run.executionUid,
    },
  };
  maps.execution.runningCount = 1;
  delete maps.execution.completionTime;
  let sends = 0;
  const client = {
    connection: { withDeadline: async (_deadline, fn) => fn() },
    workflow: {
      start: async () => {
        sends++;
        assert.equal(parent.mediaRecoveryWorkflowStart.jobRunSHA256, proofDigest(run));
        assert.equal(parent.mediaRecoveryWorkflowStart.poolSHA256, undefined);
        throw Object.assign(new Error('unknown response'), { code: 14 });
      },
      getHandle: () => ({
        describe: async () => {
          throw new Error('not yet observable');
        },
      }),
    },
  };
  const start = () =>
    startMediaRecoveryWorkflow({
      ...options,
      api: (url) => {
        if (url.endsWith(plan.name))
          return {
            ...plan.origin,
            name: plan.name,
            observedGeneration: '1',
            scaling: { manualInstanceCount: 0 },
            terminalCondition: { state: 'CONDITION_SUCCEEDED' },
            template: plan.normalTemplate,
            latestCreatedRevision: plan.origin.revision,
            latestReadyRevision: plan.origin.revision,
          };
        if (url.endsWith(plan.origin.revision))
          return { ...plan.normalTemplate, name: plan.origin.revision, uid: plan.origin.revisionUid };
        return options.api(url);
      },
      firestore,
      lockRef,
      controlRef,
      stateRef,
      config: { releaseId: plan.releaseId },
      ownedOperation: nativeSnapshotProof(snapshot(parent, version)),
      expectedAuthority,
      operationId: plan.operationId,
      bindingDigest: plan.bindingDigest,
      prepared,
      jobRun: run,
      client,
      application: { mediaRecoveryNativeStart() {}, mediaRecoveryPinnedVersion() {} },
    });
  await assert.rejects(start(), /START_UNCONFIRMED/);
  assert.equal(sends, 1);
  await assert.rejects(start(), /START_UNCONFIRMED/);
  assert.equal(sends, 1);
});
