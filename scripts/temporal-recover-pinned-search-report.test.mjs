// Pure native-wire/protocol fixtures. No SDK connection or historical journal mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertRoleAppropriateMigration,
  validateReportBindings,
  parseReportArgs,
  ORIGINAL_OPERATOR_COMMIT,
} from './temporal-recover-pinned-search-report.mjs';
import { assertMigration, recover, createPinnedSearchRecoveryDependencies } from './temporal-recover-pinned-search.mjs';
const commit = ORIGINAL_OPERATOR_COMMIT;
function fixture(role = 'search') {
  const config = {
    workerBuildId: commit,
    workerImage: 'registry/worker@sha256:' + 'b'.repeat(64),
    workerDeploymentName: 'urm-worker-staging',
  };
  const row = {
    jobId: 'original',
    workflowId: 'search:urm-app-staging:original',
    runId: '01a14238-5577-7a74-8842-8c75ee32346d',
    workflowType: role === 'search' ? 'SearchDocument' : 'SearchBackfill',
  };
  const workers = ['controls', 'email', 'images', 'media', 'orchestration', 'search'].map((role) => ({
    role,
    podName: role + '-pod',
    podUid: role + '-uid',
    containerId: 'containerd://' + role,
    image: config.workerImage,
    containerStartedAt: '2026-10-16T05:55:00Z',
    restartCount: 0,
  }));
  const worker = { instanceId: 'e5416587-2a0d-4835-b632-99734ebcffd3', buildId: commit };
  const h = {
    projectId: 'urm-app-staging',
    jobId: row.jobId,
    workflowId: row.workflowId,
    runId: row.runId,
    executionId: 'exact-execution',
    activityId: '1',
    activityType: role === 'search' ? 'syncSearchDocument' : 'loadSearchBackfillPage',
    scheduledAt: Date.parse('2026-10-16T00:59:10.629294063Z'),
    attempt: 9,
    worker,
  };
  const version = { buildId: commit };
  const identity = '7@' + role + '-pod';
  const observation = {
    ...row,
    status: 'COMPLETED',
    override: { pinned: { version: { deploymentName: config.workerDeploymentName, buildId: commit } } },
    observedAt: '2026-10-16T06:37:00Z',
    heads: [h],
    drains: [
      {
        projectId: h.projectId,
        jobId: h.jobId,
        executionId: h.executionId,
        execution: { attempt: h.attempt, runId: h.runId, worker },
        state: 'drained',
        source: 'worker_settled',
      },
    ],
    history: {
      events: [
        {
          eventId: '5',
          eventTime: '2026-10-16T00:59:10.629294063Z',
          activityTaskScheduledEventAttributes: {
            activityId: '1',
            activityType: { name: h.activityType },
            taskQueue: { name: 'urm-' + role },
          },
        },
        {
          eventId: '7',
          eventTime: '2026-10-16T06:36:00.123456789Z',
          activityTaskStartedEventAttributes: { scheduledEventId: '5', attempt: 9, identity, workerVersion: version },
        },
        {
          eventId: '8',
          eventTime: '2026-10-16T06:36:01.123456789Z',
          activityTaskCompletedEventAttributes: { scheduledEventId: '5', startedEventId: '7', identity },
        },
        {
          eventId: '11',
          eventTime: '2026-10-16T06:36:02.123456789Z',
          workflowTaskCompletedEventAttributes: {
            identity: '7@search-pod',
            workerVersion: version,
            workerDeploymentName: config.workerDeploymentName,
            deploymentVersion: { deploymentName: config.workerDeploymentName, buildId: commit },
          },
        },
      ],
    },
  };
  return { row, observation, config, prior: [{ worker: { instanceId: 'old-instance', buildId: '580' } }], workers };
}
function prove(f) {
  return assertRoleAppropriateMigration(f.row, f.observation, f.config, f.prior, f.workers);
}
for (const role of ['search', 'controls'])
  test(
    'actual minimal ' + role + ' witness joins scheduled/started/completed native activity and search workflow Pod',
    () => {
      const f = fixture(role);
      const before = structuredClone(f.observation.heads);
      const r = prove(f);
      assert.deepEqual(r.workerWitnesses, [f.observation.heads[0].worker]);
      assert.deepEqual(f.observation.heads, before);
      assert.equal(r.nativeActivityPodBindings[0].role, role);
      assert.equal(r.nativeWorkflowPodBindings[0].worker.role, 'search');
      assert.equal('podUid' in r.workerWitnesses[0], false);
      assert.equal('workerVersion' in f.observation.history.events[2].activityTaskCompletedEventAttributes, false);
      assert.throws(() => assertMigration(f.row, f.observation, f.config, f.prior, f.workers), /ACTUAL_NEW_EXECUTION/);
    }
  );
const changes = {
  foreignPod: (f) => (f.observation.history.events[1].activityTaskStartedEventAttributes.identity = '7@foreign'),
  foreignActivityBuild: (f) =>
    (f.observation.history.events[1].activityTaskStartedEventAttributes.workerVersion = { buildId: 'old' }),
  staleHeadBuild: (f) => (f.observation.heads[0].worker.buildId = 'old'),
  unsettled: (f) => (f.observation.drains = []),
  foreignDrainInstance: (f) => (f.observation.drains[0].execution.worker = { instanceId: 'other' }),
  reusedInstance: (f) => (f.prior[0].worker.instanceId = f.observation.heads[0].worker.instanceId),
  foreignRun: (f) => (f.observation.runId = 'other'),
  missingCompletion: (f) => f.observation.history.events.splice(2, 1),
  missingStart: (f) => f.observation.history.events.splice(1, 1),
  foreignCompletedIdentity: (f) =>
    (f.observation.history.events[2].activityTaskCompletedEventAttributes.identity = '7@controls-pod'),
  wrongAttempt: (f) => (f.observation.history.events[1].activityTaskStartedEventAttributes.attempt = 8),
  wrongScheduledEvent: (f) =>
    (f.observation.history.events[2].activityTaskCompletedEventAttributes.scheduledEventId = '4'),
  wrongStartedEvent: (f) => (f.observation.history.events[2].activityTaskCompletedEventAttributes.startedEventId = '6'),
  wrongActivityType: (f) => (f.observation.heads[0].activityType = 'other'),
  wrongScheduledAt: (f) => f.observation.heads[0].scheduledAt++,
  unknownQueue: (f) =>
    (f.observation.history.events[0].activityTaskScheduledEventAttributes.taskQueue.name = 'urm-other'),
  wrongWorkflowPod: (f) =>
    (f.observation.history.events[3].workflowTaskCompletedEventAttributes.identity = '7@controls-pod'),
  wrongWorkflowBuild: (f) =>
    (f.observation.history.events[3].workflowTaskCompletedEventAttributes.workerVersion = { buildId: 'old' }),
  wrongWorkflowDeployment: (f) =>
    (f.observation.history.events[3].workflowTaskCompletedEventAttributes.deploymentVersion = {
      buildId: commit,
      deploymentName: 'foreign',
    }),
  beforeContainerRestart: (f) =>
    (f.workers.find((w) => w.role === 'search').containerStartedAt = '2026-10-16T06:36:01Z'),
  afterObservation: (f) => (f.observation.observedAt = '2026-10-16T06:35:00Z'),
  missingContainerBirth: (f) => delete f.workers.find((w) => w.role === 'search').containerStartedAt,
  duplicateHistory: (f) => f.observation.history.events.push(f.observation.history.events[0]),
  wrongPodImage: (f) => (f.workers.find((w) => w.role === 'search').image = 'foreign'),
};
for (const [name, change] of Object.entries(changes))
  test('role proof rejects ' + name, () => {
    const f = fixture();
    change(f);
    assert.throws(() => prove(f));
  });
function bindings() {
  const origin = {
    operatorCommit: commit,
    operatorClosureDigest: 'a'.repeat(64),
    runtimeCommit: commit,
    runtimeRoot: '/original/runtime',
  };
  return {
    origin,
    current: { ...origin, operatorCommit: 'b'.repeat(40), operatorClosureDigest: 'c'.repeat(64) },
    target: { compatibilityCommit: commit },
  };
}
test('current descendant report provenance is separate from original plan/operator/runtime', () => {
  const f = bindings();
  const p = validateReportBindings(f.current, f.origin, f.target, true);
  assert.equal(p.originalOperatorCommit, commit);
  assert.equal(p.operatorCommit, f.current.operatorCommit);
  assert.equal(p.runtimeCommit, commit);
});
for (const key of ['origin', 'current', 'target', 'ancestry'])
  test('report source binding rejects ' + key, () => {
    const f = bindings();
    let ancestor = true;
    if (key === 'origin') f.origin.operatorCommit = 'd'.repeat(40);
    if (key === 'current') f.current.runtimeRoot = '/foreign';
    if (key === 'target') f.target.compatibilityCommit = 'e'.repeat(40);
    if (key === 'ancestry') ancestor = false;
    assert.throws(() => validateReportBindings(f.current, f.origin, f.target, ancestor));
  });
const args = [
  'report',
  '--origin-operator-root',
  '/old',
  '--old-release',
  '/old.json',
  '--target-release',
  '/target.json',
  '--target-runtime-root',
  '/runtime',
  '--plan',
  '/plan',
  '--plan-sha',
  'a'.repeat(64),
  '--audit-id',
  '11111111-2222-4333-8444-555555555555',
  '--output',
  '/output',
];
test('report parser preserves exact original inputs, refuses extra/duplicate/override flags', () => {
  const p = parseReportArgs(args);
  assert.equal(p.originOperatorRoot, '/old');
  assert.equal(p.options['--plan-sha'], 'a'.repeat(64));
  for (const extra of [
    ['--apply'],
    ['--manifest', '/ignored'],
    ['--origin-operator-root', '/other'],
    ['--unknown', 'x'],
  ])
    assert.throws(() => parseReportArgs([...args, ...extra]));
  assert.throws(() => parseReportArgs(['override', ...args.slice(1)]));
});
test('report extension cannot reach default inspect/override and unknown options are never stripped', async () => {
  for (const action of ['inspect', 'override'])
    await assert.rejects(
      recover({ action }, {}, { proveMigration: () => {}, operatorBinding: {} }),
      /REPORT_OPTIONS_REQUIRE_REPORT_ACTION/
    );
  await assert.rejects(recover({ action: 'report' }, {}, { unknown: true }), /UNKNOWN_REPORT_OPTION/);
  await assert.rejects(
    createPinnedSearchRecoveryDependencies({ action: 'override' }, { reportOnly: true }),
    /REPORT_ONLY_ACTION_REQUIRED/
  );
  await assert.rejects(
    createPinnedSearchRecoveryDependencies({ action: 'report' }, { originOperatorRoot: '/ignored' }),
    /ORIGIN_OPERATOR_OVERRIDE_REPORT_ONLY/
  );
});
