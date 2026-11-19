import { assertWorkerHandoffPromotion } from './temporal-worker-handoff-plan.mjs';
import { readMediaRecoveryNormalOrigin } from './temporal-bootstrap-pool.mjs';
import { assertMediaDiskQuotaFresh, observeMediaDiskQuota } from './temporal-media-disk-quota.mjs';
import { observeMediaRecoveryJobTermination } from './temporal-media-recovery-job.mjs';
import { readMediaPromotionRetainedResources } from './temporal-media-promotion-evidence.mjs';
import { verifyMediaPromotionPredecessor } from './temporal-promotion-predecessor.mjs';
import { observeRestoredMediaPhasePool } from './temporal-restored-media-phase-pool.mjs';
import { observeRestoredMediaOriginProtection, observeRestoredMediaPhaseProtection } from './temporal-restored-media-protection.mjs';
import {readRestoredMediaRecoveryPlan} from './temporal-restored-media-registration.mjs';
import {scanRestoredMediaInventory} from './temporal-restored-media-inventory.mjs';
import {readRestoredMediaActivationPool} from './temporal-restored-media-resources.mjs';
import {assertRestoredMediaActivationAuthority,readRestoredMediaActivationAccess} from './temporal-media-restored-origin.mjs';
import {scanPrivateMediaInventory} from './temporal-media-private-inventory.mjs';
import {observeMediaRecoveryProtection} from './temporal-media-recovery-protection.mjs';
import {observeMediaRecoveryDiagnosticZeroPool,assertMediaZeroPoolSampleFresh,mediaDiagnosticNeverStartedProof} from './temporal-media-stop-confirmation.mjs';
import {waitForMediaDiagnosticDrain,assertFreshMediaDiagnosticDrain,observeMediaDiagnosticNeverStarted,observeMediaDiagnosticStopEvents} from './temporal-media-diagnostic-drain.mjs';
import {assertMediaRecoveryAuthority} from './temporal-media-recovery-checkpoint.mjs';
import {nativeSnapshotProof,proofDigest as recoveryHash} from './temporal-release-runtime.mjs';
import {startMediaRecoveryWorkflow,observeMediaRecoveryStartedPool} from './temporal-media-recovery-start.mjs';
import {independentPromotionRoles,denyUnprovedMediaPromotion} from './temporal-promotion-roles.mjs';
import {loadNativeReleaseApplication} from './temporal-native-application.mjs';
import {promoteCloudRunControls,promoteCloudRunSearch,promoteCloudRunEmail,promoteCloudRunImages,promoteCloudRunMedia} from './temporal-promote-controls.mjs';
import { observeBootstrapProtection, observeBootstrapRegistration, observeControlsPromotionBefore, observeControlsPromotionAfter,observeSearchPromotionBefore,observeSearchPromotionAfter,observeEmailPromotionBefore,observeEmailPromotionAfter,observeImagesPromotionBefore,observeImagesPromotionAfter } from './temporal-bootstrap-observations.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createImageReplayObserver,createMediaRecoveryImageReplayObserver,assertMediaRecoveryImageReplayReceipt } from './temporal-image-replay.mjs';
import { isAbsolute, join } from 'node:path';
import { realpath, open, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { firebaseResourceEnvironment, validateConfig } from './temporal-platform.mjs';
import { serverlessComputeArguments } from './temporal-serverless-platform.mjs';
import { readCloudRunWorkerStart, readMediaBootstrapCloudOrigin, readMediaRecoveryCloudOrigin, readMediaRecoveryJobOrigins, readCloudRunWorkerSystemEvents } from './temporal-cloud-run-worker-start.mjs';
import { readCloudRunWorkerScaleAudit } from './temporal-cloud-run-worker-scale-audit.mjs';
import { proveWorkerWake } from './temporal-worker-wake-proof.mjs';
import { readCloudRunWorkerCount } from './temporal-cloud-run-worker-count.mjs';
import { assertTraditionalWorkerDrain, observeTraditionalWorkerHandoff } from './temporal-traditional-worker-handoff.mjs';
import { retireTraditionalWorkersUnderRelease } from './temporal-retire-traditional-workers.mjs';
import { handoffOrchestration, readOrchestrationProtectedHistory } from './temporal-orchestration-handoff.mjs';
import { validateCompletedRolePromotionReceipt } from './temporal-promotion-receipt.mjs';
import { readOrchestrationHandoffAuthority, readOrchestrationHandoffReceipt, saveOrchestrationHandoffCheckpoint } from './temporal-retirement-checkpoint.mjs';
import { readComputeAttachmentAuthority, saveComputeAttachmentCheckpoint } from './temporal-retirement-checkpoint.mjs';
import { readWorkerWakeAuthority, saveWorkerWakeCheckpoint } from './temporal-retirement-checkpoint.mjs';
import { verifyWorkerWake } from './temporal-verify-worker-wake.mjs';
import { observeTraditionalKubernetes } from './temporal-traditional-kubernetes.mjs';
import { attachWorkerCompute } from './temporal-attach-worker-compute.mjs';
import { observeNamespaceComputeIsolation, observeNamespaceWorkerCompute } from './temporal-compute-isolation.mjs';
import { dispatchResourceNames } from './temporal-serverless-dispatch-resources.mjs';


const roles = ['orchestration', 'controls', 'media', 'email', 'images', 'search'];
const fail = () => { throw new Error('INVALID_CLOUD_RUN_RELEASE_PLATFORM'); };
/** Hosting-specific descriptor; no Kubernetes identity is invented or borrowed. */
export function validateCloudRunReleasePlatform(platform, peer) {
  const fields = ['schemaVersion', 'environment', 'workerHosting', 'connectionMode', 'firebaseProjectId',
    'firebaseResources', 'temporalNamespace', 'cloudAccountId', 'cloudProvider', 'cloudRegion', 'cloudAddress',
    'cloudReplicaRegions', 'cloudEvidence', 'workerBuildId', 'workerImage', 'workerRoles', 'roleBindings',
    'operatorApiKeyFile', 'operatorApiKeySHA256', 'dispatcherEnabled', 'dispatch'];
  if (!platform || Object.keys(platform).some(key => !fields.includes(key)) || platform.schemaVersion !== 1 ||
    platform.environment !== 'staging' || platform.workerHosting !== 'cloud-run' ||
    platform.connectionMode !== 'temporal-cloud' || platform.firebaseProjectId !== 'urm-app-staging' ||
    platform.temporalNamespace !== 'urm-app-staging.qwejt' || platform.cloudAccountId !== 'qwejt' ||
    platform.cloudProvider !== 'gcp' || platform.cloudRegion !== 'us-central1' ||
    !['us-central1.gcp.api.temporal.io:7233', 'urm-app-staging.qwejt.tmprl.cloud:7233'].includes(platform.cloudAddress) ||
    !Array.isArray(platform.cloudReplicaRegions) || platform.cloudReplicaRegions.length ||
    !/^[a-f0-9]{40}$/.test(platform.workerBuildId) ||
    !/^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(platform.workerImage) ||
    !/^[a-f0-9]{64}$/.test(platform.operatorApiKeySHA256) || platform.dispatcherEnabled !== false || !Array.isArray(platform.workerRoles) ||
    !platform.workerRoles.includes('orchestration') || !platform.workerRoles.includes('controls') ||
    new Set(platform.workerRoles).size !== platform.workerRoles.length || platform.workerRoles.some(role => !roles.includes(role)) ||
    !Array.isArray(platform.roleBindings) || platform.roleBindings.length !== platform.workerRoles.length) fail();
  for (const field of ['operatorApiKeyFile', 'cloudEvidence'])
    if (typeof platform[field] !== 'string' || !isAbsolute(platform[field]) || /REQUIRED|PLACEHOLDER|EXAMPLE|[\r\n\0]/.test(platform[field])) fail();
  firebaseResourceEnvironment(platform);
  const seen = new Set();
  for (const binding of platform.roleBindings) {
    serverlessComputeArguments(binding);
    if (binding.buildId !== platform.workerBuildId || binding.image !== platform.workerImage ||
      !platform.workerRoles.includes(binding.role) || seen.has(binding.role)) fail();
    seen.add(binding.role);
  }
  const names = dispatchResourceNames(platform.workerBuildId);
  if (!platform.dispatch || Object.keys(platform.dispatch).sort().join(',') !== [...Object.keys(names), 'apiKeyVersion'].sort().join(',') ||
    typeof platform.dispatch.apiKeyVersion !== 'string' || !/^[1-9][0-9]{0,18}$/.test(platform.dispatch.apiKeyVersion) ||
    Object.entries(names).some(([key, value]) => platform.dispatch[key] !== value)) fail();
  if (peer !== undefined) {
    if (peer.environment !== 'production' || peer.firebaseProjectId !== 'urm-app' ||
      peer.temporalNamespace === platform.temporalNamespace) fail();
    firebaseResourceEnvironment(peer);
  }
  return platform;
}
export function validateReleasePlatformConfig(platform, peer) {
  return platform.workerHosting === 'cloud-run'
    ? validateCloudRunReleasePlatform(platform, peer)
    : validateConfig(platform, peer);
}
export async function readCloudRunOperatorKey(path, expectedSHA256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSHA256) || !isAbsolute(path) || await realpath(path) !== path) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0 ||
      (file.mode & 0o400) === 0 || file.size < 1 || file.size > 16384) fail();
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== file.size || bytesRead > 16384) fail();
    const key = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (!/^[\x21-\x7e]{1,16384}$/.test(key) || createHash('sha256').update(key).digest('hex') !== expectedSHA256) fail();
    return key;
  } finally { await handle.close(); }
}
/** Load current verified TS source, not a possibly stale untracked lib/ build.
 * CI typechecking and the immutable release/source/image guards remain mandatory.
 * The compiler/SDK come from the frozen runtime's pinned dependency installation. */
async function withNativeCloudRunClient({ binding, config, platform, firestore }, observe, purpose) {
  validateCloudRunReleasePlatform(platform);
  if (['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST',
    'FIREBASE_STORAGE_EMULATOR_HOST'].some(name => process.env[name]))
    throw new Error('CLOUD_RUN_RELEASE_REFUSES_EMULATOR_TRANSPORT');
  const key = await readCloudRunOperatorKey(platform.operatorApiKeyFile, platform.operatorApiKeySHA256);
  const { loadVerifiedRuntimeApplication } = await import('./temporal-release-runtime.mjs');
  const application = await loadVerifiedRuntimeApplication(binding, config, firestore, () => {
    return loadNativeReleaseApplication(binding.runtimeRoot);
  });
  let connection;
  try {
    connection = await application.Connection.connect({ address: platform.cloudAddress, tls: true, apiKey: key,
      connectTimeout: 15000,...nativePromotionConnectionOptions(purpose) });
    const client = new application.Client({ connection, namespace: platform.temporalNamespace });
    return await observe(client, application);

  } finally { await connection?.close(); }
}

/** A worker can run the candidate image on a replacement pool. Readiness
 * requires the same provider identities already bound by the managed handoff. */
export function assertCloudRunReadinessHandoff(proof, platform, pools) {
  const fail = () => {
    throw new Error('CLOUD_RUN_READINESS_HANDOFF_MISMATCH');
  };
  if (
    proof?.schemaVersion !== 1 ||
    proof.scope !== 'observed-role-execution-and-native-poller-identity' ||
    !Array.isArray(proof.roles) ||
    proof.roles.length !== platform.roleBindings.length
  )
    fail();
  const observations = new Map(proof.roles.map((entry) => [entry?.role, entry]));
  if (observations.size !== platform.roleBindings.length) fail();
  for (const binding of platform.roleBindings) {
    const expected = pools?.[binding.role];
    const observed = observations.get(binding.role);
    if (
      !expected ||
      !observed ||
      observed.poolUid !== expected.poolUid ||
      observed.revision !== expected.revision ||
      observed.revisionUid !== expected.revisionUid ||
      observed.declaredImage !== binding.image
    )
      fail();
  }
}

/** Re-read every provider resource after the other readiness observations have
 * finished. An unchanged revision name and immutable image do not detect a
 * pool scaling, configuration or lifecycle transition after role execution.
 */
export async function verifyCurrentCloudRunReadinessResources({ proof, platform, pools, api }) {
  assertCloudRunReadinessHandoff(proof, platform, pools);
  const byRole = new Map(proof.roles.map((role) => [role.role, role]));
  const invalid = () => new Error('CLOUD_RUN_READINESS_RESOURCE_CHANGED');
  await Promise.all(platform.roleBindings.map(async (binding) => {
    const expected = byRole.get(binding.role);
    const { revision, poolDigest, revisionDigest } = expected;
    if (
      !/^[a-f0-9]{64}$/.test(poolDigest ?? '') ||
      !/^[a-f0-9]{64}$/.test(revisionDigest ?? '') ||
      !/^[a-z][a-z0-9-]{0,62}(?:\.[1-9][0-9]*)?$/.test(revision ?? '') ||
      !revision.startsWith(binding.poolName)
    )
      throw invalid();
    const parent = `https://run.googleapis.com/v2/projects/${binding.projectId}/locations/${binding.region}/workerPools/${binding.poolName}`;
    const [pool, currentRevision] = await Promise.all([api(parent), api(`${parent}/revisions/${revision}`)]);
    if (recoveryHash(pool) !== poolDigest || recoveryHash(currentRevision) !== revisionDigest) throw invalid();
  }));
}

/** Refresh read-only provider evidence before entering the release transaction.
 * This bounds the observation window across providers without a cross-provider lock. */
export async function prepareCloudRunTransitionFence(readCurrent) {
  const windowMs = 15000;
  const wall = Date.now(), monotonic = performance.now();
  const failFence = () => new Error('CLOUD_RUN_TRANSITION_PROVIDER_EVIDENCE_STALE');
  const assertFresh = () => {
    if (Date.now() < wall || Date.now() - wall >= windowMs || performance.now() - monotonic >= windowMs)
      throw failFence();
  };
  let timer;
  try {
    const live = await Promise.race([
      Promise.resolve().then(readCurrent),
      new Promise((_, reject) => { timer = setTimeout(() => reject(failFence()), windowMs); }),
    ]);
    assertFresh();
    return { live, assertFresh };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectCloudRunReleaseWorkers({
  binding,
  config,
  platform,
  firestore,
  artifactDirectory,
  recordIntent,
  savedIntent,
  operationId,
  bindingDigest,
}) {
  return withNativeCloudRunClient({ binding, config, platform, firestore }, async (client, application) => {
    await application.assertServerlessReadinessArtifactDirectory(artifactDirectory);
    if (savedIntent && !/^[a-f0-9]{64}$/.test(savedIntent.imageWorkflowBundleSHA256 ?? ''))
      throw new Error('CLOUD_RUN_SAVED_BUNDLE_INTENT_INVALID');
    // This digest binds the canonical release configuration, not a new CI attestation.
    const evidenceDigest = createHash('sha256')
      .update(
        JSON.stringify({
          bindingDigest,
          releaseId: config.releaseId,
          image: platform.workerImage,
          scope: 'workers-ready-image-configuration',
        })
      )
      .digest('hex');
    const image = await createImageReplayObserver({
      image: platform.workerImage,
      buildId: platform.workerBuildId,
      operationId,
      bindingDigest,
      evidenceDigest,
      historyToJSON: application.historyToJSON,
    });
    const options = {
      client,
      firestore,
      artifactDirectory,
      imageWorkflowBundleSHA256: image.bundleSHA256,
      bindings: platform.roleBindings.map(
        ({ projectId, region, namespace, role, buildId, poolName, deploymentName, runnerServiceAccount, image }) => ({
          projectId,
          region,
          namespace,
          role,
          buildId,
          poolName,
          deploymentName,
          runnerServiceAccount,
          image,
        })
      ),
    };
    const proof = await (savedIntent
      ? application.reconcileServerlessRoleReadiness({ ...options, savedIntent })
      : application.collectServerlessRoleReadiness({ ...options, onStartIntent: recordIntent }));
    await writeFile(
      join(artifactDirectory, `worker-image-bundle-${randomUUID()}.json`),
      JSON.stringify(image.imageProof),
      { flag: 'wx', mode: 0o600 }
    );
    return proof;
  }, 'worker-readiness-start');
}
/** Internal start seam for an owned wake operation. Source fixes the candidate
 * build and wait window. Persistence and paused handoff authority are supplied
 * by the release controller, never by a descriptor. */
export async function startCloudRunWorkerWake(options, wake) {
  return withNativeCloudRunClient(options, (client, application) => {
    const { config, platform } = options;
    const target = platform.roleBindings.find(({ role }) => role === wake.role);
    const orchestration = platform.roleBindings.find(({ role }) => role === 'orchestration');
    if (config.projectId !== 'urm-app-staging' || !target || !orchestration)
      throw new Error('WORKER_WAKE_START_UNCONFIRMED');
    const input = {
      projectId: config.projectId,
      buildId: platform.workerBuildId,
      role: target.role,
      nonce: wake.nonce,
      delayMs: (Math.max(target.stabilizationSeconds, orchestration.stabilizationSeconds) + 300) * 1000,
    };
    return application.startOrObserveWorkerWake({
      client, input, assertAuthority: wake.assertAuthority, saveAttempt: wake.saveAttempt,
      ...(Object.hasOwn(wake, 'saved') ? { saved: wake.saved } : {}),
    });
  }, 'worker-wake-start');
}

export async function observeCloudRunWorkerWakeRetryWait(options, run) {
  return withNativeCloudRunClient(options, async (client, application) => {
    const { config, platform } = options;
    const input = run.input;
    if (
      config.projectId !== 'urm-app-staging' ||
      input?.buildId !== platform.workerBuildId ||
      !platform.roleBindings.some(({ role }) => input.role === role)
    ) throw new Error('WORKER_WAKE_HISTORY_UNCONFIRMED');
    return client.connection.withDeadline(Date.now() + 10000, async () => {
      const scope = { namespace: platform.temporalNamespace, execution: { workflowId: run.workflowId, runId: run.runId } };
      const described = await client.workflowService.describeWorkflowExecution(scope);
      const history = await client.workflow.getHandle(run.workflowId, run.runId, {
        firstExecutionRunId: run.runId, followRuns: false,
      }).fetchHistory();
      return application.inspectWorkerWakeRetryWait(history, described, run, Date.now());
    });
  });
}

async function observeCloudRunWorkerWakeStatus(options, { workflowId, runId }) {
  return withNativeCloudRunClient(options, async client => {
    const execution = { workflowId, runId };
    const { workflowExecutionInfo: info } = await client.connection.withDeadline(Date.now() + 5000, () =>
      client.workflowService.describeWorkflowExecution({ namespace: options.platform.temporalNamespace, execution }));
    if (info?.execution?.workflowId !== workflowId || info.execution.runId !== runId ||
      info.type?.name !== 'WorkerWakeProbe' || info.taskQueue !== 'urm-orchestration') fail();
    return info.status;
  });
}

/** Read the exact original run without starting or repairing it. A Temporal
 * history observation provides no Cloud Run zero, scale or termination proof. */
export async function observeCloudRunWorkerWakeHistory(options, run) {
  return withNativeCloudRunClient(options, async (client, application) => {
    const { config, platform } = options;
    if (
      config.projectId !== 'urm-app-staging' ||
      run.input?.buildId !== platform.workerBuildId ||
      !platform.roleBindings.some(({ role }) => run.input.role === role) ||
      typeof run.workflowId !== 'string' ||
      run.workflowId !== `worker-wake-${run.input.nonce}` ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(run.runId ?? '')
    ) throw new Error('WORKER_WAKE_HISTORY_UNCONFIRMED');
    const handle = client.workflow.getHandle(run.workflowId, run.runId, {
      firstExecutionRunId: run.runId,
      followRuns: false,
    });
    const history = await client.connection.withDeadline(Date.now() + 10000, () => handle.fetchHistory());
    return application.inspectWorkerWakeHistory(history, run);
  });
}

/** Bind Monitoring's historical points to the immutable candidate revision.
 * This observer returns the actual samples, including a genuinely empty series. */
export async function observeCloudRunWorkerWakeTelemetry(options, expected, window) {
  return withNativeCloudRunClient(options, async (_client, application) => {
    const { config, platform, api } = options;
    const target = platform.roleBindings.find(({ role }) => role === expected.role);
    if (config.projectId !== 'urm-app-staging' || !target)
      throw new Error('CLOUD_RUN_WORKER_COUNT_UNCONFIRMED');
    const {
      projectId, region, namespace, role, buildId, poolName, deploymentName, runnerServiceAccount, image,
    } = target;
    const binding = { projectId, region, namespace, role, buildId, poolName, deploymentName, runnerServiceAccount, image };
    const parent = `projects/${projectId}/locations/${region}/workerPools/${poolName}`;
    const path = `${parent}/revisions/${expected.revision}`;
    if (
      typeof expected.revision !== 'string' ||
      !/^[a-z][a-z0-9-]{0,62}(?:\.[1-9][0-9]*)?$/.test(expected.revision) ||
      !expected.revision.startsWith(poolName)
    ) throw new Error('CLOUD_RUN_WORKER_COUNT_UNCONFIRMED');
    const observePool = async () => {
      const [pool, revision] = await Promise.all([
        api(`https://run.googleapis.com/v2/${parent}`),
        api(`https://run.googleapis.com/v2/${path}`),
      ]);
      const state = application.verifyServerlessPool(binding, pool, revision);
      if (
        state.poolUid !== expected.poolUid ||
        state.revision !== expected.revision ||
        state.revisionUid !== expected.revisionUid
      ) throw new Error('CLOUD_RUN_WORKER_COUNT_UNCONFIRMED');
      return state;
    };
    const first = await observePool();
    const query = { api, pool: poolName, revision: first.revision, from: window.from, to: window.to };
    const [samples, start] = await Promise.all([
      readCloudRunWorkerCount(query),
      readCloudRunWorkerStart({
        ...query, revisionUid: first.revisionUid, buildId, taskQueue: target.taskQueue,
        workerIdentity: expected.workerIdentity,
      }),
    ]);
    const last = await observePool();
    if (recoveryHash(first) !== recoveryHash(last)) throw new Error('CLOUD_RUN_WORKER_COUNT_UNCONFIRMED');
    return { role, ...last, window: { from: window.from, to: window.to }, samples, start };
  });
}

/** Read-only wake/drain join for the exact saved run and candidate pool bindings.
 * The release controller must still hold authority from the original fenced handoff. */
export async function collectCloudRunWorkerWakeCycle(options, { run, retryWait, pools, from, to }) {
  const history = await observeCloudRunWorkerWakeHistory(options, run);
  const { timer, retry } = history;
  if (
    retryWait?.workflowId !== history.workflowId || retryWait.runId !== history.runId ||
    retryWait.role !== history.role || retryWait.scheduledEventId !== retry.scheduledEventId ||
    retryWait.worker !== retry.before ||
    ![retryWait.failedAt, retryWait.observedAt, retryWait.eligibleAt].every(Number.isFinite) ||
    retryWait.failedAt < retry.scheduledAt ||
    retryWait.observedAt < retryWait.failedAt || retryWait.eligibleAt <= retryWait.observedAt ||
    retryWait.eligibleAt >= retry.startedAt || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) ||
    from >= timer.startedAt || to <= retry.completedAt
  ) throw new Error('CLOUD_RUN_WORKER_WAKE_UNCONFIRMED');

  const sharedPool = history.role === 'orchestration';
  const collect = async (phase, role, event, before, after, beforeEnd, end) => {
    const binding = options.platform.roleBindings.find(item => item.role === role);
    const pinned = pools[role];
    if (!binding || !pinned) throw new Error('CLOUD_RUN_WORKER_WAKE_UNCONFIRMED');
    const expected = { ...pinned, role, image: binding.image, maxInstances: binding.maxInstances };
    const scope = { api: options.api, pool: binding.poolName, from };
    const [telemetry, audit, beforeStart] = await Promise.all([
      observeCloudRunWorkerWakeTelemetry(options, { ...expected, workerIdentity: event.workerIdentity }, { from, to: end }),
      readCloudRunWorkerScaleAudit({
        ...scope, invoker: binding.invokerServiceAccount, allowedDelegates: temporalCloudScalerPrincipals, to: end,
      }),
      readCloudRunWorkerStart({
        ...scope, revision: pinned.revision, revisionUid: pinned.revisionUid,
        buildId: binding.buildId, taskQueue: binding.taskQueue, workerIdentity: before, to: Math.floor(beforeEnd),
      }),
    ]);
    return proveWorkerWake({
      phase, event, expected, telemetry, audit, beforeInstance: beforeStart?.instanceId,
      after, zeroAfter: Math.floor(after) + 1,
    });
  };
  const [timerWake, retryWake] = await Promise.all([
    collect('timer', 'orchestration', {
      eligibleAt: timer.eligibleAt, startedAt: timer.taskStartedAt, workerIdentity: timer.after,
    }, timer.before, timer.taskCompletedAt, timer.startedAt,
    sharedPool ? Math.floor(retryWait.eligibleAt) - 1 : to),
    collect('retry', history.role, {
      eligibleAt: retryWait.eligibleAt, startedAt: retry.startedAt, workerIdentity: retry.after,
    }, retry.before, retry.completedAt, retryWait.failedAt, to),
  ]);
  return { schemaVersion: 1, workflowId: run.workflowId, runId: run.runId, timer: timerWake, retry: retryWake };
}

export async function observeCloudRunTraditionalRetirementInventory(options) {
  return withNativeCloudRunClient(options, client => observeTraditionalWorkerHandoff(client));
}

async function readCloudRunHandoffCandidate(api, application, target, expected, latestStart, managed = false) {
  const { projectId, region, namespace, role, buildId, poolName, deploymentName, runnerServiceAccount, image, taskQueue } = target;
  const binding = { projectId, region, namespace, role, buildId, poolName, deploymentName, runnerServiceAccount, image };
  if (!/^[a-z][a-z0-9-]{0,62}(?:\.[1-9][0-9]*)?$/.test(expected?.revision ?? '') ||
    !expected.revision.startsWith(poolName) || !Number.isSafeInteger(expected.startedAt) || expected.startedAt <= 1000 ||
    expected.startedAt > latestStart) fail();
  const parent = `projects/${projectId}/locations/${region}/workerPools/${poolName}`;
  const read = async () => {
    const [pool, revision] = await Promise.all([
      api(`https://run.googleapis.com/v2/${parent}`),
      api(`https://run.googleapis.com/v2/${parent}/revisions/${expected.revision}`),
    ]);
    const state = application.verifyServerlessPool(binding, pool, revision);
    const count = pool.scaling?.manualInstanceCount;
    if (state.poolUid !== expected.poolUid || state.revision !== expected.revision ||
      state.revisionUid !== expected.revisionUid ||
      (managed
        ? (count !== undefined && (!Number.isSafeInteger(count) || count < 0 || count > target.maxInstances))
        : count !== 1)) fail();
    return state;
  };
  const first = await read();
  const startup = await readCloudRunWorkerStart({
    api, pool: poolName, revision: first.revision, revisionUid: first.revisionUid, buildId, taskQueue,
    workerIdentity: expected.workerIdentity, from: expected.startedAt - 1000,
    to: Math.min(Date.now(), expected.startedAt + 1000),
  });
  if (startup?.at !== expected.startedAt || startup.instanceId !== expected.instanceId ||
    recoveryHash(await read()) !== recoveryHash(first)) fail();
  return { binding: first, startup, candidate: {
    queue: taskQueue, identity: startup.workerIdentity, buildId, deploymentName,
  } };
}

/** Shared-deployment routing action. All independent role receipts are
 * required, including the separately gated media role. */
export async function runCloudRunOrchestrationHandoff(options, operation) {
  const { platform, api, config, firestore } = options;
  const { receipts, evidenceDigest, pools } = operation;
  if (typeof api !== 'function' || !pools || Object.keys(pools).sort().join(',') !== [...roles].sort().join(',') ||
    roles.some(role => !platform.workerRoles.includes(role)) ||
    [operation.markPending, operation.updateOwnedOperation].some(fn => typeof fn !== 'function')) fail();
  const releaseId = config.releaseId;
  const readPeerReceipts = () => Promise.all(independentPromotionRoles.map(async role => {
    const id = receipts?.[`${role}Promotion`]?.operationId;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id ?? '')) fail();
    const prefix = `temporalCloud${role[0].toUpperCase() + role.slice(1)}Promotion`;
    const snapshot = await firestore.doc(`_control/${prefix}-${id}`).get();
    if (!snapshot.exists || !snapshot.createTime?.isEqual(snapshot.updateTime)) fail();
    const receipt = snapshot.data();
    if (receipt?.operationId !== id) fail();
    const completed = validateCompletedRolePromotionReceipt({ receipt, platform, releaseId, evidenceDigest, role });
    assertWorkerHandoffPromotion(role, completed, pools[role]);
    return recoveryHash(receipt);
  }));
  const peerReceipts = await readPeerReceipts();
  return withNativeCloudRunClient(options, async (client, application) => {
    const repository = { ...operation, firestore, config };
    const initial = await readOrchestrationHandoffAuthority(repository, saved => { if (saved) operation.markPending(true); });
    const imageReplay = await createImageReplayObserver({ image: platform.workerImage, buildId: platform.workerBuildId,
      operationId: operation.operationId, bindingDigest: operation.bindingDigest, evidenceDigest,
      historyToJSON: application.historyToJSON });
    const replayed = new Set();
    const capture = async phase => {
      const [workers, inventory, , peers] = await Promise.all([
        Promise.all(platform.roleBindings.map(target => readCloudRunHandoffCandidate(
          api, application, target, pools[target.role], Date.now()
        ))),
        observeTraditionalWorkerHandoff(client),
        observeNamespaceComputeIsolation(client, platform.temporalNamespace),
        readPeerReceipts(),
      ]);
      if (recoveryHash(peers) !== recoveryHash(peerReceipts)) fail();
      const bindings = new Map(workers.map(row => [row.candidate.queue, row.candidate]));
      const matches = (version, candidate) => version?.deploymentName === candidate.deploymentName &&
        version.buildId === candidate.buildId;
      const observed = new Set();
      for (const row of inventory.queueInventory) {
        const candidate = bindings.get(row.name);
        if (!candidate || (row.type !== 2 && row.name !== 'urm-orchestration')) continue;
        const shared = row.name === 'urm-orchestration';
        const current = phase === 'before' && shared
          ? { deploymentName: candidate.deploymentName, buildId: operation.previousBuildId } : candidate;
        if (row.ramping || row.rampPercentage !== 0 || !matches(row.current, current)) fail();
        if (row.pollers.some(poller => matches(poller.worker, candidate) && poller.identity === candidate.identity))
          observed.add(`${row.name}/${row.type}`);
      }
      for (const queue of bindings.keys()) if (!observed.has(`${queue}/2`) ||
        (queue === 'urm-orchestration' && !observed.has(`${queue}/1`))) fail();
      if (inventory.standaloneActivities || inventory.standaloneNexus) fail();
      const histories = [];
      if (phase === 'before') {
        for (const run of inventory.running) {
          if (run.pendingActivities.length || run.pendingChildren || run.pendingNexus || run.pendingWorkflowTask ||
            !run.latestWorker || !inventory.versions.some(v => v.buildId === run.latestWorker.buildId) ||
            run.latestWorker.deploymentName !== bindings.get('urm-orchestration').deploymentName) fail();
          const history = await readOrchestrationProtectedHistory(client, run);
          const historySHA256 = recoveryHash(history);
          const key = recoveryHash([run.runId, historySHA256]);
          if (!replayed.has(key)) {
            const proof = await imageReplay.replayHistory(history, run.workflowId, run.runId);
            assertImageReplayReceipt(proof, { image: platform.workerImage, buildId: platform.workerBuildId,
              operationId: operation.operationId, bindingDigest: operation.bindingDigest, evidenceDigest,
              bundleSHA256: imageReplay.bundleSHA256, workflowId: run.workflowId, runId: run.runId, historySHA256,
              imageId: imageReplay.imageProof.imageId, platform: imageReplay.imageProof.platform });
            replayed.add(key);
          }
          histories.push(key);
        }
        const again = await observeTraditionalWorkerHandoff(client);
        if (again.digest !== inventory.digest) fail();
        // The replay ran on the earlier complete history. Re-read the exact
        // native histories so elapsed time and a live timer cannot stand in
        // for a fresh proof of the same history head.
        for (let i = 0; i < again.running.length; i++) {
          const run = again.running[i];
          const history = await readOrchestrationProtectedHistory(client, run);
          if (histories[i] !== recoveryHash([run.runId, recoveryHash(history)])) fail();
        }
        return { preHandoffInventory: again, observedAt: Date.now(),
          immutableSHA256: recoveryHash({ workers, peerReceipts, bundleSHA256: imageReplay.bundleSHA256 }),
          protectedWorkSHA256: recoveryHash(histories) };
      }
      return { observedAt: inventory.observedAt,
        immutableSHA256: recoveryHash({ workers, peerReceipts, bundleSHA256: imageReplay.bundleSHA256 }),
        protectedWorkSHA256: recoveryHash(inventory.running) };
    };
    const result = await handoffOrchestration({ ...operation, client, buildId: platform.workerBuildId, image: platform.workerImage,
      releaseId, capture, saved: initial.saved,
      authorizeMutation: async () => {
        const again = await readOrchestrationHandoffAuthority(repository);
        if (again.workSHA256 !== initial.workSHA256) fail();
      },
      save: async next => {
        operation.markPending(true);
        repository.ownedOperation = await saveOrchestrationHandoffCheckpoint({ ...repository, next });
        operation.updateOwnedOperation(repository.ownedOperation);
      } });
    operation.markPending(false);
    return result;
  }, 'orchestration-handoff');
}

/** Protected release operation. The dispatcher lease guard is read from
 * Firestore and never supplied by a descriptor or an operator assertion. */
export async function runCloudRunTraditionalRetirement(options, operation) {
  const { platform, api, firestore, config } = options;
  const { pools, authority } = operation;
  if (typeof api !== 'function' || !pools || Object.keys(pools).sort().join(',') !== [...roles].sort().join(',') ||
    roles.some(role => !platform.workerRoles.includes(role))) fail();
  const { handoffAt, preHandoffInventory, plan } = await readOrchestrationHandoffReceipt(firestore, config, platform, operation.handoffPlanSHA256);
  if (!authority.builds.includes(plan.previousBuildId)) fail();
  return withNativeCloudRunClient(options, (client, application) => {
    return retireTraditionalWorkersUnderRelease({
      ...operation,
      firestore, config,
      observeNative: async (phase, before) => {
        if (recoveryHash(before.builds) !== recoveryHash([...authority.builds].sort())) fail();
        const [workers, inventory, compute] = await Promise.all([
          Promise.all(platform.roleBindings.map(target => readCloudRunHandoffCandidate(api, application, target, pools[target.role], handoffAt))),
          observeTraditionalWorkerHandoff(client),
          observeNamespaceComputeIsolation(client, platform.temporalNamespace),
        ]);
        const checked = assertTraditionalWorkerDrain(inventory, {
          builds: before.builds, handoffAt, preHandoffInventory,
          candidates: workers.map(row => row.candidate), requireRetired: phase === 'retired',
        });
        return {
          temporalSHA256: checked.digest,
          protectionSHA256: recoveryHash({ workers, compute: compute.inventorySHA256, handoffAt, preHandoffInventory }),
          observedAt: Math.min(checked.observedAt, Date.parse(compute.observedAt)),
        };
      },
    });
  });
}

async function observeManagedHandoffPollers({ api, platform, handoffAt, inventory, poolsAndStarts, managed }) {
  return Promise.all(poolsAndStarts.map(async row => {
    const { candidate } = row;
    const role = candidate.queue.slice(4);
    if (!managed.has(role)) return candidate;
    const b = platform.roleBindings.find(binding => binding.role === role);
    const identities = [...new Set(inventory.queueInventory.filter(q => q.name === candidate.queue)
      .flatMap(q => q.pollers.filter(poller => poller.worker?.deploymentName === candidate.deploymentName &&
        poller.worker.buildId === candidate.buildId).map(poller => poller.identity)))];
    if (identities.length > 8) fail();
    const to = Date.now();
    await Promise.all(identities.filter(id => id !== candidate.identity).map(async workerIdentity => {
      const found = await readCloudRunWorkerStart({
        api, pool: b.poolName, revision: row.binding.revision, revisionUid: row.binding.revisionUid,
        buildId: b.buildId, taskQueue: b.taskQueue, workerIdentity,
        from: Math.max(handoffAt, to - 8 * 60 * 60 * 1000), to,
      });
      if (!found) fail();
    }));
    return { ...candidate, managed: true, identities };
  }));
}

export async function attachCloudRunWorkerCompute(options, operation) {
  return withNativeCloudRunClient(options, async (client, application) => {
    const { platform, firestore, config, api } = options;
    const { role, authority, transport, pools, markPending, updateOwnedOperation } = operation;
    const target = platform.roleBindings.find(row => row.role === role);
    if (!target || typeof api !== 'function' || !pools || Object.keys(pools).sort().join(',') !== [...roles].sort().join(',') ||
      [markPending, updateOwnedOperation].some(fn => typeof fn !== 'function')) fail();
    const repository = { ...operation, firestore, config, platform };
    const initial = await readComputeAttachmentAuthority(repository, saved => { if (saved) markPending(true); });
    const { attachedRoles } = initial;
    const handoff = await readOrchestrationHandoffReceipt(firestore, config, platform, operation.handoffPlanSHA256);
    if (!authority.builds.includes(handoff.plan.previousBuildId)) fail();
    const attached = platform.roleBindings.filter(({ role }) => attachedRoles.includes(role)).sort((a, b) => a.role.localeCompare(b.role));
    const authorize = async () => {
      const current = await readComputeAttachmentAuthority(repository);
      if (current.protectionSHA256 !== initial.protectionSHA256) fail();
    };
    const result = await attachWorkerCompute({
      ...operation,
      binding: target,
      client,
      releaseId: config.releaseId,
      saved: initial.saved,
      authorize,
      save: async next => {
        markPending(true);
        repository.ownedOperation = await saveComputeAttachmentCheckpoint({ ...repository, next });
        updateOwnedOperation(repository.ownedOperation);
      },
      observeProtection: async expectedCompute => {
        const managed = new Set([...attachedRoles, ...(expectedCompute === 'exact' ? [role] : [])]);
        const [inventory, cluster, compute, scalerPolicy, poolsAndStarts] = await Promise.all([
          observeTraditionalWorkerHandoff(client),
          observeTraditionalKubernetes(transport.read, authority),
          observeNamespaceWorkerCompute(client, platform.temporalNamespace, { attached, target }),
          verifyCloudRunScalerPolicies(platform, api, [role]),
          Promise.all(platform.roleBindings.map(b => readCloudRunHandoffCandidate(
            api, application, b, pools[b.role], handoff.handoffAt, managed.has(b.role)
          ))),
        ]);
        if (compute.target !== expectedCompute || cluster.digest !== initial.retiredSHA256 || cluster.pods.length ||
          cluster.deployments.some(row => row.desired !== 0)) fail();
        const workers = await observeManagedHandoffPollers({ api, platform, handoffAt: handoff.handoffAt,
          inventory, poolsAndStarts, managed });
        const checked = assertTraditionalWorkerDrain(inventory, {
          builds: authority.builds, handoffAt: handoff.handoffAt, preHandoffInventory: handoff.preHandoffInventory,
          candidates: workers, requireRetired: true,
        });
        return {
          observedAt: Math.min(checked.observedAt, cluster.observedAt, compute.observedAt, Date.parse(scalerPolicy.observedAt)),
          protectionSHA256: recoveryHash({ release: initial.protectionSHA256, handoff, pools, policies: scalerPolicy.roles }),
        };
      },
    });
    markPending(false);
    return result;
  }, 'worker-compute-attach');
}

/** Reobserve the retired fleet and attached compute on the pinned candidate. */
export function verifyManagedWorkerHandoff(options, { authority, transport, pools, retiredSHA256, handoff }) {
  const { platform, api } = options;
  if (!authority.builds.includes(handoff.plan.previousBuildId)) fail();
  return withNativeCloudRunClient(options, async (client, application) => {
    const target = platform.roleBindings.find(binding => binding.role === 'orchestration');
    const attached = platform.roleBindings.filter(binding => binding !== target);
    const [cluster, compute, inventory, poolsAndStarts] = await Promise.all([
      observeTraditionalKubernetes(transport.read, authority),
      observeNamespaceWorkerCompute(client, platform.temporalNamespace, { attached, target }),
      observeTraditionalWorkerHandoff(client),
      Promise.all(platform.roleBindings.map(binding => readCloudRunHandoffCandidate(
        api, application, binding, pools[binding.role], handoff.handoffAt, true
      ))),
    ]);
    if (cluster.digest !== retiredSHA256 || cluster.pods.length ||
      cluster.deployments.some(row => row.desired !== 0) || compute.target !== 'exact') fail();
    const workers = await observeManagedHandoffPollers({
      api, platform, handoffAt: handoff.handoffAt, inventory, poolsAndStarts, managed: new Set(roles),
    });
    assertTraditionalWorkerDrain(inventory, { builds: authority.builds, handoffAt: handoff.handoffAt,
      preHandoffInventory: handoff.preHandoffInventory, candidates: workers, requireRetired: true });
  });
}

export async function runCloudRunWorkerWake(options, operation) {
  const { platform, firestore, config, api } = options;
  const { authority, transport, pools, role, markPending, updateOwnedOperation } = operation;
  if (!platform.roleBindings.some(row => row.role === role) || typeof api !== 'function' ||
    typeof transport?.read !== 'function' || !pools || Object.keys(pools).sort().join(',') !== [...roles].sort().join(',') ||
    [markPending, updateOwnedOperation].some(fn => typeof fn !== 'function')) fail();
  const repository = { ...operation, firestore, config, platform };
  const initial = await readWorkerWakeAuthority(repository, saved => { if (saved) markPending(true); });
  const handoff = await readOrchestrationHandoffReceipt(firestore, config, platform, operation.handoffPlanSHA256);
  const assertAuthority = async () => {
    const current = await readWorkerWakeAuthority(repository);
    if (current.protectionSHA256 !== initial.protectionSHA256) fail();
  };
  const verifyFleet = () => verifyManagedWorkerHandoff(options, {
    authority, transport, pools, retiredSHA256: initial.retiredSHA256, handoff,
  });
  const result = await verifyWorkerWake({
    ...operation, role, releaseId: config.releaseId, buildId: platform.workerBuildId,
    protectionSHA256: initial.protectionSHA256, saved: initial.saved, assertAuthority,
    beforeStart: verifyFleet,
    save: async next => {
      markPending(true);
      repository.ownedOperation = await saveWorkerWakeCheckpoint({ ...repository, next });
      updateOwnedOperation(repository.ownedOperation);
    },
    start: wake => startCloudRunWorkerWake(options, wake),
    status: run => observeCloudRunWorkerWakeStatus(options, run),
    observeRetry: run => observeCloudRunWorkerWakeRetryWait(options, run),
    collect: async evidence => {
      const proof = await collectCloudRunWorkerWakeCycle(options, { ...evidence, pools });
      await verifyFleet();
      return proof;
    },
  });
  markPending(false);
  return result;
}

export async function verifyCloudRunComputeIsolation(options) {
  return withNativeCloudRunClient(options, client =>
    observeNamespaceComputeIsolation(client, options.platform.temporalNamespace));
}

export async function readCloudRunNamespaceEvidence(platform) {
  let handle;
  try {
    handle = await open(platform.cloudEvidence, constants.O_RDONLY | constants.O_NOFOLLOW);
    const file = await handle.stat();
    if (!file.isFile() || file.size < 1 || file.size > 1024 * 1024) fail();
    const buffer = Buffer.alloc(file.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== file.size) fail();
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { throw new Error('CLOUD_RUN_NAMESPACE_EVIDENCE_UNCONFIRMED'); }
  finally { await handle?.close(); }
}


// Native authenticated Temporal Cloud Access template, account qwejt, 2026-10-20.
// These are Temporal-owned impersonators, not application production identities.
// Changes require a new native template observation and reviewed source update.
export const temporalCloudScalerPrincipals = Object.freeze([
  'serviceAccount:serverless-qwejt@prod-vs4padk9dkczcey6d6st9c58e.iam.gserviceaccount.com',
  'serviceAccount:serverless-qwejt@prod-sbe56h6wr4sykaw47a6yg4h66.iam.gserviceaccount.com',
  'serviceAccount:serverless-qwejt@prod-97gr6tp6zkv2t4epubffpz7kt.iam.gserviceaccount.com',
  'serviceAccount:serverless-qwejt@prod-c4cqaqgbfzy23vpzkbxzrx378.iam.gserviceaccount.com',
  'serviceAccount:serverless-qwejt@prod-79z2c6d76au6g5fcq768buqf9.iam.gserviceaccount.com',
]);

/** Mandatory read-only direct-policy gate before native worker probes.
 * api is the guarded operator's authenticated Google API transport, never descriptor input.
 * This does not claim inherited-policy isolation or effective runtime data access.
 * Actual scale/wake and native runtime access checks remain separate release gates.
 */
export async function verifyCloudRunScalerPolicies(platform, api, selectedRoles) {
  validateCloudRunReleasePlatform(platform);
  selectedRoles ??= platform.workerRoles;
  if (!Array.isArray(selectedRoles) || !selectedRoles.length || new Set(selectedRoles).size !== selectedRoles.length || selectedRoles.some(role => !platform.workerRoles?.includes(role))) throw new Error('CLOUD_RUN_SCALER_POLICY_UNCONFIRMED');
  validateCloudRunReleasePlatform(platform);
  if (typeof api !== 'function') throw new Error('CLOUD_RUN_SCALER_POLICY_UNCONFIRMED');
  const receipts = [];
  const identities = new Set();
  try {
    for (const binding of platform.roleBindings.filter(binding => selectedRoles.includes(binding.role))) {
      const runner = `serviceAccount:${binding.runnerServiceAccount}`;
      const scaler = `serviceAccount:${binding.invokerServiceAccount}`;
      const observed = {};
      for (const [kind, email] of [
        ['runner', binding.runnerServiceAccount],
        ['scaler', binding.invokerServiceAccount],
      ]) {
        const resource = `projects/urm-app-staging/serviceAccounts/${email}`;
        const account = await api(`https://iam.googleapis.com/v1/${resource}`);
        if (
          account.email !== email ||
          account.projectId !== 'urm-app-staging' ||
          account.disabled === true ||
          !/^[0-9]{10,30}$/.test(account.uniqueId ?? '') ||
          identities.has(account.uniqueId)
        )
          throw new Error('invalid account');
        identities.add(account.uniqueId);
        observed[kind] = { email, uniqueId: account.uniqueId };
      }
      const scalerResource = `projects/urm-app-staging/serviceAccounts/${binding.invokerServiceAccount}`;
      const runnerResource = `projects/urm-app-staging/serviceAccounts/${binding.runnerServiceAccount}`;
      const pool = `projects/urm-app-staging/locations/us-central1/workerPools/${binding.poolName}`;
      const policies = [
        [
          await api(
            `https://iam.googleapis.com/v1/${scalerResource}:getIamPolicy?options.requestedPolicyVersion=3`,
            'POST'
          ),
          [{ role: 'roles/iam.serviceAccountTokenCreator', members: temporalCloudScalerPrincipals }],
        ],
        [
          await api(
            `https://iam.googleapis.com/v1/${runnerResource}:getIamPolicy?options.requestedPolicyVersion=3`,
            'POST'
          ),
          [{ role: 'roles/iam.serviceAccountUser', members: [scaler] }],
        ],
        [
          await api(`https://run.googleapis.com/v2/${pool}:getIamPolicy?options.requestedPolicyVersion=3`),
          [
            { role: 'roles/run.viewer', members: [runner] },
            { role: 'roles/run.developer', members: [scaler] },
          ],
        ],
      ];
      for (const [policy, expected] of policies) {
        if (
          !policy ||
          typeof policy.etag !== 'string' ||
          !policy.etag ||
          !Array.isArray(policy.bindings) ||
          policy.bindings.some((b) => b.condition || Object.keys(b).some((k) => !['role', 'members'].includes(k))) ||
          policy.bindings.length !== expected.length
        )
          throw new Error('invalid direct policy');
        for (const grant of expected) {
          const matches = policy.bindings.filter((b) => b.role === grant.role);
          const members = matches[0]?.members;
          if (
            matches.length !== 1 ||
            !Array.isArray(members) ||
            members.length !== grant.members.length ||
            new Set(members).size !== members.length ||
            !grant.members.every((member) => members.includes(member))
          )
            throw new Error('invalid direct grant');
        }
      }
      receipts.push({
        role: binding.role,
        pool,
        ...observed,
        directPolicySHA256: policies.map(([policy]) =>
          createHash('sha256').update(JSON.stringify(policy)).digest('hex')
        ),
      });
    }
    return {
      schemaVersion: 1,
      projectId: 'urm-app-staging',
      namespace: platform.temporalNamespace,
      buildId: platform.workerBuildId,
      observedAt: new Date().toISOString(),
      scope: 'resource direct policies only; inherited and effective access not established',
      roles: receipts,
    };
  } catch {
    throw new Error('CLOUD_RUN_SCALER_POLICY_UNCONFIRMED');
  }
}

export async function collectCloudRunDispatchDiagnostic(options){
 return withNativeCloudRunClient(options,async(client,application)=>{
  const deadline=Date.now()+(options.recovery === 'scheduler' ? 80000 : options.recovery === 'retry' ? 50000 : 20000);
  while(Date.now()<deadline&&!options.signal?.aborted){
   try{return await application.collectDispatchDiagnosticExecution({db:options.firestore,client,manifest:options.diagnostic.manifest,surface:options.surface,recovery:options.recovery,deadline});}
   catch{if(Date.now()>=deadline||options.signal?.aborted)break;await new Promise(resolve=>setTimeout(resolve,500));}
  }
  throw new Error('NATIVE_DIAGNOSTIC_COMPLETION_UNCONFIRMED');
 });
}

export async function verifyCloudRunBootstrapProtection(options) {
  return withNativeCloudRunClient(options, client => observeBootstrapProtection({...options, client}));
}
export async function verifyCloudRunBootstrapRegistration(options) {
  return withNativeCloudRunClient(options, async (client,application) => {
    if(options.role!=='media')return observeBootstrapRegistration({...options,client});
    const b=options.platform.roleBindings.find(b=>b.role==='media');
    let registration;
    const capacity=await application.collectMediaStartupCapacity({firestore:options.firestore,operationId:options.operationId,
      binding:{projectId:b.projectId,region:b.region,namespace:b.namespace,role:b.role,buildId:b.buildId,poolName:b.poolName,deploymentName:b.deploymentName,runnerServiceAccount:b.runnerServiceAccount,image:b.image},
      readResource:application.readServerlessResource,verifyPool:application.verifyServerlessPool,
      observePoller: async (origin) => {
        const cloudRunStart = await readMediaBootstrapCloudOrigin({ api: options.api, binding: b, origin });
        const poller = await observeBootstrapRegistration({ ...options, client, expectedPoller: origin.identity });
        registration = { ...poller, cloudRunStart };
      },
    });
    return joinMediaStartupRegistration(registration,capacity);
  });
}

/** Source/CI/image guards are established by the canonical release controller. */
async function runPromotion(options,role){
 return withNativeCloudRunClient(options,async(client,application)=>{
  // No source-built bundle or caller-selected file can substitute for final image bytes.
  const imageReplay=await createImageReplayObserver({image:options.platform.workerImage,
    buildId:options.platform.workerBuildId,operationId:options.operationId,
    bindingDigest:options.bindingDigest,evidenceDigest:options.evidenceDigest,historyToJSON:application.historyToJSON});
  const observe={...options,client,bundleSHA256:imageReplay.bundleSHA256,
    replayHistory:imageReplay.replayHistory,imageReplayProof:imageReplay.imageProof};
  const operations={controls:[promoteCloudRunControls,observeControlsPromotionBefore,observeControlsPromotionAfter],search:[promoteCloudRunSearch,observeSearchPromotionBefore,observeSearchPromotionAfter],email:[promoteCloudRunEmail,observeEmailPromotionBefore,observeEmailPromotionAfter],images:[promoteCloudRunImages,observeImagesPromotionBefore,observeImagesPromotionAfter]};
  const [run,before,after]=operations[role];
  return run({...options,client,before:()=>before(observe),after:()=>after(observe)});
 },`${role}-promotion`);
}

export const runCloudRunControlsPromotion=o=>runPromotion(o,'controls');
export const runCloudRunSearchPromotion=o=>runPromotion(o,'search');

export const runCloudRunEmailPromotion=o=>runPromotion(o,'email');

export const runCloudRunImagesPromotion=o=>runPromotion(o,'images');

export const runCloudRunMediaPromotion=async(o, currentAuthority)=>{
 if(typeof currentAuthority!=='function')return denyUnprovedMediaPromotion();
 return withNativeCloudRunClient(o,async(client,application)=>
  promoteCloudRunMedia({...o,client},async stage=>{
   const proof=await collectCloudRunMediaPromotionEvidence({...o,...currentAuthority()},stage,client,application);
   if(!proof.diagnosticJobTermination)denyUnprovedMediaPromotion();
   return {proof,resources:proof.resources};
  }),'media-promotion');
};

function observedMediaRecoveryRoleBinding(o) {
  const platform = validateCloudRunReleasePlatform(o.platform);
  const media = platform.roleBindings.find(({ role }) => role === 'media');
  if (
    !media || o.role !== 'media' || o.firestore.projectId !== 'urm-app-staging' ||
    o.firestore.databaseId !== '(default)' || o.config.projectId !== platform.firebaseProjectId ||
    o.config.environment !== platform.environment || o.config.releaseId !== o.releaseId ||
    o.config.compatibilityCommit !== media.buildId ||
    ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']
      .some((name) => process.env[name])
  ) fail();
  return media;
}

/** Canonical diagnostic entry. Preparation and Job writes still perform their
 * original owned-operation, namespace and provider checks at the point of use. */
export async function assertCloudRunMediaRecoverySupported(o) {
  const failRecovery = () => { throw new Error('CLOUD_RUN_MEDIA_DIAGNOSTIC_RUNTIME_UNAVAILABLE'); };
  try {
    const media = observedMediaRecoveryRoleBinding(o);
    await assertMediaRecoveryAuthority(o);
    const options = { ...o, saved: undefined, observeProtection: failRecovery };
    const original = await readMediaRecoveryNormalOrigin(options);
    if (original.binding.poolName !== media.poolName || original.binding.image !== media.image) failRecovery();
    await withNativeCloudRunClient(o, async (client, application) => {
      await createMediaRecoveryImageReplayObserver({
        image: media.image, buildId: media.buildId, operationId: o.operationId,
        bindingDigest: o.bindingDigest, evidenceDigest: o.evidenceDigest, historyToJSON: application.historyToJSON,
      });
      await observeNamespaceComputeIsolation(client, o.platform.temporalNamespace);
      const [current, quota] = await Promise.all([
        readMediaRecoveryNormalOrigin(options),
        observeMediaDiskQuota(original.zeroPlan, o.api),
      ]);
      if (recoveryHash(original) !== recoveryHash(current)) failRecovery();
      await assertMediaRecoveryAuthority(o);
      assertMediaDiskQuotaFresh(quota);
    });
  } catch (error) {
    throw new Error('CLOUD_RUN_MEDIA_DIAGNOSTIC_RUNTIME_UNAVAILABLE', { cause: error });
  }
}

/** Restored activation takes its origin from the immutable completed recovery.
 * Resumes retain their saved LRO fence and do not require the pool to be zero. */
export async function assertCloudRunRestoredMediaSupported(o) {
  try {
    const media = observedMediaRecoveryRoleBinding(o);
    const root = await assertRestoredMediaActivationAuthority(o);
    const receipt = o.receipts?.recovery;
    const recovery = receipt?.identityState;
    if (
      receipt?.releaseId !== o.releaseId || receipt.operationId !== o.recoveryOperationId ||
      recovery?.stage !== 'completed' || recovery.disposition !== 'normal-zero-after-job' ||
      recovery.plan?.buildId !== media.buildId || recovery.plan.image !== media.image ||
      recovery.plan.operationId !== o.recoveryOperationId || !recovery.plan.job ||
      (root.cloudRestoredMediaActivation !== undefined &&
        root.cloudRestoredMediaActivation.plan?.recoveryOperationId !== o.recoveryOperationId)
    ) throw Error();
    await readCloudRunOperatorKey(o.platform.operatorApiKeyFile, o.platform.operatorApiKeySHA256);
    await assertRestoredMediaActivationAuthority(o);
  } catch (error) {
    throw new Error('RESTORED_MEDIA_NORMAL_RUNTIME_UNAVAILABLE', { cause: error });
  }
}

/** Fixed promotion purposes use one transport attempt, including SDK interceptors. */
export function nativePromotionConnectionOptions(purpose){
 return (purpose==='media-recovery-start'||purpose==='worker-wake-start'||purpose==='worker-readiness-start'||purpose==='worker-compute-attach'||purpose==='orchestration-handoff'||independentPromotionRoles.some(role=>purpose===`${role}-promotion`))?{interceptors:[],channelArgs:{'grpc.enable_retries':0}}:{};
}

export function joinMediaStartupRegistration(registration,capacity){
 const at=Date.parse(registration?.observedAt??'');
 const capacityAt=Date.parse(capacity?.capacityObservedAt??'');
 if(!Number.isFinite(at)||Math.abs(Date.now()-at)>5000||!Number.isFinite(capacityAt)||capacityAt>Date.now()+5000||Date.now()-capacityAt>120000)throw new Error('MEDIA_STARTUP_REGISTRATION_EXPIRED');
 return {...registration,mediaStartupCapacity:capacity};
}

/** Source/CI/image/authority loader and a fixed nonretrying native START purpose. */
export const startCloudRunMediaRecovery=o=>withNativeCloudRunClient(o,(client,application)=>startMediaRecoveryWorkflow({...o,client,application}),'media-recovery-start');

/** Exact verified-image private profile; GET-only native facts and offline replay.
 * This returns an episode proof only, never a drain or restored-origin proof. */
export const collectCloudRunMediaRecovery=o=>withNativeCloudRunClient(o,async(client,application)=>{
 try{
  await assertMediaRecoveryAuthority(o);
  if(o.platform.workerImage!==o.plan.image||o.platform.workerBuildId!==o.plan.buildId)throw Error();
  const collectorAuthority={db:o.firestore,client,operationId:o.operationId,plan:o.plan,
   expectedRootSHA256:o.ownedOperation.dataDigest,expectedControlSHA256:o.expectedAuthority.control.dataDigest,
   expectedStateSHA256:o.expectedAuthority.state.dataDigest};
  await application.waitForMediaRecoveryEpisode({...collectorAuthority,runId:o.start.runId});
  const image=await createMediaRecoveryImageReplayObserver({image:o.plan.image,buildId:o.plan.buildId,
   operationId:o.operationId,bindingDigest:o.bindingDigest,evidenceDigest:o.plan.evidenceDigest,historyToJSON:application.historyToJSON});
  const read=()=>application.collectMediaRecoveryExecution({db:o.firestore,client,operationId:o.operationId,plan:o.plan,
   expectedRootSHA256:o.ownedOperation.dataDigest,expectedControlSHA256:o.expectedAuthority.control.dataDigest,
   expectedStateSHA256:o.expectedAuthority.state.dataDigest,image:{bundleSHA256:image.bundleSHA256,tools:image.tools}});
  const job = o.plan.job;
  if (job && (!o.jobRun || o.start.jobRunSHA256 !== recoveryHash(o.jobRun))) throw Error();
  const observePool = () => job
    ? observeMediaRecoveryStartedPool(o, o.plan, o.plan.origin, o.plan.normalTemplate, 0)
    : observeMediaRecoveryStartedPool(o, o.plan, o.pool);
  await observePool();
  const first=await read();
  const replay=await image.replayHistory(first.history,first.workflowId,first.runId);
  assertMediaRecoveryImageReplayReceipt(replay,{image:o.plan.image,buildId:o.plan.buildId,operationId:o.operationId,
   bindingDigest:o.bindingDigest,evidenceDigest:o.plan.evidenceDigest,bundleSHA256:image.bundleSHA256,
   workflowId:first.workflowId,runId:first.runId,historySHA256:recoveryHash(first.history)});
  const second=await read();
  if(second.evidenceSHA256!==first.evidenceSHA256||recoveryHash(second.cloudOrigin)!==recoveryHash(first.cloudOrigin))throw Error();
  const deadline=Date.now()+20000;
  let providerOrigin;
  while(Date.now()<deadline&&!providerOrigin){
   await assertMediaRecoveryAuthority(o);
   if (job) {
    const task = second.cloudOrigin.job;
    if (!task || task.executionUid !== o.jobRun.executionUid || task.execution !== o.jobRun.execution) throw Error();
    try {
      const terminal = await observeMediaRecoveryJobTermination({api:o.api,plan:o.plan,run:o.jobRun,
        taskIdentity:{name:task.task,uid:task.taskUid},
        custody:{originalClosedAt:second.cloudOrigin.originalClosedAt,
          replacementClosedAt:second.cloudOrigin.replacementClosedAt}});
      const startup = await readMediaRecoveryJobOrigins({api:o.api,plan:o.plan,origin:second.cloudOrigin});
      if (startup) providerOrigin = { terminal, startup };
    } catch (error) {
      // Provider completion can trail the worker's recorded child close.
      if (error?.message !== 'MEDIA_RECOVERY_JOB_TERMINATION_UNCONFIRMED') throw error;
    }
   } else {
    providerOrigin=await readMediaRecoveryCloudOrigin({api:o.api,plan:o.plan,pool:o.pool,origin:second.cloudOrigin});
   }
   if(!providerOrigin)await new Promise(resolve=>setTimeout(resolve,500));
  }
  if(!providerOrigin||Date.now()>=deadline)throw Error();
  const pool=await observePool();
  await assertMediaRecoveryAuthority(o);
  if(Date.now()>=pool.deadline||performance.now()-pool.sampledMonotonic>=5000)throw Error();
  const recovery = {kind:'recovery',operationId:o.operationId,bindingDigest:o.bindingDigest,buildId:o.plan.buildId,image:o.plan.image,
   proofSHA256:recoveryHash({evidence:first.evidenceSHA256,image:image.imageProof,replay,providerOrigin})};
  return job ? { recovery, jobTermination: providerOrigin.terminal } : recovery;
 }catch{throw new Error('MEDIA_RECOVERY_COLLECTION_UNCONFIRMED');}
});

/** The finite Job has ended. Poller history still remains visible until the
 * namespace returns two complete and consistent empty-poller samples. */
export const drainCloudRunMediaRecoveryJob = o => withNativeCloudRunClient(o, async client => {
  const { api, plan, jobRun, jobTermination, operationId } = o;
  const deadline = performance.now() + 380000;
  const sample = async () => {
    const started = performance.now();
    const wall = Date.now();
    const fresh = () => {
      if (performance.now() - started >= 5000 || Date.now() - wall >= 5000 || Date.now() < wall)
        throw new Error('MEDIA_RECOVERY_JOB_DRAIN_UNCONFIRMED');
    };
    const read = async (fn) => {
      let timer;
      try {
        fresh();
        const value = await Promise.race([
          Promise.resolve().then(fn),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('MEDIA_RECOVERY_JOB_DRAIN_UNCONFIRMED')),
              Math.max(1, 5000 - (performance.now() - started)));
          }),
        ]);
        fresh();
        return value;
      } finally { clearTimeout(timer); }
    };
    const rpc = fn => read(() => client.connection.withDeadline(wall + 5000, fn));
    await read(() => assertMediaRecoveryAuthority(o));
    const readClosures = async () => {
      const records = await read(() => o.firestore.getAll(...[
        'OriginalReady', 'Kernel', 'ReplacementKernel',
      ].map(kind => o.firestore.doc(`_control/temporalMediaRecovery${kind}-${operationId}`))));
      if (records.some(value => !value.exists || !value.createTime || !value.updateTime))
        throw new Error('MEDIA_RECOVERY_JOB_DRAIN_UNCONFIRMED');
      const [ready, original, replacement] = records;
      const worker = replacement.get('worker'), job = worker?.cloudRunJob;
      const oldJob = original.get('worker.cloudRunJob');
      if (
        !job || !oldJob || recoveryHash(job) !== recoveryHash(oldJob) ||
        original.get('stage') !== 'closed' || replacement.get('stage') !== 'closed' ||
        original.get('close.signal') !== 'SIGKILL' || replacement.get('close.code') !== 0 ||
        replacement.get('close.signal') !== null ||
        original.get('close.descendantsAbsent') !== true ||
        replacement.get('close.descendantsAbsent') !== true ||
        original.get('close.observerFailed') === true || replacement.get('close.observerFailed') === true ||
        job.task !== jobTermination.task || job.taskUid !== jobTermination.taskUid ||
        job.execution !== jobRun.execution || job.executionUid !== jobRun.executionUid
      ) throw new Error('MEDIA_RECOVERY_JOB_DRAIN_UNCONFIRMED');
      return {
        job, worker, ready: ready.data(),
        custody: { originalClosedAt: original.get('close.observedAt'), replacementClosedAt: replacement.get('close.observedAt') },
        closureSHA256: recoveryHash(records.map(row => nativeSnapshotProof(row))),
      };
    };
    const binding = await readClosures();
    const terminal = await read(() => observeMediaRecoveryJobTermination({
      api: url => read(() => api(url)), plan, run: jobRun, custody: binding.custody,
      taskIdentity: { name: binding.job.task, uid: binding.job.taskUid },
    }));
    if (terminal.proofSHA256 !== jobTermination.proofSHA256)
      throw new Error('MEDIA_RECOVERY_JOB_DRAIN_UNCONFIRMED');
    const scan = () => scanPrivateMediaInventory({
      client, db: o.firestore, plan, operationId, read, rpc, auth: { ready: binding.ready, worker: binding.worker },
    });
    const first = await scan();
    const second = await scan();
    const isolation = await read(() => observeNamespaceComputeIsolation(client, 'urm-app-staging.qwejt'));
    const final = await readClosures();
    await read(() => assertMediaRecoveryAuthority(o));
    if (recoveryHash(first) !== recoveryHash(second) || final.closureSHA256 !== binding.closureSHA256)
      throw new Error('MEDIA_RECOVERY_JOB_DRAIN_UNCONFIRMED');
    fresh();
    return {
      kind: 'job-queues-drained', operationId, terminationSHA256: terminal.proofSHA256,
      observedAt: new Date(wall).toISOString(),
      proofSHA256: recoveryHash({ inventory: second, isolation: isolation.inventorySHA256, closure: final.closureSHA256,
        termination: terminal.proofSHA256, authority: o.ownedOperation.dataDigest }),
    };
  };
  do {
    try { return await sample(); }
    catch (error) {
      if (error?.message !== 'MEDIA_DIAGNOSTIC_POLLERS_PRESENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (performance.now() < deadline);
  throw new Error('MEDIA_RECOVERY_JOB_DRAIN_UNCONFIRMED');
});

/** Read-only namespace/partition drain. Native poller caches may outlive close;
 * only fresh empty native observations permit the immutable drain checkpoint. */
export const drainCloudRunMediaRecovery=o=>withNativeCloudRunClient(o,async client=>{
 try{
  await observeMediaRecoveryStartedPool(o,o.plan,o.pool);
  const observation=await waitForMediaDiagnosticDrain({...o,client});
  const pool=await observeMediaRecoveryStartedPool(o,o.plan,o.pool);
  await assertMediaRecoveryAuthority(o);
  if(Date.now()>=pool.deadline||performance.now()-pool.sampledMonotonic>=5000)throw Error();
  assertFreshMediaDiagnosticDrain(observation,o.plan,o.pool);
  return {kind:'drained',operationId:o.operationId,bindingDigest:o.bindingDigest,buildId:o.plan.buildId,image:o.plan.image,proofSHA256:recoveryHash(observation),observation};
 }catch{throw new Error('MEDIA_DIAGNOSTIC_DRAIN_UNCONFIRMED');}
});

export const confirmCloudRunMediaRecoveryNeverStarted = (o) =>
  withNativeCloudRunClient(o, async (client) => {
    try {
      const before = await observeMediaRecoveryDiagnosticZeroPool(o);
      const observation = await observeMediaDiagnosticNeverStarted({ ...o, client });
      const after = await observeMediaRecoveryDiagnosticZeroPool(o);
      await assertMediaRecoveryAuthority(o);
      return mediaDiagnosticNeverStartedProof(o, observation, before, after);
    } catch {
      throw new Error('MEDIA_DIAGNOSTIC_CONFIRMATION_UNCONFIRMED');
    }
  });

/** Observe provider entries before restoration with the exact original stop
 * authority and zero revision. Even a lifecycle message supplies no exit proof. */
export const readCloudRunMediaRecoveryStopEvents = (o) =>
  withNativeCloudRunClient(o, async (client) => {
    const before = await observeMediaRecoveryDiagnosticZeroPool(o);
    const observation = await observeMediaDiagnosticStopEvents({ ...o, client });
    const after = await observeMediaRecoveryDiagnosticZeroPool(o);
    await assertMediaRecoveryAuthority(o);
    assertMediaZeroPoolSampleFresh(before);
    assertMediaZeroPoolSampleFresh(after);
    const observedAt = Date.parse(observation.observedAt);
    if (before.ancestorsSHA256 !== after.ancestorsSHA256 ||
        observation.operationId !== o.operationId ||
        observation.poolSHA256 !== recoveryHash(o.pool) ||
        observedAt < before.sampledAt || observedAt > after.sampledAt)
      throw new Error('MEDIA_DIAGNOSTIC_STOP_OBSERVATION_UNCONFIRMED');
    const { events, instanceCounts, stopAttempt } = observation.stopObservation;
    return {
      observationSHA256: recoveryHash(observation),
      entries: events.length,
      lifecycleEntries: events.filter(event => event.lifecycleText).length,
      revisionSamples: instanceCounts.length,
      zeroSamplesAfterStopAttempt: instanceCounts.filter(sample => sample.at > stopAttempt && sample.count === 0).length,
    };
  });

/** Exact source-authenticated original startup identity, not a poller policy. */
export const observeCloudRunMediaIdleStartup=o=>withNativeCloudRunClient(o,async(_client,application)=>{
 try{
  const boundedRead=async fn=>{let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('MEDIA_RECOVERY_IDLE_STARTUP_UNCONFIRMED')),5000);})]);}finally{clearTimeout(timer);}};
  await boundedRead(()=>assertMediaRecoveryAuthority(o));
  const startup=await boundedRead(()=>o.firestore.doc(`_control/temporalMediaRecoveryStartup-${o.operationId}`).get());
  const image=startup.exists?await createMediaRecoveryImageReplayObserver({image:o.plan.image,buildId:o.plan.buildId,operationId:o.operationId,bindingDigest:o.bindingDigest,evidenceDigest:o.plan.evidenceDigest,historyToJSON:application.historyToJSON}):undefined;
  const result=await application.collectMediaRecoveryIdleStartup({db:o.firestore,auth:o.firebaseAuth,operationId:o.operationId,plan:o.plan,phasePool:o.phasePool,expectedRootSHA256:o.ownedOperation.dataDigest,expectedControlSHA256:o.expectedAuthority.control.dataDigest,expectedStateSHA256:o.expectedAuthority.state.dataDigest,...(image?{image:{bundleSHA256:image.bundleSHA256,tools:image.tools}}:{})});
  await boundedRead(()=>assertMediaRecoveryAuthority(o));
  if(!Number.isFinite(Date.parse(result.observedAt))||!Number.isFinite(Date.parse(o.phasePool.observedAt))||Math.abs(Date.now()-Date.parse(result.observedAt))>=5000||Math.abs(Date.now()-Date.parse(o.phasePool.observedAt))>=5000)throw Error();
  return result;
 }catch{throw new Error('MEDIA_RECOVERY_IDLE_STARTUP_UNCONFIRMED');}
});

/** Complete source-fixed diagnostic namespace policy. Preflight stays denied
 * pending separate native platform evidence and restored-origin activation. */
export const protectCloudRunMediaRecovery=o=>withNativeCloudRunClient(o,async(client,application)=>{
 try{
  const began=Date.now(),monotonic=performance.now();
  const fresh=()=>{if(Date.now()-began<0||Date.now()-began>=5000||performance.now()-monotonic<0||performance.now()-monotonic>=5000)throw Error();};
  const read=async fn=>{let timer;try{fresh();const value=await Promise.race([Promise.resolve().then(()=>{fresh();return fn();}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('MEDIA_RECOVERY_PHASE_PROTECTION_UNCONFIRMED')),Math.max(1,5000-(Date.now()-began)));})]);fresh();return value;}finally{clearTimeout(timer);}};
  await read(()=>assertMediaRecoveryAuthority(o));
  let readIdle;
  if(o.phase==='start'){
   const startup=await read(()=>o.firestore.doc(`_control/temporalMediaRecoveryStartup-${o.operationId}`).get());
   const image=startup.exists?await createMediaRecoveryImageReplayObserver({image:o.plan.image,buildId:o.plan.buildId,operationId:o.operationId,bindingDigest:o.bindingDigest,evidenceDigest:o.plan.evidenceDigest,historyToJSON:application.historyToJSON}):undefined;
   readIdle=()=>application.collectMediaRecoveryIdleStartup({db:o.firestore,auth:o.firebaseAuth,operationId:o.operationId,plan:o.plan,phasePool:o.phasePool,expectedRootSHA256:o.ownedOperation.dataDigest,expectedControlSHA256:o.expectedAuthority.control.dataDigest,expectedStateSHA256:o.expectedAuthority.state.dataDigest,...(image?{image:{bundleSHA256:image.bundleSHA256,tools:image.tools}}:{})});
  }
  const result=await observeMediaRecoveryProtection({...o,client,readIdle});
  await read(()=>assertMediaRecoveryAuthority(o));
  if(!Number.isFinite(Date.parse(result.observedAt))||Math.abs(Date.now()-Date.parse(result.observedAt))>=5000||Math.abs(Date.now()-Date.parse(o.phasePool.observedAt))>=5000)throw Error();
  fresh();
  return result;
 }catch{throw new Error('MEDIA_RECOVERY_PHASE_PROTECTION_UNCONFIRMED');}
});

/** Fixed NEW-parent historical origin, never scale/promotion authority. */
export const readRestoredMediaActivationOrigin=o=>withNativeCloudRunClient(o,async(client,application)=>{
 try{
  const bounded=async fn=>{let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('RESTORED_MEDIA_ORIGIN_UNCONFIRMED')),5000);})]);}finally{clearTimeout(timer);}};
  await bounded(()=>assertRestoredMediaActivationAuthority(o));
  const before=await readRestoredMediaActivationAccess(o),p=before.plan;
  const image=await createMediaRecoveryImageReplayObserver({image:p.image,buildId:p.buildId,operationId:o.recoveryOperationId,bindingDigest:p.bindingDigest,evidenceDigest:p.evidenceDigest,historyToJSON:application.historyToJSON});
  const args={db:o.firestore,client,recoveryOperationId:o.recoveryOperationId,activationOperationId:o.operationId,activationBindingDigest:o.bindingDigest,releaseId:o.releaseId,expectedRootSHA256:o.ownedOperation.dataDigest,expectedControlSHA256:o.expectedAuthority.control.dataDigest,expectedStateSHA256:o.expectedAuthority.state.dataDigest,buildId:p.buildId,imageDigest:p.image,image:{bundleSHA256:image.bundleSHA256,tools:image.tools}};
  const first=await application.collectCompletedMediaRecoveryExecution(args);
  const replay=await image.replayHistory(first.history,first.workflowId,first.runId);
  assertMediaRecoveryImageReplayReceipt(replay,{image:p.image,buildId:p.buildId,operationId:o.recoveryOperationId,bindingDigest:p.bindingDigest,evidenceDigest:p.evidenceDigest,bundleSHA256:image.bundleSHA256,workflowId:first.workflowId,runId:first.runId,historySHA256:recoveryHash(first.history)});
  const second=await application.collectCompletedMediaRecoveryExecution(args);
  if(first.evidenceSHA256!==second.evidenceSHA256||first.provenanceSHA256!==second.provenanceSHA256)throw Error();
  const at=Date.now(),mono=performance.now(),fresh=()=>{if(Date.now()<at||Date.now()-at>=5000||performance.now()-mono>=5000)throw Error();};
  const read=async fn=>{fresh();const value=await bounded(fn);fresh();return value;},rpc=fn=>read(()=>client.connection.withDeadline(at+5000,fn));
  const ready=await read(()=>o.firestore.doc(`_control/temporalMediaRecoveryOriginalReady-${o.recoveryOperationId}`).get()),kernel=await read(()=>o.firestore.doc(`_control/temporalMediaRecoveryReplacementKernel-${o.recoveryOperationId}`).get());
  const protection = await observeRestoredMediaOriginProtection({
    ...o, client, read, rpc, deadline: at + 5000, originalPlan: p,
    originalAuth: { ready: ready.data(), worker: kernel.get('worker') },
  });
  const proven=await read(()=>application.confirmCompletedMediaRecoveryProvenance(args));
  if(proven.provenanceSHA256!==first.provenanceSHA256)throw Error();
  const after=await readRestoredMediaActivationAccess(o);
  if(recoveryHash(before.plan)!==recoveryHash(after.plan)||recoveryHash(before.pool)!==recoveryHash(after.pool)||before.capsuleSHA256!==after.capsuleSHA256||before.provenanceSHA256!==after.provenanceSHA256||before.accessSHA256!==after.accessSHA256)throw Error();
  await read(()=>assertRestoredMediaActivationAuthority(o));fresh();
  if(!Number.isFinite(Date.parse(after.observedAt))||Math.abs(Date.now()-Date.parse(after.observedAt))>=5000)throw Error();
  return {kind:'restored-media-activation-origin-v1',operationId:o.operationId,recoveryOperationId:o.recoveryOperationId,bindingDigest:o.bindingDigest,releaseId:o.releaseId,buildId:p.buildId,image:p.image,pool:after.pool,capsuleSHA256:after.capsuleSHA256,proofSHA256:recoveryHash({before:after.provenanceSHA256,access:after.accessSHA256,evidence:first.evidenceSHA256,image:image.imageProof,replay,protection}),observedAt:new Date(at).toISOString(),scope:'historical-origin-only-no-scale-or-promotion-authority'};
 }catch{throw new Error('RESTORED_MEDIA_ORIGIN_UNCONFIRMED');}
});

/** Source/image-bound historical startup only. Namespace policy, queue permission
 * and registration are deliberately separate and remain unavailable. */
export const readRestoredMediaStartupWitness=o=>withNativeCloudRunClient(o,async(_client,application)=>{
 try{
  const before=await readRestoredMediaActivationPool({...o,count:1});
  const image=await createMediaRecoveryImageReplayObserver({image:o.plan.image,buildId:o.plan.buildId,operationId:o.operationId,bindingDigest:o.bindingDigest,evidenceDigest:o.plan.evidenceDigest,historyToJSON:application.historyToJSON});
  const at=Date.now(),mono=performance.now();
  const fresh=()=>{if(Date.now()<at||Date.now()-at>=5000||performance.now()-mono>=5000)throw Error();};
  const read=async fn=>{let timer;try{fresh();const value=await Promise.race([Promise.resolve().then(()=>{fresh();return fn();}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('RESTORED_MEDIA_STARTUP_READBACK_UNCONFIRMED')),Math.max(1,5000-(Date.now()-at)));})]);fresh();return value;}finally{clearTimeout(timer);}};
  const args={db:o.firestore,auth:o.firebaseAuth,operationId:o.operationId,bindingDigest:o.bindingDigest,plan:o.plan,pool:before,expectedRootSHA256:o.ownedOperation.dataDigest,expectedControlSHA256:o.expectedAuthority.control.dataDigest,expectedStateSHA256:o.expectedAuthority.state.dataDigest,image:image.tools};
  const first=await read(()=>application.collectRestoredMediaStartup(args));
  const after=await read(()=>readRestoredMediaActivationPool({...o,count:1}));
  if(recoveryHash(before)!==recoveryHash(after))throw Error();
  const second=await read(()=>application.collectRestoredMediaStartup({...args,pool:after}));
  if(first.proofSHA256!==second.proofSHA256||first.identity!==second.identity||first.kernelBirthSHA256!==second.kernelBirthSHA256||first.startupSHA256!==second.startupSHA256)throw Error();
  await read(()=>assertRestoredMediaActivationAuthority(o));fresh();
  return {...second,imageSHA256:recoveryHash(image.imageProof),scope:'historical-startup-only-no-polling-or-registration-authority'};
 }catch{throw new Error('RESTORED_MEDIA_STARTUP_READBACK_UNCONFIRMED');}
});

/** Fixed retained normal-media readback. The original episode and current
 * activation remain separate throughout; no zero-origin reader runs here. */
export const readRestoredMediaRegistration = (o) =>
  withNativeCloudRunClient(o, async (client, application) => {
    try {
      const pool = await readRestoredMediaActivationPool({ ...o, count: 1 });
      const p = await readRestoredMediaRecoveryPlan(o);
      const image = await createMediaRecoveryImageReplayObserver({
        image: p.image,
        buildId: p.buildId,
        operationId: o.recoveryOperationId,
        bindingDigest: p.bindingDigest,
        evidenceDigest: p.evidenceDigest,
        historyToJSON: application.historyToJSON,
      });
      const args = {
        db: o.firestore,
        client,
        recoveryOperationId: o.recoveryOperationId,
        activationOperationId: o.operationId,
        activationBindingDigest: o.bindingDigest,
        releaseId: o.releaseId,
        expectedRootSHA256: o.ownedOperation.dataDigest,
        expectedControlSHA256: o.expectedAuthority.control.dataDigest,
        expectedStateSHA256: o.expectedAuthority.state.dataDigest,
        buildId: p.buildId,
        imageDigest: p.image,
        image: { bundleSHA256: image.bundleSHA256, tools: image.tools },
      };
      const first = await application.collectCompletedMediaRecoveryExecution(args);
      const replay = await image.replayHistory(first.history, first.workflowId, first.runId);
      assertMediaRecoveryImageReplayReceipt(replay, {
        image: p.image,
        buildId: p.buildId,
        operationId: o.recoveryOperationId,
        bindingDigest: p.bindingDigest,
        evidenceDigest: p.evidenceDigest,
        bundleSHA256: image.bundleSHA256,
        workflowId: first.workflowId,
        runId: first.runId,
        historySHA256: recoveryHash(first.history),
      });
      const second = await application.collectCompletedMediaRecoveryExecution(args);
      if (first.evidenceSHA256 !== second.evidenceSHA256 || first.provenanceSHA256 !== second.provenanceSHA256)
        throw Error();
      const at = Date.now(),
        mono = performance.now();
      const fresh = () => {
        if (Date.now() < at || Date.now() - at >= 5000 || performance.now() < mono || performance.now() - mono >= 5000)
          throw Error();
      };
      const read = async (fn) => {
        let timer;
        try {
          fresh();
          const value = await Promise.race([
            Promise.resolve().then(() => {
              fresh();
              return fn();
            }),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('RESTORED_MEDIA_REGISTRATION_UNCONFIRMED')),
                Math.max(1, 5000 - (Date.now() - at))
              );
            }),
          ]);
          fresh();
          return value;
        } finally {
          clearTimeout(timer);
        }
      };
      const rpc = (fn) => read(() => client.connection.withDeadline(at + 5000, fn));
      const startupArgs = {
        db: o.firestore,
        auth: o.firebaseAuth,
        operationId: o.operationId,
        bindingDigest: o.bindingDigest,
        plan: o.plan,
        pool,
        expectedRootSHA256: o.ownedOperation.dataDigest,
        expectedControlSHA256: o.expectedAuthority.control.dataDigest,
        expectedStateSHA256: o.expectedAuthority.state.dataDigest,
        image: image.tools,
      };
      const startup = await read(() => application.collectRestoredMediaStartup(startupArgs));
      const ready = await read(() =>
        o.firestore.doc(`_control/temporalMediaRecoveryOriginalReady-${o.recoveryOperationId}`).get()
      );
      const kernel = await read(() =>
        o.firestore.doc(`_control/temporalMediaRecoveryReplacementKernel-${o.recoveryOperationId}`).get()
      );
      const scan = async () => ({
        normal: await scanRestoredMediaInventory({ client, plan: o.plan, startup, rpc }),
        diagnostic: await scanPrivateMediaInventory({
          client,
          db: o.firestore,
          plan: p,
          operationId: o.recoveryOperationId,
          read,
          rpc,
          auth: { ready: ready.data(), worker: kernel.get('worker') },
        }),
        compute: await read(() => observeNamespaceComputeIsolation(client, 'urm-app-staging.qwejt')),
      });
      const before = await scan(),
        after = await scan();
      if (
        recoveryHash(before) !== recoveryHash(after) ||
        !after.normal.ownedPollers.some((row) => row.type === 2 && row.key === 'urm-media')
      )
        throw Error();
      const finalPool = await read(() => readRestoredMediaActivationPool({ ...o, count: 1 }));
      if (recoveryHash(pool) !== recoveryHash(finalPool)) throw Error();
      const finalStartup = await read(() =>
        application.collectRestoredMediaStartup({ ...startupArgs, pool: finalPool })
      );
      if (startup.proofSHA256 !== finalStartup.proofSHA256 || startup.identity !== finalStartup.identity) throw Error();
      const proven = await read(() => application.confirmCompletedMediaRecoveryProvenance(args));
      if (proven.provenanceSHA256 !== first.provenanceSHA256) throw Error();
      await read(() => assertRestoredMediaActivationAuthority(o));
      fresh();
      return {
        kind: 'restored-media-normal-registration-v1',
        operationId: o.operationId,
        planSHA256: recoveryHash(o.plan),
        pool: finalPool,
        proofSHA256: recoveryHash({
          episode: first.evidenceSHA256,
          provenance: first.provenanceSHA256,
          replay,
          image: image.imageProof,
          startup: startup.proofSHA256,
          inventory: after,
        }),
        observedAt: new Date(at).toISOString(),
      };
    } catch {
      throw new Error('RESTORED_MEDIA_REGISTRATION_UNCONFIRMED');
    }
  });

/** Fixed source-owned phase/unused namespace collector. Full original episode
 * reads remain separate from the new parent's monotonic startup facts. */
export const readRestoredMediaPhaseProtection = (o) =>
  withNativeCloudRunClient(o, async (client, application) => {
    try {
      const p = await readRestoredMediaRecoveryPlan(o);
      const image = await createMediaRecoveryImageReplayObserver({
        image: p.image,
        buildId: p.buildId,
        operationId: o.recoveryOperationId,
        bindingDigest: p.bindingDigest,
        evidenceDigest: p.evidenceDigest,
        historyToJSON: application.historyToJSON,
      });
      const args = {
        db: o.firestore,
        client,
        recoveryOperationId: o.recoveryOperationId,
        activationOperationId: o.operationId,
        activationBindingDigest: o.bindingDigest,
        releaseId: o.releaseId,
        expectedRootSHA256: o.ownedOperation.dataDigest,
        expectedControlSHA256: o.expectedAuthority.control.dataDigest,
        expectedStateSHA256: o.expectedAuthority.state.dataDigest,
        buildId: p.buildId,
        imageDigest: p.image,
        image: { bundleSHA256: image.bundleSHA256, tools: image.tools },
      };
      const first = await application.collectCompletedMediaRecoveryExecution(args);
      const replay = await image.replayHistory(first.history, first.workflowId, first.runId);
      assertMediaRecoveryImageReplayReceipt(replay, {
        image: p.image,
        buildId: p.buildId,
        operationId: o.recoveryOperationId,
        bindingDigest: p.bindingDigest,
        evidenceDigest: p.evidenceDigest,
        bundleSHA256: image.bundleSHA256,
        workflowId: first.workflowId,
        runId: first.runId,
        historySHA256: recoveryHash(first.history),
      });
      const second = await application.collectCompletedMediaRecoveryExecution(args);
      if (first.evidenceSHA256 !== second.evidenceSHA256 || first.provenanceSHA256 !== second.provenanceSHA256)
        throw Error();
      const at = Date.now(),
        mono = performance.now();
      const fresh = () => {
        if (Date.now() < at || Date.now() - at >= 5000 || performance.now() < mono || performance.now() - mono >= 5000)
          throw Error();
      };
      const read = async (fn) => {
        let timer;
        try {
          fresh();
          const v = await Promise.race([
            Promise.resolve().then(() => {
              fresh();
              return fn();
            }),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(Error()), Math.max(1, 5000 - (Date.now() - at)));
            }),
          ]);
          fresh();
          return v;
        } finally {
          clearTimeout(timer);
        }
      };
      const phasePool = await read(() => observeRestoredMediaPhasePool(o));
      const startupArgs = {
        db: o.firestore,
        auth: o.firebaseAuth,
        operationId: o.operationId,
        bindingDigest: o.bindingDigest,
        plan: o.plan,
        pool: phasePool.pool,
        expectedRootSHA256: o.ownedOperation.dataDigest,
        expectedControlSHA256: o.expectedAuthority.control.dataDigest,
        expectedStateSHA256: o.expectedAuthority.state.dataDigest,
        image: image.tools,
      };
      const ready = await read(() =>
        o.firestore.doc(`_control/temporalMediaRecoveryOriginalReady-${o.recoveryOperationId}`).get()
      );
      const kernel = await read(() =>
        o.firestore.doc(`_control/temporalMediaRecoveryReplacementKernel-${o.recoveryOperationId}`).get()
      );
      const proof = await read(() =>
        observeRestoredMediaPhaseProtection({
          ...o,
          client,
          phasePool,
          originalPlan: p,
          originalAuth: { ready: ready.data(), worker: kernel.get('worker') },
          readStartup: () => application.collectRestoredMediaPhaseStartup(startupArgs),
        })
      );
      const lastPool = await read(() => observeRestoredMediaPhasePool(o));
      if (
        recoveryHash(phasePool.pool) !== recoveryHash(lastPool.pool) ||
        phasePool.position !== lastPool.position ||
        phasePool.provenanceSHA256 !== lastPool.provenanceSHA256
      )
        throw Error();
      const original = await read(() => application.confirmCompletedMediaRecoveryProvenance(args));
      if (original.provenanceSHA256 !== first.provenanceSHA256) throw Error();
      await read(() => assertRestoredMediaActivationAuthority(o));
      fresh();
      if (Math.abs(Date.now() - Date.parse(proof.observedAt)) >= 5000) throw Error();
      return proof;
    } catch {
      throw new Error('RESTORED_MEDIA_PHASE_PROTECTION_UNCONFIRMED');
    }
  });
export const readRestoredMediaUnused = (o) => {
  if (
    o.state?.cleanup?.kind !== 'unused-cleanup' ||
    o.state?.start?.stage !== 'completed' ||
    o.state?.registration ||
    o.state?.disposition === 'retained'
  )
    throw new Error('RESTORED_MEDIA_UNUSED_UNCONFIRMED');
  return readRestoredMediaPhaseProtection({ ...o, key: 'stop', transition: o.state.stop ?? null });
};

/** Fixed promotion-parent retained evidence. This GET-only observer joins the
 * original recovery, distinct activation, and current promotion explicitly.
 * Cloud Run instance/platform proof is separate; this cannot authorize a CAS. */
async function collectCloudRunMediaPromotionEvidence(o, stage, client, application) {
 try {
  if (!['before', 'after'].includes(stage)) throw Error();
  const resources=await readMediaPromotionRetainedResources(o),p=resources.recoveryPlan,a=resources.plan;
  const image=await createMediaRecoveryImageReplayObserver({image:p.image,buildId:p.buildId,operationId:p.operationId,bindingDigest:p.bindingDigest,evidenceDigest:p.evidenceDigest,historyToJSON:application.historyToJSON});
  const args={db:o.firestore,client,recoveryOperationId:p.operationId,activationOperationId:a.operationId,activationBindingDigest:a.bindingDigest,promotionOperationId:o.operationId,promotionBindingDigest:o.bindingDigest,releaseId:o.releaseId,expectedRootSHA256:o.ownedOperation.dataDigest,expectedControlSHA256:o.expectedAuthority.control.dataDigest,expectedStateSHA256:o.expectedAuthority.state.dataDigest,buildId:p.buildId,imageDigest:p.image,image:{bundleSHA256:image.bundleSHA256,tools:image.tools}};
  const first=await application.collectMediaPromotionRecoveryExecution(args);
  const replay=await image.replayHistory(first.history,first.workflowId,first.runId);
  assertMediaRecoveryImageReplayReceipt(replay,{image:p.image,buildId:p.buildId,operationId:p.operationId,bindingDigest:p.bindingDigest,evidenceDigest:p.evidenceDigest,bundleSHA256:image.bundleSHA256,workflowId:first.workflowId,runId:first.runId,historySHA256:recoveryHash(first.history)});
  const second=await application.collectMediaPromotionRecoveryExecution(args);
  if(first.evidenceSHA256!==second.evidenceSHA256||first.provenanceSHA256!==second.provenanceSHA256)throw Error();
  const at=Date.now(),mono=performance.now(),fresh=()=>{if(Date.now()<at||Date.now()-at>=5000||performance.now()-mono>=5000)throw Error();};
  const read=async fn=>{let timer;try{fresh();const v=await Promise.race([Promise.resolve().then(()=>{fresh();return fn();}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('MEDIA_PROMOTION_RETAINED_EVIDENCE_UNCONFIRMED')),Math.max(1,5000-(Date.now()-at)));})]);fresh();return v;}finally{clearTimeout(timer);}};
  const rpc=fn=>read(()=>client.connection.withDeadline(at+5000,fn));
  const startupArgs={...args,auth:o.firebaseAuth,operationId:a.operationId,bindingDigest:a.bindingDigest,plan:a,pool:resources.pool,image:image.tools};
  const startup=await read(()=>application.collectMediaPromotionStartup(startupArgs));
  const terminal = resources.diagnosticJobTermination;
  const diagnosticApi = (...args) => read(() => o.api(...args));
  const diagnosticOrigin = await (terminal
    ? read(() => readMediaRecoveryJobOrigins({api:diagnosticApi,plan:p,origin:second.cloudOrigin}))
    : read(() => readMediaRecoveryCloudOrigin({
      api:diagnosticApi,plan:p,pool:resources.diagnosticPool,origin:second.cloudOrigin,
    })));
  const cloud=startup.worker?.cloudRun,registeredAt=Date.parse(startup.registeredAt);
  if(!diagnosticOrigin||!cloud||!Number.isFinite(registeredAt)||
   cloud.instanceId===second.cloudOrigin.original.metadataInstanceId)throw Error();
  const restoredOrigin=await read(()=>readCloudRunWorkerStart({
   api:diagnosticApi,pool:cloud.pool,revision:cloud.revision,revisionUid:cloud.revisionUid,
   buildId:p.buildId,taskQueue:'urm-media',workerIdentity:startup.identity,
   from:registeredAt-5000,to:Math.min(Date.now(),registeredAt+90000),
  }));
  if(!restoredOrigin||restoredOrigin.instanceId===diagnosticOrigin.original.instanceId||
   restoredOrigin.at<=diagnosticOrigin.replacement.at)throw Error();
  if (terminal) {
    const task = second.cloudOrigin.job;
    const completedAt = Date.parse(terminal.completedAt);
    if (!task || ['job', 'execution', 'executionUid', 'task', 'taskUid'].some(key => task[key] !== terminal[key]) ||
      !Number.isFinite(completedAt) || registeredAt <= completedAt || restoredOrigin.at <= completedAt) throw Error();
  }
  const diagnosticClosure = terminal ? { diagnosticJobTermination: terminal } : {
    originalSystemEvents: await readCloudRunWorkerSystemEvents({
      api:diagnosticApi,pool:p.name.split('/').at(-1),revision:resources.diagnosticPool.revision.split('/').at(-1),
      instanceId:diagnosticOrigin.original.instanceId,from:diagnosticOrigin.replacement.at,to:restoredOrigin.at,
    }),
  };
  const ready=await read(()=>o.firestore.doc(`_control/temporalMediaRecoveryOriginalReady-${p.operationId}`).get()),kernel=await read(()=>o.firestore.doc(`_control/temporalMediaRecoveryReplacementKernel-${p.operationId}`).get());
  const scan = async () => {
    const [normal, diagnostic, compute, predecessors] = await Promise.all([
      scanRestoredMediaInventory({client,plan:a,startup,rpc,promotionStage:stage}),
      scanPrivateMediaInventory({client,db:o.firestore,plan:p,operationId:p.operationId,read,rpc,auth:{ready:ready.data(),worker:kernel.get('worker')}}),
      read(() => observeNamespaceComputeIsolation(client,'urm-app-staging.qwejt',{deadline:at+5000,mediaPromotion:true})),
      read(() => verifyMediaPromotionPredecessor({...o,client})),
    ]);
    if (!Number.isFinite(Date.parse(compute.observedAt)) || Math.abs(Date.now()-Date.parse(compute.observedAt))>=5000)
      throw Error();
    return {normal,diagnostic,computeInventorySHA256:compute.inventorySHA256,mediaComputeSHA256:compute.mediaPromotionSHA256,predecessors};
  };
  const before=await scan(),after=await scan();
  if(recoveryHash(before)!==recoveryHash(after)||!after.normal.ownedPollers.some(row=>row.type===2&&row.key==='urm-media'))throw Error();
  await read(()=>readCloudRunOperatorKey(o.platform.operatorApiKeyFile,o.platform.operatorApiKeySHA256));
  await read(async()=>{const {loadVerifiedRuntimeApplication}=await import('./temporal-release-runtime.mjs');await loadVerifiedRuntimeApplication(o.binding,o.config,o.firestore,()=>null);});
  const current=await read(()=>readMediaPromotionRetainedResources(o));
  if(resources.nativeFactsSHA256!==current.nativeFactsSHA256||resources.accessSHA256!==current.accessSHA256||recoveryHash(resources.pool)!==recoveryHash(current.pool)||resources.capsuleSHA256!==current.capsuleSHA256 ||
   (terminal && recoveryHash(terminal)!==recoveryHash(current.diagnosticJobTermination)))throw Error();
  const lastStartup=await read(()=>application.collectMediaPromotionStartup({...startupArgs,pool:current.pool}));
  if(startup.proofSHA256!==lastStartup.proofSHA256||startup.identity!==lastStartup.identity)throw Error();
  const last=await read(()=>application.confirmMediaPromotionRecoveryProvenance(args));
  if(last.provenanceSHA256!==first.provenanceSHA256)throw Error();fresh();
  const lineageSHA256 = recoveryHash({
    activationCapsule:current.capsuleSHA256,resources:current.nativeFactsSHA256,access:current.accessSHA256,
    pool:current.pool,bundle:image.bundleSHA256,tools:image.tools,
    startup:startup.startupSHA256,kernelBirth:startup.kernelBirthSHA256,worker:startup.worker,
    history:replay.historySHA256,diagnosticOrigin,restoredOrigin,
    task:terminal ?? null,diagnostic:after.diagnostic,predecessors:after.predecessors,
    protectedPollers:after.normal.protected.pollers,
    protectedPartitions:after.normal.protected.partitions.map(({type,key,current,owner})=>
      ({type,key,owner,...(type===1&&{current})})),
  });
  return {kind:'media-promotion-retained-evidence-v1',stage,operationId:o.operationId,activationOperationId:a.operationId,recoveryOperationId:p.operationId,buildId:p.buildId,image:p.image,pool:current.pool,lineageSHA256,
    role:'media',namespace:o.platform.temporalNamespace,bundleSHA256:image.bundleSHA256,
    mediaStartup:{
      poolUid:current.pool.uid,revision:cloud.revision,revisionUid:cloud.revisionUid,
      workerIdentity:startup.identity,instanceId:restoredOrigin.instanceId,startedAt:restoredOrigin.at,
    },
    queueRouting:{...after.normal.promotionRouting,pollers:after.normal.ownedPollers.map(({identity,deploymentName,buildId})=>
      ({identity,deploymentOptions:{deploymentName,buildId}}))},
    peerRoutingSHA256:after.normal.promotionRouting.peerRoutingSHA256,
    protectedWorkSHA256:recoveryHash(after.diagnostic),computeInventorySHA256:after.mediaComputeSHA256,
    protectionSHA256:recoveryHash({lineageSHA256,inventory:after}),
    resources:{role:'media',buildId:p.buildId,pool:current.pool,access:current.access,predecessor:after.predecessors,
      receiptsSHA256:recoveryHash(Object.fromEntries(Object.entries(o.receipts).filter(([key])=>key!=='imagesPromotion'))),
      ...(terminal&&{diagnosticJobTerminationSHA256:terminal.proofSHA256})},
    proofSHA256:recoveryHash({lineageSHA256,episode:first.evidenceSHA256,replay,image:image.imageProof,...diagnosticClosure,inventory:after}),
    ...diagnosticClosure,observedAt:new Date(at).toISOString(),scope:'readonly-retained-evidence-no-promotion-authority'};
 }catch{throw new Error('MEDIA_PROMOTION_RETAINED_EVIDENCE_UNCONFIRMED');}
}

export const readCloudRunMediaPromotionEvidence = (o, stage = 'before') =>
  withNativeCloudRunClient(o,(client,application)=>collectCloudRunMediaPromotionEvidence(o,stage,client,application),'media-promotion');
