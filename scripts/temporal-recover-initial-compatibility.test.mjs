import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRecoveryDescriptors,
  validateRecoveryCheckpoint,
  validateRecoveryReview,
  validateFrozenTraffic,
  assertFailedDeploymentAfterGuard,
  summarizeRunSettlement,
  summarizeBuildInventory,
  assertSafeRecoveryLeases,
  migrateRecoveryCheckpoint,
  STATE_PATH,
  OPERATION_PATH,
} from './temporal-recover-initial-compatibility.mjs';
import { RELEASE_DOMAINS, CONTROL_PATH } from './temporal-release-lib.mjs';
const now = Date.parse('2026-10-13T20:00:00Z');
const oldRelease = {
  environment: 'staging',
  mode: 'initial-cutover',
  projectId: 'urm-app-staging',
  backendId: 'web-staging',
  location: 'us-central1',
  releaseId: '701d1962-1b40-4fac-b96f-24b030ba6a4d',
  compatibilityCommit: 'a'.repeat(40),
  uiCommit: 'a'.repeat(40),
  domains: ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles'],
  databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com',
  mailCollection: 'mail',
  legacyQueues: ['processaudiofiletask', 'processaudioyoutubetask'],
  additionalLegacyQueues: [],
  platformConfig: '/secure/old-stage.json',
  platformPeerConfig: '/secure/prod.json',
  compatibilityEvidence: '/secure/old-compat.json',
  backendEvidence: '/secure/old-backend.json',
  smokeEvidence: '/secure/old-smoke.json',
  legacyExecutionGraceSeconds: 3600,
  providerUsageBackfillTimeoutMs: 1800000,
};
const newRelease = {
  ...oldRelease,
  releaseId: '7796ab15-2f37-4012-8438-cb29efca8b46',
  compatibilityCommit: 'b'.repeat(40),
  uiCommit: 'b'.repeat(40),
  platformConfig: '/secure/new-stage.json',
  compatibilityEvidence: '/secure/new-compat.json',
  backendEvidence: '/secure/new-backend.json',
  smokeEvidence: '/secure/new-smoke.json',
};
const savedRolloutPolicy = { codebaseBranch: 'staging', disabled: false },
  savedUiTraffic = { splits: [{ build: 'old-ui', percent: 100 }] };
function checkpoint() {
  const control = {
    schemaVersion: 1,
    revision: 2,
    releaseId: oldRelease.releaseId,
    admission: 'paused',
    domains: Object.fromEntries(RELEASE_DOMAINS.map((d) => [d, { owner: 'legacy', admission: 'paused' }])),
    updatedAt: 1,
  };
  const state = {
    releaseId: oldRelease.releaseId,
    mode: 'initial-cutover',
    phase: 'ui-frozen',
    controlRevision: 2,
    compatibilityCommit: oldRelease.compatibilityCommit,
    uiCommit: oldRelease.uiCommit,
    domains: oldRelease.domains,
    savedRolloutPolicy,
    savedUiTraffic,
    maximumLegacyExecutionSeconds: 3570,
    appHostingFreezeRequestId: 'original-freeze-uuid',
    updatedAt: 1,
  };
  return { control, state };
}
const review = {
  schemaVersion: 1,
  projectId: oldRelease.projectId,
  oldReleaseId: oldRelease.releaseId,
  newReleaseId: newRelease.releaseId,
  oldControlRevision: 2,
  candidateCiRunId: 123,
  verifiedAt: new Date(now - 1000).toISOString(),
  reason: 'Core dependency startup failure requires reviewed new immutable source',
  settledGuard: {
    action: 'controlled-backend-deploy',
    releaseId: oldRelease.releaseId,
    commit: oldRelease.compatibilityCommit,
    operationId: '5c4308a7-c1a9-4df6-99b5-55ac595ca0ad',
    createdAt: now - 10000,
  },
  guardSettlementVerified: true,
  failedCompatibilityDeploymentVerified: true,
  originalOperatorUid: 'original-admin',
  operatorIdentity: {
    actorUid: 'original-admin',
    authTime: '2026-10-13T17:00:00Z',
    verifiedAt: new Date(now - 1000).toISOString(),
  },
  operations: [
    {
      apiVersion: 'v2',
      name: 'projects/urm-app-staging/locations/us-central1/operations/failed-operation',
      done: true,
    },
  ],
  builds: [],
  runtime: [
    {
      name: 'projects/urm-app-staging/locations/us-central1/functions/deleteseries',
      state: 'FAILED',
      build: null,
      revision: 'failed-revision',
    },
  ],
  artifacts: [{ label: 'original-operator-identity', path: '/secure/identity.json', sha256: 'c'.repeat(64) }],
};

test('requires a separately pinned staging candidate and preserves reviewed scopes/grace', () => {
  assert.equal(validateRecoveryDescriptors(oldRelease, newRelease, newRelease.compatibilityCommit), newRelease);
  for (const changed of [
    { releaseId: oldRelease.releaseId },
    { uiCommit: 'c'.repeat(40) },
    { legacyExecutionGraceSeconds: 3599 },
    { domains: ['media'] },
    { legacyQueues: [...oldRelease.legacyQueues, 'new-queue'] },
    { smokeEvidence: oldRelease.smokeEvidence },
  ])
    assert.throws(() =>
      validateRecoveryDescriptors(oldRelease, { ...newRelease, ...changed }, newRelease.compatibilityCommit)
    );
  assert.throws(() => validateRecoveryDescriptors(oldRelease, newRelease, 'c'.repeat(40)), /exact reviewed/);
  const prod = {
    ...oldRelease,
    environment: 'production',
    projectId: 'urm-app',
    backendId: 'web-prod',
    databaseUrl: 'https://urm-app-default-rtdb.firebaseio.com',
    promotionApprovalEvidence: '/secure/approval.json',
  };
  assert.throws(
    () =>
      validateRecoveryDescriptors(
        prod,
        {
          ...prod,
          ...{
            releaseId: newRelease.releaseId,
            compatibilityCommit: newRelease.compatibilityCommit,
            uiCommit: newRelease.uiCommit,
          },
        },
        newRelease.compatibilityCommit
      ),
    /staging/
  );
});

test('only the exact first ui-frozen paused legacy checkpoint is recoverable', () => {
  const { control, state } = checkpoint();
  validateRecoveryCheckpoint(control, state, oldRelease, 2);
  for (const phase of [
    'freezing-ui',
    'compatibility-ready',
    'legacy-drained',
    'ownership-changed',
    'ui-ready',
    'complete',
    'paused-for-recovery',
  ])
    assert.throws(() => validateRecoveryCheckpoint(control, { ...state, phase }, oldRelease, 2));
  for (const extra of [{ legacyAdmissionCutoff: null }, { legacyAdmissionCutoff: { seconds: 1, nanoseconds: 0 } }])
    assert.throws(() => validateRecoveryCheckpoint({ ...control, ...extra }, state, oldRelease, 2), /cutoff/);
  for (const extra of [
    { compatibilityVerifiedAt: 1 },
    { legacySettlingDeadline: 1 },
    { recoveryPredecessorReleaseId: 'old' },
    { maximumLegacyExecutionSeconds: 0 },
    { savedUiTraffic: undefined },
  ])
    assert.throws(() => validateRecoveryCheckpoint(control, { ...state, ...extra }, oldRelease, 2));
  const temporal = { ...control, domains: { ...control.domains, search: { owner: 'temporal', admission: 'paused' } } };
  assert.throws(() => validateRecoveryCheckpoint(temporal, state, oldRelease, 2));
  assert.throws(() => validateRecoveryCheckpoint(control, state, oldRelease, 1));
});

test('fresh review binds failed guard, exact operation versions, original actor and candidate CI', () => {
  validateRecoveryReview(review, oldRelease, newRelease, now);
  for (const change of [
    { verifiedAt: new Date(now - 600001).toISOString() },
    { verifiedAt: new Date(now + 1).toISOString() },
    { candidateCiRunId: 0 },
    { guardSettlementVerified: false },
    { failedCompatibilityDeploymentVerified: false },
    { originalOperatorUid: 'other' },
    { newReleaseId: oldRelease.releaseId },
    { operations: [{ ...review.operations[0], done: false }] },
    { operations: [{ ...review.operations[0], apiVersion: 'v1' }] },
  ])
    assert.throws(() => validateRecoveryReview({ ...review, ...change }, oldRelease, newRelease, now));
  assert.throws(() =>
    validateRecoveryReview(
      { ...review, settledGuard: { ...review.settledGuard, commit: newRelease.compatibilityCommit } },
      oldRelease,
      newRelease,
      now
    )
  );
});

test('actual frozen traffic/policy must match original traffic and have no pending UI rollouts', () => {
  const { state } = checkpoint(),
    traffic = {
      etag: 'actual-etag',
      rolloutPolicy: { ...savedRolloutPolicy, disabled: true },
      current: savedUiTraffic,
    };
  validateFrozenTraffic(traffic, [{ state: 'FAILED' }], state);
  for (const change of [
    { current: { splits: [{ build: 'other', percent: 100 }] } },
    { rolloutPolicy: { ...traffic.rolloutPolicy, disabled: false } },
    { reconciling: true },
    { etag: undefined },
  ])
    assert.throws(() => validateFrozenTraffic({ ...traffic, ...change }, [], state));
  assert.throws(() => validateFrozenTraffic(traffic, [{ state: 'BUILDING' }], state));
});

test('leases must be completed with a known outcome; no expiration or false effects exemption', () => {
  const safe = {
    schemaVersion: 1,
    projectId: 'urm-app-staging',
    state: 'completed',
    outcome: 'succeeded',
    effectsStarted: true,
  };
  assertSafeRecoveryLeases([safe]);
  assertSafeRecoveryLeases([]);
  for (const change of [
    { state: 'active', effectsStarted: false, diagnosticExpiresAt: 0 },
    { state: 'needs_attention' },
    { outcome: 'unknown' },
    { state: 'completed', effectsStarted: undefined },
    { projectId: 'urm-app' },
  ])
    assert.throws(() => assertSafeRecoveryLeases([{ ...safe, ...change }]));
});

function database({ changedControl, changedState, leases = [], lockChanged = false, archiveExists = false } = {}) {
  const initial = checkpoint(),
    stored = new Map([
      [CONTROL_PATH, changedControl ?? initial.control],
      [STATE_PATH, changedState ?? initial.state],
      [
        OPERATION_PATH,
        {
          operationId: lockChanged ? 'other' : 'recovery-op',
          action: 'recover-initial-compatibility',
          releaseId: oldRelease.releaseId,
          newReleaseId: newRelease.releaseId,
          commit: newRelease.compatibilityCommit,
        },
      ],
    ]),
    writes = [];
  const stamp = { seconds: 1791913009, nanoseconds: 857000000 };
  const db = {
    doc: (path) => ({ path }),
    collection: (path) => ({ collection: path }),
    runTransaction: (callback) =>
      callback({
        get: async (ref) =>
          ref.collection
            ? { docs: leases.map((value) => ({ data: () => value })) }
            : {
                exists: ref.path.startsWith('_control/temporalCompatibilityRecovery-')
                  ? archiveExists
                  : stored.has(ref.path),
                data: () => stored.get(ref.path),
                createTime: stamp,
              },
        create: (ref, data) => {
          writes.push({ method: 'create', path: ref.path, data });
          stored.set(ref.path, data);
        },
        update: (ref, data) => {
          writes.push({ method: 'update', path: ref.path, data });
          stored.set(ref.path, { ...stored.get(ref.path), ...data });
        },
        delete: (ref) => {
          writes.push({ method: 'delete', path: ref.path });
          stored.delete(ref.path);
        },
      }),
  };
  return { db, initial, stored, writes, stamp };
}
function migrate(f) {
  return migrateRecoveryCheckpoint(f.db, {
    oldRelease,
    newRelease,
    review,
    operationId: 'recovery-op',
    verified: f.initial,
    archive: { reviewSha256: 'c'.repeat(64), inventory: { claimsLegacyDrained: false, pendingCanonicalUploads: 4 } },
  });
}

test('CAS migration archives exact predecessor, preserves first freeze/traffic/grace and keeps paused owners', async () => {
  const f = database();
  const result = await migrate(f);
  assert.equal(result.controlRevision, 3);
  const archive = f.writes.find((w) => w.method === 'create').data;
  assert.equal(archive.originalControlCreateTime, f.stamp);
  assert.equal(archive.originalStateCreateTime, f.stamp);
  assert.equal(archive.predecessorReleaseId, oldRelease.releaseId);
  assert.equal(archive.successorReleaseId, newRelease.releaseId);
  assert.deepEqual(archive.originalControl, f.initial.control);
  assert.deepEqual(archive.originalState, f.initial.state);
  assert.equal(archive.inventory.pendingCanonicalUploads, 4);
  assert.equal(archive.inventory.claimsLegacyDrained, false);
  const control = f.stored.get(CONTROL_PATH),
    state = f.stored.get(STATE_PATH);
  assert.deepEqual(control.domains, f.initial.control.domains);
  assert.equal(control.admission, 'paused');
  assert.equal(Object.hasOwn(control, 'legacyAdmissionCutoff'), false);
  for (const key of [
    'phase',
    'savedUiTraffic',
    'savedRolloutPolicy',
    'maximumLegacyExecutionSeconds',
    'appHostingFreezeRequestId',
    'domains',
  ])
    assert.deepEqual(state[key], f.initial.state[key]);
  assert.equal(state.recoveryPredecessorReleaseId, oldRelease.releaseId);
  assert.equal(state.compatibilityCommit, newRelease.compatibilityCommit);
  assert.deepEqual(
    f.writes.filter((w) => [CONTROL_PATH, STATE_PATH].includes(w.path)).map((w) => w.method),
    ['update', 'update']
  );
  assert.deepEqual(
    f.writes.filter((w) => w.method === 'delete').map((w) => w.path),
    [OPERATION_PATH]
  );
});

test('transaction rejects revision/state/lock/archive races and new uncertain leases without writes', async () => {
  const initial = checkpoint();
  for (const options of [
    { changedControl: { ...initial.control, revision: 3 } },
    { changedState: { ...initial.state, updatedAt: 2 } },
    { lockChanged: true },
    { archiveExists: true },
    {
      leases: [
        { schemaVersion: 1, projectId: 'urm-app-staging', state: 'active', outcome: 'unknown', effectsStarted: false },
      ],
    },
  ]) {
    const f = database(options);
    await assert.rejects(migrate(f));
    assert.deepEqual(f.writes, []);
  }
});

test('failed operations must actually follow this guard, not be successful or historical', () => {
  const time = new Date(now - 1000).toISOString();
  assertFailedDeploymentAfterGuard([{ errorCode: 3, createTime: time }], now - 2000);
  for (const operations of [
    [],
    [{ errorCode: null, createTime: time }],
    [{ errorCode: 0, createTime: time }],
    [{ errorCode: 3, createTime: new Date(now - 10000).toISOString() }],
    [{ errorCode: 3, createTime: null }],
  ])
    assert.throws(() => assertFailedDeploymentAfterGuard(operations, now - 2000));
});

test('settled Cloud Run failure is allowed, active operations and reconciling services are not', () => {
  const failed = {
    name: 'projects/urm-app-staging/locations/us-central1/services/core',
    reconciling: false,
    terminalCondition: { state: 'CONDITION_FAILED' },
    latestCreatedRevision: 'failed-new',
    latestReadyRevision: 'ready-old',
  };
  const result = summarizeRunSettlement([{ done: true }], [failed]);
  assert.equal(result.services[0].terminalState, 'CONDITION_FAILED');
  assert.equal(result.services[0].latestReadyRevision, 'ready-old');
  assert.throws(() => summarizeRunSettlement([{ done: false }], [failed]));
  assert.throws(() => summarizeRunSettlement([], [{ ...failed, reconciling: true }]));
  assert.throws(() => summarizeRunSettlement([], [{ ...failed, terminalCondition: { state: 'CONDITION_PENDING' } }]));
});

test('build summary retains actual full-set hash/count without archiving historical rows; pending cannot be hidden', () => {
  const rows = [
    { id: 'old', status: 'FAILURE' },
    { id: 'candidate', status: 'SUCCESS' },
  ];
  const summary = summarizeBuildInventory('us-central1', rows);
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.statusCounts, { FAILURE: 1, SUCCESS: 1 });
  assert.equal(Object.hasOwn(summary, 'builds'), false);
  assert.match(summary.sha256, /^[a-f0-9]{64}$/);
  for (const status of ['PENDING', 'QUEUED', 'WORKING', 'STATUS_UNKNOWN'])
    assert.throws(() => summarizeBuildInventory('global', [...rows, { id: 'ongoing', status }]));
});

test('review accepts actual camelCase function identifiers', () => {
  validateRecoveryReview(
    {
      ...review,
      runtime: [
        { name: 'projects/urm-app-staging/locations/us-central1/functions/acknowledgeDurablePublish', state: 'ACTIVE' },
      ],
    },
    oldRelease,
    newRelease,
    now
  );
});

test('transaction also binds the recovery lock to the exact predecessor/successor source identities', async () => {
  for (const change of [
    { releaseId: newRelease.releaseId },
    { newReleaseId: oldRelease.releaseId },
    { commit: oldRelease.compatibilityCommit },
  ]) {
    const f = database();
    f.stored.set(OPERATION_PATH, { ...f.stored.get(OPERATION_PATH), ...change });
    await assert.rejects(migrate(f));
    assert.deepEqual(f.writes, []);
  }
});
