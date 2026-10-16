#!/usr/bin/env node
/** Versioned report repair only. No native workflow mutation capability is exposed. */
import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { proofDigest, canonical } from './temporal-release-runtime.mjs';
import {
  PROJECT,
  parseArgs,
  targetOverride,
  assertSettled,
  recover,
  createPinnedSearchRecoveryDependencies,
} from './temporal-recover-pinned-search.mjs';
import { pinRecoveryOperatorBindings } from './temporal-pinned-search-operator-binding.mjs';
export { ORIGINAL_OPERATOR_COMMIT } from './temporal-pinned-search-operator-binding.mjs';
const need = (value, code) => {
  if (!value) throw Object.assign(new Error(code), { code });
};
const same = (a, b) => proofDigest(a) === proofDigest(b);
const readJson = (path, sha) => {
  need(typeof path === 'string' && resolve(path) === path, 'ABSOLUTE_ARTIFACT_REQUIRED');
  const s = lstatSync(path);
  need(s.isFile() && !s.isSymbolicLink() && s.size <= 32 * 1024 * 1024, 'REGULAR_BOUNDED_ARTIFACT_REQUIRED');
  const bytes = readFileSync(path);
  if (sha)
    need(
      /^[a-f0-9]{64}$/.test(sha) && createHash('sha256').update(bytes).digest('hex') === sha,
      'ARTIFACT_HASH_CHANGED'
    );
  return JSON.parse(bytes);
};
const time = (value) => {
  need(
    typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value),
    'NATIVE_EVENT_TIME_REQUIRED'
  );
  const t = Date.parse(value);
  need(Number.isFinite(t), 'NATIVE_EVENT_TIME_REQUIRED');
  return t;
};
function podFor(identity, role, workers, config) {
  const candidates = workers.filter(
    (w) =>
      w.role === role &&
      typeof identity === 'string' &&
      identity.split('@').length === 2 &&
      identity.split('@')[0].length > 0 &&
      identity.split('@')[1] === w.podName
  );
  need(candidates.length === 1, 'NATIVE_IDENTITY_NOT_CURRENT_ROLE_POD');
  const w = candidates[0];
  need(
    w.image === config.workerImage &&
      typeof w.podUid === 'string' &&
      w.podUid &&
      typeof w.containerId === 'string' &&
      w.containerId &&
      Number.isSafeInteger(w.restartCount) &&
      w.restartCount >= 0,
    'CURRENT_POD_CONTAINER_IDENTITY_REQUIRED'
  );
  time(w.containerStartedAt);
  return w;
}
function withinContainer(event, worker, observedAt) {
  const at = time(event.eventTime);
  need(at >= time(worker.containerStartedAt) && at <= time(observedAt), 'EVENT_OUTSIDE_CURRENT_CONTAINER_LIFETIME');
  return at;
}
/** Keeps the original minimal journal witness; native evidence supplies a separate Pod/container join. */
export function assertRoleAppropriateMigration(row, observation, config, prior, workers) {
  need(
    observation.workflowId === row.workflowId &&
      observation.runId === row.runId &&
      observation.workflowType === row.workflowType &&
      ['RUNNING', 'COMPLETED'].includes(observation.status) &&
      targetOverride(observation.override, config),
    'TARGET_OVERRIDE_NOT_OBSERVED'
  );
  need(
    Array.isArray(workers) && workers.length === 6 && new Set(workers.map((w) => w.role)).size === 6,
    'ACTUAL_TARGET_POD_IDENTITIES_REQUIRED'
  );
  const events = observation.history?.events;
  need(
    Array.isArray(events) && events.length && new Set(events.map((e) => String(e.eventId))).size === events.length,
    'UNIQUE_NATIVE_HISTORY_REQUIRED'
  );
  time(observation.observedAt);
  const heads = observation.heads.filter((h) => h.runId === row.runId && h.worker?.buildId === config.workerBuildId);
  need(heads.length > 0, 'ACTUAL_NEW_EXECUTION_AND_SDK_HISTORY_REQUIRED');
  assertSettled(heads, observation.drains);
  need(
    heads.every((h) =>
      observation.drains.some(
        (d) =>
          d.executionId === h.executionId &&
          d.execution?.attempt === h.attempt &&
          d.execution?.runId === h.runId &&
          same(d.execution?.worker, h.worker) &&
          d.projectId === PROJECT &&
          d.jobId === row.jobId &&
          d.state === 'drained' &&
          d.source === 'worker_settled'
      )
    ),
    'EXACT_MINIMAL_WORKER_DRAIN_REQUIRED'
  );
  const bindings = heads.map((h) => {
    need(
      h.projectId === PROJECT &&
        h.jobId === row.jobId &&
        h.workflowId === row.workflowId &&
        typeof h.worker.instanceId === 'string' &&
        h.worker.instanceId &&
        typeof h.executionId === 'string' &&
        h.executionId &&
        Number.isSafeInteger(h.attempt) &&
        h.attempt > 0 &&
        Number.isSafeInteger(h.scheduledAt) &&
        typeof h.activityId === 'string' &&
        typeof h.activityType === 'string',
      'EXACT_MINIMAL_EXECUTION_REQUIRED'
    );
    need(!prior.some((p) => p.worker?.instanceId === h.worker.instanceId), 'NEW_EXECUTION_INSTANCE_REQUIRED');
    const scheduled = events.filter((e) => e.activityTaskScheduledEventAttributes?.activityId === h.activityId);
    need(scheduled.length === 1, 'EXACT_ACTIVITY_SCHEDULE_REQUIRED');
    const s = scheduled[0],
      a = s.activityTaskScheduledEventAttributes;
    need(a.activityType?.name === h.activityType && time(s.eventTime) === h.scheduledAt, 'JOURNAL_SCHEDULE_CHANGED');
    const role = { 'urm-search': 'search', 'urm-controls': 'controls' }[a.taskQueue?.name];
    need(role, 'UNKNOWN_ACTIVITY_QUEUE');
    const starts = events.filter(
      (e) =>
        String(e.activityTaskStartedEventAttributes?.scheduledEventId) === String(s.eventId) &&
        e.activityTaskStartedEventAttributes?.attempt === h.attempt
    );
    need(starts.length === 1, 'EXACT_ACTIVITY_START_REQUIRED');
    const start = starts[0],
      started = start.activityTaskStartedEventAttributes;
    need(started.workerVersion?.buildId === config.workerBuildId, 'ACTIVITY_BUILD_CHANGED');
    const worker = podFor(started.identity, role, workers, config);
    const completions = events.filter(
      (e) =>
        String(e.activityTaskCompletedEventAttributes?.scheduledEventId) === String(s.eventId) &&
        String(e.activityTaskCompletedEventAttributes?.startedEventId) === String(start.eventId)
    );
    need(
      completions.length === 1 && completions[0].activityTaskCompletedEventAttributes.identity === started.identity,
      'EXACT_ACTIVITY_COMPLETION_REQUIRED'
    );
    const startedAt = withinContainer(start, worker, observation.observedAt);
    need(withinContainer(completions[0], worker, observation.observedAt) >= startedAt, 'ACTIVITY_TIME_ORDER_CHANGED');
    return {
      executionId: h.executionId,
      attempt: h.attempt,
      activityId: h.activityId,
      activityType: h.activityType,
      scheduledEventId: String(s.eventId),
      startedEventId: String(start.eventId),
      completedEventId: String(completions[0].eventId),
      identity: started.identity,
      role,
      worker: canonical(worker),
    };
  });
  const tasks = events.filter((e) => {
    const t = e.workflowTaskCompletedEventAttributes;
    return (
      t &&
      t.workerVersion?.buildId === config.workerBuildId &&
      t.workerDeploymentName === config.workerDeploymentName &&
      t.deploymentVersion?.buildId === config.workerBuildId &&
      t.deploymentVersion?.deploymentName === config.workerDeploymentName
    );
  });
  need(tasks.length > 0, 'TARGET_WORKFLOW_TASK_REQUIRED');
  const workflowBindings = tasks.map((e) => {
    const worker = podFor(e.workflowTaskCompletedEventAttributes.identity, 'search', workers, config);
    withinContainer(e, worker, observation.observedAt);
    return {
      eventId: String(e.eventId),
      identity: e.workflowTaskCompletedEventAttributes.identity,
      worker: canonical(worker),
    };
  });
  return {
    workflowId: row.workflowId,
    runId: row.runId,
    targetCommit: config.workerBuildId,
    sdkIdentities: workflowBindings.map((w) => w.identity),
    workerWitnesses: heads.map((h) => h.worker),
    nativeActivityPodBindings: bindings,
    nativeWorkflowPodBindings: workflowBindings,
    noJobIdentityMutation: true,
  };
}
export { validateRecoveryOperatorBindings as validateReportBindings } from './temporal-pinned-search-operator-binding.mjs';
export function parseReportArgs(args) {
  need(args[0] === 'report' && !args.includes('--apply'), 'REPORT_ONLY_ACTION_REQUIRED');
  const allowed = new Set([
    '--origin-operator-root',
    '--old-release',
    '--target-release',
    '--target-runtime-root',
    '--plan',
    '--plan-sha',
    '--audit-id',
    '--output',
  ]);
  for (let i = 1; i < args.length; i += 2)
    need(allowed.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'), 'UNKNOWN_REPORT_ARGUMENT');
  const copy = [...args],
    i = copy.indexOf('--origin-operator-root');
  need(
    i > 0 && copy[i + 1] && !copy[i + 1].startsWith('--') && copy.lastIndexOf('--origin-operator-root') === i,
    'EXACT_ORIGIN_OPERATOR_ROOT_REQUIRED'
  );
  const originOperatorRoot = copy[i + 1];
  copy.splice(i, 2);
  return { options: parseArgs(copy), originOperatorRoot };
}
export async function main(args) {
  const { options: o, originOperatorRoot } = parseReportArgs(args);
  try {
    lstatSync(o['--output']);
    throw Object.assign(new Error('FRESH_OUTPUT_REQUIRED'), { code: 'FRESH_OUTPUT_REQUIRED' });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const currentRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const target = readJson(o['--target-release']);
  const { origin, operatorBinding } = pinRecoveryOperatorBindings(
    currentRoot,
    originOperatorRoot,
    o['--target-runtime-root'],
    target
  );
  const deps = await createPinnedSearchRecoveryDependencies(o, {
    originOperatorRoot: origin.operatorRoot,
    reportOnly: true,
  });
  let failure, result;
  try {
    result = await recover(o, deps, { proveMigration: assertRoleAppropriateMigration, operatorBinding });
  } catch (e) {
    failure = e;
  } finally {
    try {
      await deps.close();
    } catch (e) {
      failure ||= e;
    }
  }
  if (failure) throw failure;
  writeFileSync(
    o['--output'],
    JSON.stringify(canonical({ ...result, reportOperatorBinding: operatorBinding }), null, 2) + '\n',
    { flag: 'wx', mode: 0o600 }
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.code || 'REPORT_ONLY_RECOVERY_STOPPED');
    process.exitCode = 1;
  });
