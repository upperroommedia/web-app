// Pure protocol/fake adapter tests ONLY. These do not prove SDK replay, live IAM or native routing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  PROJECT,
  OLD_COMMIT,
  OLD_RELEASE,
  NAMESPACE,
  validateDescriptors,
  validateAuthority,
  validateManifest,
  overrideArgs,
  targetOverride,
  validateJob,
  assertOriginalPinnedVersion,
  assertSettled,
  assertNoRunningActivity,
  assertMigration,
  validateReplay,
  parseArgs,
  recover,
} from './temporal-recover-pinned-search.mjs';
import { nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';
const S = 'a'.repeat(40),
  IMAGE = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`;
const RUN = '11111111-2222-4333-8444-555555555555';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const config = {
  firebaseProjectId: PROJECT,
  cloudProvider: 'gcp',
  cloudRegion: 'us-central1',
  cloudAccountId: 'qwejt',
  connectionMode: 'temporal-cloud',
  temporalNamespace: NAMESPACE,
  cloudAddress: 'urm-app-staging.qwejt.tmprl.cloud:7233',
  workerDeploymentName: 'urm-worker-staging',
  workerBuildId: S,
  workerImage: IMAGE,
  workerRoles: ['orchestration', 'controls', 'media', 'email', 'images', 'search'],
};
const row = {
  jobId: 'document-one',
  workflowId: `search:${PROJECT}:document-one`,
  runId: RUN,
  workflowType: 'SearchDocument',
};
function descriptor(commit = OLD_COMMIT, id = OLD_RELEASE) {
  return {
    environment: 'staging',
    projectId: PROJECT,
    backendId: 'web-staging',
    location: 'us-central1',
    releaseId: id,
    compatibilityCommit: commit,
    uiCommit: commit,
    mode: 'initial-cutover',
    domains: ['search'],
    legacyExecutionGraceSeconds: 3600,
    providerUsageBackfillTimeoutMs: 60000,
    databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com',
    mailCollection: 'mail',
    legacyQueues: ['processaudiofiletask', 'processaudioyoutubetask'],
    additionalLegacyQueues: [],
    platformConfig: '/fixture/platform.json',
    platformPeerConfig: '/fixture/peer.json',
    compatibilityEvidence: '/fixture/compat.json',
    backendEvidence: '/fixture/backend.json',
    smokeEvidence: '/fixture/smoke.json',
    searchSettingsEvidence: '/fixture/settings.json',
  };
}
const old = descriptor(),
  target = descriptor(S, '22222222-3333-4444-8555-666666666666');
function boundary() {
  const t = { seconds: 1792100000, nanoseconds: 123456789 };
  return {
    control: {
      schemaVersion: 1,
      revision: 28,
      releaseId: OLD_RELEASE,
      admission: 'paused',
      legacyAdmissionCutoff: t,
      domains: Object.fromEntries(
        ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
          d,
          { owner: 'temporal', admission: d === 'search' ? 'paused' : 'open' },
        ])
      ),
    },
    state: {
      releaseId: OLD_RELEASE,
      controlRevision: 28,
      phase: 'backend-ready',
      mode: 'initial-cutover',
      compatibilityCommit: OLD_COMMIT,
      uiCommit: OLD_COMMIT,
      domains: ['search'],
      legacySettlingCutoff: t,
      compatibilityVerifiedAt: t,
      legacySettlingGraceSeconds: 3600,
      maximumLegacyExecutionSeconds: 540,
    },
  };
}
function admission() {
  const entity = { type: 'maintenance', id: 'fixture-doc' };
  return {
    job: {
      projectId: PROJECT,
      jobId: row.jobId,
      workflowId: row.workflowId,
      kind: 'search.sync',
      requestedBy: 'system:search',
      requestId: 'fixture-request',
      generation: 2,
      createdAt: 1,
      entity,
      state: 'needs_attention',
      revision: 7,
    },
    intent: {
      projectId: PROJECT,
      jobId: row.jobId,
      kind: 'search.sync',
      actorUid: 'system:search',
      generation: 2,
      entity,
    },
    entity: { projectId: PROJECT, activeJobId: row.jobId, generation: 2 },
  };
}
function execution(build = OLD_COMMIT, instance = 'old-instance') {
  return {
    projectId: PROJECT,
    jobId: row.jobId,
    executionId: 'execution-one',
    runId: RUN,
    attempt: 1,
    worker: {
      buildId: build,
      instanceId: instance,
      podName: instance,
      podUid: instance + '-uid',
      containerIds: ['containerd://fixture'],
    },
  };
}
const drain = (head) => ({
  projectId: PROJECT,
  jobId: row.jobId,
  executionId: head.executionId,
  execution: { runId: head.runId, attempt: head.attempt, worker: head.worker },
  state: 'drained',
  source: 'worker_settled',
});
const pinned = { pinned: { version: { deploymentName: config.workerDeploymentName, buildId: S } } };
test('new honest target and exact old paused native authority are accepted', () => {
  validateDescriptors(old, target, config);
  const b = boundary();
  validateAuthority(old, b.control, b.state);
});
for (const [name, change] of Object.entries({
  'same-source': (x) => (x.target.compatibilityCommit = OLD_COMMIT),
  'same-UUID': (x) => (x.target.releaseId = OLD_RELEASE),
  'partial-roles': (x) => x.config.workerRoles.pop(),
  'foreign-project': (x) => (x.config.firebaseProjectId = 'urm-app'),
  'tagged-image': (x) => (x.config.workerImage = 'worker:latest'),
}))
  test(`descriptor rejects ${name}`, () => {
    const x = structuredClone({ target, config });
    change(x);
    assert.throws(() => validateDescriptors(old, x.target, x.config));
  });
for (const [name, change] of Object.entries({
  'open-global': (b) => (b.control.admission = 'open'),
  revision29: (b) => (b.control.revision = 29),
  'search-ready': (b) => (b.state.phase = 'search-ready'),
  'old-source-relabel': (b) => (b.state.compatibilityCommit = S),
  'legacy-owner': (b) => (b.control.domains.search.owner = 'legacy'),
  'domain-open': (b) => (b.control.domains.search.admission = 'open'),
  'cutoff-change': (b) => (b.state.legacySettlingCutoff = { seconds: 1, nanoseconds: 0 }),
  'grace-shortened': (b) => (b.state.legacySettlingGraceSeconds = 3599),
  'eighth-domain': (b) => (b.control.domains.other = { owner: 'temporal', admission: 'paused' }),
}))
  test(`authority rejects ${name}`, () => {
    const b = boundary();
    change(b);
    assert.throws(() => validateAuthority(old, b.control, b.state));
  });
test('manifest and CLI write are finite exact-original-run pinned only', () => {
  const m = {
    schemaVersion: 1,
    projectId: PROJECT,
    oldReleaseId: OLD_RELEASE,
    oldControlRevision: 28,
    targetCommit: S,
    targetImage: IMAGE,
    runs: [row],
  };
  validateManifest(m, target, config);
  assert.throws(() => validateManifest({ ...m, runs: [row, row] }, target, config));
  assert.throws(() => validateManifest({ ...m, runs: [{ ...row, workflowType: 'Publishing' }] }, target, config));
  const args = overrideArgs(row, config);
  assert.equal(args[args.indexOf('--run-id') + 1], RUN);
  assert.equal(args[args.indexOf('--versioning-override-behavior') + 1], 'pinned');
  for (const forbidden of [
    '--query',
    'reset',
    'start',
    'terminate',
    'auto_upgrade',
    '--ignore-missing-task-queues',
    '--allow-no-pollers',
  ])
    assert.equal(args.includes(forbidden), false);
});
test('native override accepts supported pinned representations and rejects foreign/mixed forms', () => {
  assert.equal(targetOverride(pinned, config), true);
  assert.equal(targetOverride({ behavior: 1, pinnedVersion: `${config.workerDeploymentName}.${S}` }, config), true);
  for (const v of [
    { autoUpgrade: true },
    { oneTime: {} },
    { pinned: { version: { deploymentName: 'other', buildId: S } } },
    { ...pinned, pinnedVersion: 'other.bad' },
  ])
    assert.equal(targetOverride(v, config), false);
});
test('intent can run on a new build without changing job generation, closed failures cannot', () => {
  const a = admission();
  validateJob(row, a.job, a.intent, a.entity);
  assert.throws(() => validateJob(row, { ...a.job, state: 'failed' }, a.intent, a.entity));
  assert.throws(() => validateJob(row, a.job, a.intent, { ...a.entity, generation: 3 }));
  validateJob(row, { ...a.job, state: 'succeeded' }, a.intent, a.entity, true);
});
test('old head requires exact real worker-settled witness; expiry/termination checkbox is insufficient', () => {
  const h = execution();
  assertSettled([h], [drain(h)]);
  for (const d of [
    { ...drain(h), source: 'elapsed_time' },
    { ...drain(h), executionId: 'other' },
    { ...drain(h), execution: { ...drain(h).execution, worker: { instanceId: 'other' } } },
  ])
    assert.throws(() => assertSettled([h], [d]));
  assert.throws(() => assertSettled([h], []));
});
test('started, cancelled and unknown activities block before CLI', () => {
  assertNoRunningActivity([{ state: 1 }, { state: 4 }]);
  for (const state of [0, 2, 3, 'PENDING_ACTIVITY_STATE_STARTED'])
    assert.throws(() => assertNoRunningActivity([{ state }]));
});
test('migration requires actual new head, settlement and SDK hostname history', () => {
  const h = execution(S, 'new-pod'),
    workers = [
      {
        role: 'search',
        podName: 'new-pod',
        podUid: h.worker.podUid,
        containerId: h.worker.containerIds[0],
        image: IMAGE,
      },
    ],
    observation = {
      ...row,
      status: 'RUNNING',
      override: pinned,
      heads: [h],
      drains: [drain(h)],
      history: { events: [{ workflowTaskCompletedEventAttributes: { identity: '123@new-pod' } }] },
    };
  assert.equal(assertMigration(row, observation, config, [execution()], workers).runId, RUN);
  assert.throws(() => assertMigration(row, { ...observation, heads: [] }, config, [], workers));
  assert.throws(() => assertMigration(row, { ...observation, drains: [] }, config, [], workers));
  assert.throws(() => assertMigration(row, { ...observation, history: { events: [] } }, config, [], workers));
  assert.throws(() => assertMigration(row, observation, config, [h], workers));
});
test('CLI parser has help and refuses broad write/retry actions', () => {
  assert.deepEqual(parseArgs(['--help']), { help: true });
  for (const action of ['reset', 'start', 'resume', 'terminate']) assert.throws(() => parseArgs([action]));
  assert.throws(() => parseArgs(['override', '--query', 'WorkflowType=SearchDocument']));
});
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pinned-search-unit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'replay.log');
  writeFileSync(log, 'FAKE SDK BOUNDARY UNIT FIXTURE; NOT LIVE REPLAY\n');
  const replay = {
    schemaVersion: 1,
    execution: 'actual-temporal-sdk-replay',
    ...row,
    targetCommit: S,
    targetImage: IMAGE,
    historySha256: 'd'.repeat(64),
    exitCode: 0,
    log: { path: log, sha256: hash(readFileSync(log)) },
  };
  const replayPath = join(directory, 'replay.json');
  writeFileSync(replayPath, JSON.stringify(replay));
  const entry = { ...row, replay: { path: replayPath, sha256: hash(readFileSync(replayPath)) } };
  const manifest = {
    schemaVersion: 1,
    projectId: PROJECT,
    oldReleaseId: OLD_RELEASE,
    oldControlRevision: 28,
    targetCommit: S,
    targetImage: IMAGE,
    runs: [entry],
  };
  const manifestPath = join(directory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const a = admission();
  const b = boundary(),
    time = { seconds: 1, nanoseconds: 2, toDate: () => new Date(1000) },
    values = new Map([
      ['_control/temporalRelease', b.control],
      ['_control/temporalReleaseState', b.state],
      [`durableJobs/${row.jobId}`, a.job],
      [`durableJobIntents/${row.jobId}`, a.intent],
      [`durableJobEntities/${hash(JSON.stringify([PROJECT, a.job.entity.type, a.job.entity.id, 'search']))}`, a.entity],
    ]);
  const snap = (p) => ({
    exists: values.has(p),
    data: () => values.get(p),
    get: (k) => values.get(p)?.[k],
    createTime: time,
    updateTime: time,
  });
  const doc = (p) => ({
    path: p,
    get: async () => snap(p),
    create: async (v) => {
      assert.equal(values.has(p), false);
      values.set(p, v);
    },
  });
  const db = {
    doc,
    runTransaction: (fn) =>
      fn({
        get: async (r) => snap(r.path),
        create: (r, v) => {
          assert.equal(values.has(r.path), false);
          values.set(r.path, v);
        },
        delete: (r) => values.delete(r.path),
      }),
  };
  const inputs = { fixtureOnly: true },
    authority = {
      control: nativeSnapshotProof(snap('_control/temporalRelease')),
      state: nativeSnapshotProof(snap('_control/temporalReleaseState')),
      inputs,
    };
  const h = execution(),
    observation = {
      ...row,
      status: 'RUNNING',
      override: null,
      versioningInfo: {
        behavior: 1,
        deploymentVersion: { deploymentName: config.workerDeploymentName, buildId: OLD_COMMIT },
      },
      pendingActivities: [{ state: 1 }],
      jobIdentity: Object.fromEntries(
        [
          'projectId',
          'jobId',
          'workflowId',
          'kind',
          'entity',
          'generation',
          'requestedBy',
          'requestId',
          'createdAt',
        ].map((k) => [k, a.job[k]])
      ),
      intentDigest: 'intent',
      entityDigest: 'entity',
      heads: [h],
      drains: [drain(h)],
      history: { events: [] },
      historySha256: replay.historySha256,
    };
  let current = structuredClone(observation),
    calls = 0,
    unknown = false;
  const deps = {
    db,
    config,
    target,
    inputs,
    operator: { fixtureOnly: true },
    stamp: () => ({ fixtureOnly: true }),
    guard: async (owned) => {
      const op = values.get('_control/temporalReleaseOperation');
      assert.equal(owned ? op?.operationId === owned : !op, true);
      return authority;
    },
    observe: async () => structuredClone(current),
    cli: async () => {
      calls++;
      assert.equal(
        [...values.keys()].some((k) => /^_control\/temporalPinnedSearchRecovery-[a-f0-9-]+$/.test(k)),
        true,
        'intent precedes write'
      );
      current.override = pinned;
      if (unknown) throw Error('simulated transport lost ACK');
      return '{}';
    },
  };
  const plan = {
    schemaVersion: 1,
    scope: 'recover-pinned-search',
    authority,
    inputs,
    manifestPath,
    manifestSha256: hash(readFileSync(manifestPath)),
    runs: [{ ...entry, observation }],
  };
  const planPath = join(directory, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan));
  const args = {
    action: 'override',
    '--plan': planPath,
    '--plan-sha': hash(readFileSync(planPath)),
    '--workflow-id': row.workflowId,
    '--run-id': row.runId,
  };
  return {
    args,
    deps,
    values,
    directory,
    entry,
    replay,
    observation,
    plan,
    manifestPath,
    setUnknown: () => (unknown = true),
    calls: () => calls,
    setObservation: (v) => (current = v),
  };
}
test('finite fake override records intent BEFORE one CLI write and never claims migrated', async (t) => {
  const f = fixture(t);
  const r = await recover(f.args, f.deps);
  assert.equal(r.result, 'override-observed-not-migration-proof');
  assert.equal(f.calls(), 1);
  assert.equal(f.values.has('_control/temporalReleaseOperation'), false);
});
test('unknown ACK rereads but retains owned operation and does not call CLI twice', async (t) => {
  const f = fixture(t);
  f.setUnknown();
  await assert.rejects(recover(f.args, f.deps), /UNKNOWN_OVERRIDE_ACK/);
  assert.equal(f.calls(), 1);
  assert.equal(f.values.has('_control/temporalReleaseOperation'), true);
  await assert.rejects(recover(f.args, f.deps));
  assert.equal(f.calls(), 1);
});
test('changed replay history blocks before any immutable intent/CLI write', async (t) => {
  const f = fixture(t);
  f.setObservation({ ...f.observation, historySha256: 'e'.repeat(64) });
  await assert.rejects(recover(f.args, f.deps), /REPLAY_HISTORY_CHANGED/);
  assert.equal(f.calls(), 0);
  assert.equal(f.values.has('_control/temporalReleaseOperation'), false);
});
test('actual replay artifact hash/log tampering blocks', (t) => {
  const f = fixture(t);
  validateReplay(f.replay, row, target, config, f.replay.historySha256);
  writeFileSync(f.replay.log.path, 'modified');
  assert.throws(() => validateReplay(f.replay, row, target, config, f.replay.historySha256), /ARTIFACT_HASH_CHANGED/);
});

test('report accepts separate real search workflow and controls Activity pod identities', () => {
  const h = execution(S, 'controls-pod');
  const workers = [
    { role: 'search', podName: 'search-pod', podUid: 'search-uid', containerId: 'containerd://search', image: IMAGE },
    {
      role: 'controls',
      podName: h.worker.podName,
      podUid: h.worker.podUid,
      containerId: h.worker.containerIds[0],
      image: IMAGE,
    },
  ];
  const o = {
    ...row,
    status: 'COMPLETED',
    override: pinned,
    heads: [h],
    drains: [drain(h)],
    history: { events: [{ workflowTaskCompletedEventAttributes: { identity: '123@search-pod' } }] },
  };
  assert.deepEqual(assertMigration(row, o, config, [execution()], workers).sdkIdentities, ['123@search-pod']);
  assert.throws(() =>
    assertMigration(
      row,
      o,
      config,
      [execution()],
      workers.map((w) => ({ ...w, podUid: 'foreign' }))
    )
  );
});
test('unknown ACK may be reconciled by report only after actual target execution, never another CLI', async (t) => {
  const f = fixture(t);
  f.setUnknown();
  await assert.rejects(recover(f.args, f.deps), /UNKNOWN_OVERRIDE_ACK/);
  const op = f.values.get('_control/temporalReleaseOperation');
  const h = execution(S, 'target-search');
  f.deps.workers = () => [
    {
      role: 'search',
      podName: h.worker.podName,
      podUid: h.worker.podUid,
      containerId: h.worker.containerIds[0],
      image: IMAGE,
    },
  ];
  f.setObservation({
    ...f.observation,
    override: pinned,
    heads: [h],
    drains: [drain(h)],
    history: { events: [{ workflowTaskCompletedEventAttributes: { identity: '1@target-search' } }] },
  });
  const report = { ...f.args, action: 'report', '--audit-id': op.operationId };
  const result = await recover(report, f.deps);
  assert.equal(result.result, 'actual-original-run-migration-observed');
  assert.equal(f.calls(), 1);
  assert.equal(f.values.has('_control/temporalReleaseOperation'), false);
});

test('original native routing must be pinned to580, not an arbitrary existing build or override', () => {
  const info = { behavior: 1, deploymentVersion: { deploymentName: config.workerDeploymentName, buildId: OLD_COMMIT } };
  assertOriginalPinnedVersion(info, config);
  assert.throws(() =>
    assertOriginalPinnedVersion(
      { ...info, deploymentVersion: { deploymentName: config.workerDeploymentName, buildId: 'c'.repeat(40) } },
      config
    )
  );
  assert.throws(() => assertOriginalPinnedVersion({ ...info, behavior: 2 }, config));
  assert.throws(() => assertOriginalPinnedVersion({ ...info, versioningOverride: pinned }, config));
});

test('transaction rejects a newer entity generation even if earlier observation was current', async (t) => {
  const f = fixture(t);
  const key = [...f.values.keys()].find((k) => k.startsWith('durableJobEntities/'));
  f.values.set(key, { ...f.values.get(key), generation: 3, activeJobId: 'newer-job' });
  await assert.rejects(recover(f.args, f.deps), /CURRENT_NONTERMINAL/);
  assert.equal(f.calls(), 0);
});

// Native JSON shape observed in the preserved 001-native.json; no payload or credentials.
test('actual captured native pinned wire fields and scheduled retry are accepted together', () => {
  assertOriginalPinnedVersion(
    {
      behavior: 'VERSIONING_BEHAVIOR_PINNED',
      version: `urm-worker-staging.${OLD_COMMIT}`,
      deploymentVersion: { buildId: OLD_COMMIT, deploymentName: 'urm-worker-staging' },
      revisionNumber: '9',
    },
    config
  );
  assertNoRunningActivity([
    {
      activityId: '1',
      activityType: { name: 'syncSearchDocument' },
      state: 'PENDING_ACTIVITY_STATE_SCHEDULED',
      attempt: 9,
    },
  ]);
});
