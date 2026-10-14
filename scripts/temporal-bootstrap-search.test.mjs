import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STAGING_SEARCH_TARGET,
  STAGING_SEARCH_INSTANCES,
  stagingSearchSettingsPlan,
} from './algolia-staging-search-schema.mjs';
import {
  assertSearchBootstrapBoundary,
  validateSearchBootstrapOptions,
  searchBootstrapIdentity,
  searchBootstrapEntityKey,
  validateSearchBootstrapProof,
  validateSearchSettingsReceipt,
  runSearchBootstrap,
  createSearchBootstrapStore,
  confirmSearchBootstrapInTransaction,
  parseSearchBootstrapArgs,
  requiredPreUiPhase,
  searchRecoveryPhase,
  SEARCH_BOOTSTRAP_INSTANCES,
  searchReadinessMarker,
  confirmAndWriteSearchReadiness,
} from './temporal-bootstrap-search.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const req = createRequire(new URL('../package.json', import.meta.url));
req('ts-node').register({ project: resolve(root, 'functions/tsconfig.json'), transpileOnly: true });
req('tsconfig-paths').register({
  baseUrl: resolve(root, 'functions'),
  paths: {
    '@upperroom/contracts/*': ['../packages/contracts/*'],
    '@upperroom/orchestration/*': ['../packages/orchestration/src/*'],
    '@upperroom/shared/*': ['../packages/shared/*'],
  },
});
const { createDurableJobStore, durableEntityKey } = req(resolve(root, 'packages/orchestration/src/job-store.ts'));
const now = Date.parse('2026-10-15T12:00:00Z');
const options = {
  projectId: 'urm-app-staging',
  releaseId: 'a801c079-a832-4bfa-a526-ec385e49d27f',
  commit: 'a'.repeat(40),
  controlRevision: 17,
  operationId: '99ef4e7e-fadf-4830-b631-68a82a20d82d',
  timeoutMs: 2000,
};
function boundary() {
  return {
    control: {
      schemaVersion: 1,
      releaseId: options.releaseId,
      revision: 17,
      admission: 'paused',
      domains: Object.fromEntries(
        ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
          d,
          { owner: 'temporal', admission: d === 'search' ? 'paused' : 'open' },
        ])
      ),
    },
    state: {
      releaseId: options.releaseId,
      controlRevision: 17,
      compatibilityCommit: options.commit,
      phase: 'backend-ready',
      mode: 'initial-cutover',
      domains: ['search'],
      backendVerifiedAt: now - 1000,
    },
    operation: { operationId: options.operationId, releaseId: options.releaseId, action: 'bootstrap-search' },
  };
}
function settings() {
  const updates = stagingSearchSettingsPlan({
    projectId: STAGING_SEARCH_TARGET.projectId,
    appId: STAGING_SEARCH_TARGET.appId,
    indexNames: STAGING_SEARCH_INSTANCES.map((r) => r.indexName),
  });
  return {
    projectId: options.projectId,
    appId: STAGING_SEARCH_TARGET.appId,
    mode: 'apply',
    usersPolicy: 'empty-private',
    updates,
    tasks: updates.map((p, i) => ({ indexName: p.indexName, taskID: i + 100, completed: true })),
    verifiedAt: new Date(now).toISOString(),
  };
}
function memory() {
  const state = new Map(),
    initial = boundary();
  for (const [key, value] of [
    ['temporalRelease', initial.control],
    ['temporalReleaseState', initial.state],
    ['temporalReleaseOperation', initial.operation],
  ])
    state.set('_control/' + key, structuredClone(value));
  const snapshot = (path, values = state) => ({
    exists: values.has(path),
    data: () => structuredClone(values.get(path)),
    get: (key) => values.get(path)?.[key],
  });
  const doc = (path) => ({ path, get: async () => snapshot(path) });
  const query = (collection, filters = [], limit = Infinity) => ({
    query: true,
    collection,
    filters,
    max: limit,
    where: (field, op, value) => query(collection, [...filters, { field, op, value }], limit),
    limit: (count) => query(collection, filters, count),
    get: async () => querySnapshot({ collection, filters, max: limit }, state),
  });
  const querySnapshot = (q, values) => {
    const docs = [...values]
      .filter(
        ([p, v]) =>
          p.startsWith(q.collection + '/') &&
          q.filters.every((f) =>
            f.op === 'not-in'
              ? !f.value.includes(v[f.field])
              : f.op === 'in'
              ? f.value.includes(v[f.field])
              : v[f.field] === f.value
          )
      )
      .slice(0, q.max)
      .map(([p]) => snapshot(p, values));
    return { size: docs.length, docs };
  };
  let writes = 0;
  const db = {
    doc,
    collection: (name) => ({
      doc: (id) => doc(name + '/' + id),
      where: (field, op, value) => query(name, [{ field, op, value }]),
    }),
    runTransaction: async (callback) => {
      const values = new Map(structuredClone([...state]));
      let written = false,
        count = 0;
      const tx = {
        get: async (ref) => {
          assert.equal(written, false, 'all reads precede writes');
          return ref.query ? querySnapshot(ref, values) : snapshot(ref.path, values);
        },
        create: (ref, value) => {
          assert(!values.has(ref.path));
          written = true;
          count++;
          values.set(ref.path, structuredClone(value));
        },
        set: (ref, value) => {
          written = true;
          count++;
          values.set(ref.path, structuredClone(value));
        },
      };
      const result = await callback(tx);
      state.clear();
      for (const pair of values) state.set(...pair);
      writes += count;
      return result;
    },
  };
  const store = createSearchBootstrapStore(db, options, {
    createStore: createDurableJobStore,
    entityKey: durableEntityKey,
  });
  const complete = () => {
    for (const [p, job] of state)
      if (p.startsWith('durableJobs/') && job.kind === 'search.backfill')
        state.set(p, { ...job, state: 'succeeded', revision: job.revision + 1, result: { count: 3 } });
  };
  return { db, store, state, complete, writes: () => writes };
}
test('bootstrap is scoped to a real paused search-only release; other six owners remain Temporal/open by domain', () => {
  assertSearchBootstrapBoundary(boundary(), options);
  for (const change of [
    (x) => (x.projectId = 'urm-app'),
    (x) => (x.commit = 'short'),
    (x) => (x.controlRevision = 0),
    (x) => (x.operationId = 'same'),
  ]) {
    const x = structuredClone(options);
    change(x);
    assert.throws(() => validateSearchBootstrapOptions(x));
  }
  for (const change of [
    (x) => (x.control.admission = 'open'),
    (x) => (x.control.domains.search.owner = 'legacy'),
    (x) => (x.control.domains.search.admission = 'open'),
    (x) => (x.control.domains.media.owner = 'legacy'),
    (x) => (x.control.domains.media.admission = 'paused'),
    (x) => (x.state.phase = 'ui-ready'),
    (x) => (x.state.domains = ['search', 'bundles']),
    (x) => (x.state.compatibilityCommit = 'b'.repeat(40)),
    (x) => x.state.controlRevision++,
    (x) => (x.operation.action = 'backend-ready'),
    (x) => (x.operation.operationId = 'other'),
  ]) {
    const x = boundary();
    change(x);
    assert.throws(() => assertSearchBootstrapBoundary(x, options));
  }
  assert.equal(
    requiredPreUiPhase({ projectId: options.projectId, mode: 'initial-cutover', domains: ['search'] }),
    'search-ready'
  );
  assert.equal(requiredPreUiPhase({ projectId: options.projectId, domains: ['bundles'] }), 'bundles-ready');
  assert.equal(requiredPreUiPhase({ projectId: 'urm-app', domains: ['search'] }), 'backend-ready');
});
test('exact applied settings require eleven awaited target tasks and a fresh completion receipt', () => {
  validateSearchSettingsReceipt(settings(), now);
  for (const change of [
    (x) => (x.appId = '8OY'),
    (x) => (x.mode = 'dry-run'),
    (x) => x.tasks.pop(),
    (x) => (x.tasks[0].completed = false),
    (x) => (x.tasks[0].indexName = x.tasks[1].indexName),
    (x) => (x.updates[0].indexName = 'prod-users'),
    (x) => (x.verifiedAt = new Date(now + 1).toISOString()),
    (x) => delete x.verifiedAt,
  ]) {
    const x = settings();
    change(x);
    assert.throws(() => validateSearchSettingsReceipt(x, now));
  }
});
test('real durable store creates exactly five protocol jobs; retries reuse IDs, generation, intent and outbox', async () => {
  const m = memory();
  for (const row of STAGING_SEARCH_INSTANCES) {
    const identity = searchBootstrapIdentity(options, row.instanceId);
    assert.equal(
      searchBootstrapEntityKey(options, row.instanceId),
      durableEntityKey(options.projectId, identity.entity, 'search.backfill')
    );
    const p = await m.store.submit(row.instanceId);
    validateSearchBootstrapProof(p, options, row.instanceId, false);
  }
  const before = structuredClone([...m.state]);
  const writes = m.writes();
  for (const row of STAGING_SEARCH_INSTANCES) await m.store.submit(row.instanceId);
  assert.equal(m.writes(), writes);
  assert.deepEqual([...m.state], before);
  assert.equal([...m.state.keys()].filter((p) => p.startsWith('durableJobs/')).length, 5);
  assert.equal([...m.state.keys()].filter((p) => p.startsWith('durableJobOutbox/')).length, 5);
  const outbox = [...m.state].filter(([p]) => p.startsWith('durableJobOutbox/')).map(([, v]) => v);
  assert(
    outbox.every(
      (v) =>
        v.dispatch.workflowType === 'SearchBackfill' &&
        v.dispatch.taskQueue === 'urm-search' &&
        v.dispatch.startArgs.ref.jobId === v.jobId
    )
  );
});
test('paused admission rejects changed owner/operation even on duplicate retry, and refuses unrelated unfinished work before any write', async () => {
  for (const change of [
    (m) => (m.state.get('_control/temporalRelease').domains.search.owner = 'legacy'),
    (m) => (m.state.get('_control/temporalReleaseOperation').operationId = 'other'),
    (m) => m.state.set('durableJobs/existing', { state: 'running', kind: 'sermon.publish' }),
  ]) {
    const m = memory();
    change(m);
    await assert.rejects(m.store.submit('sermons-index'));
    assert.equal(m.writes(), 0);
  }
  const m = memory();
  await m.store.submit('sermons-index');
  const writes = m.writes();
  m.state.get('_control/temporalRelease').revision++;
  await assert.rejects(m.store.submit('sermons-index'));
  assert.equal(m.writes(), writes);
  const large = memory();
  for (let i = 0; i < 501; i++) large.state.set('durableJobs/active' + i, { state: 'queued', kind: 'search.sync' });
  await assert.rejects(large.store.submit('sermons-index'));
  assert.equal(large.writes(), 0);
});
test('bootstrap waits for all five durable completions and final transaction rechecks exact generation and authority', async () => {
  const m = memory();
  let clock = now,
    sleeps = 0;
  const proof = await runSearchBootstrap(options, {
    ...m.store,
    now: () => clock,
    readSettings: async () => settings(),
    sleep: async () => {
      sleeps++;
      clock += 100;
      m.complete();
    },
  });
  assert.equal(sleeps, 1);
  assert.equal(proof.jobIds.length, 5);
  assert.equal(proof.result, 'passed');
  await m.db.runTransaction((tx) => confirmSearchBootstrapInTransaction(m.db, tx, options, proof));
  const key = 'durableJobEntities/' + searchBootstrapEntityKey(options, 'sermons-index');
  m.state.get(key).generation++;
  await assert.rejects(m.db.runTransaction((tx) => confirmSearchBootstrapInTransaction(m.db, tx, options, proof)));
});
test('settings failure admits nothing; unknown outcomes or deadline never yield convergence', async () => {
  const m = memory();
  const invalid = settings();
  invalid.mode = 'dry-run';
  await assert.rejects(runSearchBootstrap(options, { ...m.store, now: () => now, readSettings: async () => invalid }));
  assert.equal(m.writes(), 0);
  let clock = now;
  await assert.rejects(
    runSearchBootstrap(options, {
      ...m.store,
      now: () => clock,
      readSettings: async () => settings(),
      sleep: async () => {
        clock += 3000;
      },
    }),
    /SEARCH_BOOTSTRAP_TIMEOUT/
  );
  const first = searchBootstrapIdentity(options, 'users-index');
  m.state.get('durableJobs/' + first.ref.jobId).state = 'needs_attention';
  await assert.rejects(
    runSearchBootstrap(options, { ...m.store, now: () => now, readSettings: async () => settings() }),
    /SEARCH_BOOTSTRAP_REQUIRES_REVIEW/
  );
});
test('proof rejects foreign identities, replaced intent/generation and noninteger provider count', async () => {
  const m = memory();
  const p = await m.store.submit('sermons-index');
  m.complete();
  const completed = (await m.store.readProofs())[2];
  assert.equal(validateSearchBootstrapProof(completed, options, 'sermons-index'), true);
  for (const mutate of [
    (x) => (x.job.projectId = 'urm-app'),
    (x) => x.job.generation++,
    (x) => (x.entity.activeJobId = 'foreign'),
    (x) => (x.intent.payload.instanceId = 'users-index'),
    (x) => (x.intent.payload.releaseBootstrap.commit = 'b'.repeat(40)),
    (x) => (x.job.result.count = 1.5),
  ]) {
    const x = structuredClone(completed);
    mutate(x);
    if (x.job.result.count === 1.5) assert.equal(validateSearchBootstrapProof(x, options, 'sermons-index'), false);
    else assert.throws(() => validateSearchBootstrapProof(x, options, 'sermons-index'));
  }
  assert.equal(p.job.state, 'queued');
});
test('CLI requires explicit apply and every actual release/operation/settings identity', () => {
  const args = [
    '--project',
    options.projectId,
    '--release-id',
    options.releaseId,
    '--commit',
    options.commit,
    '--control-revision',
    '17',
    '--operation-id',
    options.operationId,
    '--settings-proof',
    '/private/settings.json',
    '--release',
    '/private/release.json',
    '--apply',
  ];
  assert.equal(parseSearchBootstrapArgs(args).options.operationId, options.operationId);
  for (const bad of [
    args.filter((x) => x !== '--apply'),
    [...args, '--apply'],
    [...args, '--unsafe', 'yes'],
    [...args, '--project', 'urm-app'],
  ])
    assert.throws(() => parseSearchBootstrapArgs(bad));
});

test('live search work must settle before bootstrap or later UI/open checkpoints; recovery rechecks bootstrap', async () => {
  const m = memory();
  for (const id of SEARCH_BOOTSTRAP_INSTANCES) await m.store.submit(id);
  m.complete();
  const proofs = await m.store.readProofs();
  const expected = {
    jobIds: proofs.map((p) => p.job.jobId),
    generations: proofs.map((p) => p.job.generation),
    counts: proofs.map((p) => p.job.result.count),
  };
  m.state.set('durableJobs/live', { state: 'running', kind: 'search.sync' });
  assert.equal(await m.store.confirmProofs(proofs), false);
  await assert.rejects(
    m.db.runTransaction((tx) => confirmSearchBootstrapInTransaction(m.db, tx, options, expected)),
    /SEARCH_BOOTSTRAP_NOT_CONVERGED/
  );
  m.state.get('durableJobs/live').state = 'succeeded';
  await m.db.runTransaction((tx) => confirmSearchBootstrapInTransaction(m.db, tx, options, expected));
  m.state.get('_control/temporalReleaseState').phase = 'search-ready';
  m.state.get('_control/temporalReleaseOperation').action = 'rollout-ui';
  await m.db.runTransaction((tx) =>
    confirmSearchBootstrapInTransaction(m.db, tx, options, expected, { phase: 'search-ready', action: 'rollout-ui' })
  );
  m.state.get('_control/temporalReleaseOperation').action = 'other';
  await assert.rejects(
    m.db.runTransaction((tx) =>
      confirmSearchBootstrapInTransaction(m.db, tx, options, expected, { phase: 'search-ready', action: 'rollout-ui' })
    )
  );
  assert.equal(searchRecoveryPhase('search-ready'), 'backend-ready');
  assert.equal(searchRecoveryPhase('complete'), 'ui-ready');
  assert.equal(searchRecoveryPhase('backend-ready'), 'backend-ready');
});

test('failed or cancelled live sync must have a strictly newer succeeded canonical generation', async () => {
  for (const state of ['failed', 'cancelled']) {
    const m = memory();
    for (const id of SEARCH_BOOTSTRAP_INSTANCES) await m.store.submit(id);
    m.complete();
    const proofs = await m.store.readProofs();
    const old = {
      projectId: options.projectId,
      jobId: 'old-live',
      kind: 'search.sync',
      state,
      entity: { type: 'maintenance', id: 'source' },
      generation: 1,
    };
    m.state.set('durableJobs/old-live', old);
    await assert.rejects(m.store.confirmProofs(proofs), /SEARCH_BOOTSTRAP_REQUIRES_REVIEW/);
    const key = durableEntityKey(options.projectId, old.entity, 'search.sync');
    const entity = { projectId: options.projectId, entity: old.entity, activeJobId: 'new-live', generation: 2 };
    m.state.set('durableJobEntities/' + key, entity);
    m.state.set('durableJobs/new-live', { ...old, jobId: 'new-live', state: 'succeeded', generation: 2 });
    assert.equal(await m.store.confirmProofs(proofs), true);
    for (const mutate of [
      (x) => (x.generation = 1),
      (x) => (x.activeJobId = 'missing'),
      (x) => (x.projectId = 'urm-app'),
    ]) {
      const saved = structuredClone(entity);
      mutate(entity);
      m.state.set('durableJobEntities/' + key, structuredClone(entity));
      await assert.rejects(m.store.confirmProofs(proofs));
      Object.assign(entity, saved);
    }
  }
});

test('persistent private readiness binds schema/target and permits later nonsearch releases without premature UI enablement', async () => {
  const { validateStagingSearchReadiness, STAGING_SEARCH_SCHEMA_SHA256 } = req(
    resolve(root, 'packages/contracts/stagingSearchReadiness.ts')
  );
  const m = memory();
  let clock = now;
  const proof = await runSearchBootstrap(options, {
    ...m.store,
    now: () => clock,
    readSettings: async () => settings(),
    sleep: async () => {
      clock += 100;
      m.complete();
    },
  });
  const before = m.writes();
  const marker = await m.db.runTransaction((tx) => confirmAndWriteSearchReadiness(m.db, tx, options, proof));
  assert.equal(m.writes(), before + 1);
  assert.deepEqual(
    m.state.get('_control/temporalSearchReadiness'),
    searchReadinessMarker(proof, options.controlRevision + 1)
  );
  const control = { ...boundary().control, revision: options.controlRevision + 1 };
  assert.equal(marker.recordSchemaSha256, STAGING_SEARCH_SCHEMA_SHA256);
  validateStagingSearchReadiness(control, marker);
  validateStagingSearchReadiness(
    { ...control, revision: control.revision + 5, releaseId: 'later-non-search-release' },
    marker
  );
  for (const change of [
    (x) => (x.projectId = 'urm-app'),
    (x) => (x.appId = 'old-staging'),
    (x) => (x.recordSchemaSha256 = 'f'.repeat(64)),
    (x) => (x.controlRevision = 999),
    (x) => x.jobIds.pop(),
    (x) => (x.jobIds[0] = x.jobIds[1]),
    (x) => (x.generations[0] = 0),
    (x) => (x.counts[0] = -1),
    (x) => (x.compatibilityCommit = ['a'.repeat(40)]),
    (x) => (x.extra = true),
  ]) {
    const bad = structuredClone(marker);
    change(bad);
    assert.throws(() => validateStagingSearchReadiness(control, bad));
  }
  assert.throws(() => validateStagingSearchReadiness(control, undefined));
  const legacy = structuredClone(control);
  legacy.domains.search.owner = 'legacy';
  assert.throws(() => validateStagingSearchReadiness(legacy, marker));
});
