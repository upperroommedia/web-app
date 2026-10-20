import { createHash, randomBytes } from 'node:crypto';
import { writeFile, realpath, stat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { Connection, type Client } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import type { Firestore } from 'firebase-admin/firestore';
import { verifyCloudRunWorkerIdentity } from './cloud-run-witness';
import {
  workerReadinessDigest,
  WORKER_READINESS_COLLECTION,
  WORKER_READINESS_ROLES,
  type WorkerReadinessRole,
  type WorkerReadinessReceipt,
} from './readiness-probe';

export interface ServerlessRoleBinding {
  projectId: 'urm-app-staging';
  region: 'us-central1';
  namespace: 'urm-app-staging.qwejt';
  role: WorkerReadinessRole;
  buildId: string;
  poolName: string;
  deploymentName: string;
  runnerServiceAccount: string;
  image: string;
}
async function writeExclusiveReceipt(directory: string, name: string, value: unknown): Promise<void> {
  await writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600, flag: 'wx', flush: true });
  const parent = await open(directory, 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
const fail = (): never => {
  throw new Error('SERVERLESS_NATIVE_READINESS_UNCONFIRMED');
};
const object = (value: unknown): Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : fail();
const normalize = (name: unknown): string =>
  typeof name === 'string' ? name.replace('projects/251680231116/', 'projects/urm-app-staging/') : fail();
const generation = (value: unknown): string =>
  typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
    ? value
    : fail();
const settled = (resource: Record<string, any>) => {
  if (
    resource.reconciling !== false ||
    resource.deleteTime !== undefined ||
    generation(resource.generation) !== generation(resource.observedGeneration)
  )
    fail();
};
export function validateServerlessRoleBinding(binding: ServerlessRoleBinding): void {
  const short = { orchestration: 'o', controls: 'c', media: 'm', email: 'e', images: 'i', search: 's' };
  if (
    Object.keys(binding).sort().join(',') !==
      'buildId,deploymentName,image,namespace,poolName,projectId,region,role,runnerServiceAccount' ||
    binding.projectId !== 'urm-app-staging' ||
    binding.region !== 'us-central1' ||
    binding.namespace !== 'urm-app-staging.qwejt' ||
    !WORKER_READINESS_ROLES.includes(binding.role) ||
    !/^[a-f0-9]{40}$/.test(binding.buildId) ||
    binding.poolName !== `urm-worker-${binding.role}-${binding.buildId.slice(0, 20)}` ||
    binding.deploymentName !==
      (binding.role === 'orchestration' ? 'urm-worker-staging' : `urm-worker-${binding.role}-staging`) ||
    binding.runnerServiceAccount !==
      `tw-${short[binding.role]}-${binding.buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com` ||
    !/^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(binding.image)
  )
    fail();
}
/** Official v2 reconciliation evidence. Image is a declared immutable pin, not
 * an independently observed running-byte digest. Native execution joins below. */
export function verifyServerlessPool(binding: ServerlessRoleBinding, rawPool: unknown, rawRevision: unknown) {
  validateServerlessRoleBinding(binding);
  const pool = object(rawPool),
    revision = object(rawRevision);
  const parent = `projects/${binding.projectId}/locations/${binding.region}/workerPools/${binding.poolName}`;
  const revisionName = normalize(pool.latestReadyRevision);
  if (
    normalize(pool.name) !== parent ||
    typeof pool.uid !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(pool.uid) ||
    !revisionName.startsWith(`${parent}/revisions/${binding.poolName}-`) ||
    !/^[a-z0-9-]+$/.test(revisionName.slice(revisionName.lastIndexOf('/') + 1)) ||
    revisionName !== normalize(pool.latestCreatedRevision) ||
    normalize(revision.name) !== revisionName ||
    pool.terminalCondition?.state !== 'CONDITION_SUCCEEDED'
  )
    fail();
  settled(pool);
  settled(revision);
  if (typeof revision.uid !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(revision.uid)) fail();
  if (
    !Array.isArray(revision.conditions) ||
    !revision.conditions.some((c: any) => c.type === 'Ready' && c.state === 'CONDITION_SUCCEEDED')
  )
    fail();
  const desired = pool.instanceSplits ?? [];
  const oneSplit = (split: any, allowDefault: boolean) => {
    if (
      !split ||
      split.percent !== 100 ||
      !['INSTANCE_SPLIT_ALLOCATION_TYPE_LATEST', 'INSTANCE_SPLIT_ALLOCATION_TYPE_REVISION'].includes(split.type)
    )
      fail();
    if (split.type === 'INSTANCE_SPLIT_ALLOCATION_TYPE_REVISION' || !allowDefault || split.revision)
      if (normalize(split.revision) !== revisionName) fail();
  };
  if (!Array.isArray(desired) || desired.length > 1) fail();
  if (desired.length) oneSplit(desired[0], true);
  if (!Array.isArray(pool.instanceSplitStatuses) || pool.instanceSplitStatuses.length !== 1) fail();
  oneSplit(pool.instanceSplitStatuses[0], false);
  const worker = Array.isArray(revision.containers) ? revision.containers.filter((c: any) => c.name === 'worker') : [];
  if (
    worker.length !== 1 ||
    worker[0].image !== binding.image ||
    revision.serviceAccount !== binding.runnerServiceAccount
  )
    fail();
  const env = worker[0].env;
  if (!Array.isArray(env)) fail();
  for (const [name, value] of Object.entries({
    TEMPORAL_BUILD_ID: binding.buildId,
    TEMPORAL_TASK_QUEUES: `urm-${binding.role}`,
    TEMPORAL_DEPLOYMENT_NAME: binding.deploymentName,
    TEMPORAL_WORKER_HOSTING: 'cloud-run',
    TEMPORAL_DISPATCHER_ENABLED: 'false',
  }))
    if (
      env.filter((item: any) => item.name === name).length !== 1 ||
      env.find((item: any) => item.name === name).value !== value
    )
      fail();
  return {
    poolUid: pool.uid as string,
    revision: revisionName.slice(revisionName.lastIndexOf('/') + 1),
    revisionUid: revision.uid as string,
    poolGeneration: pool.generation as string,
    revisionGeneration: revision.generation as string,
    declaredImage: binding.image,
  };
}

export async function readServerlessResource(name: string): Promise<unknown> {
  if (
    !/^projects\/urm-app-staging\/locations\/us-central1\/workerPools\/[a-z0-9-]+(?:\/revisions\/[a-z0-9-]+)?$/.test(
      name
    )
  )
    fail();
  const controller = new AbortController();
  const signal = controller.signal;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('SERVERLESS_NATIVE_RESOURCE_READ_UNCONFIRMED'));
    }, 15000);
  });
  const operation = (async () => {
    const auth = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
    signal.throwIfAborted();
    const response = await auth.request({
      url: `https://run.googleapis.com/v2/${name}`,
      method: 'GET',
      timeout: 10000,
      retry: false,
      maxRedirects: 0,
      signal,
    });
    signal.throwIfAborted();
    return response.data;
  })();
  try {
    return await Promise.race([operation, deadline]);
  } catch {
    throw new Error('SERVERLESS_NATIVE_RESOURCE_READ_UNCONFIRMED');
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
  }
}

/** Operator-only native collector. It creates one inert workflow and private
 * evidence, never promotes versions or changes application admission. An exclusive
 * start intent survives unknown acknowledgement; do not rerun into a new directory
 * instead of reconciling that exact saved workflow. No raw API errors/credentials
 * or arbitrary environment values are persisted. Other release gates remain required. */
export async function collectServerlessReadinessObservations(options: {
  client: Client;
  firestore: Firestore;
  bindings: ServerlessRoleBinding[];
  artifactDirectory: string;
  readResource?: typeof readServerlessResource;
  onStartIntent?: (intent: {
    schemaVersion: number;
    workflowId: string;
    nonce: string;
    bindings: ServerlessRoleBinding[];
    createdAt: string;
  }) => Promise<void>;
}) {
  const bindings = structuredClone(options.bindings);
  if (
    !bindings.length ||
    bindings.length > 6 ||
    new Set(bindings.map((b) => b.role)).size !== bindings.length ||
    !bindings.some((b) => b.role === 'orchestration') ||
    !bindings.some((b) => b.role === 'controls') ||
    new Set(bindings.map((b) => b.buildId)).size !== 1 ||
    options.client.options.namespace !== 'urm-app-staging.qwejt' ||
    !('projectId' in options.firestore) ||
    options.firestore.projectId !== 'urm-app-staging' ||
    options.firestore.databaseId !== '(default)'
  )
    fail();
  bindings.forEach(validateServerlessRoleBinding);
  const directory = await stat(options.artifactDirectory);
  if (
    !isAbsolute(options.artifactDirectory) ||
    (await realpath(options.artifactDirectory)) !== options.artifactDirectory ||
    !directory.isDirectory() ||
    (directory.mode & 0o777) !== 0o700 ||
    directory.uid !== process.getuid?.()
  )
    fail();
  const nonce = randomBytes(16).toString('hex'),
    workflowId = `serverless-readiness-${nonce}`;
  const intent = { schemaVersion: 1, workflowId, nonce, bindings, createdAt: new Date().toISOString() };
  await writeExclusiveReceipt(options.artifactDirectory, 'readiness-start-intent.json', intent);
  await options.onStartIntent?.(intent);
  const read = options.readResource ?? readServerlessResource;
  const service = options.client.connection.workflowService;
  const routing = async (binding: ServerlessRoleBinding) => {
    const report = await options.client.connection.withDeadline(Date.now() + 10000, () =>
      service.describeWorkerDeployment({ namespace: binding.namespace, deploymentName: binding.deploymentName })
    );
    const config = report.workerDeploymentInfo?.routingConfig;
    if (
      config?.currentDeploymentVersion?.buildId !== binding.buildId ||
      config.currentDeploymentVersion.deploymentName !== binding.deploymentName ||
      Number(config.rampingVersionPercentage ?? 0) !== 0 ||
      config.rampingDeploymentVersion?.buildId
    )
      fail();
    const version = await options.client.connection.withDeadline(Date.now() + 10000, () =>
      service.describeWorkerDeploymentVersion({
        namespace: binding.namespace,
        deploymentVersion: { deploymentName: binding.deploymentName, buildId: binding.buildId },
      })
    );
    if (
      version.workerDeploymentVersionInfo?.deploymentVersion?.buildId !== binding.buildId ||
      version.workerDeploymentVersionInfo.deploymentVersion.deploymentName !== binding.deploymentName
    )
      fail();
    const queues = version.workerDeploymentVersionInfo?.taskQueueInfos ?? [];
    if (
      !queues.some((q) => q.name === `urm-${binding.role}` && q.type === 2) ||
      (binding.role === 'orchestration' && !queues.some((q) => q.name === 'urm-orchestration' && q.type === 1))
    )
      fail();
    return {
      routingDigest: createHash('sha256').update(JSON.stringify(report)).digest('hex'),
      queueDigest: createHash('sha256').update(JSON.stringify(version)).digest('hex'),
    };
  };
  try {
    for (const binding of bindings) await routing(binding);
    const startedAt = Date.now();
    const handle = await options.client.connection.withDeadline(Date.now() + 15000, () =>
      options.client.workflow.start('WorkerRuntimeProbe', {
        workflowId,
        taskQueue: 'urm-orchestration',
        args: [
          { projectId: 'urm-app-staging', buildId: bindings[0].buildId, nonce, roles: bindings.map((b) => b.role) },
        ],
        workflowExecutionTimeout: '10 minutes',
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        workflowIdConflictPolicy: 'FAIL',
      })
    );
    await writeExclusiveReceipt(options.artifactDirectory, 'readiness-start-ack.json', {
      workflowId,
      runId: handle.firstExecutionRunId,
    });
    const result = object(await options.client.connection.withDeadline(startedAt + 660000, () => handle.result()));
    const history = await options.client.connection.withDeadline(Date.now() + 10000, () => handle.fetchHistory());
    const scheduled = new Map(
      (history.events ?? [])
        .filter((e) => e.activityTaskScheduledEventAttributes)
        .map((e) => [String(e.eventId), e.activityTaskScheduledEventAttributes!])
    );
    const roles = [];
    if (
      Object.keys(result).sort().join(',') !==
      bindings
        .map((b) => b.role)
        .sort()
        .join(',')
    )
      fail();
    for (const binding of bindings) {
      const receipt = object(result[binding.role]) as WorkerReadinessReceipt;
      if (
        Object.keys(receipt).sort().join(',') !== 'digest,id' ||
        !/^[a-f0-9]{64}$/.test(receipt.id) ||
        !/^[a-f0-9]{64}$/.test(receipt.digest)
      )
        fail();
      const stored = await options.firestore.collection(WORKER_READINESS_COLLECTION).doc(receipt.id).get();
      const { digest, ...evidence } = object(stored.data());
      if (
        Object.keys(evidence).sort().join(',') !==
          'activityId,attempt,buildId,nonce,observedAt,projectId,role,runId,schemaVersion,taskQueue,worker,workflowId' ||
        evidence.schemaVersion !== 1 ||
        digest !== receipt.digest ||
        workerReadinessDigest(evidence) !== digest ||
        evidence.projectId !== binding.projectId ||
        evidence.buildId !== binding.buildId ||
        evidence.nonce !== nonce ||
        evidence.role !== binding.role ||
        evidence.workflowId !== workflowId ||
        evidence.runId !== handle.firstExecutionRunId ||
        evidence.taskQueue !== `urm-${binding.role}` ||
        evidence.attempt !== 1 ||
        !Number.isFinite(Date.parse(evidence.observedAt)) ||
        Date.parse(evidence.observedAt) < startedAt - 5000 ||
        Date.parse(evidence.observedAt) > Date.now() + 5000 ||
        Date.now() - startedAt > 600000
      )
        fail();
      const completed = (history.events ?? []).find((e) => {
        const done = e.activityTaskCompletedEventAttributes;
        const task = done && scheduled.get(String(done.scheduledEventId));
        return (
          task?.activityId === evidence.activityId &&
          task?.taskQueue?.name === evidence.taskQueue &&
          task?.activityType?.name === 'recordWorkerReadiness'
        );
      })?.activityTaskCompletedEventAttributes;
      const payloads = completed?.result?.payloads;
      if (
        !payloads ||
        payloads.length !== 1 ||
        workerReadinessDigest(defaultPayloadConverter.fromPayload(payloads[0])) !== workerReadinessDigest(receipt)
      )
        fail();
      const parent = `projects/${binding.projectId}/locations/${binding.region}/workerPools/${binding.poolName}`;
      const pool = object(await read(parent));
      const revisionName = normalize(pool.latestReadyRevision);
      const revision = await read(revisionName);
      const platform = verifyServerlessPool(binding, pool, revision);
      const cloud = object(object(evidence.worker).cloudRun);
      const expected = verifyCloudRunWorkerIdentity(
        {
          projectId: binding.projectId,
          region: binding.region,
          pool: binding.poolName,
          revision: platform.revision,
          buildId: binding.buildId,
          image: binding.image,
          serviceAccount: binding.runnerServiceAccount,
        },
        { projectId: binding.projectId, serviceAccount: binding.runnerServiceAccount, instanceId: cloud.instanceId },
        revision
      );
      if (
        Object.keys(object(evidence.worker)).sort().join(',') !== 'buildId,cloudRun,instanceId' ||
        evidence.worker.buildId !== binding.buildId ||
        typeof evidence.worker.instanceId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(evidence.worker.instanceId) ||
        workerReadinessDigest(cloud) !== workerReadinessDigest(expected)
      )
        fail();
      roles.push({
        role: binding.role,
        ...platform,
        receipt,
        ...(await routing(binding)),
        poolDigest: createHash('sha256').update(JSON.stringify(pool)).digest('hex'),
        revisionDigest: createHash('sha256').update(JSON.stringify(revision)).digest('hex'),
      });
    }
    const proof = {
      schemaVersion: 1,
      scope: 'observed-role-execution-and-declared-pool-identity',
      workflowId,
      runId: handle.firstExecutionRunId,
      verifiedAt: new Date().toISOString(),
      roles,
      historyDigest: createHash('sha256').update(JSON.stringify(history)).digest('hex'),
    };
    await writeExclusiveReceipt(options.artifactDirectory, 'readiness-proof.json', proof);
    return proof;
  } catch {
    throw new Error('SERVERLESS_READINESS_PENDING_RECONCILE_SAVED_INTENT');
  }
}

/** Guarded native entry: transport overrides and injected API readers are not
 * accepted here. Observations still cannot replace the other release gates. */
export async function collectServerlessRoleReadiness(
  options: Omit<Parameters<typeof collectServerlessReadinessObservations>[0], 'readResource' | 'onStartIntent'> & {
    onStartIntent: NonNullable<Parameters<typeof collectServerlessReadinessObservations>[0]['onStartIntent']>;
  }
) {
  if (typeof options.onStartIntent !== 'function') fail();
  const native = options.client.connection;
  const connection = native instanceof Connection ? native.options : fail();
  // The pinned SDK normalizes tls into native gRPC ChannelCredentials and
  // removes the original tls option. Inspect the actual secure channel setting.
  const secure = connection.credentials._isSecure();
  if (
    !['us-central1.gcp.api.temporal.io:7233', 'urm-app-staging.qwejt.tmprl.cloud:7233'].includes(connection.address) ||
    !secure ||
    ['grpc.ssl_target_name_override', 'grpc.default_authority'].some((key) => connection.channelArgs[key] !== undefined)
  )
    fail();
  return collectServerlessReadinessObservations({ ...options, readResource: readServerlessResource });
}
