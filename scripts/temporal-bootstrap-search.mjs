#!/usr/bin/env node
// Trusted release operation only: five deterministic paused-search backfills, never a public admission override.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STAGING_SEARCH_TARGET,
  STAGING_SEARCH_INSTANCES,
  stagingSearchSettingsPlan,
} from './algolia-staging-search-schema.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]])
        )
      : v
  );
const fail = (code) => Object.assign(new Error(code), { code });
export const SEARCH_BOOTSTRAP_INSTANCES = Object.freeze(STAGING_SEARCH_INSTANCES.map((row) => row.instanceId));
export function requiresSearchBootstrap(config) {
  return (
    config.projectId === STAGING_SEARCH_TARGET.projectId &&
    config.mode === 'initial-cutover' &&
    config.domains.includes('search')
  );
}
export function requiredPreUiPhase(config) {
  return requiresSearchBootstrap(config)
    ? 'search-ready'
    : config.domains.includes('bundles')
    ? 'bundles-ready'
    : 'backend-ready';
}
export function validateSearchBootstrapOptions(options) {
  if (
    options.projectId !== STAGING_SEARCH_TARGET.projectId ||
    !/^[a-f0-9]{40}$/.test(options.commit ?? '') ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(options.releaseId ?? '') ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(options.operationId ?? '') ||
    !Number.isSafeInteger(options.controlRevision) ||
    options.controlRevision < 1 ||
    !Number.isSafeInteger(options.timeoutMs ?? 840000) ||
    (options.timeoutMs ?? 840000) < 1000 ||
    (options.timeoutMs ?? 840000) > 3600000
  )
    throw fail('SEARCH_BOOTSTRAP_OPTIONS_INVALID');
}
export function searchRecoveryPhase(pausedFrom) {
  return pausedFrom === 'search-ready'
    ? 'backend-ready'
    : ['open', 'complete'].includes(pausedFrom)
    ? 'ui-ready'
    : pausedFrom;
}
export function assertSearchBootstrapBoundary(
  { control, state, operation },
  options,
  checkpoint = { phase: 'backend-ready', action: 'bootstrap-search' }
) {
  validateSearchBootstrapOptions(options);
  const domains = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'];
  if (
    control?.schemaVersion !== 1 ||
    control.releaseId !== options.releaseId ||
    control.revision !== options.controlRevision ||
    control.admission !== 'paused' ||
    stable(Object.keys(control.domains ?? {}).sort()) !== stable([...domains].sort()) ||
    domains.some(
      (d) =>
        control.domains[d]?.owner !== 'temporal' ||
        control.domains[d]?.admission !== (d === 'search' ? 'paused' : 'open')
    ) ||
    state?.releaseId !== options.releaseId ||
    state.controlRevision !== options.controlRevision ||
    state.compatibilityCommit !== options.commit ||
    state.phase !== checkpoint.phase ||
    state.mode !== 'initial-cutover' ||
    stable(state.domains) !== stable(['search']) ||
    !Number.isFinite(state.backendVerifiedAt) ||
    operation?.releaseId !== options.releaseId ||
    operation.operationId !== options.operationId ||
    operation.action !== checkpoint.action
  )
    throw fail('SEARCH_BOOTSTRAP_AUTHORITY_CHANGED');
}
export function searchBootstrapIdentity(options, instanceId) {
  validateSearchBootstrapOptions(options);
  if (!SEARCH_BOOTSTRAP_INSTANCES.includes(instanceId)) throw fail('SEARCH_BOOTSTRAP_INSTANCE_INVALID');
  const requestId = `search-bootstrap-${sha(stable([options.releaseId, instanceId]))}`;
  return {
    requestId,
    ref: { projectId: options.projectId, jobId: `job-${sha(stable([options.projectId, requestId])).slice(0, 48)}` },
    entity: { type: 'maintenance', id: sha(`${instanceId}:backfill`) },
    payload: { instanceId, releaseBootstrap: { releaseId: options.releaseId, commit: options.commit } },
  };
}
export function validateSearchSettingsReceipt(receipt, now = Date.now()) {
  const plan = stagingSearchSettingsPlan({
    projectId: STAGING_SEARCH_TARGET.projectId,
    appId: STAGING_SEARCH_TARGET.appId,
    indexNames: STAGING_SEARCH_INSTANCES.map((r) => r.indexName),
  });
  const verifiedAt = Date.parse(receipt?.verifiedAt);
  if (
    receipt?.projectId !== STAGING_SEARCH_TARGET.projectId ||
    receipt.appId !== STAGING_SEARCH_TARGET.appId ||
    receipt.mode !== 'apply' ||
    receipt.usersPolicy !== 'empty-private' ||
    !Number.isFinite(verifiedAt) ||
    verifiedAt > now ||
    now - verifiedAt > 3600000 ||
    stable(receipt.updates) !== stable(plan) ||
    !Array.isArray(receipt.tasks) ||
    receipt.tasks.length !== plan.length ||
    new Set(receipt.tasks.map((t) => t.indexName)).size !== plan.length ||
    receipt.tasks.some(
      (t) =>
        !plan.some((p) => p.indexName === t.indexName) ||
        t.completed !== true ||
        !Number.isSafeInteger(t.taskID) ||
        t.taskID < 0
    )
  )
    throw fail('SEARCH_BOOTSTRAP_SETTINGS_NOT_READY');
}
export function validateSearchBootstrapProof(proof, options, instanceId, requireComplete = true) {
  const identity = searchBootstrapIdentity(options, instanceId),
    { job, entity, intent } = proof ?? {};
  if (
    !job ||
    !entity ||
    !intent ||
    job.projectId !== options.projectId ||
    job.jobId !== identity.ref.jobId ||
    job.kind !== 'search.backfill' ||
    job.requestId !== identity.requestId ||
    job.requestedBy !== 'system:search' ||
    stable(job.entity) !== stable(identity.entity) ||
    !Number.isSafeInteger(job.generation) ||
    job.generation < 1 ||
    entity.projectId !== options.projectId ||
    entity.activeJobId !== job.jobId ||
    entity.generation !== job.generation ||
    entity.scope !== 'search' ||
    stable(entity.entity) !== stable(identity.entity) ||
    intent.jobId !== job.jobId ||
    intent.projectId !== options.projectId ||
    intent.kind !== 'search.backfill' ||
    intent.actorUid !== 'system:search' ||
    intent.generation !== job.generation ||
    stable(intent.payload) !== stable(identity.payload) ||
    stable(intent.entity) !== stable(identity.entity)
  )
    throw fail('SEARCH_BOOTSTRAP_PROOF_CHANGED');
  if (!requireComplete) return true;
  if (['failed', 'cancelled', 'superseded', 'needs_attention'].includes(job.state))
    throw fail('SEARCH_BOOTSTRAP_REQUIRES_REVIEW');
  return job.state === 'succeeded' && Number.isSafeInteger(job.result?.count) && job.result.count >= 0;
}
/** The dependency seam exercises real protocol admissions without requiring a provider or emulator in unit tests. */
export async function runSearchBootstrap(options, deps) {
  validateSearchBootstrapOptions(options);
  const now = deps.now ?? Date.now,
    sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  validateSearchSettingsReceipt(await deps.readSettings(), now());
  const deadline = now() + (options.timeoutMs ?? 840000);
  assertSearchBootstrapBoundary(await deps.readBoundary(), options);
  for (const instanceId of SEARCH_BOOTSTRAP_INSTANCES) {
    assertSearchBootstrapBoundary(await deps.readBoundary(), options);
    const proof = await deps.submit(instanceId, options);
    validateSearchBootstrapProof(proof, options, instanceId, false);
  }
  while (now() < deadline) {
    assertSearchBootstrapBoundary(await deps.readBoundary(), options);
    const proofs = await deps.readProofs(options);
    if (proofs.length !== SEARCH_BOOTSTRAP_INSTANCES.length) throw fail('SEARCH_BOOTSTRAP_PROOF_CHANGED');
    const complete = proofs.map((p, i) => validateSearchBootstrapProof(p, options, SEARCH_BOOTSTRAP_INSTANCES[i]));
    if (complete.every(Boolean) && (await deps.confirmProofs(proofs, options))) {
      validateSearchSettingsReceipt(await deps.readSettings(), now());
      return {
        schemaVersion: 1,
        result: 'passed',
        projectId: options.projectId,
        appId: STAGING_SEARCH_TARGET.appId,
        releaseId: options.releaseId,
        commit: options.commit,
        controlRevision: options.controlRevision,
        instanceIds: SEARCH_BOOTSTRAP_INSTANCES,
        jobIds: proofs.map((p) => p.job.jobId),
        generations: proofs.map((p) => p.job.generation),
        counts: proofs.map((p) => p.job.result.count),
        settingsReceiptCanonicalSha256: sha(stable(await deps.readSettings())),
        verifiedAt: new Date(now()).toISOString(),
      };
    }
    await sleep(options.pollMs ?? 2000);
  }
  throw fail('SEARCH_BOOTSTRAP_TIMEOUT');
}
export function searchReadinessMarker(proof, readyRevision) {
  return {
    schemaVersion: 1,
    projectId: STAGING_SEARCH_TARGET.projectId,
    appId: STAGING_SEARCH_TARGET.appId,
    recordSchemaSha256: sha(stable(STAGING_SEARCH_TARGET)),
    releaseId: proof.releaseId,
    compatibilityCommit: proof.commit,
    controlRevision: readyRevision,
    jobIds: proof.jobIds,
    generations: proof.generations,
    counts: proof.counts,
    settingsReceiptCanonicalSha256: proof.settingsReceiptCanonicalSha256,
  };
}
export function searchBootstrapEntityKey(options, instanceId) {
  const { entity } = searchBootstrapIdentity(options, instanceId);
  return sha(stable([options.projectId, entity.type, entity.id, 'search']));
}
export async function assertNoUnfinishedNonSearchJobs(db, tx) {
  const query = db
    .collection('durableJobs')
    .where('state', 'not-in', ['succeeded', 'failed', 'cancelled', 'superseded'])
    .limit(501);
  const active = tx ? await tx.get(query) : await query.get();
  if (active.size > 500 || active.docs.some((d) => !['search.sync', 'search.backfill'].includes(d.get('kind'))))
    throw fail('SEARCH_BOOTSTRAP_OTHER_WORK_NOT_DRAINED');
}
async function assertSearchFailuresResolved(db, tx) {
  const failed = await tx.get(
    db
      .collection('durableJobs')
      .where('kind', '==', 'search.sync')
      .where('state', 'in', ['failed', 'cancelled'])
      .limit(501)
  );
  if (failed.size > 500) throw fail('SEARCH_BOOTSTRAP_REQUIRES_REVIEW');
  for (const row of failed.docs) {
    const old = row.data();
    if (
      old.projectId !== STAGING_SEARCH_TARGET.projectId ||
      old.entity?.type !== 'maintenance' ||
      typeof old.entity.id !== 'string' ||
      !Number.isSafeInteger(old.generation) ||
      old.generation < 1
    )
      throw fail('SEARCH_BOOTSTRAP_PROOF_CHANGED');
    const key = sha(stable([old.projectId, old.entity.type, old.entity.id, 'search']));
    const entity = (await tx.get(db.collection('durableJobEntities').doc(key))).data();
    if (
      !entity ||
      entity.projectId !== old.projectId ||
      stable(entity.entity) !== stable(old.entity) ||
      !Number.isSafeInteger(entity.generation) ||
      entity.generation <= old.generation ||
      typeof entity.activeJobId !== 'string' ||
      entity.activeJobId === old.jobId
    )
      throw fail('SEARCH_BOOTSTRAP_REQUIRES_REVIEW');
    const current = (await tx.get(db.collection('durableJobs').doc(entity.activeJobId))).data();
    if (
      !current ||
      current.projectId !== old.projectId ||
      current.jobId !== entity.activeJobId ||
      current.kind !== 'search.sync' ||
      stable(current.entity) !== stable(old.entity) ||
      current.generation !== entity.generation ||
      current.state !== 'succeeded'
    )
      throw fail('SEARCH_BOOTSTRAP_REQUIRES_REVIEW');
  }
}
async function searchJobsSettled(db, tx) {
  await assertSearchFailuresResolved(db, tx);
  const active = await tx.get(
    db.collection('durableJobs').where('state', 'not-in', ['succeeded', 'failed', 'cancelled', 'superseded']).limit(501)
  );
  if (active.size > 500 || active.docs.some((d) => !['search.sync', 'search.backfill'].includes(d.get('kind'))))
    throw fail('SEARCH_BOOTSTRAP_OTHER_WORK_NOT_DRAINED');
  return active.size === 0;
}
export async function confirmSearchBootstrapInTransaction(db, tx, options, expected, checkpoint) {
  if (
    !expected ||
    !Array.isArray(expected.jobIds) ||
    expected.jobIds.length !== 5 ||
    !Array.isArray(expected.generations) ||
    expected.generations.length !== 5 ||
    !Array.isArray(expected.counts) ||
    expected.counts.length !== 5
  )
    throw fail('SEARCH_BOOTSTRAP_PROOF_CHANGED');
  const snapshots = await Promise.all(
    ['_control/temporalRelease', '_control/temporalReleaseState', '_control/temporalReleaseOperation'].map((p) =>
      tx.get(db.doc(p))
    )
  );
  assertSearchBootstrapBoundary(
    { control: snapshots[0].data(), state: snapshots[1].data(), operation: snapshots[2].data() },
    options,
    checkpoint
  );
  if (!(await searchJobsSettled(db, tx))) throw fail('SEARCH_BOOTSTRAP_NOT_CONVERGED');
  const proofs = await Promise.all(
    SEARCH_BOOTSTRAP_INSTANCES.map(async (instanceId) => {
      const identity = searchBootstrapIdentity(options, instanceId);
      const refs = [
        db.collection('durableJobs').doc(identity.ref.jobId),
        db.collection('durableJobEntities').doc(searchBootstrapEntityKey(options, instanceId)),
        db.collection('durableJobIntents').doc(identity.ref.jobId),
      ];
      const rows = await Promise.all(refs.map((r) => tx.get(r)));
      return { job: rows[0].data(), entity: rows[1].data(), intent: rows[2].data() };
    })
  );
  if (
    !proofs.every(
      (p, i) =>
        validateSearchBootstrapProof(p, options, SEARCH_BOOTSTRAP_INSTANCES[i]) &&
        p.job.jobId === expected.jobIds[i] &&
        p.job.generation === expected.generations[i] &&
        p.job.result.count === expected.counts[i]
    )
  )
    throw fail('SEARCH_BOOTSTRAP_NOT_CONVERGED');
  return proofs;
}
/** Called only by the controller's search-ready transition, in its revision/operation CAS. */
export async function confirmAndWriteSearchReadiness(db, tx, options, expected) {
  if (
    expected?.result !== 'passed' ||
    expected.projectId !== options.projectId ||
    expected.appId !== STAGING_SEARCH_TARGET.appId ||
    expected.releaseId !== options.releaseId ||
    expected.commit !== options.commit ||
    expected.controlRevision !== options.controlRevision ||
    typeof expected.settingsReceiptCanonicalSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expected.settingsReceiptCanonicalSha256)
  )
    throw fail('SEARCH_BOOTSTRAP_PROOF_CHANGED');
  await confirmSearchBootstrapInTransaction(db, tx, options, expected);
  const marker = searchReadinessMarker(expected, options.controlRevision + 1);
  tx.set(db.doc('_control/temporalSearchReadiness'), marker);
  return marker;
}
export function createSearchBootstrapStore(db, options, { createStore, entityKey }) {
  validateSearchBootstrapOptions(options);
  const store = createStore({ firestore: db, projectId: options.projectId });
  for (const id of SEARCH_BOOTSTRAP_INSTANCES) {
    const identity = searchBootstrapIdentity(options, id);
    if (entityKey(options.projectId, identity.entity, 'search.backfill') !== searchBootstrapEntityKey(options, id))
      throw fail('SEARCH_BOOTSTRAP_ENTITY_PROTOCOL_CHANGED');
  }
  const refs = ['_control/temporalRelease', '_control/temporalReleaseState', '_control/temporalReleaseOperation'].map(
    (p) => db.doc(p)
  );
  const readBoundary = async (tx) => {
    const docs = await Promise.all(refs.map((ref) => (tx ? tx.get(ref) : ref.get())));
    return { control: docs[0].data(), state: docs[1].data(), operation: docs[2].data() };
  };
  const proofRefs = (instanceId) => {
    const id = searchBootstrapIdentity(options, instanceId);
    return {
      id,
      job: db.collection('durableJobs').doc(id.ref.jobId),
      intent: db.collection('durableJobIntents').doc(id.ref.jobId),
      entity: db.collection('durableJobEntities').doc(entityKey(options.projectId, id.entity, 'search.backfill')),
    };
  };
  const proof = async (instanceId, tx) => {
    const r = proofRefs(instanceId),
      docs = await Promise.all([r.job, r.intent, r.entity].map((ref) => (tx ? tx.get(ref) : ref.get())));
    return { job: docs[0].data(), intent: docs[1].data(), entity: docs[2].data() };
  };
  return {
    readBoundary: async () => {
      const boundary = await readBoundary();
      await assertNoUnfinishedNonSearchJobs(db);
      return boundary;
    },
    submit: (instanceId) =>
      db.runTransaction(async (tx) => {
        assertSearchBootstrapBoundary(await readBoundary(tx), options);
        await assertNoUnfinishedNonSearchJobs(db, tx);
        const r = proofRefs(instanceId),
          old = await proof(instanceId, tx);
        if (old.job) {
          validateSearchBootstrapProof(old, options, instanceId, false);
          return old;
        }
        if (old.intent || (old.entity && !Number.isSafeInteger(old.entity.generation)))
          throw fail('SEARCH_BOOTSTRAP_PROOF_CHANGED');
        if (old.entity?.activeJobId) {
          const previous = await tx.get(db.collection('durableJobs').doc(old.entity.activeJobId));
          if (!previous.exists || !['succeeded', 'failed', 'cancelled', 'superseded'].includes(previous.get('state')))
            throw fail('SEARCH_BOOTSTRAP_REQUIRES_REVIEW');
        }
        const generation = Number(old.entity?.generation ?? 0) + 1;
        const workflowId = `search:${options.projectId}:${r.id.ref.jobId}`;
        const job = store.createInTransaction(tx, {
          ...r.id,
          kind: 'search.backfill',
          actorUid: 'system:search',
          generation,
          createdAt: Date.now(),
          dispatch: {
            ref: r.id.ref,
            workflowId,
            workflowType: 'SearchBackfill',
            taskQueue: 'urm-search',
            startArgs: { ref: r.id.ref },
          },
        });
        return {
          job,
          entity: {
            schemaVersion: 1,
            projectId: options.projectId,
            entity: r.id.entity,
            scope: 'search',
            activeJobId: job.jobId,
            generation,
          },
          intent: {
            ...r.id.ref,
            kind: 'search.backfill',
            entity: r.id.entity,
            actorUid: 'system:search',
            payload: r.id.payload,
            generation,
          },
        };
      }),
    readProofs: () => Promise.all(SEARCH_BOOTSTRAP_INSTANCES.map((i) => proof(i))),
    confirmProofs: (expected) =>
      db.runTransaction(async (tx) => {
        assertSearchBootstrapBoundary(await readBoundary(tx), options);
        if (!(await searchJobsSettled(db, tx))) return false;
        const latest = await Promise.all(SEARCH_BOOTSTRAP_INSTANCES.map((i) => proof(i, tx)));
        return latest.every(
          (p, i) =>
            validateSearchBootstrapProof(p, options, SEARCH_BOOTSTRAP_INSTANCES[i]) &&
            p.job.jobId === expected[i].job.jobId &&
            p.job.generation === expected[i].job.generation &&
            p.job.revision === expected[i].job.revision
        );
      }),
  };
}
export async function firebaseSearchBootstrapDependencies(options, settingsPath, releasePath) {
  const req = createRequire(resolve(root, 'package.json'));
  if (Object.entries(process.env).some(([k, v]) => k.includes('EMULATOR') && v))
    throw fail('SEARCH_BOOTSTRAP_EMULATOR_FORBIDDEN');
  req('ts-node').register({ project: resolve(root, 'functions/tsconfig.json'), transpileOnly: true });
  req('tsconfig-paths').register({
    baseUrl: resolve(root, 'functions'),
    paths: {
      '@upperroom/contracts/*': ['../packages/contracts/*'],
      '@upperroom/shared/*': ['../packages/shared/*'],
      '@upperroom/orchestration/*': ['../packages/orchestration/src/*'],
    },
  });
  const { firebaseAdmin, validateReleaseConfig } = await import('./temporal-release-lib.mjs');
  const release = validateReleaseConfig(JSON.parse(readFileSync(releasePath, 'utf8')));
  if (
    release.projectId !== options.projectId ||
    release.releaseId !== options.releaseId ||
    release.compatibilityCommit !== options.commit ||
    stable(release.domains) !== stable(['search']) ||
    release.searchSettingsEvidence !== settingsPath ||
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== options.commit
  )
    throw fail('SEARCH_BOOTSTRAP_DESCRIPTOR_CHANGED');
  const { firestore } = firebaseAdmin(options.projectId);
  try {
    const { createDurableJobStore, durableEntityKey } = req(resolve(root, 'packages/orchestration/src/job-store.ts'));
    const source = createSearchBootstrapStore(firestore, options, {
      createStore: createDurableJobStore,
      entityKey: durableEntityKey,
    });
    const boundary = await source.readBoundary();
    const { assertCheckoutSource } = await import('./temporal-deploy-source.mjs');
    assertCheckoutSource(root, options.commit, {
      project: options.projectId,
      control: boundary.control,
      includeStagingSearch: true,
      release,
    });
    let settingsSha;
    return {
      ...source,
      readSettings: async () => {
        const stat = lstatSync(settingsPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
          throw fail('SEARCH_BOOTSTRAP_SETTINGS_NOT_READY');
        const raw = readFileSync(settingsPath);
        const digest = sha(raw);
        if (settingsSha && settingsSha !== digest) throw fail('SEARCH_BOOTSTRAP_SETTINGS_CHANGED');
        settingsSha = digest;
        return JSON.parse(raw);
      },
      close: () => firestore.terminate(),
    };
  } catch (error) {
    await firestore.terminate();
    throw error;
  }
}
export function parseSearchBootstrapArgs(args) {
  const allowed = [
    '--project',
    '--release-id',
    '--commit',
    '--control-revision',
    '--operation-id',
    '--timeout-ms',
    '--settings-proof',
    '--release',
  ];
  const values = {};
  if (args.filter((v) => v === '--apply').length !== 1) throw fail('SEARCH_BOOTSTRAP_APPLY_REQUIRED');
  const input = args.filter((v) => v !== '--apply');
  for (let i = 0; i < input.length; i += 2) {
    if (!allowed.includes(input[i]) || !input[i + 1] || values[input[i]])
      throw fail('SEARCH_BOOTSTRAP_OPTIONS_INVALID');
    values[input[i]] = input[i + 1];
  }
  if (!values['--settings-proof'] || !values['--release']) throw fail('SEARCH_BOOTSTRAP_SETTINGS_NOT_READY');
  const options = {
    projectId: values['--project'],
    releaseId: values['--release-id'],
    commit: values['--commit'],
    controlRevision: Number(values['--control-revision']),
    operationId: values['--operation-id'],
    ...(values['--timeout-ms'] ? { timeoutMs: Number(values['--timeout-ms']) } : {}),
  };
  validateSearchBootstrapOptions(options);
  return { options, settingsPath: values['--settings-proof'], releasePath: values['--release'] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let deps;
  try {
    const { options, settingsPath, releasePath } = parseSearchBootstrapArgs(process.argv.slice(2));
    deps = await firebaseSearchBootstrapDependencies(options, settingsPath, releasePath);
    console.log(JSON.stringify(await runSearchBootstrap(options, deps)));
  } catch (error) {
    console.error(error.code?.startsWith('SEARCH_BOOTSTRAP_') ? error.code : 'SEARCH_BOOTSTRAP_FAILED');
    process.exitCode = 1;
  } finally {
    await deps?.close();
  }
}
