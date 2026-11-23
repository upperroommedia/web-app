import { expectedCloudRunStorageAccess } from './cloud-run-storage-readiness';
export { collectMediaStartupCapacity } from './media-startup-capacity';
import { createHash, randomBytes } from 'node:crypto';
import { writeFile, realpath, stat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { Connection, type Client } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import type { Firestore } from 'firebase-admin/firestore';
import { cloudRunPollerIdentity, isCloudRunWorkerRevision, verifyCloudRunWorkerIdentity } from './cloud-run-witness';
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
export interface ServerlessReadinessStartIntent {
  schemaVersion: number;
  workflowId: string;
  nonce: string;
  bindings: ServerlessRoleBinding[];
  createdAt: string;
  imageWorkflowBundleSHA256: string;
}
async function readPrivateReceipt(directory: string, name: string, optional = false): Promise<unknown> {
  let handle;
  try {
    handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const file = await handle.stat();
    if (
      !file.isFile() ||
      file.uid !== process.getuid?.() ||
      (file.mode & 0o777) !== 0o600 ||
      file.size < 1 ||
      file.size > 65536
    )
      fail();
    const buffer = Buffer.alloc(file.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== file.size) fail();
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    fail();
  } finally {
    await handle?.close();
  }
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
export async function verifyStagingEmailReceipt(
  value: unknown,
  nonce: string,
  runId: string,
  startedAt: number,
  recordedAt: string
): Promise<void> {
  const { expectedEmailCaptureReadiness } = await import(
    '@upperroom/function-kit-firestore-send-email/lib/temporal/capture'
  );
  const { observedAt, ...capture } = object(value);
  const expected = expectedEmailCaptureReadiness(nonce, runId);
  if (
    workerReadinessDigest(capture) !== workerReadinessDigest(expected) ||
    typeof observedAt !== 'string' ||
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(observedAt).toISOString() !== observedAt ||
    Date.parse(observedAt) < startedAt - 5000 ||
    Date.parse(observedAt) > Date.parse(recordedAt)
  )
    fail();
}
function nativeTimestampNanos(
  value: { seconds?: { toString(): string } | null; nanos?: number | null } | null | undefined
): bigint {
  const seconds = value?.seconds?.toString();
  const nanos = value?.nanos ?? 0;
  if (!seconds || !/^[1-9][0-9]{0,11}$/.test(seconds) || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1e9)
    return fail();
  return BigInt(seconds) * 1000000000n + BigInt(nanos);
}
const normalize = (name: unknown): string =>
  typeof name === 'string' ? name.replace('projects/251680231116/', 'projects/urm-app-staging/') : fail();
const generation = (value: unknown): string =>
  typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
    ? value
    : fail();
const settled = (resource: Record<string, any>) => {
  if (
    (resource.reconciling !== undefined && resource.reconciling !== false) ||
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
  const revisionParent = `${parent}/revisions/`;
  const revisionName = normalize(pool.latestReadyRevision);
  if (
    normalize(pool.name) !== parent ||
    typeof pool.uid !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(pool.uid) ||
    !revisionName.startsWith(revisionParent) ||
    !isCloudRunWorkerRevision(binding.poolName, revisionName.slice(revisionParent.length)) ||
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
    !/^projects\/urm-app-staging\/locations\/us-central1\/workerPools\/[a-z0-9-]+(?:\/revisions\/[a-z0-9-]+(?:\.[1-9][0-9]*)?)?$/.test(
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
export async function assertServerlessReadinessArtifactDirectory(directory: string): Promise<void> {
  const info = await stat(directory);
  if (
    !isAbsolute(directory) ||
    (await realpath(directory)) !== directory ||
    !info.isDirectory() ||
    (info.mode & 0o777) !== 0o700 ||
    info.uid !== process.getuid?.()
  )
    fail();
}

export async function collectServerlessReadinessObservations(options: {
  client: Client;
  firestore: Firestore;
  bindings: ServerlessRoleBinding[];
  artifactDirectory: string;
  imageWorkflowBundleSHA256: string;
  readResource?: typeof readServerlessResource;
  onStartIntent?: (intent: ServerlessReadinessStartIntent) => Promise<void>;
  savedIntent?: ServerlessReadinessStartIntent;
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
  await assertServerlessReadinessArtifactDirectory(options.artifactDirectory);
  if (!/^[a-f0-9]{64}$/.test(options.imageWorkflowBundleSHA256)) fail();
  const reconciling = Object.prototype.hasOwnProperty.call(options, 'savedIntent');
  if (
    reconciling &&
    (!options.savedIntent || typeof options.savedIntent !== 'object' || Array.isArray(options.savedIntent))
  )
    fail();
  const generatedNonce = randomBytes(16).toString('hex');
  const intent = structuredClone(
    options.savedIntent ?? {
      schemaVersion: 1,
      workflowId: `serverless-readiness-${generatedNonce}`,
      nonce: generatedNonce,
      bindings,
      createdAt: new Date().toISOString(),
      imageWorkflowBundleSHA256: options.imageWorkflowBundleSHA256,
    }
  );
  if (
    Object.keys(intent).sort().join(',') !==
      'bindings,createdAt,imageWorkflowBundleSHA256,nonce,schemaVersion,workflowId' ||
    intent.schemaVersion !== 1 ||
    intent.imageWorkflowBundleSHA256 !== options.imageWorkflowBundleSHA256 ||
    !/^[a-f0-9]{32}$/.test(intent.nonce) ||
    intent.workflowId !== `serverless-readiness-${intent.nonce}` ||
    !Number.isFinite(Date.parse(intent.createdAt)) ||
    Date.parse(intent.createdAt) > Date.now() + 5000 ||
    workerReadinessDigest(intent.bindings) !== workerReadinessDigest(bindings)
  )
    fail();
  const { nonce, workflowId } = intent;
  if (reconciling) {
    const localIntent = await readPrivateReceipt(options.artifactDirectory, 'readiness-start-intent.json');
    if (workerReadinessDigest(localIntent) !== workerReadinessDigest(intent)) fail();
  } else {
    await writeExclusiveReceipt(options.artifactDirectory, 'readiness-start-intent.json', intent);
  }
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
    const startedAt = reconciling ? Date.parse(intent.createdAt) : Date.now();
    let handle: ReturnType<Client['workflow']['getHandle']>;
    let runId: string;
    if (reconciling) {
      // GET only: absence, a failed lookup or an expired execution cannot authorize another start.
      const described = await options.client.connection.withDeadline(Date.now() + 10000, () =>
        options.client.workflow.getHandle(workflowId).describe()
      );
      if (
        described.workflowId !== workflowId ||
        described.type !== 'WorkerRuntimeProbe' ||
        described.taskQueue !== 'urm-orchestration' ||
        !described.runId ||
        described.startTime.getTime() < startedAt - 5000 ||
        described.startTime.getTime() > Date.now() + 5000
      )
        fail();
      runId = described.runId;
      handle = options.client.workflow.getHandle(workflowId, runId, { firstExecutionRunId: runId, followRuns: false });
      const original = await options.client.connection.withDeadline(Date.now() + 10000, () => handle.fetchHistory());
      const first = original.events?.[0]?.workflowExecutionStartedEventAttributes;
      const input = first?.input?.payloads;
      if (
        !first ||
        first.originalExecutionRunId !== runId ||
        first.firstExecutionRunId !== runId ||
        first.continuedExecutionRunId ||
        first.workflowType?.name !== 'WorkerRuntimeProbe' ||
        first.taskQueue?.name !== 'urm-orchestration' ||
        !input ||
        input.length !== 1 ||
        workerReadinessDigest(defaultPayloadConverter.fromPayload(input[0])) !==
          workerReadinessDigest({
            projectId: 'urm-app-staging',
            buildId: bindings[0].buildId,
            nonce,
            roles: bindings.map((b) => b.role),
          })
      )
        fail();
      const acknowledgement = await readPrivateReceipt(options.artifactDirectory, 'readiness-start-ack.json', true);
      if (
        acknowledgement !== undefined &&
        workerReadinessDigest(acknowledgement) !== workerReadinessDigest({ workflowId, runId })
      )
        fail();
    } else {
      await options.onStartIntent?.(intent);
      const started = await options.client.connection.withDeadline(Date.now() + 15000, () =>
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
      runId = started.firstExecutionRunId;
      handle = options.client.workflow.getHandle(workflowId, runId, { firstExecutionRunId: runId, followRuns: false });
      await writeExclusiveReceipt(options.artifactDirectory, 'readiness-start-ack.json', { workflowId, runId });
    }
    const result = object(await options.client.connection.withDeadline(startedAt + 660000, () => handle.result()));
    const history = await options.client.connection.withDeadline(Date.now() + 10000, () => handle.fetchHistory());
    const scheduled = new Map(
      (history.events ?? [])
        .filter((e) => e.activityTaskScheduledEventAttributes)
        .map((e) => [String(e.eventId), e.activityTaskScheduledEventAttributes!])
    );
    const startedActivities = new Map(
      (history.events ?? []).filter((e) => e.activityTaskStartedEventAttributes).map((e) => [String(e.eventId), e])
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
          'activityId,attempt,buildId,cloudStorage,email,firebaseRtdb,nonce,observedAt,projectId,role,runId,schemaVersion,taskQueue,worker,workflowBundle,workflowId' ||
        evidence.schemaVersion !== 3 ||
        digest !== receipt.digest ||
        workerReadinessDigest(evidence) !== digest ||
        evidence.projectId !== binding.projectId ||
        evidence.buildId !== binding.buildId ||
        evidence.nonce !== nonce ||
        evidence.role !== binding.role ||
        evidence.workflowId !== workflowId ||
        evidence.runId !== runId ||
        evidence.taskQueue !== `urm-${binding.role}` ||
        evidence.attempt !== 1 ||
        !Number.isFinite(Date.parse(evidence.observedAt)) ||
        Date.parse(evidence.observedAt) < startedAt - 5000 ||
        Date.parse(evidence.observedAt) > Date.now() + 5000 ||
        Date.now() - startedAt > 600000
      )
        fail();
      if (binding.role === 'orchestration') {
        const bundle = object(evidence.workflowBundle);
        if (
          Object.keys(bundle).sort().join(',') !== 'buildId,bundleBytes,bundleSHA256,schemaVersion' ||
          bundle.schemaVersion !== 1 ||
          bundle.buildId !== binding.buildId ||
          bundle.bundleSHA256 !== options.imageWorkflowBundleSHA256 ||
          !Number.isSafeInteger(bundle.bundleBytes) ||
          bundle.bundleBytes < 1 ||
          bundle.bundleBytes > 64 * 1024 * 1024
        )
          fail();
      } else if (evidence.workflowBundle !== null) fail();
      if (binding.role === 'orchestration') {
        const access = object(evidence.firebaseRtdb);
        if (
          Object.keys(access).sort().join(',') !== 'databaseURL,observedAt,readPath,readSucceeded' ||
          access.databaseURL !== 'https://urm-app-staging-default-rtdb.firebaseio.com/' ||
          access.readPath !== 'bundle-metadata' ||
          access.readSucceeded !== true ||
          !Number.isFinite(Date.parse(access.observedAt)) ||
          Date.parse(access.observedAt) < startedAt - 5000 ||
          Date.parse(access.observedAt) > Date.parse(evidence.observedAt)
        )
          fail();
      } else if (evidence.firebaseRtdb !== null) fail();
      const expectedStorage = expectedCloudRunStorageAccess(binding.role);
      if (expectedStorage) {
        const storage = object(evidence.cloudStorage);
        if (
          Object.keys(storage).sort().join(',') !== 'bucket,observedAt,permissions' ||
          storage.bucket !== expectedStorage.bucket ||
          !Array.isArray(storage.permissions) ||
          storage.permissions.length !== expectedStorage.permissions.length ||
          storage.permissions.some(
            (permission: unknown, index: number) => permission !== expectedStorage.permissions[index]
          ) ||
          !Number.isFinite(Date.parse(storage.observedAt)) ||
          Date.parse(storage.observedAt) < startedAt - 5000 ||
          Date.parse(storage.observedAt) > Date.parse(evidence.observedAt)
        )
          fail();
      } else if (evidence.cloudStorage !== null) fail();

      if (binding.role === 'email') {
        await verifyStagingEmailReceipt(evidence.email, nonce, runId, startedAt, evidence.observedAt);
      } else if (evidence.email !== null) fail();
      const completedEvent = (history.events ?? []).find((e) => {
        const done = e.activityTaskCompletedEventAttributes;
        const task = done && scheduled.get(String(done.scheduledEventId));
        return (
          task?.activityId === evidence.activityId &&
          task?.taskQueue?.name === evidence.taskQueue &&
          task?.activityType?.name === 'recordWorkerReadiness'
        );
      });
      const completed = completedEvent?.activityTaskCompletedEventAttributes;
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
      const observedIdentity = cloudRunPollerIdentity(expected.instanceId, evidence.worker.instanceId);
      const startedEvent = startedActivities.get(String(completed?.startedEventId));
      const started = startedEvent?.activityTaskStartedEventAttributes;
      if (
        !started ||
        String(started.scheduledEventId) !== String(completed?.scheduledEventId) ||
        started.attempt !== evidence.attempt ||
        started.identity !== completed?.identity ||
        (started.identity !== observedIdentity &&
          (binding.role !== 'media' || started.identity !== `media-restored-${evidence.worker.instanceId}`))
      )
        fail();
      if (binding.role === 'email') {
        const { readEmailReadinessCapture } = await import(
          '@upperroom/function-kit-firestore-send-email/lib/temporal/capture'
        );
        const capture = await readEmailReadinessCapture(options.firestore, nonce, runId);
        const start = nativeTimestampNanos(startedEvent?.eventTime);
        const end = nativeTimestampNanos(completedEvent?.eventTime);
        for (const timestamp of [capture.createdAt, capture.capturedAt]) {
          const at = nativeTimestampNanos({ seconds: timestamp.seconds, nanos: timestamp.nanoseconds });
          if (at < start || at > end) fail();
        }
      }
      roles.push({
        role: binding.role,
        workflowBundle: evidence.workflowBundle,
        firebaseRtdb: evidence.firebaseRtdb,
        cloudStorage: evidence.cloudStorage,
        email: evidence.email,
        ...platform,
        receipt,
        ...(await routing(binding)),
        poolDigest: workerReadinessDigest(pool),
        revisionDigest: workerReadinessDigest(revision),
      });
    }
    const proof = {
      schemaVersion: 1,
      scope: 'observed-role-execution-and-native-poller-identity',
      workflowId,
      runId,
      imageWorkflowBundleSHA256: options.imageWorkflowBundleSHA256,
      verifiedAt: new Date().toISOString(),
      roles,
      historyDigest: createHash('sha256').update(JSON.stringify(history)).digest('hex'),
    };
    await writeExclusiveReceipt(
      options.artifactDirectory,
      reconciling ? `readiness-reconciliation-${randomBytes(16).toString('hex')}.json` : 'readiness-proof.json',
      proof
    );
    return proof;
  } catch {
    throw new Error('SERVERLESS_READINESS_PENDING_RECONCILE_SAVED_INTENT');
  }
}

/** Guarded native entry: transport overrides and injected API readers are not
 * accepted here. Observations still cannot replace the other release gates. */
export async function collectServerlessRoleReadiness(
  options: Omit<
    Parameters<typeof collectServerlessReadinessObservations>[0],
    'readResource' | 'onStartIntent' | 'savedIntent'
  > & {
    onStartIntent: NonNullable<Parameters<typeof collectServerlessReadinessObservations>[0]['onStartIntent']>;
  }
) {
  if (typeof options.onStartIntent !== 'function' || Object.prototype.hasOwnProperty.call(options, 'savedIntent'))
    fail();
  const connection = assertNativeReadinessConnection(options.client);
  if (
    !Array.isArray(connection.interceptors) ||
    connection.interceptors.length ||
    connection.channelArgs['grpc.enable_retries'] !== 0
  )
    fail();
  return collectServerlessReadinessObservations({ ...options, readResource: readServerlessResource });
}

/** Reconcile the exact saved execution using GETs only; never retries its start. */
export async function reconcileServerlessRoleReadiness(
  options: Omit<
    Parameters<typeof collectServerlessReadinessObservations>[0],
    'readResource' | 'onStartIntent' | 'savedIntent'
  > & {
    savedIntent: ServerlessReadinessStartIntent;
  }
) {
  if (!options.savedIntent || typeof options.savedIntent !== 'object' || Array.isArray(options.savedIntent)) fail();
  assertNativeReadinessConnection(options.client);
  return collectServerlessReadinessObservations({
    client: options.client,
    firestore: options.firestore,
    bindings: options.bindings,
    artifactDirectory: options.artifactDirectory,
    imageWorkflowBundleSHA256: options.imageWorkflowBundleSHA256,
    savedIntent: options.savedIntent,
    readResource: readServerlessResource,
  });
}
function assertNativeReadinessConnection(client: Client) {
  const native = client.connection;
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
  return connection;
}

export { collectDispatchDiagnosticExecution } from './dispatch-diagnostic';
