#!/usr/bin/env node
/** Narrow staging recovery: native routing only; never change a durable job or release checkpoint. */
import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  canonical,
  proofDigest,
  pinReleaseCheckouts,
  prepareLocalReleaseADC,
  verifyReleaseOperator,
  loadReleaseResourceBinding,
  verifyReleaseResourceIdentity,
  nativeSnapshotProof,
  assertNativeSnapshot,
} from './temporal-release-runtime.mjs';
import { validateReleaseConfig, validateControl } from './temporal-release-lib.mjs';
import { assertCheckoutSource } from './temporal-deploy-source.mjs';
import { assertWorkerRouting, assertWorkerQueues, platformOperatorCommands } from './temporal-platform.mjs';
import { assertCompatibilitySettlingCheckpoint } from './temporal-compatibility-cutoff.mjs';
export const PROJECT = 'urm-app-staging';
export const OLD_COMMIT = '580f5f564dc80d876b527f6b129fa9c539ef4ce7';
export const OLD_RELEASE = 'd6401173-c28b-42e9-ba75-f7c714e289c2';
export const NAMESPACE = 'urm-app-staging.qwejt';
const CONTROL = '_control/temporalRelease',
  STATE = '_control/temporalReleaseState',
  OP = '_control/temporalReleaseOperation';
const ACTION = 'recover-pinned-search';
const ROLES = ['controls', 'email', 'images', 'media', 'orchestration', 'search'];
const fail = (code) => Object.assign(new Error(code), { code });
const need = (v, code) => {
  if (!v) throw fail(code);
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => proofDigest(a) === proofDigest(b);
const uuid = (value) =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function bytes(file, expected) {
  need(typeof file === 'string' && resolve(file) === file, 'ABSOLUTE_ARTIFACT_REQUIRED');
  const s = lstatSync(file);
  need(s.isFile() && !s.isSymbolicLink() && s.size <= 32 * 1024 * 1024, 'REGULAR_BOUNDED_ARTIFACT_REQUIRED');
  const value = readFileSync(file);
  if (expected) need(/^[a-f0-9]{64}$/.test(expected) && sha(value) === expected, 'ARTIFACT_HASH_CHANGED');
  return value;
}
function json(file, expected) {
  return JSON.parse(bytes(file, expected));
}
function output(file, value) {
  writeFileSync(file, JSON.stringify(canonical(value), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export function validateDescriptors(old, target, config) {
  validateReleaseConfig(old);
  validateReleaseConfig(target);
  need(
    old.projectId === PROJECT &&
      old.releaseId === OLD_RELEASE &&
      old.compatibilityCommit === OLD_COMMIT &&
      old.uiCommit === OLD_COMMIT &&
      old.mode === 'initial-cutover' &&
      same(old.domains, ['search']),
    'EXACT_PREDECESSOR_REQUIRED'
  );
  need(
    target.projectId === PROJECT &&
      target.environment === 'staging' &&
      target.mode === 'initial-cutover' &&
      same(target.domains, ['search']) &&
      target.releaseId !== old.releaseId &&
      target.compatibilityCommit !== OLD_COMMIT &&
      target.compatibilityCommit === target.uiCommit,
    'NEW_REVIEWED_SOURCE_DESCRIPTOR_REQUIRED'
  );
  need(
    config.firebaseProjectId === PROJECT &&
      config.cloudProvider === 'gcp' &&
      config.cloudRegion === 'us-central1' &&
      config.cloudAccountId === 'qwejt' &&
      config.connectionMode === 'temporal-cloud' &&
      config.temporalNamespace === NAMESPACE &&
      config.cloudAddress === 'urm-app-staging.qwejt.tmprl.cloud:7233' &&
      config.workerDeploymentName === 'urm-worker-staging' &&
      config.workerBuildId === target.compatibilityCommit &&
      /^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(
        config.workerImage
      ) &&
      same([...config.workerRoles].sort(), ROLES),
    'EXACT_SIX_ROLE_TARGET_REQUIRED'
  );
}
export function validateAuthority(old, control, state) {
  validateControl(control);
  need(
    control.releaseId === OLD_RELEASE &&
      control.revision === 28 &&
      control.admission === 'paused' &&
      state?.releaseId === OLD_RELEASE &&
      state.controlRevision === 28 &&
      state.phase === 'backend-ready' &&
      state.mode === 'initial-cutover' &&
      state.compatibilityCommit === OLD_COMMIT &&
      state.uiCommit === OLD_COMMIT &&
      same(state.domains, ['search']),
    'EXACT_PAUSED_BACKEND_READY_28_REQUIRED'
  );
  need(
    same(Object.keys(control.domains).sort(), [
      'accounts',
      'bundles',
      'emails',
      'images',
      'media',
      'publishing',
      'search',
    ]),
    'EXACT_SEVEN_DOMAINS_REQUIRED'
  );
  for (const d of ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'])
    need(
      control.domains[d].owner === 'temporal' && control.domains[d].admission === (d === 'search' ? 'paused' : 'open'),
      'OWNERSHIP_OR_ADMISSION_CHANGED'
    );
  assertCompatibilitySettlingCheckpoint(control, state, old);
}
export function validateManifest(m, target, config) {
  need(
    m?.schemaVersion === 1 &&
      m.projectId === PROJECT &&
      m.oldReleaseId === OLD_RELEASE &&
      m.oldControlRevision === 28 &&
      m.targetCommit === target.compatibilityCommit &&
      m.targetImage === config.workerImage &&
      Array.isArray(m.runs) &&
      m.runs.length > 0 &&
      m.runs.length <= 500,
    'FINITE_REVIEWED_RUN_MANIFEST_REQUIRED'
  );
  need(
    new Set(m.runs.map((r) => r.workflowId)).size === m.runs.length &&
      new Set(m.runs.map((r) => r.jobId)).size === m.runs.length,
    'DUPLICATE_ORIGINAL_RUN'
  );
  for (const r of m.runs)
    need(
      typeof r.jobId === 'string' &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(r.jobId) &&
        r.workflowId === `search:${PROJECT}:${r.jobId}` &&
        uuid(r.runId) &&
        ['SearchDocument', 'SearchBackfill'].includes(r.workflowType),
      'EXACT_ORIGINAL_SEARCH_RUN_REQUIRED'
    );
}
export function overrideArgs(row, config) {
  need(uuid(row.runId) && row.workflowId === `search:${PROJECT}:${row.jobId}`, 'EXACT_ORIGINAL_SEARCH_RUN_REQUIRED');
  return [
    '--disable-config-file',
    'workflow',
    'update-options',
    '--workflow-id',
    row.workflowId,
    '--run-id',
    row.runId,
    '--versioning-override-behavior',
    'pinned',
    '--versioning-override-deployment-name',
    config.workerDeploymentName,
    '--versioning-override-build-id',
    config.workerBuildId,
    '--address',
    config.cloudAddress,
    '--namespace',
    NAMESPACE,
    '--tls',
  ];
}
export function targetOverride(value, config) {
  if (!value || value.autoUpgrade || value.oneTime) return false;
  const versions = [value.pinned?.version, value.deployment].filter(Boolean);
  if (
    versions.length &&
    !versions.every((v) => v.deploymentName === config.workerDeploymentName && v.buildId === config.workerBuildId)
  )
    return false;
  if (value.pinnedVersion && value.pinnedVersion !== `${config.workerDeploymentName}.${config.workerBuildId}`)
    return false;
  return Boolean(
    value.pinned?.version ||
      value.pinnedVersion ||
      (value.deployment && [1, 'VERSIONING_BEHAVIOR_PINNED', 'PINNED'].includes(value.behavior))
  );
}
export function assertOriginalPinnedVersion(info, config) {
  const versions = [info?.deploymentVersion, info?.deployment].filter(Boolean);
  const names = [info?.version].filter(Boolean);
  need(
    (versions.length || names.length) &&
      versions.every(
        (v) => (v.deploymentName ?? v.seriesName) === config.workerDeploymentName && v.buildId === OLD_COMMIT
      ) &&
      names.every((v) => v === `${config.workerDeploymentName}.${OLD_COMMIT}`),
    'ORIGINAL_580_NATIVE_VERSION_REQUIRED'
  );
  need([1, 'VERSIONING_BEHAVIOR_PINNED', 'PINNED'].includes(info.behavior), 'ORIGINAL_PINNED_BEHAVIOR_REQUIRED');
  if (info.versioningOverride)
    need(
      targetOverride(info.versioningOverride, { ...config, workerBuildId: OLD_COMMIT }),
      'FOREIGN_EXISTING_VERSION_OVERRIDE'
    );
}
export function validateJob(row, job, intent, entity, allowSucceeded = false) {
  const kind = row.workflowType === 'SearchDocument' ? 'search.sync' : 'search.backfill';
  need(
    job?.projectId === PROJECT &&
      job.jobId === row.jobId &&
      job.workflowId === row.workflowId &&
      job.kind === kind &&
      job.requestedBy === 'system:search' &&
      [...['queued', 'running', 'retrying', 'needs_attention'], ...(allowSucceeded ? ['succeeded'] : [])].includes(
        job.state
      ) &&
      Number.isSafeInteger(job.generation) &&
      job.generation > 0 &&
      intent?.projectId === PROJECT &&
      intent.jobId === job.jobId &&
      intent.kind === kind &&
      intent.actorUid === 'system:search' &&
      intent.generation === job.generation &&
      same(intent.entity, job.entity) &&
      entity?.projectId === PROJECT &&
      entity.activeJobId === job.jobId &&
      entity.generation === job.generation,
    'CURRENT_NONTERMINAL_SEARCH_INTENT_REQUIRED'
  );
}
export function assertSettled(heads, drains) {
  for (const h of heads)
    need(
      drains.some(
        (d) =>
          d.projectId === PROJECT &&
          d.jobId === h.jobId &&
          d.executionId === h.executionId &&
          d.execution?.attempt === h.attempt &&
          d.execution?.runId === h.runId &&
          d.execution?.worker?.instanceId === h.worker?.instanceId &&
          d.state === 'drained' &&
          d.source === 'worker_settled'
      ),
      'EXACT_WORKER_SETTLEMENT_REQUIRED'
    );
}
export function assertNoRunningActivity(pending) {
  need(
    Array.isArray(pending) &&
      pending.every((p) =>
        [1, 4, 'PENDING_ACTIVITY_STATE_SCHEDULED', 'PENDING_ACTIVITY_STATE_PAUSED'].includes(p.state)
      ),
    'STARTED_OR_UNCERTAIN_ACTIVITY_BLOCKS_OVERRIDE'
  );
}
function identity(job) {
  return Object.fromEntries(
    ['projectId', 'jobId', 'workflowId', 'kind', 'entity', 'generation', 'requestedBy', 'requestId', 'createdAt'].map(
      (k) => [k, job[k]]
    )
  );
}
export function validateReplay(receipt, row, target, config, historySha256) {
  need(
    receipt?.schemaVersion === 1 &&
      receipt.execution === 'actual-temporal-sdk-replay' &&
      receipt.workflowId === row.workflowId &&
      receipt.runId === row.runId &&
      receipt.workflowType === row.workflowType &&
      receipt.targetCommit === target.compatibilityCommit &&
      receipt.targetImage === config.workerImage &&
      receipt.historySha256 === historySha256 &&
      receipt.exitCode === 0 &&
      receipt.log?.path &&
      /^[a-f0-9]{64}$/.test(receipt.log.sha256),
    'ACTUAL_MATCHING_SDK_REPLAY_REQUIRED'
  );
  bytes(receipt.log.path, receipt.log.sha256);
}
export function assertMigration(row, observation, config, prior, workers) {
  need(
    observation.runId === row.runId &&
      observation.workflowId === row.workflowId &&
      observation.workflowType === row.workflowType &&
      ['RUNNING', 'COMPLETED'].includes(observation.status) &&
      targetOverride(observation.override, config),
    'TARGET_OVERRIDE_NOT_OBSERVED'
  );
  const tasks = observation.history.events
    .filter((e) => e.workflowTaskCompletedEventAttributes)
    .map((e) => e.workflowTaskCompletedEventAttributes);
  const heads = observation.heads.filter(
    (h) =>
      h.runId === row.runId &&
      h.worker?.buildId === config.workerBuildId &&
      h.worker?.instanceId &&
      h.worker?.podUid &&
      h.worker?.podName &&
      h.worker?.containerIds?.length
  );
  need(Array.isArray(workers) && workers.length > 0, 'ACTUAL_TARGET_POD_IDENTITIES_REQUIRED');
  assertSettled(heads, observation.drains);
  const taskIdentities = tasks
    .filter((t) => workers.some((w) => w.role === 'search' && t.identity?.endsWith('@' + w.podName)))
    .map((t) => t.identity);
  need(
    heads.length > 0 &&
      taskIdentities.length > 0 &&
      heads.some((h) =>
        workers.some(
          (w) =>
            w.podUid === h.worker.podUid &&
            w.podName === h.worker.podName &&
            h.worker.containerIds.includes(w.containerId) &&
            w.image === config.workerImage
        )
      ),
    'ACTUAL_NEW_EXECUTION_AND_SDK_HISTORY_REQUIRED'
  );
  need(
    heads.every((h) => !prior.some((p) => p.worker?.instanceId === h.worker.instanceId)),
    'NEW_EXECUTION_INSTANCE_REQUIRED'
  );
  return {
    workflowId: row.workflowId,
    runId: row.runId,
    targetCommit: config.workerBuildId,
    sdkIdentities: taskIdentities,
    workerWitnesses: heads.map((h) => h.worker),
    noJobIdentityMutation: true,
  };
}
const USAGE = `Inspect: temporal-recover-pinned-search.mjs inspect --old-release PATH --target-release PATH --target-runtime-root PATH --manifest PATH --manifest-sha SHA --output PATH
Override ONE original run: ... override --old-release PATH --target-release PATH --target-runtime-root PATH --plan PATH --plan-sha SHA --workflow-id ID --run-id ID --output PATH --apply
Report/reconcile unknown ACK WITHOUT reissuing: ... report --old-release PATH --target-release PATH --target-runtime-root PATH --plan PATH --plan-sha SHA --audit-id UUID --output PATH
No resume/reset/start/terminate/deployment/release-transition action is implemented.`;
export function parseArgs(args) {
  if (args.length === 1 && ['--help', 'help'].includes(args[0])) return { help: true };
  const [action, ...rest] = args,
    o = { action };
  need(['inspect', 'override', 'report'].includes(action), 'ACTION_REQUIRED');
  const allowed = new Set([
    '--old-release',
    '--target-release',
    '--target-runtime-root',
    '--manifest',
    '--manifest-sha',
    '--plan',
    '--plan-sha',
    '--workflow-id',
    '--run-id',
    '--audit-id',
    '--output',
  ]);
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === '--apply') {
      need(!o.apply, 'DUPLICATE_ARGUMENT');
      o.apply = true;
      continue;
    }
    need(
      allowed.has(k) && rest[i + 1] && !rest[i + 1].startsWith('--') && o[k] === undefined,
      'UNKNOWN_OR_DUPLICATE_ARGUMENT'
    );
    o[k] = rest[++i];
  }
  for (const k of ['--old-release', '--target-release', '--target-runtime-root', '--output'])
    need(o[k], 'REQUIRED_ARGUMENT_MISSING');
  need(o.apply === (action === 'override' ? true : undefined), 'EXPLICIT_OVERRIDE_APPLY_ONLY');
  need(
    action === 'inspect' ? o['--manifest'] && o['--manifest-sha'] : o['--plan'] && o['--plan-sha'],
    'PINNED_MANIFEST_OR_PLAN_REQUIRED'
  );
  if (action === 'override') need(o['--workflow-id'] && uuid(o['--run-id']), 'EXACT_ORIGINAL_RUN_REQUIRED');
  if (action === 'report') need(uuid(o['--audit-id']), 'EXACT_AUDIT_REQUIRED');
  return o;
}
export async function createPinnedSearchRecoveryDependencies(o, { originOperatorRoot, reportOnly = false } = {}) {
  need(!originOperatorRoot || reportOnly, 'ORIGIN_OPERATOR_OVERRIDE_REPORT_ONLY');
  need(!reportOnly || o.action === 'report', 'REPORT_ONLY_ACTION_REQUIRED');
  const root = realpathSync(originOperatorRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const oldBytes = bytes(o['--old-release']),
    targetBytes = bytes(o['--target-release']);
  const old = JSON.parse(oldBytes),
    target = JSON.parse(targetBytes);
  const binding = pinReleaseCheckouts(root, realpathSync(o['--target-runtime-root']), target);
  need(binding.operatorCommit === target.compatibilityCommit, 'OPERATOR_MUST_BE_COMMITTED_TARGET_SOURCE');
  const resource = loadReleaseResourceBinding(target),
    previousResource = loadReleaseResourceBinding(old);
  need(resource.resourceDigest === previousResource.resourceDigest, 'FIREBASE_RESOURCE_BINDING_CHANGED');
  const config = json(target.platformConfig);
  validateDescriptors(old, target, config);
  const inputs = {
    oldDescriptorSha256: sha(oldBytes),
    targetDescriptorSha256: sha(targetBytes),
    runtimeRoot: binding.runtimeRoot,
    operatorCommit: binding.operatorCommit,
    operatorClosureDigest: binding.operatorClosureDigest,
    resourceDigest: resource.resourceDigest,
    targetConfigSha256: sha(bytes(target.platformConfig)),
  };
  for (const k of Object.keys(process.env))
    need(!/EMULATOR/.test(k) || !process.env[k], 'LIVE_EMULATOR_OVERRIDE_REFUSED');
  const adc = prepareLocalReleaseADC(binding.runtimeRoot, PROJECT);
  let app, db, connection;
  const require = createRequire(resolve(binding.runtimeRoot, 'apps/temporal-worker/package.json'));
  const adminRequire = createRequire(resolve(binding.runtimeRoot, 'functions/package.json'));
  try {
    const admin = adminRequire('firebase-admin/app');
    app = admin.initializeApp(
      { projectId: PROJECT, credential: adc.credential },
      `pinned-search-recovery-${randomUUID()}`
    );
    db = adminRequire('firebase-admin/firestore').getFirestore(app);
    const stamp = adminRequire('firebase-admin/firestore').FieldValue.serverTimestamp;
    const operator = await verifyReleaseOperator(binding, adc.credential);
    need(operator.verified && operator.adcAndGcloudAccountMatch === true, 'MATCHED_VERIFIED_GOOGLE_OPERATOR_REQUIRED');
    const api = async (url) => {
      need(
        [
          `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}`,
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(resource.resources.storageBucket)}`,
        ].includes(url),
        'READONLY_RESOURCE_URL_REQUIRED'
      );
      const token = await adc.credential.getAccessToken(),
        r = await fetch(url, {
          headers: { authorization: `Bearer ${token.access_token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
        });
      need(r.ok, 'RESOURCE_IDENTITY_READ_FAILED');
      return r.json();
    };
    const resourceIdentity = await verifyReleaseResourceIdentity(resource, api);
    const key = execFileSync(
      'gcloud',
      ['secrets', 'versions', 'access', 'latest', '--secret=TEMPORAL_OPERATOR_API_KEY', '--project', PROJECT],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }
    ).trim();
    need(key, 'TEMPORAL_OPERATOR_KEY_REQUIRED');
    const { Connection, Client } = require('@temporalio/client'),
      { historyToJSON } = require('@temporalio/common/lib/proto-utils');
    connection = await Connection.connect({ address: config.cloudAddress, tls: true, apiKey: key });
    const client = new Client({ connection, namespace: NAMESPACE });
    const cli = (args) =>
      execFileSync('temporal', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TEMPORAL_API_KEY: key },
        timeout: 60000,
        maxBuffer: 32 * 1024 * 1024,
      });
    let targetWorkers = [];
    const guard = async (owned) => {
      const docs = await db.getAll(db.doc(CONTROL), db.doc(STATE), db.doc(OP));
      need(docs[0].exists && docs[1].exists, 'CHECKPOINT_MISSING');
      validateAuthority(old, docs[0].data(), docs[1].data());
      need(
        owned
          ? docs[2].exists && docs[2].get('operationId') === owned && docs[2].get('action') === ACTION
          : !docs[2].exists,
        'OPERATION_NOT_ABSENT_OR_NOT_OWNED'
      );
      // Worker-only source check: no new staging-search Functions env opt-in for inactive UUID.
      assertCheckoutSource(binding.runtimeRoot, target.compatibilityCommit, {
        project: PROJECT,
        control: docs[0].data(),
      });
      const commands = platformOperatorCommands(config),
        flags = ['--address', config.cloudAddress, '--namespace', NAMESPACE, '--tls'];
      assertWorkerRouting(JSON.parse(cli(['--disable-config-file', ...commands.deploymentDescribe, ...flags])), config);
      const nativeVersion = JSON.parse(cli(['--disable-config-file', ...commands.versionDescribe, ...flags]));
      assertWorkerQueues(nativeVersion, config);
      const info = nativeVersion.workerDeploymentVersionInfo ?? nativeVersion;
      const queues = nativeVersion.versionTaskQueues ?? info.taskQueuesInfos ?? [];
      need(
        queues.some(
          (q) =>
            q.name === 'urm-search' && ['workflow', 'TASK_QUEUE_TYPE_WORKFLOW', 1].includes(q.type ?? q.taskQueueType)
        ),
        'NATIVE_SEARCH_WORKFLOW_QUEUE_MISSING'
      );
      const pods = JSON.parse(
        execFileSync(
          'kubectl',
          [
            '--context',
            config.context,
            'get',
            'pods',
            '-n',
            config.namespace,
            '-l',
            `app.kubernetes.io/version=${config.workerBuildId}`,
            '-o',
            'json',
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }
        )
      ).items;
      need(
        Array.isArray(pods) &&
          pods.length === 6 &&
          same(pods.map((p) => p.metadata.labels['urm.temporal/role']).sort(), ROLES) &&
          pods.every(
            (p) =>
              !p.metadata.deletionTimestamp &&
              p.status.phase === 'Running' &&
              p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') &&
              p.spec.containers.length === 1 &&
              p.spec.containers[0].image === config.workerImage &&
              p.status.containerStatuses?.length === 1 &&
              p.status.containerStatuses[0].ready &&
              p.status.containerStatuses[0].imageID === config.workerImage
          ),
        'ACTUAL_SIX_ROLE_TARGET_IMAGE_NOT_READY'
      );
      targetWorkers = pods.map((p) => ({
        role: p.metadata.labels['urm.temporal/role'],
        podName: p.metadata.name,
        podUid: p.metadata.uid,
        containerId: p.status.containerStatuses[0].containerID,
        image: p.status.containerStatuses[0].imageID,
        ...(reportOnly
          ? {
              containerStartedAt: p.status.containerStatuses[0].state?.running?.startedAt,
              restartCount: p.status.containerStatuses[0].restartCount,
            }
          : {}),
      }));
      return { control: nativeSnapshotProof(docs[0]), state: nativeSnapshotProof(docs[1]), resourceIdentity, inputs };
    };
    const observe = async (row, { allowSucceeded = false } = {}) => {
      const [jobDoc, intentDoc] = await db.getAll(
        db.collection('durableJobs').doc(row.jobId),
        db.collection('durableJobIntents').doc(row.jobId)
      );
      const job = jobDoc.data(),
        intent = intentDoc.data();
      need(job?.entity?.type && typeof job.entity.id === 'string', 'SEARCH_ENTITY_REQUIRED');
      const entityKey = sha(JSON.stringify([PROJECT, job.entity.type, job.entity.id, 'search']));
      const entity = (await db.collection('durableJobEntities').doc(entityKey).get()).data();
      validateJob(row, job, intent, entity, allowSucceeded);
      const [hs, ds] = await Promise.all(
        ['durableActivityExecutions', 'durableActivityDrains'].map((collection) =>
          db.collection(collection).where('jobId', '==', row.jobId).limit(1001).get()
        )
      );
      need(hs.size <= 1000 && ds.size <= 1000, 'BOUNDED_EXECUTION_INVENTORY_EXCEEDED');
      const handle = client.workflow.getHandle(row.workflowId, row.runId);
      const description = await connection.withDeadline(Date.now() + 30000, () => handle.describe());
      need(
        description.workflowId === row.workflowId &&
          description.runId === row.runId &&
          description.type === row.workflowType &&
          (description.status.name === 'RUNNING' || (allowSucceeded && description.status.name === 'COMPLETED')),
        'CLOSED_OR_FOREIGN_WORKFLOW_REQUIRES_SEPARATE_RECOVERY'
      );
      const rawHistory = historyToJSON(await connection.withDeadline(Date.now() + 30000, () => handle.fetchHistory()));
      return {
        workflowId: row.workflowId,
        runId: row.runId,
        workflowType: row.workflowType,
        ...(reportOnly ? { observedAt: new Date().toISOString() } : {}),
        status: description.status.name,
        override: description.raw.workflowExecutionInfo?.versioningInfo?.versioningOverride ?? null,
        versioningInfo: canonical(description.raw.workflowExecutionInfo?.versioningInfo),
        pendingActivities: canonical(description.raw.pendingActivities || []),
        jobIdentity: identity(job),
        jobRevision: job.revision,
        intentDigest: proofDigest(intent),
        entityDigest: proofDigest({
          projectId: entity.projectId,
          entity: entity.entity,
          scope: entity.scope,
          activeJobId: entity.activeJobId,
          generation: entity.generation,
        }),
        heads: hs.docs.map((d) => d.data()),
        drains: ds.docs.map((d) => d.data()),
        history: JSON.parse(rawHistory),
        historySha256: sha(rawHistory),
      };
    };
    return {
      db,
      stamp,
      operator,
      onIntent: (value) =>
        console.error(JSON.stringify({ event: 'immutable-search-recovery-intent-created', ...value })),
      config,
      target,
      inputs,
      guard,
      observe,
      ...(reportOnly ? {} : { cli }),
      workers: () => targetWorkers,
      close: async () => {
        const result = await Promise.allSettled([
          Promise.resolve().then(() => connection.close()),
          Promise.resolve().then(() => db.terminate()),
          Promise.resolve().then(() => adminRequire('firebase-admin/app').deleteApp(app)),
        ]);
        adc.close();
        need(
          result.every((r) => r.status === 'fulfilled'),
          'OWNED_SDK_CLEANUP_FAILED'
        );
      },
    };
  } catch (error) {
    await Promise.allSettled([
      Promise.resolve().then(() => connection?.close()),
      Promise.resolve().then(() => db?.terminate()),
      Promise.resolve().then(() => app && adminRequire('firebase-admin/app').deleteApp(app)),
    ]);
    adc.close();
    throw error;
  }
}
export async function recover(o, deps, reportOptions = {}) {
  need(
    Object.keys(reportOptions).every((k) => ['proveMigration', 'operatorBinding'].includes(k)),
    'UNKNOWN_REPORT_OPTION'
  );
  need(
    !Object.keys(reportOptions).length ||
      (typeof reportOptions.proveMigration === 'function' && reportOptions.operatorBinding),
    'COMPLETE_REPORT_OPTIONS_REQUIRED'
  );
  if (Object.keys(reportOptions).length && o.action !== 'report') throw fail('REPORT_OPTIONS_REQUIRE_REPORT_ACTION');
  if (o.action === 'inspect') {
    const m = json(o['--manifest'], o['--manifest-sha']);
    validateManifest(m, deps.target, deps.config);
    const authority = await deps.guard(),
      runs = [];
    for (const row of m.runs) {
      const observation = await deps.observe(row);
      assertOriginalPinnedVersion(observation.versioningInfo, deps.config);
      assertNoRunningActivity(observation.pendingActivities);
      assertSettled(observation.heads, observation.drains);
      validateReplay(
        json(row.replay.path, row.replay.sha256),
        row,
        deps.target,
        deps.config,
        observation.historySha256
      );
      runs.push({ ...row, observation });
    }
    need(same(authority, await deps.guard()), 'INSPECTION_AUTHORITY_CHANGED');
    return {
      schemaVersion: 1,
      scope: ACTION,
      observedAt: new Date().toISOString(),
      authority,
      inputs: deps.inputs,
      manifestPath: o['--manifest'],
      manifestSha256: o['--manifest-sha'],
      runs,
      operator: deps.operator,
      result: 'review-only-no-native-write',
    };
  }
  const plan = json(o['--plan'], o['--plan-sha']);
  need(plan.scope === ACTION && same(plan.inputs, deps.inputs), 'REVIEWED_PLAN_BINDING_CHANGED');
  const reviewedManifest = json(plan.manifestPath, plan.manifestSha256);
  validateManifest(reviewedManifest, deps.target, deps.config);
  need(
    plan.schemaVersion === 1 &&
      Array.isArray(plan.runs) &&
      same(
        plan.runs.map(({ observation, ...entry }) => entry),
        reviewedManifest.runs
      ),
    'PLAN_RUNS_DIFFER_FROM_FINITE_MANIFEST'
  );
  const auditId = o.action === 'override' ? randomUUID() : o['--audit-id'];
  const ref = deps.db.doc(`_control/temporalPinnedSearchRecovery-${auditId}`),
    lock = deps.db.doc(OP);
  const existing = o.action === 'report' ? await ref.get() : undefined;
  const row =
    o.action === 'override'
      ? plan.runs.find((r) => r.workflowId === o['--workflow-id'] && r.runId === o['--run-id'])
      : plan.runs.find((r) => r.workflowId === existing?.get('workflowId') && r.runId === existing?.get('runId'));
  need(
    row && (o.action !== 'report' || existing?.get('planSha256') === o['--plan-sha']),
    'EXACT_REVIEWED_RUN_OR_AUDIT_REQUIRED'
  );
  if (existing) {
    const native = nativeSnapshotProof(existing);
    need(same(native.createTime, native.updateTime), 'RECOVERY_INTENT_WAS_MODIFIED');
  }
  const currentLock = o.action === 'report' ? await lock.get() : undefined;
  const owned = currentLock?.exists ? auditId : undefined;
  const authority = await deps.guard(owned);
  need(same(authority, plan.authority), 'NATIVE_AUTHORITY_CHANGED');
  const observation = await deps.observe(row, { allowSucceeded: o.action === 'report' });
  validateReplay(
    json(row.replay.path, row.replay.sha256),
    row,
    deps.target,
    deps.config,
    row.observation.historySha256
  );
  need(
    same(observation.jobIdentity, row.observation.jobIdentity) &&
      observation.intentDigest === row.observation.intentDigest &&
      observation.entityDigest === row.observation.entityDigest,
    'ADMISSION_IDENTITY_CHANGED'
  );
  if (o.action === 'report') {
    if (reportOptions.operatorBinding) {
      need(same(authority, await deps.guard(owned)), 'REPORT_AUTHORITY_CHANGED');
      need(
        existing.get('action') === ACTION &&
          existing.get('jobId') === row.jobId &&
          existing.get('targetCommit') === deps.config.workerBuildId &&
          existing.get('targetImage') === deps.config.workerImage &&
          same(existing.get('args'), overrideArgs(row, deps.config)) &&
          same(existing.get('before')?.jobIdentity, row.observation.jobIdentity) &&
          existing.get('before')?.intentDigest === row.observation.intentDigest &&
          existing.get('before')?.entityDigest === row.observation.entityDigest &&
          existing.get('before')?.historySha256 === row.observation.historySha256,
        'ORIGINAL_AUDIT_CHANGED'
      );
    }
    const migration = (reportOptions.proveMigration ?? assertMigration)(
      row,
      observation,
      deps.config,
      row.observation.heads,
      deps.workers()
    );
    await deps.db.runTransaction(async (tx) => {
      const entityKey = sha(
        JSON.stringify([
          PROJECT,
          row.observation.jobIdentity.entity.type,
          row.observation.jobIdentity.entity.id,
          'search',
        ])
      );
      const [op, intent, control, state, previousReport, job, jobIntent, entity] = await Promise.all([
        tx.get(lock),
        tx.get(ref),
        tx.get(deps.db.doc(CONTROL)),
        tx.get(deps.db.doc(STATE)),
        reportOptions.operatorBinding ? tx.get(deps.db.doc(`${ref.path}-reported`)) : undefined,
        reportOptions.operatorBinding ? tx.get(deps.db.doc(`durableJobs/${row.jobId}`)) : undefined,
        reportOptions.operatorBinding ? tx.get(deps.db.doc(`durableJobIntents/${row.jobId}`)) : undefined,
        reportOptions.operatorBinding ? tx.get(deps.db.doc(`durableJobEntities/${entityKey}`)) : undefined,
      ]);
      assertNativeSnapshot(plan.authority.control, control);
      assertNativeSnapshot(plan.authority.state, state);
      need(intent.exists && intent.get('planSha256') === o['--plan-sha'], 'IMMUTABLE_INTENT_CHANGED');
      if (reportOptions.operatorBinding) {
        assertNativeSnapshot(nativeSnapshotProof(existing), intent);
        validateJob(row, job.data(), jobIntent.data(), entity.data(), true);
        need(
          same(identity(job.data()), row.observation.jobIdentity) &&
            proofDigest(jobIntent.data()) === observation.intentDigest &&
            proofDigest({
              projectId: entity.get('projectId'),
              entity: entity.get('entity'),
              scope: entity.get('scope'),
              activeJobId: entity.get('activeJobId'),
              generation: entity.get('generation'),
            }) === observation.entityDigest,
          'REPORT_ADMISSION_CHANGED'
        );
        if (previousReport.exists) {
          const native = nativeSnapshotProof(previousReport),
            saved = previousReport.data();
          need(same(native.createTime, native.updateTime), 'REPORTED_AUDIT_WAS_MODIFIED');
          const { observedAt, operator, ...facts } = saved;
          need(
            same(facts, { ...migration, reportOperatorBinding: reportOptions.operatorBinding }) &&
              same(operator, deps.operator) &&
              !op.exists,
            'EXISTING_REPORT_CHANGED'
          );
          return;
        }
      }
      if (op.exists) {
        need(
          op.get('operationId') === auditId &&
            op.get('action') === ACTION &&
            op.get('planSha256') === o['--plan-sha'] &&
            op.get('releaseId') === OLD_RELEASE,
          'FOREIGN_OPERATION'
        );
        tx.delete(lock);
      }
      tx.create(deps.db.doc(`${ref.path}-reported`), {
        ...migration,
        ...(reportOptions.operatorBinding ? { reportOperatorBinding: reportOptions.operatorBinding } : {}),
        operator: deps.operator,
        observedAt: deps.stamp(),
      });
    });
    return { result: 'actual-original-run-migration-observed', auditId, migration, nativeObservation: observation };
  }
  assertOriginalPinnedVersion(observation.versioningInfo, deps.config);
  assertNoRunningActivity(observation.pendingActivities);
  assertSettled(observation.heads, observation.drains);
  need(observation.historySha256 === row.observation.historySha256, 'REPLAY_HISTORY_CHANGED_REINSPECT_AND_REPLAY');
  need(!targetOverride(observation.override, deps.config), 'ALREADY_OVERRIDDEN_INSPECT_EXISTING_AUDIT');
  const args = overrideArgs(row, deps.config);
  await deps.db.runTransaction(async (tx) => {
    const key = sha(
      JSON.stringify([
        PROJECT,
        row.observation.jobIdentity.entity.type,
        row.observation.jobIdentity.entity.id,
        'search',
      ])
    );
    const [control, state, operation, job, intent, entity] = await Promise.all([
      tx.get(deps.db.doc(CONTROL)),
      tx.get(deps.db.doc(STATE)),
      tx.get(lock),
      tx.get(deps.db.doc(`durableJobs/${row.jobId}`)),
      tx.get(deps.db.doc(`durableJobIntents/${row.jobId}`)),
      tx.get(deps.db.doc(`durableJobEntities/${key}`)),
    ]);
    validateJob(row, job.data(), intent.data(), entity.data());
    assertNativeSnapshot(plan.authority.control, control);
    assertNativeSnapshot(plan.authority.state, state);
    need(
      !operation.exists && same(identity(job.data()), row.observation.jobIdentity),
      'AUTHORITY_OR_JOB_CHANGED_BEFORE_INTENT'
    );
    tx.create(ref, {
      action: ACTION,
      planSha256: o['--plan-sha'],
      workflowId: row.workflowId,
      runId: row.runId,
      jobId: row.jobId,
      targetCommit: deps.config.workerBuildId,
      targetImage: deps.config.workerImage,
      args,
      before: canonical(observation),
      operator: deps.operator,
      createdAt: deps.stamp(),
    });
    tx.create(lock, {
      action: ACTION,
      operationId: auditId,
      releaseId: OLD_RELEASE,
      planSha256: o['--plan-sha'],
      createdAt: deps.stamp(),
    });
  });
  deps.onIntent?.({ auditId, workflowId: row.workflowId, runId: row.runId });
  await deps.guard(auditId);
  const immediatelyBefore = await deps.observe(row);
  assertOriginalPinnedVersion(immediatelyBefore.versioningInfo, deps.config);
  assertNoRunningActivity(immediatelyBefore.pendingActivities);
  assertSettled(immediatelyBefore.heads, immediatelyBefore.drains);
  need(
    same(immediatelyBefore.jobIdentity, observation.jobIdentity) &&
      immediatelyBefore.historySha256 === observation.historySha256,
    'RUN_CHANGED_AFTER_INTENT_STOP_NO_CLI_WRITE'
  );
  let stdout, cliError;
  try {
    stdout = await deps.cli(args);
  } catch {
    cliError = true;
  }
  // Always reread once, never issue a second override on an uncertain acknowledgement.
  const after = await deps.observe(row, { allowSucceeded: true });
  await deps.db.doc(`${ref.path}-ack`).create({
    cliExitedZero: !cliError,
    stdoutSha256: stdout === undefined ? null : sha(stdout),
    observedOverride: canonical(after.override),
    planSha256: o['--plan-sha'],
    observedAt: deps.stamp(),
  });
  need(!cliError && targetOverride(after.override, deps.config), 'UNKNOWN_OVERRIDE_ACK_STOP_AND_REPORT_NO_RECALL');
  await deps.db.runTransaction(async (tx) => {
    const op = await tx.get(lock);
    need(
      op.get('operationId') === auditId &&
        op.get('action') === ACTION &&
        op.get('planSha256') === o['--plan-sha'] &&
        op.get('releaseId') === OLD_RELEASE,
      'OWNED_OPERATION_CHANGED'
    );
    tx.delete(lock);
  });
  return {
    result: 'override-observed-not-migration-proof',
    auditId,
    workflowId: row.workflowId,
    runId: row.runId,
    next: 'Use normal authenticated durable resume if offered; report only after real target execution/history exists.',
  };
}
export async function main(args) {
  const o = parseArgs(args);
  if (o.help) {
    console.log(USAGE);
    return;
  }
  try {
    lstatSync(o['--output']);
    throw fail('FRESH_OUTPUT_REQUIRED');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const deps = await createPinnedSearchRecoveryDependencies(o);
  let failed;
  let result;
  try {
    result = await recover(o, deps);
  } catch (error) {
    failed = error;
  } finally {
    try {
      await deps.close();
    } catch (error) {
      failed ||= error;
    }
  }
  if (failed) throw failed;
  output(o['--output'], result);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.code || 'PINNED_SEARCH_RECOVERY_STOPPED_INSPECT_PRIVATE_AUDIT');
    process.exitCode = 1;
  });
