#!/usr/bin/env node
// Narrow checkpoint migration. This command never deploys, resumes admission,
// deletes legacy work, changes owners, or replaces the original control documents.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  validateReleaseConfig,
  validateControl,
  firebaseAdmin,
  CONTROL_PATH,
  RELEASE_DOMAINS,
  legacyStateCounts,
} from './temporal-release-lib.mjs';
import { assertCheckoutSource } from './temporal-deploy-source.mjs';
export const STATE_PATH = '_control/temporalReleaseState';
export const OPERATION_PATH = '_control/temporalReleaseOperation';
export const canonical = (value) =>
  Array.isArray(value)
    ? JSON.stringify(value.map((v) => JSON.parse(canonical(v))))
    : value && typeof value === 'object'
    ? JSON.stringify(
        Object.fromEntries(
          Object.keys(value)
            .sort()
            .filter((k) => value[k] !== undefined)
            .map((k) => [k, JSON.parse(canonical(value[k]))])
        )
      )
    : JSON.stringify(value);
export const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a, b) => canonical(a) === canonical(b);
const fresh = (at, now) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now && now - Date.parse(at) <= 600000;
const TERMINAL_BUILDS = new Set(['SUCCESS', 'FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED']);
export function validateRecoveryDescriptors(oldRelease, newRelease, actualCommit) {
  validateReleaseConfig(oldRelease);
  validateReleaseConfig(newRelease);
  if (
    oldRelease.environment !== 'staging' ||
    newRelease.environment !== 'staging' ||
    oldRelease.mode !== 'initial-cutover' ||
    newRelease.mode !== 'initial-cutover'
  )
    throw new Error('Recovery supports staging initial cutover only');
  if (
    oldRelease.releaseId === newRelease.releaseId ||
    oldRelease.compatibilityCommit === newRelease.compatibilityCommit ||
    newRelease.compatibilityCommit !== newRelease.uiCommit ||
    actualCommit !== newRelease.compatibilityCommit
  )
    throw new Error('A new release UUID and exact reviewed backend/UI checkout commit are required');
  for (const key of [
    'projectId',
    'backendId',
    'location',
    'mode',
    'domains',
    'databaseUrl',
    'mailCollection',
    'legacyQueues',
    'additionalLegacyQueues',
  ])
    if (!same(oldRelease[key], newRelease[key])) throw new Error(`Recovery cannot change ${key}`);
  if (
    newRelease.legacyExecutionGraceSeconds < oldRelease.legacyExecutionGraceSeconds ||
    newRelease.providerUsageBackfillTimeoutMs < oldRelease.providerUsageBackfillTimeoutMs
  )
    throw new Error('Recovery cannot shorten reviewed execution or maintenance grace');
  for (const key of ['compatibilityEvidence', 'backendEvidence', 'smokeEvidence'])
    if (oldRelease[key] === newRelease[key]) throw new Error('New release requires separate evidence paths');
  return newRelease;
}
export function validateRecoveryCheckpoint(control, state, oldRelease, revision) {
  validateControl(control);
  if (
    control.releaseId !== oldRelease.releaseId ||
    control.revision !== revision ||
    state?.releaseId !== oldRelease.releaseId ||
    state.controlRevision !== revision ||
    state.phase !== 'ui-frozen' ||
    state.mode !== 'initial-cutover' ||
    state.compatibilityCommit !== oldRelease.compatibilityCommit ||
    state.uiCommit !== oldRelease.uiCommit ||
    !same(state.domains, oldRelease.domains) ||
    control.admission !== 'paused' ||
    RELEASE_DOMAINS.some((d) => control.domains[d].owner !== 'legacy' || control.domains[d].admission !== 'paused')
  )
    throw new Error('Recovery requires the exact ui-frozen legacy paused checkpoint');
  if (
    Object.hasOwn(control, 'legacyAdmissionCutoff') ||
    Object.hasOwn(state, 'compatibilityVerifiedAt') ||
    Object.hasOwn(state, 'legacySettlingDeadline') ||
    Object.hasOwn(state, 'compatibilityEvidenceAt') ||
    state.recoveryPredecessorReleaseId ||
    !state.appHostingFreezeRequestId ||
    !Number.isSafeInteger(state.maximumLegacyExecutionSeconds) ||
    state.maximumLegacyExecutionSeconds < 540 ||
    !state.savedRolloutPolicy ||
    state.savedRolloutPolicy.codebaseBranch !== 'staging' ||
    !state.savedUiTraffic
  )
    throw new Error(
      'Recovery cannot rewrite a cutoff, completed compatibility gate, prior recovery, or missing freeze metadata'
    );
}
export function assertSafeRecoveryLeases(rows) {
  for (const row of rows)
    if (
      row.schemaVersion !== 1 ||
      row.projectId !== 'urm-app-staging' ||
      row.state !== 'completed' ||
      !['succeeded', 'rejected_no_effect'].includes(row.outcome) ||
      typeof row.effectsStarted !== 'boolean'
    )
      throw new Error('Active, uncertain or malformed legacy leases require explicit reconciliation before recovery');
}
export function validateRecoveryReview(review, oldRelease, newRelease, now = Date.now()) {
  if (
    !Number.isSafeInteger(review.candidateCiRunId) ||
    review.candidateCiRunId < 1 ||
    review.schemaVersion !== 1 ||
    review.projectId !== oldRelease.projectId ||
    review.oldReleaseId !== oldRelease.releaseId ||
    review.newReleaseId !== newRelease.releaseId ||
    !Number.isSafeInteger(review.oldControlRevision) ||
    review.oldControlRevision < 1 ||
    !fresh(review.verifiedAt, now) ||
    typeof review.reason !== 'string' ||
    review.reason.trim().length < 20 ||
    review.reason.length > 2000
  )
    throw new Error('Fresh scoped reviewed recovery evidence is required');
  const g = review.settledGuard,
    i = review.operatorIdentity;
  if (
    g?.action !== 'controlled-backend-deploy' ||
    g.releaseId !== oldRelease.releaseId ||
    g.commit !== oldRelease.compatibilityCommit ||
    !/^[a-f0-9-]{36}$/.test(g.operationId || '') ||
    !Number.isSafeInteger(g.createdAt) ||
    g.createdAt > now ||
    review.guardSettlementVerified !== true ||
    review.failedCompatibilityDeploymentVerified !== true ||
    !i?.actorUid ||
    !Number.isFinite(Date.parse(i.authTime)) ||
    !fresh(i.verifiedAt, now) ||
    i.actorUid !== review.originalOperatorUid
  )
    throw new Error('Matching settled failed deployment and unchanged reviewed operator are required');
  if (
    !Array.isArray(review.operations) ||
    !review.operations.length ||
    !Array.isArray(review.builds) ||
    !Array.isArray(review.runtime) ||
    !review.runtime.length ||
    !Array.isArray(review.artifacts) ||
    !review.artifacts.length
  )
    throw new Error('Actual operation, runtime and artifact evidence is required');
  for (const o of review.operations)
    if (
      !(o.apiVersion === 'v1'
        ? /^operations\/[A-Za-z0-9_-]+$/.test(o.name || '')
        : o.apiVersion === 'v2' &&
          /^projects\/urm-app-staging\/locations\/us-central1\/operations\/[A-Za-z0-9_-]+$/.test(o.name || '')) ||
      o.done !== true
    )
      throw new Error('Invalid settled operation identity');
  for (const b of review.builds)
    if (
      !/^projects\/urm-app-staging\/locations\/(?:global|us-central1)\/builds\/[a-f0-9-]+$/.test(b.name || '') ||
      !TERMINAL_BUILDS.has(b.status)
    )
      throw new Error('Invalid settled build identity');
  for (const r of review.runtime)
    if (
      !/^projects\/urm-app-staging\/locations\/us-central1\/functions\/[A-Za-z0-9_-]+$/.test(r.name || '') ||
      typeof r.state !== 'string'
    )
      throw new Error('Invalid observed staging runtime identity');
  for (const a of review.artifacts)
    if (!/^[a-z0-9-]+$/.test(a.label || '') || typeof a.path !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256 || ''))
      throw new Error('Reviewed immutable artifact identity required');
}
export function validateFrozenTraffic(traffic, rollouts, state) {
  if (
    traffic.reconciling ||
    traffic.rolloutPolicy?.disabled !== true ||
    !same(traffic.rolloutPolicy, { ...state.savedRolloutPolicy, disabled: true }) ||
    !same(traffic.current, state.savedUiTraffic) ||
    !traffic.etag ||
    rollouts.some((r) => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(r.state))
  )
    throw new Error('Original frozen UI policy/traffic must remain unchanged with no pending rollout');
}
export function assertFailedDeploymentAfterGuard(settled, createdAt) {
  if (
    !settled.some(
      (o) =>
        Number.isInteger(o.errorCode) &&
        o.errorCode > 0 &&
        Number.isFinite(Date.parse(o.createTime)) &&
        Date.parse(o.createTime) >= createdAt
    )
  )
    throw new Error('An actual failed deployment operation after the reviewed guard started is required');
}
export function summarizeRunSettlement(operations, services) {
  if (operations.some((o) => o.done !== true)) throw new Error('Cloud Run operations remain pending');
  if (
    services.some(
      (s) => s.reconciling || !['CONDITION_SUCCEEDED', 'CONDITION_FAILED'].includes(s.terminalCondition?.state)
    )
  )
    throw new Error('Cloud Run services are still reconciling');
  return {
    operationCount: operations.length,
    pendingOperations: 0,
    services: services.map((s) => ({
      name: s.name,
      reconciling: Boolean(s.reconciling),
      terminalState: s.terminalCondition.state,
      latestCreatedRevision: s.latestCreatedRevision ?? null,
      latestReadyRevision: s.latestReadyRevision ?? null,
    })),
  };
}
export function summarizeBuildInventory(location, rows) {
  if (rows.some((b) => !TERMINAL_BUILDS.has(b.status))) throw new Error('Cloud Build operations remain pending');
  const projection = rows.map((b) => ({
    name: b.name ?? null,
    id: b.id,
    status: b.status,
    finishTime: b.finishTime ?? null,
  }));
  return {
    location,
    total: rows.length,
    pendingBuilds: 0,
    sha256: digest(projection),
    statusCounts: rows.reduce((counts, b) => ({ ...counts, [b.status]: (counts[b.status] ?? 0) + 1 }), {}),
  };
}
export async function migrateRecoveryCheckpoint(
  db,
  { oldRelease, newRelease, review, operationId, verified, archive }
) {
  const archivePath = `_control/temporalCompatibilityRecovery-${oldRelease.releaseId}`;
  return db.runTransaction(async (tx) => {
    const [cs, ss, ls, archived, leases] = await Promise.all([
      tx.get(db.doc(CONTROL_PATH)),
      tx.get(db.doc(STATE_PATH)),
      tx.get(db.doc(OPERATION_PATH)),
      tx.get(db.doc(archivePath)),
      tx.get(db.collection('legacyAdmissionLeases')),
    ]);
    const control = cs.data(),
      state = ss.data();
    validateRecoveryCheckpoint(control, state, oldRelease, review.oldControlRevision);
    if (
      !same(control, verified.control) ||
      !same(state, verified.state) ||
      ls.data()?.operationId !== operationId ||
      ls.data()?.action !== 'recover-initial-compatibility' ||
      ls.data()?.releaseId !== oldRelease.releaseId ||
      ls.data()?.newReleaseId !== newRelease.releaseId ||
      ls.data()?.commit !== newRelease.compatibilityCommit ||
      archived.exists
    )
      throw new Error('Recovery CAS, operation ownership or archive identity changed');
    assertSafeRecoveryLeases(leases.docs.map((d) => d.data()));
    tx.create(db.doc(archivePath), {
      ...archive,
      predecessorReleaseId: oldRelease.releaseId,
      successorReleaseId: newRelease.releaseId,
      originalControl: control,
      originalState: state,
      originalControlCreateTime: cs.createTime,
      originalStateCreateTime: ss.createTime,
    });
    tx.update(db.doc(CONTROL_PATH), {
      releaseId: newRelease.releaseId,
      revision: control.revision + 1,
      updatedAt: Date.now(),
    });
    tx.update(db.doc(STATE_PATH), {
      releaseId: newRelease.releaseId,
      compatibilityCommit: newRelease.compatibilityCommit,
      uiCommit: newRelease.uiCommit,
      controlRevision: control.revision + 1,
      updatedAt: Date.now(),
      recoveryPredecessorReleaseId: oldRelease.releaseId,
      recoveryArchivePath: archivePath,
    });
    tx.delete(db.doc(OPERATION_PATH));
    return { archivePath, controlRevision: control.revision + 1, phase: 'ui-frozen', admission: 'paused' };
  });
}
async function main() {
  if (process.versions.node.split('.')[0] !== '22') throw new Error('Node22 is required for recovery');
  let clients;
  try {
    const args = process.argv.slice(2),
      value = (flag) => args[args.indexOf(flag) + 1];
    if (
      !['--old-release', '--new-release', '--review', '--archive-dir'].every(
        (flag) => args.includes(flag) && value(flag)
      )
    )
      throw new Error(
        'Usage: temporal-recover-initial-compatibility.mjs --old-release FILE --new-release FILE --review FILE --archive-dir NEW_PRIVATE_DIR [--apply]'
      );
    const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
    const oldRelease = await readJson(value('--old-release')),
      newRelease = await readJson(value('--new-release')),
      review = await readJson(value('--review'));
    for (const name of [
      'FIRESTORE_EMULATOR_HOST',
      'FIREBASE_AUTH_EMULATOR_HOST',
      'FIREBASE_DATABASE_EMULATOR_HOST',
      'FIREBASE_STORAGE_EMULATOR_HOST',
    ])
      if (process.env[name]) throw new Error('Recovery refuses emulators');
    const root = resolve(new URL('..', import.meta.url).pathname);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    validateRecoveryDescriptors(oldRelease, newRelease, commit);
    validateRecoveryReview(review, oldRelease, newRelease);
    const archiveDir = resolve(value('--archive-dir'));
    await mkdir(archiveDir, { mode: 0o700 });
    for (const [name, data] of [
      ['old-descriptor', oldRelease],
      ['new-descriptor', newRelease],
      ['review', review],
    ])
      await writeFile(`${archiveDir}/${name}.json`, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    let originalIdentity;
    for (const artifact of review.artifacts) {
      const bytes = await readFile(artifact.path);
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
        throw new Error('Reviewed runtime/settlement artifact changed');
      await writeFile(`${archiveDir}/${artifact.label}.artifact`, bytes, { mode: 0o600, flag: 'wx' });
      if (artifact.label === 'original-operator-identity') originalIdentity = JSON.parse(bytes.toString('utf8'));
    }
    if (
      originalIdentity?.projectId !== oldRelease.projectId ||
      originalIdentity.actorUid !== review.originalOperatorUid ||
      originalIdentity.authTime !== review.operatorIdentity.authTime ||
      originalIdentity.enabled !== true ||
      originalIdentity.role !== 'admin' ||
      !Number.isFinite(Date.parse(originalIdentity.verifiedAt))
    )
      throw new Error('Reviewed original operator identity artifact required');
    const { firestore: db, database, credential } = firebaseAdmin(oldRelease.projectId, oldRelease.databaseUrl);
    clients = { db, database };
    const operationId = randomUUID(),
      apply = args.includes('--apply');
    let verified;
    await db.runTransaction(async (tx) => {
      const [cs, ss, lock] = await Promise.all([
        tx.get(db.doc(CONTROL_PATH)),
        tx.get(db.doc(STATE_PATH)),
        tx.get(db.doc(OPERATION_PATH)),
      ]);
      validateRecoveryCheckpoint(cs.data(), ss.data(), oldRelease, review.oldControlRevision);
      if (Date.parse(originalIdentity.verifiedAt) >= cs.createTime.toMillis())
        throw new Error('Original operator identity must predate the original freeze');
      if (lock.exists)
        throw new Error('Settle the existing deployment/release operation first; recovery never steals locks');
      assertCheckoutSource(root, commit, { project: newRelease.projectId, control: cs.data() });
      verified = {
        control: cs.data(),
        state: ss.data(),
        controlCreateTime: cs.createTime,
        stateCreateTime: ss.createTime,
      };
      if (apply)
        tx.create(db.doc(OPERATION_PATH), {
          operationId,
          action: 'recover-initial-compatibility',
          releaseId: oldRelease.releaseId,
          newReleaseId: newRelease.releaseId,
          commit,
          createdAt: Date.now(),
        });
    });
    const observationStart = new Date().toISOString();
    const gh = (path) =>
      JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const workflow = gh('repos/upperroommedia/web-app/actions/workflows/temporal-application-validation.yml');
    const run = gh(`repos/upperroommedia/web-app/actions/runs/${review.candidateCiRunId}`);
    if (
      run.workflow_id !== workflow.id ||
      run.repository?.full_name !== 'upperroommedia/web-app' ||
      run.head_sha !== commit ||
      run.status !== 'completed' ||
      run.conclusion !== 'success'
    )
      throw new Error('Exact candidate application CI must have actually passed');
    const candidateCi = {
      id: run.id,
      workflowId: run.workflow_id,
      headSha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      htmlUrl: run.html_url,
    };
    const api = async (url) => {
      const access = await credential.getAccessToken();
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${access.access_token}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`Recovery read-only API failed HTTP${response.status}`);
      return response.json();
    };
    const list = async (url, key) => {
      const rows = [];
      let pageToken;
      do {
        const page = await api(`${url}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
        if (page.unreachable?.length || page.warning) throw new Error('Partial inventory cannot authorize recovery');
        rows.push(...(page[key] ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return rows;
    };
    const project = oldRelease.projectId,
      parent = `projects/${project}/locations/us-central1/backends/web-staging`;
    const traffic = await api(`https://firebaseapphosting.googleapis.com/v1beta/${parent}/traffic`);
    const rollouts = await list(
      `https://firebaseapphosting.googleapis.com/v1beta/${parent}/rollouts?pageSize=100`,
      'rollouts'
    );
    validateFrozenTraffic(traffic, rollouts, verified.state);
    const functions = await list(
      `https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/-/functions?pageSize=1000`,
      'functions'
    );
    if (
      !functions.length ||
      functions.some((f) => !f.name.startsWith(`projects/${project}/locations/us-central1/functions/`))
    )
      throw new Error('Narrow staging recovery requires the reviewed single-region function inventory');
    const operationsV2 = await list(
      `https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/us-central1/operations?pageSize=1000`,
      'operations'
    );
    const v1 = await api(
      `https://cloudfunctions.googleapis.com/v1/operations?filter=${encodeURIComponent(
        `project:${project},latest:true`
      )}&pageSize=100`
    );
    if (
      v1.nextPageToken ||
      (v1.operations?.length ?? 0) >= 100 ||
      v1.unreachable?.length ||
      [...operationsV2, ...(v1.operations ?? [])].some((o) => o.done !== true)
    )
      throw new Error('Functions operations remain pending or incomplete inventory');
    const settled = [];
    for (const o of review.operations) {
      const actual = await api(`https://cloudfunctions.googleapis.com/${o.apiVersion}/${o.name}`);
      if (
        actual.name !== o.name ||
        actual.done !== true ||
        !actual.metadata?.target?.startsWith(`projects/${project}/`)
      )
        throw new Error('Reviewed deployment operation is not actually settled for staging');
      settled.push({
        name: actual.name,
        done: actual.done,
        target: actual.metadata.target,
        errorCode: actual.error?.code ?? null,
        createTime: actual.metadata?.createTime ?? actual.metadata?.startTime ?? null,
      });
    }
    assertFailedDeploymentAfterGuard(settled, review.settledGuard.createdAt);
    const runOperations = await list(
      `https://run.googleapis.com/v2/projects/${project}/locations/us-central1/operations?pageSize=1000`,
      'operations'
    );
    const services = await list(
      `https://run.googleapis.com/v2/projects/${project}/locations/us-central1/services?pageSize=1000`,
      'services'
    );
    const runSettlement = summarizeRunSettlement(runOperations, services);
    const buildInventory = [];
    const builds = [];
    for (const location of ['global', 'us-central1']) {
      const rows = await list(
        `https://cloudbuild.googleapis.com/v1/projects/${project}/locations/${location}/builds?pageSize=1000`,
        'builds'
      );
      buildInventory.push(summarizeBuildInventory(location, rows));
    }
    for (const b of review.builds) {
      const actual = await api(`https://cloudbuild.googleapis.com/v1/${b.name}`);
      if (actual.status !== b.status) throw new Error('Reviewed build settlement changed');
      builds.push({ name: b.name, id: actual.id, status: actual.status, finishTime: actual.finishTime ?? null });
    }
    const runtime = [];
    for (const expected of review.runtime) {
      const actual = functions.find((f) => f.name === expected.name);
      const projection = {
        name: actual?.name,
        state: actual?.state,
        build: actual?.buildConfig?.build ?? null,
        revision: actual?.serviceConfig?.revision ?? null,
      };
      if (!same(projection, expected))
        throw new Error('Observed failed runtime identity changed; review actual settlement again');
      runtime.push(projection);
    }
    const { createRequire } = await import('node:module');
    const require = createRequire(resolve(root, 'functions/package.json'));
    const app = require('firebase-admin/app')
      .getApps()
      .find((a) => a.name === `temporal-release-${project}` && a.options.projectId === project);
    if (!app) throw new Error('Explicit staging Admin app required');
    const user = await require('firebase-admin/auth').getAuth(app).getUser(review.originalOperatorUid);
    if (
      user.disabled ||
      user.customClaims?.role !== 'admin' ||
      !Number.isFinite(Date.parse(user.tokensValidAfterTime)) ||
      Date.parse(review.operatorIdentity.authTime) < Date.parse(user.tokensValidAfterTime)
    )
      throw new Error('Reviewed original operator is disabled, no longer admin, or authentication revoked');
    const queues = await list(
      `https://cloudtasks.googleapis.com/v2/projects/${project}/locations/us-central1/queues?pageSize=1000`,
      'queues'
    );
    const queueNames = new Set([
      ...oldRelease.legacyQueues,
      ...oldRelease.additionalLegacyQueues,
      ...queues.map((q) => q.name.split('/').at(-1)),
    ]);
    const queueInventory = [];
    for (const q of queueNames) {
      const name = `projects/${project}/locations/us-central1/queues/${q}`;
      if (!queues.some((q) => q.name === name)) {
        queueInventory.push({
          name,
          state: 'ABSENT',
          pendingTasksObserved: false,
          absenceVerifiedBy: 'actual-complete-queue-list',
        });
        continue;
      }
      const tasks = await api(`https://cloudtasks.googleapis.com/v2/${name}/tasks?pageSize=1&responseView=BASIC`);
      queueInventory.push({
        name,
        state: queues.find((q) => q.name === name)?.state ?? null,
        pendingTasksObserved: Boolean(tasks.tasks?.length || tasks.nextPageToken),
      });
    }
    const paths = [
      'processAudioRequests',
      'processAudioLocks',
      'processAudioQueueClaims',
      'processAudioQueues/youtube/deferred',
      'processAudioQueues/youtube/state',
      'subsplashLocks',
    ];
    const vals = await Promise.all(
      paths.map((p) =>
        database
          .ref(p)
          .get()
          .then((s) => s.val())
      )
    );
    const pending = await db
      .collection('sermons')
      .where('status.audioStatus', 'in', ['PENDING', 'PROCESSING'])
      .count()
      .get();
    const leases = await db.collection('legacyAdmissionLeases').get();
    assertSafeRecoveryLeases(leases.docs.map((d) => d.data()));
    const inventory = {
      queueInventory,
      rtdbCounts: legacyStateCounts({
        requests: vals[0],
        locks: vals[1],
        claims: vals[2],
        deferred: vals[3],
        youtubeState: vals[4],
        subsplashLocks: vals[5],
      }),
      pendingCanonicalUploads: pending.data().count,
      completedLeaseCount: leases.size,
      completedLeaseSha256: digest(
        leases.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.id.localeCompare(b.id))
      ),
      claimsLegacyDrained: false,
      preservedWorkReason:
        'Checkpoint identity only; no queue, canonical admission, RTDB work, or provider state is changed. Original settling and transactional drain gates remain mandatory.',
    };
    assertCheckoutSource(root, commit, { project, control: verified.control });
    if (Date.now() - Date.parse(observationStart) > 120000)
      throw new Error('Recovery observations are stale; lock retained if acquired');
    const archive = {
      schemaVersion: 1,
      oldDescriptor: oldRelease,
      newDescriptor: newRelease,
      oldDescriptorSha256: digest(oldRelease),
      newDescriptorSha256: digest(newRelease),
      reviewSha256: digest(review),
      candidateCi,
      settledGuard: review.settledGuard,
      reviewedBrowserActorUid: user.uid,
      claimsADCActorIdentity: false,
      reason: review.reason,
      observationStart,
      observedAt: new Date().toISOString(),
      traffic,
      runtime,
      settledOperations: settled,
      runSettlement,
      builds,
      buildInventory,
      inventory,
      artifacts: review.artifacts.map(({ label, sha256 }) => ({ label, sha256 })),
      originalFreezePreserved: true,
      admissionsOpened: false,
      ownersChanged: false,
    };
    if (Buffer.byteLength(JSON.stringify(archive)) > 750000)
      throw new Error('Recovery archive exceeds reviewed Firestore document size budget');
    await writeFile(
      `${archiveDir}/observations.json`,
      JSON.stringify(
        {
          ...archive,
          originalControl: verified.control,
          originalState: verified.state,
          originalControlCreateTime: verified.controlCreateTime,
          originalStateCreateTime: verified.stateCreateTime,
        },
        null,
        2
      ),
      { mode: 0o600, flag: 'wx' }
    );
    if (!apply) {
      console.log(
        JSON.stringify({
          result: 'reviewed-dry-run',
          remoteMutationRequested: false,
          archiveDir,
          nextReleaseId: newRelease.releaseId,
          claimsLegacyDrained: false,
        })
      );
      return;
    }
    const result = await migrateRecoveryCheckpoint(db, {
      oldRelease,
      newRelease,
      review,
      operationId,
      verified,
      archive,
    });
    console.log(
      JSON.stringify({
        result: 'paused-checkpoint-migrated',
        ...result,
        archiveDir,
        nextReleaseId: newRelease.releaseId,
      })
    );
  } finally {
    if (clients) {
      clients.database.goOffline();
      await clients.db.terminate();
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error(
      'Initial compatibility recovery failed; admissions remain paused. Any acquired recovery lock is retained for explicit inspection. Do not rewrite descriptors or clear locks blindly.'
    );
    process.exitCode = 1;
  });
