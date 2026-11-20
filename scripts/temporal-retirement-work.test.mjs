import assert from 'node:assert/strict';
import test from 'node:test';
import { proofDigest } from './temporal-release-runtime.mjs';
import { assertTraditionalRetirementWorkIdle, readTraditionalRetirementWork } from './temporal-retirement-work.mjs';

function timestamp(value) {
  return { valueOf: () => value, isEqual: (other) => value === other?.valueOf() };
}

function fixture() {
  const dispatched = { state: 'dispatched', leaseExpiresAt: 0, leaseToken: 'old', leaseOwner: 'old' };
  const collections = {
    durableJobOutbox: Array(4204).fill(dispatched),
    durableJobCommands: [{ state: 'dispatched', leaseExpiresAt: 0 }],
    temporalProviderMutationSessions: [{ state: 'committed' }, { state: 'aborted' }],
    durableJobCriticalSections: [],
    temporalProviderMutationLocks: [],
  };
  function query(name, filters = []) {
    return {
      where: (...filter) => query(name, [...filters, filter]),
      count: () => ({
        count: collections[name].filter((row) =>
          filters.every(([key, op, value]) => (op === '==' ? row[key] === value : value.includes(row[key])))
        ).length,
      }),
    };
  }
  const slot = { exists: false };
  const documents = new Map();
  const snapshot = (path) => {
    const row = documents.get(path);
    return {
      exists: row !== undefined,
      createTime: timestamp(path.startsWith('temporalPublishingRecoverySettlementAudits/') ? 3 : 1),
      updateTime: timestamp(
        row?.rewritten ? 4 : path.startsWith('temporalPublishingRecoverySettlementAudits/') ? 3 : 1
      ),
      data: () => row,
      get: (key) => key.split('.').reduce((value, step) => value?.[step], row),
    };
  };
  const db = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    collection: query,
    doc: (path) => (path === 'temporalYouTubeRenderHosts/staging' ? slot : { path }),
  };
  const tx = {
    get: async (ref) =>
      'exists' in ref ? ref : ref.path ? snapshot(ref.path) : { data: () => ({ count: ref.count }) },
    getAll: async (...refs) => refs.map((ref) => snapshot(ref.path)),
  };
  return { collections, documents, slot, read: () => readTraditionalRetirementWork(db, tx) };
}

test('indexed retirement inventory tolerates historical lease metadata only after zero-expiry dispatch', async () => {
  const f = fixture();
  const result = await f.read();
  assert.deepEqual(result.outbox, { total: 4204, settled: 4204 });
  assert.match(assertTraditionalRetirementWorkIdle(result), /^[a-f0-9]{64}$/);
  f.collections.durableJobOutbox.push({ state: 'dispatched', leaseExpiresAt: 1 });
  const changed = await f.read();
  assert.throws(() => assertTraditionalRetirementWorkIdle(changed), /TRADITIONAL_RETIREMENT_WORK_UNCONFIRMED/);
});

test('retirement denies pending or unknown work, active provider locks and reserved YouTube work', async () => {
  const changes = [
    (f) => f.collections.durableJobCommands.push({ state: 'pending', leaseExpiresAt: 0 }),
    (f) => f.collections.durableJobCommands.push({ state: 'dispatching', leaseExpiresAt: 0 }),
    (f) => f.collections.durableJobCommands.push({ leaseExpiresAt: 0 }),
    (f) => f.collections.temporalProviderMutationSessions.push({ state: 'active' }),
    (f) => f.collections.temporalProviderMutationLocks.push({}),
    (f) => f.collections.durableJobCriticalSections.push({}),
    (f) => {
      f.slot.exists = true;
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    const result = await f.read();
    assert.throws(() => assertTraditionalRetirementWorkIdle(result), /TRADITIONAL_RETIREMENT_WORK_UNCONFIRMED/);
  }
});

test('retirement excludes only the immutable, terminal staging repair ownership records', async () => {
  const f = fixture();
  const projectId = 'urm-app-staging';
  const jobId = 'job-2cdc4bbb473b76b91027c9ee51ce98234f0537fe69f202ba';
  const workflowId = projectId + ':sermon:fixture:' + jobId;
  const scope = { projectId, jobId, operation: 'fixture' };
  const sessionId = proofDigest(scope);
  const operationId = '11111111-1111-4111-8111-111111111111';
  const operatorDigest = 'b'.repeat(64);
  const nativeRoutingDigest = 'c'.repeat(64);
  const resources = ['d', 'e', 'f'].map((resourceId) => ({ provider: 'subsplash', account: 'fixture', resourceId }));
  const keys = resources.map((r) => proofDigest([projectId, r.provider, r.account, r.resourceId]));
  const audit = {
    schemaVersion: 1,
    projectId,
    jobId,
    workflowId,
    sessionId,
    operationId,
    runId: operationId,
    terminalEvent: '760',
    recordedAt: timestamp(2),
    operatorDigest,
    nativeRoutingDigest,
    result: {
      retainedOwnershipRecordsSettled: true,
      confirmedRouting: true,
      repairApplied: true,
      successfulRepair: true,
      sessionState: 'committed',
      jobState: 'cancelled',
      workflowStatus: 3,
    },
  };
  f.documents.set('temporalPublishingRecoverySettlementAudits/' + jobId, audit);
  f.documents.set('temporalPublishingRecoveryRoutingReadbacks/' + jobId, {
    projectId,
    jobId,
    operationId,
    operatorDigest,
    nativeDigest: nativeRoutingDigest,
    schemaVersion: 1,
    confirmed: true,
  });
  f.documents.set('durableJobs/' + jobId, { projectId, generation: 1, workflowId, state: 'cancelled' });
  const session = {
    scope,
    resources,
    schemaVersion: 1,
    state: 'committed',
    effectsClosed: true,
    effectsClosedSourceDispositionValidated: true,
    canonicalCompletionDigest: '1'.repeat(64),
    canonicalCompletionCatalogDigest: '2'.repeat(64),
    resourceKeys: keys,
  };
  f.documents.set('temporalProviderMutationSessions/' + sessionId, session);
  const critical = { schemaVersion: 1, projectId, jobId, generation: 1, workflowId };
  f.collections.durableJobCriticalSections.push(critical);
  f.documents.set('durableJobCriticalSections/' + jobId, critical);
  for (const key of keys) {
    const lock = { schemaVersion: 1, projectId, jobId, state: 'held', sessionId };
    f.collections.temporalProviderMutationLocks.push(lock);
    f.documents.set('temporalProviderMutationLocks/' + key, lock);
  }
  assert.match(assertTraditionalRetirementWorkIdle(await f.read()), /^[a-f0-9]{64}$/);

  const denials = [
    [audit, 'rewritten', true],
    [audit, 'recordedAt', timestamp(4)],
    [audit, 'recordedAt', 2],
    [audit, 'nativeRoutingDigest', '0'.repeat(64)],
    [session, 'state', 'active'],
    [session, 'rewritten', true],
    [session, 'effectsClosed', false],
    [resources[0], 'resourceId', 'different-provider-resource'],
    [scope, 'operation', 'different-publication'],
    [critical, 'generation', 2],
    [critical, 'rewritten', true],
    [f.collections.temporalProviderMutationLocks[0], 'rewritten', true],
    [f.collections.temporalProviderMutationLocks[0], 'sessionId', '0'.repeat(64)],
  ];
  for (const [row, key, value] of denials) {
    const original = row[key];
    row[key] = value;
    const inventory = await f.read();
    assert.throws(() => assertTraditionalRetirementWorkIdle(inventory), /TRADITIONAL_RETIREMENT_WORK_UNCONFIRMED/);
    row[key] = original;
  }
});
