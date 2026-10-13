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
  validateRecoveryAncestry,
  assertRecoveryAncestryUnchanged,
  digest,
  canonical,
  nativeRecoveryTimestamp,
  buildRecoveryArchive,
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

test('only the exact ui-frozen paused legacy boundary and well-formed ancestry pointers are recoverable', () => {
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
                updateTime: stamp,
              },
        getAll: async (...refs) =>
          refs
            .filter((ref) => ref.path)
            .map((ref) => ({
              exists: stored.has(ref.path),
              data: () => stored.get(ref.path),
              createTime: stamp,
              updateTime: stamp,
            })),
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
    verified: {
      ...f.initial,
      controlCreateTime: f.stamp,
      stateCreateTime: f.stamp,
      ancestry: {
        archives: [],
        summary: {
          originReleaseId: oldRelease.releaseId,
          originalOperatorUid: 'original-admin',
          originalIdentitySha256: 'c'.repeat(64),
        },
      },
    },
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

const { Timestamp } = (await import('node:module')).createRequire(
  new URL('../functions/package.json', import.meta.url)
)('firebase-admin/firestore');
const originalStamp = new Timestamp(1791913009, 856938000);
const identityHash = 'c'.repeat(64);
const clone = (value) => structuredClone(value);
function successorCheckpoint(initial, descriptor, revision) {
  return {
    control: { ...initial.control, releaseId: descriptor.releaseId, revision },
    state: {
      ...initial.state,
      releaseId: descriptor.releaseId,
      compatibilityCommit: descriptor.compatibilityCommit,
      uiCommit: descriptor.uiCommit,
      controlRevision: revision,
      recoveryPredecessorReleaseId: initial.state.releaseId,
      recoveryArchivePath: `_control/temporalCompatibilityRecovery-${initial.state.releaseId}`,
    },
  };
}
function archiveFixture(initial, prior, next) {
  return {
    schemaVersion: 1,
    predecessorReleaseId: prior.releaseId,
    successorReleaseId: next.releaseId,
    oldDescriptor: prior,
    newDescriptor: next,
    oldDescriptorSha256: digest(prior),
    newDescriptorSha256: digest(next),
    originalControl: initial.control,
    originalState: initial.state,
    originalControlCreateTime: originalStamp,
    originalStateCreateTime: originalStamp,
    originalFreezePreserved: true,
    admissionsOpened: false,
    ownersChanged: false,
    reviewedBrowserActorUid: 'original-admin',
    artifacts: [{ label: 'original-operator-identity', sha256: identityHash }],
    candidateCi: { headSha: next.compatibilityCommit, status: 'completed', conclusion: 'success' },
    settledGuard: {
      action: 'controlled-backend-deploy',
      releaseId: prior.releaseId,
      commit: prior.compatibilityCommit,
    },
    reviewSha256: 'd'.repeat(64),
  };
}
function ancestryFixture() {
  const first = checkpoint(),
    current = successorCheckpoint(first, newRelease, 3),
    path = current.state.recoveryArchivePath,
    archive = archiveFixture(first, oldRelease, newRelease);
  const rows = new Map([[path, { archive, createTime: originalStamp, updateTime: originalStamp }]]);
  const input = {
    ...current,
    oldRelease: newRelease,
    controlCreateTime: originalStamp,
    stateCreateTime: originalStamp,
    originalOperatorUid: 'original-admin',
    originalIdentitySha256: identityHash,
  };
  const load = async (path) => {
    const row = rows.get(path);
    return row
      ? { exists: true, data: () => row.archive, createTime: row.createTime, updateTime: row.updateTime }
      : { exists: false };
  };
  return { first, current, path, archive, rows, input, load };
}

test('timestamp canonicalization recognizes actual native timestamps and exact serialized equivalents without dropping fields', () => {
  const plain = { seconds: originalStamp.seconds, nanoseconds: originalStamp.nanoseconds };
  assert.equal(digest(originalStamp), digest(plain));
  const extra = { ...plain, unreviewedOwner: 'temporal' };
  assert.notEqual(digest(extra), digest(plain));
  assert.match(canonical(extra), /unreviewedOwner/);
  for (const invalid of [
    extra,
    { _seconds: plain.seconds, _nanoseconds: plain.nanoseconds },
    { seconds: 1, nanoseconds: -1 },
    { seconds: 1, nanoseconds: 1e9 },
    { seconds: 253402300800, nanoseconds: 0 },
    { seconds: -62135596801, nanoseconds: 0 },
    { seconds: 1.5, nanoseconds: 0 },
    Object.assign(Object.create({}), plain),
  ])
    assert.throws(() => nativeRecoveryTimestamp(invalid));
  const extraNative = new Timestamp(originalStamp.seconds, originalStamp.nanoseconds);
  extraNative.unreviewedOwner = 'temporal';
  assert.throws(() => nativeRecoveryTimestamp(extraNative));
  assert.match(canonical(extraNative), /unreviewedOwner/);
  assert.notEqual(digest(extraNative), digest(originalStamp));
  assert.notEqual(digest(originalStamp), digest({ ...plain, nanoseconds: 857000000 }));
});

test('genuine first recovery without a head hash bootstraps only an immutable exact original paused boundary', async () => {
  const f = ancestryFixture(),
    result = await validateRecoveryAncestry(f.input, f.load);
  assert.equal(result.summary.archiveCount, 1);
  assert.equal(result.summary.originReleaseId, oldRelease.releaseId);
  assert.deepEqual(result.summary.originalControlCreateTime, { seconds: 1791913009, nanoseconds: 856938000 });
  assert.equal(result.archives[0].digest, digest(f.archive));
  // Firestore decoding may yield native Timestamp or an exact explicit seconds/nanoseconds equivalent.
  f.archive.originalControlCreateTime = { seconds: 1791913009, nanoseconds: 856938000 };
  await validateRecoveryAncestry(f.input, f.load);
});

test('bootstrap rejects missing, changed or malformed descriptors, freeze, actor, revisions, CI, owners and timestamps', async () => {
  const mutations = [
    (f) => f.rows.delete(f.path),
    (f) => (f.rows.get(f.path).updateTime = new Timestamp(originalStamp.seconds, originalStamp.nanoseconds + 1)),
    (f) => (f.archive.oldDescriptorSha256 = '0'.repeat(64)),
    (f) => (f.archive.newDescriptor = { ...newRelease, uiCommit: 'e'.repeat(40) }),
    (f) => (f.archive.originalControl.revision = 1),
    (f) => (f.archive.originalControl.domains.media.owner = 'temporal'),
    (f) => (f.archive.originalState.phase = 'compatibility-ready'),
    (f) => (f.archive.originalState.legacySettlingDeadline = 1),
    (f) => (f.archive.originalControl.legacyAdmissionCutoff = null),
    (f) => (f.archive.originalState.savedUiTraffic = { splits: [{ build: 'foreign', percent: 100 }] }),
    (f) => (f.archive.originalState.appHostingFreezeRequestId = 'foreign'),
    (f) => (f.archive.originalControlCreateTime = { seconds: 1791913009, nanoseconds: 857000000 }),
    (f) => (f.archive.originalStateCreateTime = { seconds: 1791913009, nanoseconds: 856938000, extra: true }),
    (f) => (f.archive.reviewedBrowserActorUid = 'another-admin'),
    (f) => f.archive.artifacts.push({ label: 'original-operator-identity', sha256: identityHash }),
    (f) => (f.archive.candidateCi.conclusion = 'failure'),
    (f) => (f.archive.settledGuard.commit = 'e'.repeat(40)),
    (f) => (f.archive.successorReleaseId = oldRelease.releaseId),
    (f) => (f.archive.predecessorArchive = { path: 'foreign', digest: identityHash }),
    (f) => (f.input.state.recoveryArchiveSha256 = '0'.repeat(64)),
    (f) => (f.input.state.recoveryOriginalIdentitySha256 = '0'.repeat(64)),
  ];
  for (const mutate of mutations) {
    const f = ancestryFixture();
    mutate(f);
    await assert.rejects(validateRecoveryAncestry(f.input, f.load));
  }
});

async function repeatedFixture() {
  const f = ancestryFixture(),
    ancestry = await validateRecoveryAncestry(f.input, f.load),
    third = {
      ...newRelease,
      releaseId: '611a7937-faee-4f6d-b856-9e0668b7a6bd',
      compatibilityCommit: 'e'.repeat(40),
      uiCommit: 'e'.repeat(40),
      compatibilityEvidence: '/secure/third-compat.json',
      backendEvidence: '/secure/third-backend.json',
      smokeEvidence: '/secure/third-smoke.json',
    };
  const record = buildRecoveryArchive({
    archive: archiveFixture(f.current, newRelease, third),
    oldRelease: newRelease,
    newRelease: third,
    verified: { ...f.current, controlCreateTime: originalStamp, stateCreateTime: originalStamp, ancestry },
  });
  const next = successorCheckpoint(f.current, third, 4);
  Object.assign(next.state, {
    recoveryArchiveSha256: digest(record),
    recoveryOriginReleaseId: oldRelease.releaseId,
    recoveryOriginalOperatorUid: 'original-admin',
    recoveryOriginalIdentitySha256: identityHash,
  });
  f.rows.set(next.state.recoveryArchivePath, { archive: record, createTime: originalStamp, updateTime: originalStamp });
  return { ...f, record, third, input: { ...f.input, ...next, oldRelease: third } };
}

test('repeated recovery validates the full hashed chain while preserving legacy bootstrap and exact original freeze', async () => {
  const f = await repeatedFixture(),
    result = await validateRecoveryAncestry(f.input, f.load);
  assert.equal(result.summary.archiveCount, 2);
  assert.equal(result.summary.originReleaseId, oldRelease.releaseId);
  assert.deepEqual(result.releaseIds, [f.third.releaseId, newRelease.releaseId, oldRelease.releaseId]);
  assert.equal(f.record.predecessorArchive.digest, digest(f.archive));
});

test('repeated recovery rejects unpinned heads, bad parent hashes, cycles, grace reductions and summary tampering', async () => {
  const mutations = [
    (f) => delete f.input.state.recoveryArchiveSha256,
    (f) => (f.record.predecessorArchive.digest = '0'.repeat(64)),
    (f) => (f.record.predecessorArchive.path = 'foreign'),
    (f) => delete f.record.ancestry,
    (f) => (f.record.ancestry.archiveCount = 0),
    (f) => (f.record.ancestry.chainDigest = '0'.repeat(64)),
    (f) => (f.input.state.recoveryOriginReleaseId = newRelease.releaseId),
    (f) => (f.record.originalState.recoveryPredecessorReleaseId = f.third.releaseId),
    (f) => {
      f.record.newDescriptor = { ...f.third, legacyExecutionGraceSeconds: 3599 };
      f.record.newDescriptorSha256 = digest(f.record.newDescriptor);
      f.input.oldRelease = f.record.newDescriptor;
    },
  ];
  for (const mutate of mutations) {
    const f = await repeatedFixture();
    mutate(f);
    if (Object.hasOwn(f.input.state, 'recoveryArchiveSha256')) f.input.state.recoveryArchiveSha256 = digest(f.record);
    await assert.rejects(validateRecoveryAncestry(f.input, f.load));
  }
  const f = await repeatedFixture();
  for (const newCandidate of [oldRelease, newRelease, f.third])
    await assert.rejects(validateRecoveryAncestry({ ...f.input, newRelease: newCandidate }, f.load), /ancestor/);
});

test('final transaction detects archive deletion or any exact native update/create timestamp race', async () => {
  const f = ancestryFixture(),
    ancestry = await validateRecoveryAncestry(f.input, f.load),
    db = { doc: (path) => ({ path }) };
  const tx = { getAll: async (...refs) => Promise.all(refs.filter((ref) => ref.path).map((ref) => f.load(ref.path))) };
  await assertRecoveryAncestryUnchanged(tx, db, ancestry);
  f.rows.get(f.path).updateTime = new Timestamp(originalStamp.seconds, originalStamp.nanoseconds + 1);
  await assert.rejects(assertRecoveryAncestryUnchanged(tx, db, ancestry), /changed/);
  f.rows.get(f.path).updateTime = originalStamp;
  f.rows.get(f.path).createTime = new Timestamp(originalStamp.seconds, originalStamp.nanoseconds + 1);
  await assert.rejects(assertRecoveryAncestryUnchanged(tx, db, ancestry), /changed/);
  f.rows.delete(f.path);
  await assert.rejects(assertRecoveryAncestryUnchanged(tx, db, ancestry), /changed/);
});

test('complete archive budget includes original documents and fails before any transaction write', async () => {
  const f = database();
  f.initial.state.payload = 'x'.repeat(750001);
  await assert.rejects(migrate(f), /byte budget/);
  assert.deepEqual(f.writes, []);
});

test('full repeated-recovery transaction pins the new archive and rejects ancestor races before writes', async () => {
  for (const race of ['none', 'edited', 'missing']) {
    const f = ancestryFixture(),
      ancestry = await validateRecoveryAncestry(f.input, f.load),
      candidate = {
        ...newRelease,
        releaseId: '611a7937-faee-4f6d-b856-9e0668b7a6bd',
        compatibilityCommit: 'e'.repeat(40),
        uiCommit: 'e'.repeat(40),
        compatibilityEvidence: '/secure/third-compat.json',
        backendEvidence: '/secure/third-backend.json',
        smokeEvidence: '/secure/third-smoke.json',
      };
    const stored = new Map([
        [CONTROL_PATH, f.current.control],
        [STATE_PATH, f.current.state],
        [
          OPERATION_PATH,
          {
            operationId: 'recovery-op',
            action: 'recover-initial-compatibility',
            releaseId: newRelease.releaseId,
            newReleaseId: candidate.releaseId,
            commit: candidate.compatibilityCommit,
          },
        ],
      ]),
      writes = [];
    const snapshot = async (ref) =>
      ref.collection
        ? { docs: [] }
        : f.rows.has(ref.path)
        ? f.load(ref.path)
        : {
            exists: stored.has(ref.path),
            data: () => stored.get(ref.path),
            createTime: originalStamp,
            updateTime: originalStamp,
          };
    const db = {
      doc: (path) => ({ path }),
      collection: (path) => ({ collection: path }),
      runTransaction: (callback) =>
        callback({
          get: snapshot,
          getAll: async (...refs) => Promise.all(refs.filter((ref) => ref.path).map(snapshot)),
          create: (ref, data) => {
            writes.push({ path: ref.path, data });
            stored.set(ref.path, data);
          },
          update: (ref, data) => {
            writes.push({ path: ref.path, data });
            stored.set(ref.path, { ...stored.get(ref.path), ...data });
          },
          delete: (ref) => {
            writes.push({ path: ref.path });
            stored.delete(ref.path);
          },
        }),
    };
    if (race === 'edited')
      f.rows.get(f.path).updateTime = new Timestamp(originalStamp.seconds + 1, originalStamp.nanoseconds);
    if (race === 'missing') f.rows.delete(f.path);
    const action = migrateRecoveryCheckpoint(db, {
      oldRelease: newRelease,
      newRelease: candidate,
      review: { oldControlRevision: 3 },
      operationId: 'recovery-op',
      verified: { ...f.current, controlCreateTime: originalStamp, stateCreateTime: originalStamp, ancestry },
      archive: archiveFixture(f.current, newRelease, candidate),
    });
    if (race !== 'none') {
      await assert.rejects(action, /archive changed/);
      assert.deepEqual(writes, []);
      continue;
    }
    const result = await action;
    assert.equal(result.controlRevision, 4);
    const archive = stored.get(`_control/temporalCompatibilityRecovery-${newRelease.releaseId}`),
      state = stored.get(STATE_PATH);
    assert.equal(state.recoveryArchiveSha256, digest(archive));
    assert.equal(archive.predecessorArchive.digest, digest(f.archive));
    assert.equal(state.recoveryOriginReleaseId, oldRelease.releaseId);
    assert.equal(state.recoveryOriginalIdentitySha256, identityHash);
    assert.equal(state.phase, 'ui-frozen');
    assert.equal(stored.get(CONTROL_PATH).admission, 'paused');
  }
});
