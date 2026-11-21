import { isDeepStrictEqual } from 'node:util';
import { createPublicKey } from 'node:crypto';
import { nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';
import { prepareFencedPolicyGrant, verifyPreparedDirectPolicyGrant } from './temporal-preparation-iam.mjs';

const location = 'projects/urm-app-staging/locations/us-central1';
const endpoint = 'https://run.googleapis.com/v2/';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const segment = /^[a-z0-9][a-z0-9-]{0,62}$/;
const normalize = (name) =>
  typeof name === 'string' ? name.replace(/^projects\/251680231116\//, 'projects/urm-app-staging/') : undefined;
const fail = () => {
  throw new Error('MEDIA_RECOVERY_JOB_TERMINATION_UNCONFIRMED');
};

function isChild(name, prefix) {
  return typeof name === 'string' && name.startsWith(prefix) && segment.test(name.slice(prefix.length));
}

function refersTo(value, name) {
  return normalize(value) === name || value === name.split('/').at(-1);
}

function exactResources(resources, expected) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(resources) &&
      resources.length === expected.length &&
      expected.every((item, index) => exactResources(resources[index], item))
    );
  }
  if (expected && typeof expected === 'object') {
    return (
      !!resources &&
      typeof resources === 'object' &&
      Object.entries(expected).every(([key, value]) =>
        key === 'maxRetries' && value === 0
          ? [undefined, 0].includes(resources[key])
          : exactResources(resources[key], value)
      )
    );
  }
  return resources === expected;
}

function exactTaskSpec(actual,expected,taskProjection=false) {
  const worker = actual?.containers?.[0];
  const fields=taskProjection&&!Object.hasOwn(actual??{},'executionEnvironment')
    ? Object.fromEntries(Object.entries(expected).filter(([key])=>key!=='executionEnvironment'))
    : expected;
  return (
    exactResources(actual, fields) &&
    [worker?.command, worker?.args].every(
      (value) => value === undefined || (Array.isArray(value) && value.length === 0)
    )
  );
}

export function isMediaRecoveryTaskIdentity(value) {
  const hasUid=Object.hasOwn(value??{},'uid');
  const hasCreateTime=Object.hasOwn(value??{},'createTime');
  if(hasUid&&(typeof value.uid!=='string'||!uuid.test(value.uid)))return false;
  if(hasCreateTime){
    if(typeof value.createTime!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value.createTime))
      return false;
    const time=Date.parse(value.createTime);
    if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,19)!==value.createTime.slice(0,19))return false;
  }
  return hasUid||hasCreateTime;
}

export function mediaRecoveryTaskIdentity({task,taskUid,taskCreateTime}) {
  return {name:task,...(taskUid===undefined?{}:{uid:taskUid}),...(taskCreateTime===undefined?{}:{createTime:taskCreateTime})};
}

export function sameMediaRecoveryTask(a,b) {
  return Boolean(a&&b&&typeof a.task==='string'&&a.task.length>0&&a.task===b.task&&
    isMediaRecoveryTaskIdentity(mediaRecoveryTaskIdentity(a))&&isMediaRecoveryTaskIdentity(mediaRecoveryTaskIdentity(b))&&
    a.taskUid===b.taskUid&&a.taskCreateTime===b.taskCreateTime);
}

function validGeneration(value) {
  return (
    /^[1-9][0-9]*$/.test(String(value?.generation ?? '')) &&
    String(value.generation) === String(value.observedGeneration) &&
    value.reconciling !== true &&
    !value.deleteTime
  );
}

export function attestationPublicKey(value) {
  if (typeof value !== 'string' || value.length !== 60) fail();
  const der = Buffer.from(value, 'base64');
  if (der.length !== 44 || der.toString('base64') !== value) fail();
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519' || !key.export({ format: 'der', type: 'spki' }).equals(der)) fail();
  return key;
}

/** Derive the finite diagnostic compute from the reviewed media worker image,
 * resources and credentials. The ordinary worker pool template stays intact. */
export function renderMediaRecoveryJob(plan) {
  const template = structuredClone(plan?.diagnosticTemplate);
  const worker = template?.containers?.[0];
  const volume = template?.volumes?.find(({ name }) => name === 'scratch');
  const env = new Map(
    worker?.env?.filter((entry) => Object.hasOwn(entry, 'value')).map(({ name, value }) => [name, value])
  );
  if (
    !uuid.test(plan?.operationId) ||
    !/^[a-f0-9]{40}$/.test(plan?.buildId ?? '') ||
    plan?.runner !== `tw-m-${plan.buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com` ||
    !/^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(
      plan.image ?? ''
    ) ||
    template?.serviceAccount !== plan.runner ||
    template.containers.length !== 1 ||
    worker.name !== 'worker' ||
    worker.image !== plan.image ||
    worker.command?.length ||
    worker.args?.length ||
    worker.resources?.limits?.cpu !== '2' ||
    worker.resources.limits.memory !== '4Gi' ||
    volume?.emptyDir?.medium !== 'DISK' ||
    volume.emptyDir.sizeLimit !== '100Gi' ||
    !worker.volumeMounts?.some((mount) => mount.name === 'scratch' && mount.mountPath === '/tmp') ||
    env.get('TEMPORAL_TASK_QUEUES') !== 'urm-media-kernel-recovery' ||
    env.get('TEMPORAL_MEDIA_RECOVERY_OPERATION') !== plan.operationId ||
    env.get('TEMPORAL_BUILD_ID') !== plan.buildId ||
    env.get('TEMPORAL_WORKER_HOSTING') !== 'cloud-run' ||
    env.get('TEMPORAL_DISPATCHER_ENABLED') !== 'false' ||
    env.has('TEMPORAL_MEDIA_RECOVERY_COMPUTE')
  )
    fail();
  const modeName = 'TEMPORAL_MEDIA_RECOVERY_ATTESTATION_MODE';
  const keyName = 'TEMPORAL_MEDIA_RECOVERY_ATTESTATION_KEY';
  if (worker.env.some(({ name }) => name === modeName || name === keyName)) fail();
  delete worker.startupProbe;
  worker.env.push({ name: 'TEMPORAL_MEDIA_RECOVERY_COMPUTE', value: 'cloud-run-job-v1' });
  if (Object.hasOwn(plan, 'taskAttestationPublicKey')) {
    attestationPublicKey(plan.taskAttestationPublicKey);
    worker.env.push({ name: modeName, value: 'operator-ed25519-v1' },
      { name: keyName, value: plan.taskAttestationPublicKey });
  }
  return {
    name: `${location}/jobs/urm-media-recovery-${plan.operationId.replaceAll('-', '')}`,
    launchStage: 'BETA',
    labels: { 'urm-role': 'media', 'urm-build': plan.buildId },
    template: {
      taskCount: 1,
      parallelism: 1,
      template: {
        ...template,
        maxRetries: 0,
        timeout: '300s',
        executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
      },
    },
  };
}

/** Read back the sole original diagnostic task from its owned RUN receipt.
 * Temporal history, child custody and release authority are independent. */
export async function observeMediaRecoveryJobTermination({ api, plan, run, taskIdentity, custody }) {
  if (!isDeepStrictEqual(plan?.job, renderMediaRecoveryJob(plan))) fail();
  const job = plan.job.name;
  const taskSpec = plan?.job?.template?.template;
  const execution = normalize(run?.execution);
  const task = normalize(taskIdentity?.name);
  const operation = normalize(run?.operation);
  const attemptTime = Date.parse(run?.attemptedAt);
  const sampledAt = Date.now();
  if (
    typeof api !== 'function' ||
    !uuid.test(plan?.operationId) ||
    typeof plan?.buildId !== 'string' ||
    !/^[a-f0-9]{40}$/.test(plan.buildId) ||
    job !== `${location}/jobs/urm-media-recovery-${plan.operationId.replaceAll('-', '')}` ||
    !isChild(execution, job + '/executions/') ||
    !isChild(task, execution + '/tasks/') ||
    typeof operation !== 'string' ||
    !operation.startsWith(location + '/operations/') ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(operation.slice((location + '/operations/').length)) ||
    !uuid.test(run?.jobUid) ||
    !uuid.test(run?.executionUid) ||
    !isMediaRecoveryTaskIdentity(taskIdentity) ||
    run?.stage !== 'acknowledged' ||
    run?.jobPlanSHA256 !== proofDigest(plan.job) ||
    !sha.test(run?.intentSHA256) ||
    plan?.job?.template?.taskCount !== 1 ||
    plan.job.template.parallelism !== 1 ||
    taskSpec?.maxRetries !== 0 ||
    taskSpec?.executionEnvironment !== 'EXECUTION_ENVIRONMENT_GEN2' ||
    taskSpec?.serviceAccount !== plan.runner ||
    taskSpec?.containers?.length !== 1 ||
    taskSpec.containers[0].image !== plan.image ||
    !Number.isFinite(attemptTime) ||
    attemptTime > sampledAt
  )
    fail();

  const read = async (...resources) => {
    let timer;
    try {
      const left = 5000 - (Date.now() - sampledAt);
      if (left <= 0 || left > 5000) fail();
      return await Promise.race([
        Promise.all(resources.map((resource) => api(endpoint + resource))),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('MEDIA_RECOVERY_JOB_TERMINATION_UNCONFIRMED')), left);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const [nativeJob,ownedRun,nativeExecution,nativeTask,inventory]=await read(job,operation,execution,task,
    ...(taskIdentity.createTime===undefined?[]:[execution+'/tasks?pageSize=2']));
  const matchesTask=value=>{
    const statuses=value?.conditions?.filter(entry=>entry.type==='Completed');
    const attempt=value?.lastAttemptResult;
    return normalize(value?.name)===task&&validGeneration(value)&&
      (taskIdentity.uid===undefined||value.uid===taskIdentity.uid)&&
      (taskIdentity.createTime===undefined||value.createTime===taskIdentity.createTime)&&
      (value.uid===undefined||(typeof value.uid==='string'&&uuid.test(value.uid)))&&
      refersTo(value.job,job)&&refersTo(value.execution,execution)&&
      [undefined,0].includes(value.index)&&[undefined,0].includes(value.retried)&&
      [undefined,0].includes(value.maxRetries)&&exactTaskSpec(value,taskSpec,true)&&
      statuses?.length===1&&statuses[0].state==='CONDITION_SUCCEEDED'&&attempt?.status&&
      [undefined,0].includes(attempt.status.code)&&[undefined,0].includes(attempt.exitCode)&&
      !Object.hasOwn(attempt,'termSignal');
  };
  const stableCompleted = (resource, name, uid) =>
    normalize(resource?.name) === name && resource?.uid === uid && validGeneration(resource);
  const started = Date.parse(nativeTask?.startTime);
  const completed = Date.parse(nativeTask?.completionTime);
  const executionStarted = Date.parse(nativeExecution?.startTime);
  const executionCompleted = Date.parse(nativeExecution?.completionTime);
  const originalClosedAt = Date.parse(custody?.originalClosedAt);
  const replacementClosedAt = Date.parse(custody?.replacementClosedAt);
  const executionStatus = nativeExecution?.conditions?.filter((entry) => entry.type === 'Completed');
  if (
    !stableCompleted(nativeJob, job, run.jobUid) ||
    !exactResources(nativeJob.template, plan.job.template) ||
    !exactTaskSpec(nativeJob.template.template, taskSpec) ||
    normalize(ownedRun?.name) !== operation ||
    ownedRun.done !== true ||
    ownedRun.error ||
    normalize(ownedRun.response?.name) !== execution ||
    ownedRun.response.uid !== run.executionUid ||
    !stableCompleted(nativeExecution, execution, run.executionUid) ||
    !refersTo(nativeExecution.job, job) ||
    nativeExecution.taskCount !== 1 ||
    nativeExecution.parallelism !== 1 ||
    ![undefined, 0].includes(nativeExecution.runningCount) ||
    ![undefined, 0].includes(nativeExecution.failedCount) ||
    ![undefined, 0].includes(nativeExecution.cancelledCount) ||
    ![undefined, 0].includes(nativeExecution.retriedCount) ||
    nativeExecution.succeededCount !== 1 ||
    executionStatus?.length !== 1 ||
    executionStatus[0].state !== 'CONDITION_SUCCEEDED' ||
    !exactTaskSpec(nativeExecution.template, taskSpec) ||
    !matchesTask(nativeTask) ||
    (taskIdentity.createTime!==undefined&&(!Array.isArray(inventory?.tasks)||inventory.tasks.length!==1||
      inventory.nextPageToken||(inventory.unreachable!==undefined&&(!Array.isArray(inventory.unreachable)||inventory.unreachable.length))||
      !matchesTask(inventory.tasks[0])||inventory.tasks[0].completionTime!==nativeTask.completionTime||
      inventory.tasks[0].generation!==nativeTask.generation||inventory.tasks[0].uid!==nativeTask.uid||
      Date.parse(taskIdentity.createTime)<attemptTime||Date.parse(taskIdentity.createTime)>started)) ||
    ![started, completed, executionStarted, executionCompleted].every(Number.isFinite) ||
    attemptTime > executionStarted ||
    executionStarted > started ||
    started > completed ||
    !Number.isFinite(originalClosedAt) ||
    !Number.isFinite(replacementClosedAt) ||
    started > originalClosedAt ||
    originalClosedAt >= replacementClosedAt ||
    replacementClosedAt > completed ||
    completed > executionCompleted ||
    executionCompleted > Date.now() ||
    Date.now() < sampledAt ||
    Date.now() - sampledAt > 5000
  )
    fail();

  const [owned] = await read(execution);
  if (!isDeepStrictEqual(nativeExecution, owned) || Date.now() - sampledAt > 5000) fail();
  const facts = {
    job,
    jobUid: run.jobUid,
    operation,
    execution,
    executionUid: run.executionUid,
    task,
    ...(taskIdentity.uid===undefined?{}:{taskUid:taskIdentity.uid}),
    ...(taskIdentity.createTime===undefined?{}:{taskCreateTime:taskIdentity.createTime}),
    completedAt: nativeTask.completionTime,
  };
  return {
    kind: 'job-task-terminated',
    operationId: plan.operationId,
    ...facts,
    proofSHA256: proofDigest({ facts, run, taskIdentity, custody, nativeJob, nativeExecution, nativeTask }),
  };
}

/** Re-read a completed Job from the exact child closure snapshots sealed with its capsule. */
export async function readCompletedMediaRecoveryJob({ api, firestore, read, capsule, recovery }) {
  const plan = recovery?.plan;
  const provider = capsule?.originalParent?.mediaRecoveryJobProvider;
  const run = provider?.runIdentity;
  const terminal = recovery?.jobTermination;
  if (
    capsule?.schemaVersion !== 2 ||
    capsule.kind !== 'completed-media-recovery-job-provenance-v2' ||
    capsule.operationId !== plan?.operationId ||
    !isDeepStrictEqual(capsule.originalParent.cloudMediaRecovery, recovery) ||
    !run ||
    provider.create?.stage !== 'acknowledged' ||
    provider.run?.stage !== 'acknowledged' ||
    run.operation !== provider.run.operation ||
    run.intentSHA256 !== provider.run.intentSHA256 ||
    terminal?.execution !== run.execution ||
    terminal.executionUid !== run.executionUid ||
    terminal.jobUid !== run.jobUid ||
    recovery.jobDrain?.terminationSHA256 !== terminal.proofSHA256 ||
    !isDeepStrictEqual(capsule.restoredPool, plan.origin)
  )
    fail();

  const paths = ['Kernel', 'ReplacementKernel'].map(
    (kind) => `_control/temporalMediaRecovery${kind}-${plan.operationId}`
  );
  if (plan.taskAttestationPublicKey) paths.push(`_control/temporalMediaRecoveryTaskAttestation-${plan.operationId}`);
  const snapshots = await read(() => firestore.getAll(...paths.map((path) => firestore.doc(path))));
  if (snapshots.length !== paths.length) fail();
  for (const [index, path] of paths.entries()) {
    const row = snapshots[index];
    const expected = capsule.facts.find((fact) => fact.path === path);
    const proof = nativeSnapshotProof(row);
    if (
      row.ref.path !== path ||
      !isDeepStrictEqual(
        { path, dataSHA256: proof.dataDigest, createTime: proof.createTime, updateTime: proof.updateTime },
        expected
      )
    )
      fail();
  }
  const [original, replacement, certificate] = snapshots;
  if (plan.taskAttestationPublicKey && (!certificate?.createTime?.isEqual(certificate.updateTime) ||
      !isDeepStrictEqual(capsule.originalParent.mediaRecoveryTaskAttestation, {
        certificateSHA256: proofDigest(certificate.data()),
      }))) fail();
  const native = await read(() =>
    observeMediaRecoveryJobTermination({
      api,
      plan,
      run,
      taskIdentity: mediaRecoveryTaskIdentity(terminal),
      custody: {
        originalClosedAt: original.get('close.observedAt'),
        replacementClosedAt: replacement.get('close.observedAt'),
      },
    })
  );
  if (!isDeepStrictEqual(native, terminal)) fail();
  return native;
}

const jobUnconfirmed = () => {
  throw new Error('MEDIA_RECOVERY_JOB_OPERATION_UNCONFIRMED');
};

function jobOperationName(value) {
  const name = normalize(value);
  if (!name || !/^projects\/urm-app-staging\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(name))
    jobUnconfirmed();
  return name;
}

function assertOwnedJob(plan, native, expectedUid) {
  if (
    normalize(native?.name) !== plan.job.name ||
    !uuid.test(native?.uid) ||
    (expectedUid && native.uid !== expectedUid) ||
    typeof native.etag !== 'string' ||
    !native.etag ||
    !validGeneration(native) ||
    !exactResources(native.template, plan.job.template) ||
    !exactTaskSpec(native.template.template, plan.job.template.template)
  )
    jobUnconfirmed();
  return { uid: native.uid, generation: String(native.generation), etag: native.etag };
}

export function mediaRecoveryJobAccessPlan(plan, jobUid) {
  if (!uuid.test(jobUid) || !isDeepStrictEqual(plan.job, renderMediaRecoveryJob(plan))) jobUnconfirmed();
  return {
    operationId: plan.operationId,
    jobPlanSHA256: proofDigest(plan.job),
    jobUid,
    resource: plan.job.name,
    grants: [{ role: 'roles/run.viewer', members: [`serviceAccount:${plan.runner}`] }],
  };
}

const recoveryJobPolicyUrl = (name) => endpoint + name + ':getIamPolicy?options.requestedPolicyVersion=3';

async function readMediaRecoveryJobPolicy(api, expected) {
  const policy = await api(recoveryJobPolicyUrl(expected.resource));
  if (policy?.bindings?.length) {
    if (!isDeepStrictEqual(policy.bindings, expected.grants)) jobUnconfirmed();
    verifyPreparedDirectPolicyGrant(policy, expected.grants[0], expected.resource);
  }
  return policy;
}

export async function assertMediaRecoveryJobAccess({ api, plan, access, jobUid }) {
  const expected = mediaRecoveryJobAccessPlan(plan, jobUid);
  if (
    access?.stage !== 'completed' ||
    access.outcome !== 'acknowledged-write-and-policy-observation' ||
    !isDeepStrictEqual(access.plan, expected)
  )
    jobUnconfirmed();
  const policy = await readMediaRecoveryJobPolicy(api, expected);
  if (!isDeepStrictEqual(policy?.bindings, expected.grants) || policy.etag !== access.observedEtag) jobUnconfirmed();
}

export function renderMediaRecoveryJobCreateRequest(plan) {
  // Cloud Run derives the resource name from the parent and jobId query.
  const { name, ...body } = plan.job;
  return {
    url: endpoint + location + '/jobs?jobId=' + name.split('/').at(-1),
    method: 'POST',
    body,
  };
}

/** A single CREATE and RUN under the caller's release snapshot and normal pool
 * isolation fence. Persisting intent or losing either ACK grants zero resends. */
export async function advanceMediaRecoveryJob({ api, plan, saved, save, fence, observeAcknowledgedRun }) {
  if (
    ![api, save, fence].every((method) => typeof method === 'function') ||
    !isDeepStrictEqual(plan?.job, renderMediaRecoveryJob(plan)) ||
    !Number.isFinite(Date.parse(plan.createdAt)) ||
    plan.expiresAt !== Date.parse(plan.createdAt) + 300000 ||
    Date.parse(plan.createdAt) > Date.now()
  )
    jobUnconfirmed();
  const jobPlanSHA256 = proofDigest(plan.job);
  let state = saved ?? { jobPlanSHA256 };
  if (state.jobPlanSHA256 !== jobPlanSHA256) jobUnconfirmed();

  async function put(key, value) {
    const next = { ...state, [key]: value };
    await save(structuredClone(next));
    state = next;
  }

  const jobUrl = endpoint + plan.job.name;
  const fresh = () => {
    if (Date.now() >= plan.expiresAt || Date.now() < Date.parse(plan.createdAt)) jobUnconfirmed();
  };
  const absent = async () => {
    try {
      await api(jobUrl);
    } catch (error) {
      if (error?.status === 404) return;
      throw error;
    }
    jobUnconfirmed();
  };

  const mutate = async (key, url, body, beforeSend) => {
    const request = { url, method: 'POST', body };
    if (state[key]) {
      const record = state[key];
      const inten = { key, request, jobPlanSHA256, attemptedAt: record.attemptedAt };
      if (
        record.stage !== 'acknowledged' ||
        !isDeepStrictEqual(record.request, request) ||
        record.intentSHA256 !== proofDigest(inten) ||
        !Number.isFinite(Date.parse(record.attemptedAt)) ||
        Date.parse(record.attemptedAt) < Date.parse(plan.createdAt) ||
        Date.parse(record.attemptedAt) >= plan.expiresAt
      )
        jobUnconfirmed();
      return record;
    }
    fresh();
    await fence(state);
    await beforeSend();
    fresh();
    const attemptedAt = new Date().toISOString();
    const intentSHA256 = proofDigest({ key, request, jobPlanSHA256, attemptedAt });
    const attempt = { stage: 'attempted', request, attemptedAt, intentSHA256 };
    await put(key, attempt);
    let sent = false;
    const response = await api(url, 'POST', body, async () => {
      if (sent) jobUnconfirmed();
      fresh();
      await beforeSend();
      await fence(state);
      fresh();
      sent = true;
    });
    if (!sent) jobUnconfirmed();
    const operation = jobOperationName(response?.name);
    // Record the exact ACK before subsequent native reads. Do not adopt a job
    // or an execution named by a list result or by the attempted record alone.
    const acknowledged = { ...attempt, stage: 'acknowledged', operation };
    await put(key, acknowledged);
    return acknowledged;
  };

  const readAcknowledged = async (ack, kind) => {
    const name = jobOperationName(ack.operation);
    const deadline = performance.now() + 25000;
    for (;;) {
      const result = await api(endpoint + name);
      if (!observeAcknowledgedRun ||
          performance.now() >= deadline || result?.error || normalize(result?.name) !== name ||
          ![undefined, false, true].includes(result.done) ||
          result.done === true || (kind === 'run' && result.metadata?.name)) return result;
      if (Date.now() >= plan.expiresAt) jobUnconfirmed();
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  };
  const originalRun = () => observeAcknowledgedRun ? observeAcknowledgedRun() : fence(state);
  const createRequest = renderMediaRecoveryJobCreateRequest(plan);
  const create = await mutate('create', createRequest.url, createRequest.body, absent);
  if (state.run?.stage === 'acknowledged') await originalRun();
  else await fence(state);
  const createResult = await readAcknowledged(create, 'create');
  if (normalize(createResult?.name) !== create.operation || createResult.error) jobUnconfirmed();
  if (createResult.done !== true) {
    if (![undefined, false].includes(createResult.done)) jobUnconfirmed();
    return state;
  }

  if (createResult.response?.['@type'] !== 'type.googleapis.com/google.cloud.run.v2.Job') jobUnconfirmed();
  const created = assertOwnedJob(plan, createResult.response);
  const current = assertOwnedJob(plan, await api(jobUrl), created.uid);
  // RUN itself can update the Job's observed execution metadata and etag.
  if (created.generation !== current.generation || (!state.run && current.etag !== created.etag)) jobUnconfirmed();
  const verifyEmptyJob = async () => {
    const latest = assertOwnedJob(plan, await api(jobUrl), current.uid);
    if (!isDeepStrictEqual(current, latest)) jobUnconfirmed();
    const inventory = await api(jobUrl + '/executions?pageSize=2');
    if (
      !inventory ||
      inventory.nextPageToken ||
      (inventory.executions !== undefined && (!Array.isArray(inventory.executions) || inventory.executions.length))
    )
      jobUnconfirmed();
    return latest;
  };
  if (!state.run) {
    const accessPlan = mediaRecoveryJobAccessPlan(plan, current.uid);
    await prepareFencedPolicyGrant({
      plan: accessPlan,
      saved: state.access,
      save: (access) => put('access', access),
      readPolicy: () => readMediaRecoveryJobPolicy(api, accessPlan),
      setPolicy: (body) =>
        api(jobUrl + ':setIamPolicy', 'POST', body, async () => {
          fresh();
          await verifyEmptyJob();
          await fence(state);
          fresh();
        }),
      verifyPrerequisites: async () => {
        fresh();
        await fence(state);
        return verifyEmptyJob();
      },
    });
  }
  await assertMediaRecoveryJobAccess({ api, plan, access: state.access, jobUid: current.uid });
  const run = await mutate('run', jobUrl + ':run', { etag: created.etag }, async () => {
    await verifyEmptyJob();
    await assertMediaRecoveryJobAccess({ api, plan, access: state.access, jobUid: current.uid });
  });
  await originalRun();
  const runResult = await readAcknowledged(run, 'run');
  if (normalize(runResult?.name) !== run.operation || runResult.error) jobUnconfirmed();
  if (![undefined, false, true].includes(runResult.done)) jobUnconfirmed();
  const reported = runResult.done === true ? runResult.response : runResult.metadata;
  const executionName = normalize(reported?.name);
  if (!executionName) {
    if (runResult.done === true) jobUnconfirmed();
    return state;
  }
  if (reported['@type'] !== 'type.googleapis.com/google.cloud.run.v2.Execution') jobUnconfirmed();
  if (!isChild(executionName, plan.job.name + '/executions/')) jobUnconfirmed();
  const execution = await api(endpoint + executionName);
  if (
    normalize(execution?.name) !== executionName ||
    !uuid.test(execution.uid) ||
    (reported.uid && reported.uid !== execution.uid) ||
    !refersTo(execution.job, plan.job.name) ||
    execution.taskCount !== 1 ||
    execution.parallelism !== 1 ||
    !exactTaskSpec(execution.template, plan.job.template.template) ||
    execution.deleteTime
  )
    jobUnconfirmed();
  const owned = {
    stage: 'acknowledged',
    operation: run.operation,
    attemptedAt: run.attemptedAt,
    intentSHA256: run.intentSHA256,
    jobPlanSHA256,
    jobUid: current.uid,
    execution: executionName,
    executionUid: execution.uid,
  };
  if (state.runIdentity) {
    if (!isDeepStrictEqual(state.runIdentity, owned)) jobUnconfirmed();
  } else {
    await originalRun();
    await put('runIdentity', owned);
  }
  return state;
}

/** Active execution guard for the sole Temporal START, distinct from terminal evidence. */
export async function observeMediaRecoveryJobActive({ api, plan, run, allowProvisioning = false }) {
  if (
    typeof api !== 'function' ||
    !isDeepStrictEqual(plan?.job, renderMediaRecoveryJob(plan)) ||
    run?.stage !== 'acknowledged' ||
    run.jobPlanSHA256 !== proofDigest(plan.job) ||
    !uuid.test(run.jobUid) ||
    !uuid.test(run.executionUid) ||
    !isChild(run.execution, plan.job.name + '/executions/')
  )
    jobUnconfirmed();
  const operation = jobOperationName(run.operation);
  const [job, lro, execution] = await Promise.all(
    [plan.job.name, operation, run.execution].map((resource) => api(endpoint + resource))
  );
  assertOwnedJob(plan, job, run.jobUid);
  if (
    normalize(lro?.name) !== operation ||
    lro.done === true ||
    lro.error ||
    lro.metadata?.['@type'] !== 'type.googleapis.com/google.cloud.run.v2.Execution' ||
    normalize(lro.metadata.name) !== run.execution ||
    (lro.metadata.uid && lro.metadata.uid !== run.executionUid) ||
    normalize(execution?.name) !== run.execution ||
    execution.uid !== run.executionUid ||
    !refersTo(execution.job, plan.job.name) ||
    execution.deleteTime ||
    execution.completionTime ||
    execution.conditions?.some(({ type, state }) =>
      type === 'Completed' && ['CONDITION_FAILED', 'CONDITION_SUCCEEDED'].includes(state)) ||
    execution.parallelism !== 1 ||
    execution.taskCount !== 1 ||
    ![undefined, 0].includes(execution.retriedCount) ||
    ![undefined, 0].includes(execution.failedCount) ||
    ![undefined, 0].includes(execution.cancelledCount) ||
    ![undefined, 0].includes(execution.succeededCount) ||
    !exactTaskSpec(execution.template, plan.job.template.template)
  )
    jobUnconfirmed();
  if (allowProvisioning && [undefined, 0].includes(execution.runningCount)) return undefined;
  if (execution.runningCount !== 1) jobUnconfirmed();
  return execution;
}

/** The controller, using its own read authority, witnesses the native task
 * attached to the original acknowledged execution. */
export async function observeMediaRecoveryAttestationTask({ api, plan, run }) {
  const execution = await observeMediaRecoveryJobActive({ api, plan, run, allowProvisioning: true });
  if (!execution) return undefined;
  if (!validGeneration(execution)) jobUnconfirmed();
  const task = run.execution + '/tasks/' + run.execution.split('/').at(-1) + '-task0';
  const listed = await api(endpoint + run.execution + '/tasks?pageSize=2');
  if (![undefined, ''].includes(listed?.nextPageToken) || (listed?.unreachable !== undefined &&
      (!Array.isArray(listed.unreachable) || listed.unreachable.length))) jobUnconfirmed();
  if (!listed || typeof listed !== 'object') jobUnconfirmed();
  if (listed.tasks === undefined || (Array.isArray(listed.tasks) && !listed.tasks.length)) return undefined;
  if (!Array.isArray(listed.tasks) || listed.tasks.length !== 1 || normalize(listed.tasks[0]?.name) !== task)
    jobUnconfirmed();
  const direct = await api(endpoint + task);
  const attemptTime = Date.parse(run.attemptedAt);
  const matches = value =>
    normalize(value?.name) === task && validGeneration(value) &&
    Object.hasOwn(value, 'createTime') && isMediaRecoveryTaskIdentity(value) &&
    Date.parse(value.createTime) >= attemptTime && Date.parse(value.createTime) < plan.expiresAt &&
    refersTo(value.job, plan.job.name) && refersTo(value.execution, run.execution) &&
    [undefined, 0].includes(value.index) && [undefined, 0].includes(value.retried) &&
    Number.isFinite(Date.parse(value.startTime)) &&
    Date.parse(value.startTime) >= Date.parse(value.createTime) &&
    !value.completionTime && !value.lastAttemptResult &&
    exactTaskSpec(value, plan.job.template.template, true);
  const fromList = listed.tasks[0];
  if (!matches(direct) || !matches(fromList) || direct.createTime !== fromList.createTime ||
      direct.uid !== fromList.uid || direct.startTime !== fromList.startTime ||
      String(direct.generation) !== String(fromList.generation) ||
      !isDeepStrictEqual(direct.containers, fromList.containers) ||
      !isDeepStrictEqual(direct.volumes, fromList.volumes)) jobUnconfirmed();
  return {
    executionGeneration: String(execution.generation),
    task,
    taskCreateTime: direct.createTime,
    taskGeneration: String(direct.generation),
    taskUid: direct.uid ?? null,
  };
}
