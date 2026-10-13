#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const fail = (message) => {
  throw new Error(message);
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  return value;
}
const fingerprint = (value) => hash(canonical(value));
const name = (value) =>
  typeof value === 'string' && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) && value.length <= 253;
const nonempty = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\r\n\0]/.test(value);

export function validateRecoveryScope(config) {
  const project = { staging: 'urm-app-staging', production: 'urm-app' }[config.environment];
  if (!project || config.firebaseProjectId !== project || config.temporalNamespace !== project)
    fail('Project and Temporal namespace must match the environment');
  for (const key of ['context', 'clusterUid'])
    if (!nonempty(config[key]) || /REQUIRED|PLACEHOLDER/.test(config[key])) fail(`Concrete ${key} is required`);
  if (!name(config.namespace)) fail('A concrete Kubernetes namespace is required');
  return config;
}

export function validateOperator(operator) {
  if (!nonempty(operator?.google?.subject)) fail('A verified immutable Google operator subject is required');
  const username = operator?.kubernetes?.username;
  if (!nonempty(username) || ['system:anonymous', 'system:unauthenticated'].includes(username))
    fail('An authenticated Kubernetes operator is required');
  if (operator.google.email !== undefined && !nonempty(operator.google.email)) fail('Invalid verified operator email');
  if (operator.kubernetes.uid !== undefined && !nonempty(operator.kubernetes.uid))
    fail('Invalid Kubernetes operator UID');
  if (
    operator.kubernetes.groups !== undefined &&
    (!Array.isArray(operator.kubernetes.groups) ||
      operator.kubernetes.groups.length > 64 ||
      operator.kubernetes.groups.some((group) => !nonempty(group)))
  )
    fail('Invalid authenticated Kubernetes groups');
  if (operator.kubernetes.groups?.includes('system:unauthenticated')) fail('Unauthenticated Kubernetes operator');
  return `google:${operator.google.subject}`;
}

export function verifyPodTermination(config, worker, observations) {
  validateRecoveryScope(config);
  for (const key of ['instanceId', 'buildId', 'podUid', 'podName', 'namespace', 'clusterId', 'nodeUid', 'nodeName'])
    if (!nonempty(worker?.[key])) fail(`Missing originating worker ${key}`);
  if (!name(worker.podName) || !name(worker.nodeName)) fail('Invalid originating Kubernetes object name');
  if (!/^[a-f0-9]{40}$/.test(worker.buildId)) fail('Worker build must be immutable');
  if (worker.clusterId !== config.clusterUid || worker.namespace !== config.namespace)
    fail('Originating worker belongs to a different cluster or namespace');
  if (
    !Array.isArray(worker.containerIds) ||
    !worker.containerIds.length ||
    worker.containerIds.some((id) => !/^[a-z0-9-]+:\/\/[a-f0-9]{16,128}$/.test(id)) ||
    new Set(worker.containerIds).size !== worker.containerIds.length
  )
    fail('Exact originating container IDs are required');
  const { cluster, namespace, pod, node, runningPods } = observations;
  if (cluster?.metadata?.uid !== config.clusterUid || cluster.metadata.name !== 'kube-system')
    fail('Cluster identity differs from the reviewed environment');
  if (
    namespace?.metadata?.name !== config.namespace ||
    !nonempty(namespace.metadata.uid) ||
    namespace.metadata.deletionTimestamp
  )
    fail('Namespace is unavailable or deleting');
  if (
    pod?.metadata?.uid !== worker.podUid ||
    pod.metadata.name !== worker.podName ||
    pod.metadata.namespace !== worker.namespace
  )
    fail('Originating pod UID cannot be verified');
  if (!nonempty(pod.metadata.resourceVersion)) fail('Pod resource version is unavailable');
  if (!['Succeeded', 'Failed'].includes(pod.status?.phase)) fail('Originating pod is not terminal');
  if (
    pod.spec?.nodeName !== worker.nodeName ||
    node?.metadata?.name !== worker.nodeName ||
    node.metadata.uid !== worker.nodeUid
  )
    fail('Originating node UID cannot be verified');
  if (
    !nonempty(node.metadata.resourceVersion) ||
    node.metadata.deletionTimestamp ||
    !node.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True')
  )
    fail('Originating node is unavailable');
  if (
    pod.metadata.labels?.['app.kubernetes.io/name'] !== 'urm-temporal-worker' ||
    pod.metadata.labels?.['app.kubernetes.io/version'] !== worker.buildId
  )
    fail('Pod does not identify the recorded immutable worker build');
  const containers = [
    ...(pod.spec.initContainers ?? []),
    ...(pod.spec.containers ?? []),
    ...(pod.spec.ephemeralContainers ?? []),
  ];
  const statuses = [
    ...(pod.status.initContainerStatuses ?? []),
    ...(pod.status.containerStatuses ?? []),
    ...(pod.status.ephemeralContainerStatuses ?? []),
  ];
  if (
    !containers.length ||
    statuses.length !== containers.length ||
    new Set(statuses.map((status) => status.name)).size !== statuses.length
  )
    fail('Every container must have an unambiguous termination status');
  for (const container of containers) {
    const status = statuses.find((status) => status.name === container.name);
    if (
      !status?.state?.terminated ||
      status.state.running ||
      status.state.waiting ||
      !nonempty(status.containerID) ||
      !nonempty(status.state.terminated.finishedAt)
    )
      fail('A container is alive or its termination is unknown');
  }
  const ids = statuses.map((status) => status.containerID);
  if (worker.containerIds.some((id) => !ids.includes(id)))
    fail('Originating container was replaced or restarted; its termination is not proved');
  const origin = containers.find(
    (container) =>
      statuses.some((status) => status.name === container.name && worker.containerIds.includes(status.containerID)) &&
      container.env?.some((env) => env.name === 'TEMPORAL_BUILD_ID' && env.value === worker.buildId)
  );
  if (
    !origin ||
    !origin.env.some((env) => env.name === 'FIREBASE_PROJECT_ID' && env.value === config.firebaseProjectId) ||
    !origin.env.some((env) => env.name === 'TEMPORAL_NAMESPACE' && env.value === config.temporalNamespace) ||
    !/@sha256:[a-f0-9]{64}$/.test(origin.image ?? '')
  )
    fail('Originating worker environment and image are not bound to this project');
  if (
    runningPods?.kind !== 'PodList' ||
    !Array.isArray(runningPods.items) ||
    runningPods.items.some((item) => !nonempty(item.metadata?.uid))
  )
    fail('Live kubelet container inventory is unavailable or malformed');
  if (runningPods.items.some((item) => item.metadata.uid === worker.podUid))
    fail('The live kubelet still observes the originating pod');
  return {
    kind: 'verified_pod_termination',
    projectId: config.firebaseProjectId,
    temporalNamespace: config.temporalNamespace,
    clusterId: worker.clusterId,
    namespace: worker.namespace,
    namespaceUid: namespace.metadata.uid,
    podUid: worker.podUid,
    podName: worker.podName,
    nodeUid: worker.nodeUid,
    nodeName: worker.nodeName,
    instanceId: worker.instanceId,
    buildId: worker.buildId,
    containerIds: [...worker.containerIds],
    kubePodResourceVersion: pod.metadata.resourceVersion,
    kubeNodeResourceVersion: node.metadata.resourceVersion,
    evidenceDigest: fingerprint(observations),
  };
}

function validateRecords(config, uid, jobId, records, phase) {
  const { resource, job, intent, entity } = records;
  for (const record of [resource, job, intent, entity])
    if (!record || record.projectId !== config.firebaseProjectId)
      fail('Private record project identity is missing or mismatched');
  const sessions = phase === 'sessions';
  const execution = sessions ? resource.sessionExecution : resource.execution;
  if (
    resource.uid !== uid ||
    resource.jobId !== jobId ||
    !execution?.worker ||
    (sessions
      ? resource.state !== 'applied' ||
        resource.sessionState !== 'started' ||
        resource.sessionTransport !== 'single_shot_identity_toolkit'
      : resource.state !== 'started' || resource.transport !== 'single_shot_identity_toolkit')
  )
    fail('No unresolved single-shot account mutation with a bound originating worker exists');
  if (sessions) {
    if (
      typeof resource.sessionOperationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(resource.sessionOperationId) ||
      !resource.sessionClaims ||
      typeof resource.sessionClaims !== 'object' ||
      Array.isArray(resource.sessionClaims) ||
      resource.sessionClaims.temporalAccountSessionOperationId !== resource.sessionOperationId
    )
      fail('Frozen uniquely marked session claims are required');
    if (
      typeof resource.sessionCutoffSeconds !== 'string' ||
      !/^\d{1,16}$/.test(resource.sessionCutoffSeconds) ||
      !Number.isSafeInteger(Number(resource.sessionCutoffSeconds)) ||
      Number(resource.sessionCutoffSeconds) < 0
    )
      fail('Frozen session cutoff is invalid');
  }
  if (
    job.jobId !== jobId ||
    intent.jobId !== jobId ||
    job.generation !== intent.generation ||
    entity.generation !== intent.generation ||
    entity.activeJobId !== jobId
  )
    fail('The job generation changed or is no longer current');
  if (
    resource.claims?.temporalAccountClaimJobId !== jobId ||
    !['invite.claim', 'role.resolve'].includes(intent.kind) ||
    job.kind !== intent.kind
  )
    fail('Frozen account claim identity is invalid');
  if (
    execution.temporalNamespace !== config.temporalNamespace ||
    execution.activityType !== (sessions ? 'revokeAccountSessions' : 'applyAccountClaims') ||
    execution.workflowId !== job.workflowId ||
    !nonempty(execution.runId) ||
    !nonempty(execution.activityId) ||
    !Number.isSafeInteger(execution.attempt) ||
    execution.attempt < 1 ||
    !Number.isFinite(execution.scheduledAt) ||
    typeof execution.runStartedAtNanos !== 'string' ||
    !/^[0-9]+$/.test(execution.runStartedAtNanos)
  )
    fail('Account execution identity is incomplete or mismatched');
  if (intent.entity?.type !== 'user' || intent.entity?.id !== uid)
    fail('The account mutation target differs from the current job entity');
  if (
    intent.entity?.type !== job.entity?.type ||
    intent.entity?.id !== job.entity?.id ||
    entity.entity?.type !== intent.entity.type ||
    entity.entity?.id !== intent.entity.id
  )
    fail('Entity identity differs between private records');
  return execution;
}

/** No Auth mutation, job resume, public projection or receipt completion occurs here. */
export async function reconcileAccountExecution(
  { firestore, config, uid, jobId, kubernetes, operator, phase = 'claims', apply = false, now = Date.now },
  { drainKey, entityKey }
) {
  validateRecoveryScope(config);
  if (!['claims', 'sessions'].includes(phase)) fail('Phase must be claims or sessions');
  const operatorUid = validateOperator(operator);
  const operatorIdentity = {
    google: { subject: operator.google.subject, ...(operator.google.email ? { email: operator.google.email } : {}) },
    kubernetes: {
      username: operator.kubernetes.username,
      ...(operator.kubernetes.uid ? { uid: operator.kubernetes.uid } : {}),
      groups: [...(operator.kubernetes.groups ?? [])],
    },
  };
  if (!nonempty(uid) || !nonempty(jobId) || uid.includes('/') || jobId.includes('/'))
    fail('Exact UID and job ID are required');
  const resourceRef = firestore
    .collection('_durableAccountClaimResources')
    .doc(createHash('sha256').update(`${config.firebaseProjectId}:${uid}`).digest('hex'));
  const jobRef = firestore.collection('durableJobs').doc(jobId);
  const intentRef = firestore.collection('durableJobIntents').doc(jobId);
  const initial = await Promise.all([resourceRef.get(), jobRef.get(), intentRef.get()]);
  const [resource, job, intent] = initial.map((snapshot) => snapshot.data());
  if (!intent?.entity || !intent?.kind) fail('Private job intent is unavailable');
  const entityRef = firestore
    .collection('durableJobEntities')
    .doc(entityKey(config.firebaseProjectId, intent.entity, intent.kind));
  const entity = (await entityRef.get()).data();
  const records = { resource, job, intent, entity };
  const execution = validateRecords(config, uid, jobId, records, phase);
  const proofRef = firestore
    .collection('durableActivityDrains')
    .doc(drainKey(config.firebaseProjectId, jobId, execution));
  const evidenceReference = `durableAccountExecutionAudits/${randomUUID()}`;
  const auditRef = firestore.doc(evidenceReference);
  const initialFingerprint = fingerprint(records);
  const gather = async () => verifyPodTermination(config, execution.worker, await kubernetes.observe(execution.worker));
  const preview = await gather();
  if (!apply)
    return {
      applied: false,
      phase,
      jobId,
      proofId: proofRef.id,
      evidence: preview,
      operatorUid,
      remoteRpcCompletionProven: false,
    };
  return firestore.runTransaction(async (tx) => {
    // All reads precede writes. Firestore retries re-read the exact original
    // resource snapshot and live node evidence, never replay an Auth operation.
    const current = await Promise.all([resourceRef, jobRef, intentRef, entityRef, proofRef].map((ref) => tx.get(ref)));
    const fresh = {
      resource: current[0].data(),
      job: current[1].data(),
      intent: current[2].data(),
      entity: current[3].data(),
    };
    validateRecords(config, uid, jobId, fresh, phase);
    if (fingerprint(fresh) !== initialFingerprint)
      fail('The private resource/job changed during verification; restart the review');
    if (current[4].exists) fail('A completion witness already exists; this script will not replace it');
    const evidence = await gather();
    if (fingerprint(evidence) !== fingerprint(preview))
      fail('Kubernetes evidence changed during verification; restart the review');
    const attestation = {
      ...evidence,
      verifiedAt: now(),
      kubernetesOperator: operatorIdentity.kubernetes,
      googleOperator: operatorIdentity.google,
      remoteRpcCompletionProven: false,
    };
    const executionId = hash([execution.workflowId, execution.runId, execution.activityId, execution.scheduledAt]);
    tx.create(proofRef, {
      schemaVersion: 1,
      projectId: config.firebaseProjectId,
      jobId,
      executionId,
      execution,
      state: 'drained',
      drainedAt: attestation.verifiedAt,
      source: 'operator_verified_pod_termination',
      operatorUid,
      evidenceReference,
      attestation,
    });
    tx.create(auditRef, {
      schemaVersion: 1,
      action: 'attest_account_worker_termination',
      phase,
      projectId: config.firebaseProjectId,
      temporalNamespace: config.temporalNamespace,
      jobId,
      uid,
      proofId: proofRef.id,
      operatorUid,
      reviewedRecordDigest: initialFingerprint,
      frozenClaimsDigest: fingerprint(phase === 'sessions' ? resource.sessionClaims : resource.claims),
      ...(phase === 'sessions'
        ? { sessionOperationId: resource.sessionOperationId, sessionCutoffSeconds: resource.sessionCutoffSeconds }
        : {}),
      execution,
      attestation,
    });
    return { applied: true, phase, jobId, proofId: proofRef.id, evidenceReference, remoteRpcCompletionProven: false };
  });
}

export function createKubernetesReader(config, execute = execFileSync) {
  const json = (args) =>
    JSON.parse(
      execute('kubectl', ['--context', config.context, ...args], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 20_000,
        maxBuffer: 16 * 1024 * 1024,
      })
    );
  return {
    whoami: () => json(['auth', 'whoami', '-o', 'json']).status?.userInfo,
    async observe(worker) {
      // Missing/deleted objects, proxy errors and unresponsive nodes throw;
      // deletion or an elapsed timeout are never evidence of termination.
      const cluster = json(['get', 'namespace', 'kube-system', '-o', 'json']);
      const namespace = json(['get', 'namespace', config.namespace, '-o', 'json']);
      const pod = json(['get', 'pod', worker.podName, '-n', config.namespace, '-o', 'json']);
      const node = json(['get', 'node', worker.nodeName, '-o', 'json']);
      const runningPods = json([
        'get',
        '--raw',
        `/api/v1/nodes/${encodeURIComponent(worker.nodeName)}/proxy/runningpods/`,
      ]);
      return { cluster, namespace, pod, node, runningPods };
    },
  };
}

export function parseRecoveryArguments(args) {
  const flags = {},
    allowed = new Set(['--config', '--uid', '--job', '--phase']);
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') {
      if (apply) fail('Duplicate --apply');
      apply = true;
      continue;
    }
    if (!allowed.has(args[index]) || flags[args[index]] || !args[index + 1] || args[index + 1].startsWith('--'))
      fail(
        'Usage: temporal-reconcile-account-execution.mjs --config PATH --uid UID --job JOB_ID [--phase claims|sessions] [--apply]'
      );
    flags[args[index]] = args[++index];
  }
  if (!['--config', '--uid', '--job'].every((key) => flags[key])) fail('Config, UID and job are required');
  const phase = flags['--phase'] ?? 'claims';
  if (!['claims', 'sessions'].includes(phase)) fail('Phase must be claims or sessions');
  return { flags, apply, phase };
}

async function main() {
  const { flags, apply, phase } = parseRecoveryArguments(process.argv.slice(2));
  const config = validateRecoveryScope(JSON.parse(await readFile(flags['--config'], 'utf8')));
  const kubernetes = createKubernetesReader(config);
  const { GoogleAuth, OAuth2Client } = await import('google-auth-library');
  const auth = new GoogleAuth({
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) fail('Authenticated Google operator credentials are required');
  const identity = await new OAuth2Client().getTokenInfo(token.token);
  const subject = identity.sub ?? identity.user_id;
  if (!subject) fail('OAuth token information does not expose an immutable operator identity');
  const operator = {
    google: { subject, ...(identity.email ? { email: identity.email } : {}) },
    kubernetes: kubernetes.whoami(),
  };
  validateOperator(operator);
  const { initializeApp, applicationDefault, deleteApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { durableActivityDrainKey, durableEntityKey } = await import('@upperroom/orchestration/job-store');
  const app = initializeApp(
    { projectId: config.firebaseProjectId, credential: applicationDefault() },
    `account-recovery-${randomUUID()}`
  );
  try {
    const result = await reconcileAccountExecution(
      {
        firestore: getFirestore(app),
        config,
        uid: flags['--uid'],
        jobId: flags['--job'],
        phase,
        kubernetes,
        operator,
        apply,
      },
      { drainKey: durableActivityDrainKey, entityKey: durableEntityKey }
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await deleteApp(app);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
