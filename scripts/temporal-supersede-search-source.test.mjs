import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  ACTION,
  PATHS,
  archivePath,
  validateDescriptors,
  validateCheckpoint,
  successorState,
  activityDrainIdentity,
  assertWorkerSettled,
  inspectTransaction,
  claimOperation,
  supersedeTransaction,
  releaseOwnedOperation,
  confirmAlreadyReleased,
} from './temporal-supersede-search-source.mjs';
import { hash, proofDigest, nativeSnapshotProof } from './temporal-release-runtime.mjs';
import { captureProviderUsageContinuity } from './temporal-provider-usage-continuity.mjs';
import { PROVIDER_USAGE_SCAN_GROUPS } from './temporal-backfill-provider-usage.mjs';
import {
  SEARCH_BOOTSTRAP_INSTANCES,
  searchBootstrapIdentity,
  searchBootstrapEntityKey,
  searchReadinessMarker,
} from './temporal-bootstrap-search.mjs';
const { Timestamp } = createRequire(new URL('../functions/package.json', import.meta.url))('firebase-admin/firestore');
const NOW = 1792200000,
  stamp = () => new Timestamp(NOW, 0);
const clone = (value) =>
  value instanceof Timestamp
    ? value
    : Array.isArray(value)
    ? value.map(clone)
    : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, clone(value)]))
    : value;
const OP = '12345678-1234-4234-8234-123456789012';

// A serializable in-memory Firestore boundary. Production validators and five-job proof logic remain real.
class FakeDB {
  constructor() {
    this.rows = new Map();
    this.versions = new Map();
    this.createdVersions = new Map();
    this.version = 0;
  }
  put(path, data) {
    this.rows.set(path, clone(data));
    this.versions.set(path, ++this.version);
    if (!this.createdVersions.has(path)) this.createdVersions.set(path, this.version);
  }
  doc(path) {
    return { path, get: async () => this.snapshot(path) };
  }
  collection(path) {
    const query = { collection: path, filters: [], maximum: Infinity };
    query.where = (...filter) => {
      query.filters.push(filter);
      return query;
    };
    query.limit = (maximum) => {
      query.maximum = maximum;
      return query;
    };
    query.doc = (id) => this.doc(path + '/' + id);
    return query;
  }
  snapshot(path) {
    const data = this.rows.get(path),
      version = this.versions.get(path) || 0;
    return {
      exists: data !== undefined,
      ref: this.doc(path),
      data: () => clone(data),
      get: (key) => clone(data?.[key]),
      createTime: new Timestamp(NOW - 100, this.createdVersions.get(path) || 0),
      updateTime: new Timestamp(NOW - 100, version),
      readTime: stamp(),
    };
  }
  async runTransaction(callback) {
    const writes = [],
      reads = new Map();
    let queryVersion;
    const tx = {
      get: async (ref) => {
        if (!ref.collection) {
          reads.set(ref.path, this.versions.get(ref.path) || 0);
          return this.snapshot(ref.path);
        }
        queryVersion ??= this.version;
        const docs = [...this.rows.keys()]
          .filter((path) => path.startsWith(ref.collection + '/') && path.split('/').length === 2)
          .map((path) => this.snapshot(path))
          .filter((row) =>
            ref.filters.every(([field, operator, value]) => {
              const actual = row.get(field);
              return operator === '=='
                ? actual === value
                : operator === 'in'
                ? value.includes(actual)
                : operator === 'not-in'
                ? actual !== undefined && !value.includes(actual)
                : false;
            })
          )
          .slice(0, ref.maximum);
        docs.forEach((row) => reads.set(row.ref.path, this.versions.get(row.ref.path) || 0));
        return { docs, size: docs.length };
      },
      create: (ref, data) => writes.push(['create', ref.path, clone(data)]),
      set: (ref, data) => writes.push(['set', ref.path, clone(data)]),
      delete: (ref) => writes.push(['delete', ref.path]),
    };
    const result = await callback(tx);
    for (const [path, version] of reads)
      assert.equal(this.versions.get(path) || 0, version, 'Simulated native transaction conflict');
    if (queryVersion !== undefined) assert.equal(this.version, queryVersion, 'Simulated query phantom conflict');
    for (const [kind, path, data] of writes) {
      if (kind === 'create') assert(!this.rows.has(path), 'create-only archive/operation');
      if (kind === 'delete') {
        this.rows.delete(path);
        this.versions.set(path, ++this.version);
      } else this.put(path, data);
    }
    return result;
  }
}
function descriptor(releaseId, commit, suffix) {
  return {
    environment: 'staging',
    mode: 'initial-cutover',
    projectId: 'urm-app-staging',
    backendId: 'web-staging',
    location: 'us-central1',
    releaseId,
    compatibilityCommit: commit,
    uiCommit: commit,
    domains: ['search'],
    databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com',
    mailCollection: 'mail',
    legacyQueues: ['processaudiofiletask', 'processaudioyoutubetask'],
    additionalLegacyQueues: [],
    legacyExecutionGraceSeconds: 3600,
    providerUsageBackfillTimeoutMs: 1800000,
    platformConfig: '/private/platform-' + suffix + '.json',
    platformPeerConfig: '/private/peer.json',
    compatibilityEvidence: '/private/compat-' + suffix + '.json',
    backendEvidence: '/private/backend-' + suffix + '.json',
    smokeEvidence: '/private/smoke-' + suffix + '.json',
    searchSettingsEvidence: '/private/settings-' + suffix + '.json',
  };
}
function fixture() {
  const db = new FakeDB(),
    oldRelease = descriptor('d6401173-c28b-42e9-ba75-f7c714e289c2', 'a'.repeat(40), 'old'),
    nextRelease = descriptor('12345678-1234-4234-8234-123456789012', 'b'.repeat(40), 'new');
  const predecessor = 'a801c079-a832-4bfa-a526-ec385e49d27f';
  const marker = {
    schemaVersion: 1,
    projectId: 'urm-app-staging',
    status: 'ready',
    releaseId: predecessor,
    controlRevision: 7,
    epoch: 'historical-provider-epoch',
    groups: [...PROVIDER_USAGE_SCAN_GROUPS],
    groupIndex: PROVIDER_USAGE_SCAN_GROUPS.length,
    cursor: null,
    documentCount: 100,
    edgeCount: 200,
    completedAtMillis: NOW * 1000 - 100000,
  };
  db.put(PATHS.usage, marker);
  const history = {
    releaseId: predecessor,
    controlRevision: 20,
    mode: 'initial-cutover',
    phase: 'complete',
    providerUsageEpoch: marker.epoch,
    providerUsageBackfillRevision: 7,
    providerUsageVerifiedAt: NOW * 1000 - 90000,
  };
  db.put('_control/temporalReleaseHistory-' + predecessor, history);
  const domains = Object.fromEntries(
    ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((domain) => [
      domain,
      { owner: domain === 'search' ? 'legacy' : 'temporal', admission: domain === 'search' ? 'paused' : 'open' },
    ])
  );
  const continuity = captureProviderUsageContinuity(
    oldRelease,
    { schemaVersion: 1, releaseId: predecessor, revision: 20, admission: 'open', domains },
    history,
    db.snapshot(PATHS.usage)
  );
  domains.search.owner = 'temporal';
  const control = {
    schemaVersion: 1,
    releaseId: oldRelease.releaseId,
    revision: 29,
    admission: 'paused',
    domains,
    legacyAdmissionCutoff: new Timestamp(NOW - 7200, 844000000),
  };
  const options = {
    projectId: oldRelease.projectId,
    releaseId: oldRelease.releaseId,
    commit: oldRelease.compatibilityCommit,
    controlRevision: 29,
    operationId: OP,
  };
  const jobs = SEARCH_BOOTSTRAP_INSTANCES.map((instance, index) => {
    const identity = searchBootstrapIdentity(options, instance),
      generation = index + 1;
    const job = {
      projectId: options.projectId,
      jobId: identity.ref.jobId,
      kind: 'search.backfill',
      requestId: identity.requestId,
      requestedBy: 'system:search',
      entity: identity.entity,
      generation,
      state: 'succeeded',
      result: { count: index },
    };
    const entity = {
      projectId: options.projectId,
      activeJobId: job.jobId,
      generation,
      scope: 'search',
      entity: identity.entity,
    };
    const intent = {
      projectId: options.projectId,
      jobId: job.jobId,
      kind: 'search.backfill',
      actorUid: 'system:search',
      generation,
      payload: identity.payload,
      entity: identity.entity,
    };
    db.put('durableJobs/' + job.jobId, job);
    db.put('durableJobEntities/' + searchBootstrapEntityKey(options, instance), entity);
    db.put('durableJobIntents/' + job.jobId, intent);
    return { job, entity, intent };
  });
  const proof = {
    schemaVersion: 1,
    result: 'passed',
    projectId: options.projectId,
    appId: '2VZFOFLFHE',
    releaseId: oldRelease.releaseId,
    commit: oldRelease.compatibilityCommit,
    controlRevision: 28,
    jobIds: jobs.map((row) => row.job.jobId),
    generations: jobs.map((row) => row.job.generation),
    counts: jobs.map((row) => row.job.result.count),
    settingsReceiptCanonicalSha256: 'c'.repeat(64),
  };
  const state = {
    releaseId: oldRelease.releaseId,
    controlRevision: 29,
    phase: 'search-ready',
    mode: 'initial-cutover',
    domains: ['search'],
    compatibilityCommit: oldRelease.compatibilityCommit,
    uiCommit: oldRelease.uiCommit,
    backendVerifiedAt: NOW * 1000 - 2000,
    searchConverged: true,
    searchBootstrapProof: proof,
    workerBuildId: oldRelease.compatibilityCommit,
    appHostingFreezeRequestId: OP,
    savedRolloutPolicy: { codebaseBranch: 'staging', disabled: false },
    savedUiTraffic: { splits: [{ build: 'original-8f-build', percent: 100 }] },
    maximumLegacyExecutionSeconds: 540,
    compatibilityVerifiedAt: control.legacyAdmissionCutoff,
    legacySettlingCutoff: control.legacyAdmissionCutoff,
    legacySettlingGraceSeconds: 3600,
    providerUsageContinuity: continuity,
    providerUsageEpoch: marker.epoch,
    providerUsageBackfillRevision: 7,
    providerUsageVerifiedAt: NOW * 1000 - 1000,
  };
  db.put(PATHS.control, control);
  db.put(PATHS.state, state);
  db.put(PATHS.readiness, searchReadinessMarker(proof, 29));
  const input = {
    oldRelease,
    nextRelease,
    revision: 29,
    digest: 'e'.repeat(64),
    oldDescriptorSHA256: 'd'.repeat(64),
    newDescriptorSHA256: 'f'.repeat(64),
    source: { operatorCommit: nextRelease.compatibilityCommit },
    review: { reason: 'Synthetic fixture only' },
  };
  const external = { serverReadTime: stamp(), workerBuildId: nextRelease.compatibilityCommit };
  return { db, input, control, state, jobs, external };
}
async function claimed(f) {
  const inspection = await inspectTransaction(f.db, f.input);
  await claimOperation(f.db, f.input, inspection, OP, { email: 'synthetic-operator@example.invalid' });
  return { inspection, operation: { operationId: OP, native: nativeSnapshotProof(f.db.snapshot(PATHS.operation)) } };
}
test('descriptors require distinct staging search-only immutable source/UUID and separate evidence', () => {
  const f = fixture();
  assert.doesNotThrow(() => validateDescriptors(f.input.oldRelease, f.input.nextRelease, 'b'.repeat(40)));
  for (const mutate of [
    (r) => (r.projectId = 'urm-app'),
    (r) => (r.releaseId = f.input.oldRelease.releaseId),
    (r) => (r.compatibilityCommit = f.input.oldRelease.compatibilityCommit),
    (r) => (r.domains = ['search', 'media']),
    (r) => (r.legacyExecutionGraceSeconds = 3599),
    (r) => (r.backendEvidence = f.input.oldRelease.backendEvidence),
  ]) {
    const next = clone(f.input.nextRelease);
    mutate(next);
    assert.throws(() => validateDescriptors(f.input.oldRelease, next, 'b'.repeat(40)));
  }
});
test('unfinished backend-ready/current generations cannot be superseded or even claim an operation', async () => {
  for (const mutate of [
    (f) => f.db.put(PATHS.state, { ...f.state, phase: 'backend-ready' }),
    (f) => f.db.put('durableJobs/' + f.jobs[0].job.jobId, { ...f.jobs[0].job, state: 'needs_attention' }),
    (f) =>
      f.db.put(
        'durableJobEntities/' +
          searchBootstrapEntityKey(
            {
              projectId: f.input.oldRelease.projectId,
              releaseId: f.input.oldRelease.releaseId,
              commit: f.input.oldRelease.compatibilityCommit,
              controlRevision: 29,
              operationId: OP,
            },
            SEARCH_BOOTSTRAP_INSTANCES[0]
          ),
        { ...f.jobs[0].entity, generation: 99 }
      ),
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(() => inspectTransaction(f.db, f.input));
    assert(!f.db.rows.has(PATHS.operation));
    assert(!f.db.rows.has(archivePath(f.input.oldRelease.releaseId)));
  }
});
test('weaker grace, drifted native control/state, existing operation and provider continuity changes refuse', async () => {
  for (const mutate of [
    (f) => f.db.put(PATHS.state, { ...f.state, legacySettlingGraceSeconds: 1 }),
    (f) => f.db.put(PATHS.operation, { operationId: OP, action: 'other' }),
    (f) => f.db.put(PATHS.usage, { ...f.db.rows.get(PATHS.usage), epoch: 'new-unreviewed-epoch' }),
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(() => inspectTransaction(f.db, f.input));
  }
  const f = fixture(),
    inspection = await inspectTransaction(f.db, f.input);
  f.db.put(PATHS.control, { ...f.control, updatedAt: 123 });
  await assert.rejects(() => claimOperation(f.db, f.input, inspection, OP, {}));
});
test('actual worker-settled witness identity is required; TTL and terminal job state do not count', () => {
  const head = {
    projectId: 'urm-app-staging',
    jobId: 'synthetic-job',
    workflowId: 'wf',
    runId: 'run',
    activityId: '1',
    activityType: 'searchBackfill',
    scheduledAt: NOW * 1000,
    attempt: 1,
    worker: { instanceId: 'pod-instance', buildId: 'b'.repeat(40) },
  };
  head.executionId = hash(JSON.stringify([head.workflowId, head.runId, head.activityId, head.scheduledAt]));
  assert.equal(activityDrainIdentity(head).length, 64);
  const execution = Object.fromEntries(
    Object.entries(head).filter(([key]) => !['projectId', 'jobId', 'executionId'].includes(key))
  );
  const drain = {
    schemaVersion: 1,
    projectId: head.projectId,
    jobId: head.jobId,
    executionId: head.executionId,
    source: 'worker_settled',
    state: 'drained',
    execution,
  };
  assert.doesNotThrow(() => assertWorkerSettled(head, drain));
  for (const bad of [
    undefined,
    { ...drain, source: 'lease_expired' },
    { ...drain, execution: { ...execution, attempt: 2 } },
    { ...drain, execution: { ...execution, worker: { ...execution.worker, instanceId: 'other' } } },
  ])
    assert.throws(() => assertWorkerSettled(head, bad));
});
test('successful one-CAS handoff archives SUPERSEDED facts and removes stale readiness without relabeling history', async () => {
  const f = fixture(),
    beforeJobs = proofDigest(f.jobs),
    { inspection, operation } = await claimed(f);
  const result = await supersedeTransaction(f.db, f.input, inspection, operation, f.external, {
    now: () => NOW * 1000,
  });
  const archive = f.db.rows.get(result.archivePath),
    state = f.db.rows.get(PATHS.state),
    control = f.db.rows.get(PATHS.control);
  assert.equal(archive.disposition, 'SUPERSEDED');
  assert.equal(archive.notComplete, true);
  assert.equal(archive.inputDigest, f.input.digest);
  assert.equal(archive.originalState.phase, 'search-ready');
  assert.equal(archive.originalReadiness.releaseId, f.input.oldRelease.releaseId);
  assert.equal(state.phase, 'ownership-changed');
  assert.equal(state.controlRevision, 30);
  assert.equal(control.admission, 'paused');
  assert.deepEqual(control.domains, f.control.domains);
  assert.equal(state.workerBuildId, f.input.nextRelease.compatibilityCommit);
  for (const key of ['backendVerifiedAt', 'searchConverged', 'searchBootstrapProof', 'uiBuild', 'uiVerifiedAt'])
    assert(!Object.hasOwn(state, key));
  assert.deepEqual(state.compatibilityVerifiedAt, f.state.compatibilityVerifiedAt);
  assert.deepEqual(state.providerUsageContinuity, f.state.providerUsageContinuity);
  assert.equal(state.sourceSupersession.inheritedCompatibility.sourceAlreadyDeployed, false);
  assert(!f.db.rows.has(PATHS.readiness));
  assert.equal(proofDigest(f.jobs), beforeJobs);
  assert(f.db.rows.has(PATHS.operation));
  await releaseOwnedOperation(f.db, operation, f.input, result);
  assert(!f.db.rows.has(PATHS.operation));
});
test('changed operation, generation or current job failure abort final transaction with no archive/state write', async () => {
  for (const mutate of [
    (f) => f.db.put(PATHS.operation, { ...f.db.rows.get(PATHS.operation), operationId: 'different' }),
    (f) => f.db.put('durableJobs/' + f.jobs[0].job.jobId, { ...f.jobs[0].job, state: 'failed' }),
  ]) {
    const f = fixture(),
      { inspection, operation } = await claimed(f);
    mutate(f);
    await assert.rejects(() => supersedeTransaction(f.db, f.input, inspection, operation, f.external));
    assert.equal(f.db.rows.get(PATHS.state).phase, 'search-ready');
    assert(!f.db.rows.has(archivePath(f.input.oldRelease.releaseId)));
    assert(f.db.rows.has(PATHS.operation));
  }
});
test('stale external proof and concurrent head creation cannot slip through final native query/CAS', async () => {
  const f = fixture(),
    { inspection, operation } = await claimed(f);
  await assert.rejects(() =>
    supersedeTransaction(f.db, f.input, inspection, operation, {
      ...f.external,
      serverReadTime: new Timestamp(NOW - 60, 0),
    })
  );
  await assert.rejects(
    () =>
      supersedeTransaction(f.db, f.input, inspection, operation, f.external, {
        confirmHeads: async (db, tx) => {
          await tx.get(
            db.collection('durableActivityExecutions').where('projectId', '==', 'urm-app-staging').limit(10001)
          );
          db.put('durableActivityExecutions/concurrent', { projectId: 'urm-app-staging' });
        },
      }),
    /conflict/
  );
  assert.equal(f.db.rows.get(PATHS.state).phase, 'search-ready');
  assert(!f.db.rows.has(archivePath(f.input.oldRelease.releaseId)));
});
test('unknown acknowledgement preserves owned operation; explicit exact archive reconciliation does not repeat handoff', async () => {
  const f = fixture(),
    { inspection, operation } = await claimed(f);
  const result = await supersedeTransaction(f.db, f.input, inspection, operation, f.external, {
    now: () => NOW * 1000,
  });
  // Simulate caller losing the commit acknowledgement: no automatic operation cleanup follows.
  assert(f.db.rows.has(PATHS.operation));
  await assert.rejects(() => supersedeTransaction(f.db, f.input, inspection, operation, f.external));
  await releaseOwnedOperation(f.db, operation, f.input, result);
  assert.equal(f.db.rows.get(PATHS.state).controlRevision, 30);
  assert.equal(
    [...f.db.rows.keys()].filter((path) => path.startsWith('_control/temporalSearchSourceSupersession-')).length,
    1
  );
});
test('successor-state whitelist never copies old backend/search/UI readiness or opens admissions', () => {
  const f = fixture();
  const next = successorState(
    {
      ...f.state,
      backendEvidence: { passed: true },
      uiBuild: 'old',
      uiVerifiedAt: 100,
      uiRolloutIdentity: { old: true },
      bundlesConverged: true,
    },
    f.input.nextRelease,
    f.input.nextRelease.compatibilityCommit,
    'archive',
    'a'.repeat(64),
    NOW * 1000
  );
  assert.equal(next.phase, 'ownership-changed');
  assert(!next.backendEvidence);
  assert(!next.uiBuild);
  assert(!next.uiRolloutIdentity);
  assert(!next.bundlesConverged);
  assert.equal(next.providerUsageEpoch, f.state.providerUsageEpoch);
  assert.equal(next.sourceSupersession.inheritedCompatibility.releaseId, f.input.oldRelease.releaseId);
});

test('lost cleanup-delete ACK is reconciled read-only only for exact immutable archive/input/successor and absent op', async () => {
  const f = fixture();
  const { inspection, operation } = await claimed(f);
  const result = await supersedeTransaction(f.db, f.input, inspection, operation, f.external, {
    now: () => NOW * 1000,
  });
  await assert.rejects(async () => {
    await releaseOwnedOperation(f.db, operation, f.input, result);
    throw new Error('Synthetic acknowledgement lost after atomic own-operation deletion');
  }, /acknowledgement lost/);
  assert(!f.db.rows.has(PATHS.operation));
  const version = f.db.version;
  const confirmed = await confirmAlreadyReleased(f.db, f.input, OP);
  assert.equal(confirmed.result, 'already-released-confirmed');
  assert.equal(confirmed.noMutation, true);
  assert.equal(f.db.version, version, 'Read-only reconciliation must perform zero writes');
  await assert.rejects(() => confirmAlreadyReleased(f.db, { ...f.input, digest: '0'.repeat(64) }, OP));
  await assert.rejects(() => confirmAlreadyReleased(f.db, f.input, '87654321-4321-4321-8321-210987654321'));
  f.db.put(PATHS.operation, { operationId: 'other', action: 'other' });
  await assert.rejects(() => confirmAlreadyReleased(f.db, f.input, OP));
  f.db.rows.delete(PATHS.operation);
  f.db.put(PATHS.state, { ...f.db.rows.get(PATHS.state), updatedAt: NOW * 1000 + 1 });
  await assert.rejects(() => confirmAlreadyReleased(f.db, f.input, OP));
  f.db.put(PATHS.state, result.successorState);
  f.db.put(result.archivePath, f.db.rows.get(result.archivePath));
  await assert.rejects(() => confirmAlreadyReleased(f.db, f.input, OP), /RECONCILIATION_CHANGED/);
});
