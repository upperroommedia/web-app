#!/usr/bin/env node
// Search-ready source handoff only. Never admits work, deploys, or marks an old release complete.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  validateReleaseConfig,
  validateControl,
  validateWorkerCoverage,
  firebaseAdmin,
  RELEASE_DOMAINS,
} from './temporal-release-lib.mjs';
import {
  pinReleaseCheckouts,
  loadReleaseResourceBinding,
  assertReleaseRuntimeSource,
  prepareLocalReleaseADC,
  verifyReleaseOperator,
  verifyReleaseResourceIdentity,
  nativeSnapshotProof,
  assertNativeSnapshot,
  proofDigest,
  hash,
} from './temporal-release-runtime.mjs';
import { assertCompatibilityGraceElapsed } from './temporal-compatibility-cutoff.mjs';
import {
  confirmSearchBootstrapInTransaction,
  searchReadinessMarker,
  SEARCH_BOOTSTRAP_INSTANCES,
  searchBootstrapIdentity,
  searchBootstrapEntityKey,
  validateSearchBootstrapProof,
} from './temporal-bootstrap-search.mjs';
import { validateProviderUsageContinuity, providerUsageHistoryPath } from './temporal-provider-usage-continuity.mjs';
import { verifyAppHostingBuild } from './temporal-apphosting-rollout.mjs';
import { verifyFirebaseRtdbReadiness } from './temporal-platform.mjs';
import { runWithCleanup } from './temporal-release-resources.mjs';

export const ACTION = 'supersede-search-source';
export const PATHS = Object.freeze({
  control: '_control/temporalRelease',
  state: '_control/temporalReleaseState',
  operation: '_control/temporalReleaseOperation',
  readiness: '_control/temporalSearchReadiness',
  usage: '_control/temporalProviderUsage',
});
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = (code) => Object.assign(new Error(code), { code });
const same = (a, b) => proofDigest(a) === proofDigest(b);
const ORIGINAL_UI = '8f519c686c53dd140c8ae0f8340587cd1d186510';
export const archivePath = (releaseId) => `_control/temporalSearchSourceSupersession-${releaseId}`;

export function validateDescriptors(oldRelease, nextRelease, actualCommit) {
  validateReleaseConfig(oldRelease);
  validateReleaseConfig(nextRelease);
  for (const descriptor of [oldRelease, nextRelease]) {
    if (
      descriptor.projectId !== 'urm-app-staging' ||
      descriptor.environment !== 'staging' ||
      descriptor.mode !== 'initial-cutover' ||
      !same(descriptor.domains, ['search']) ||
      descriptor.compatibilityCommit !== descriptor.uiCommit ||
      descriptor.legacyExecutionGraceSeconds < 3600
    )
      throw fail('SEARCH_SUPERSESSION_DESCRIPTOR_INVALID');
  }
  if (
    oldRelease.releaseId === nextRelease.releaseId ||
    oldRelease.compatibilityCommit === nextRelease.compatibilityCommit ||
    nextRelease.compatibilityCommit !== actualCommit
  )
    throw fail('SEARCH_SUPERSESSION_DISTINCT_SOURCE_REQUIRED');
  for (const key of [
    'projectId',
    'backendId',
    'location',
    'databaseUrl',
    'mailCollection',
    'legacyQueues',
    'additionalLegacyQueues',
  ])
    if (!same(oldRelease[key], nextRelease[key])) throw fail('SEARCH_SUPERSESSION_RESOURCE_CHANGED');
  if (
    nextRelease.legacyExecutionGraceSeconds !== oldRelease.legacyExecutionGraceSeconds ||
    nextRelease.providerUsageBackfillTimeoutMs < oldRelease.providerUsageBackfillTimeoutMs
  )
    throw fail('SEARCH_SUPERSESSION_GRACE_CHANGED');
  for (const key of ['compatibilityEvidence', 'backendEvidence', 'smokeEvidence', 'searchSettingsEvidence'])
    if (!nextRelease[key] || nextRelease[key] === oldRelease[key])
      throw fail('SEARCH_SUPERSESSION_FRESH_EVIDENCE_REQUIRED');
}

export function validateCheckpoint(control, state, oldRelease, revision) {
  validateControl(control);
  if (
    control.releaseId !== oldRelease.releaseId ||
    state?.releaseId !== oldRelease.releaseId ||
    control.revision !== revision ||
    state.controlRevision !== revision ||
    state.phase !== 'search-ready' ||
    state.mode !== oldRelease.mode ||
    !same(state.domains, ['search']) ||
    state.compatibilityCommit !== oldRelease.compatibilityCommit ||
    state.uiCommit !== oldRelease.uiCommit ||
    control.admission !== 'paused' ||
    state.searchConverged !== true ||
    !state.appHostingFreezeRequestId ||
    !state.savedRolloutPolicy ||
    state.savedRolloutPolicy.codebaseBranch !== 'staging' ||
    !state.savedUiTraffic ||
    RELEASE_DOMAINS.some(
      (domain) =>
        control.domains[domain]?.owner !== 'temporal' ||
        control.domains[domain]?.admission !== (domain === 'search' ? 'paused' : 'open')
    )
  )
    throw fail('SEARCH_SUPERSESSION_SEARCH_READY_REQUIRED');
  if (state.providerUsageContinuity?.predecessorReleaseId !== 'a801c079-a832-4bfa-a526-ec385e49d27f')
    throw fail('SEARCH_SUPERSESSION_PROVIDER_PREDECESSOR_CHANGED');
  const proof = state.searchBootstrapProof;
  if (
    proof?.result !== 'passed' ||
    proof.releaseId !== oldRelease.releaseId ||
    proof.commit !== oldRelease.compatibilityCommit ||
    proof.projectId !== oldRelease.projectId ||
    proof.appId !== '2VZFOFLFHE' ||
    proof.controlRevision !== revision - 1 ||
    !SHA.test(proof.settingsReceiptCanonicalSha256 || '')
  )
    throw fail('SEARCH_SUPERSESSION_OLD_SEARCH_PROOF_INVALID');
}

// Whitelist inherited facts. Backend/search/UI readiness from the old source is archived, never relabeled.
export function successorState(oldState, nextRelease, workerBuildId, archive, archiveSHA256, at) {
  const retained = {};
  for (const key of [
    'appHostingFreezeRequestId',
    'savedRolloutPolicy',
    'savedUiTraffic',
    'maximumLegacyExecutionSeconds',
    'compatibilityVerifiedAt',
    'legacySettlingCutoff',
    'legacySettlingGraceSeconds',
    'legacySettlingDeadline',
    'providerUsageContinuity',
    'providerUsageEpoch',
    'providerUsageBackfillRevision',
    'providerUsageVerifiedAt',
  ])
    if (Object.hasOwn(oldState, key)) retained[key] = oldState[key];
  return {
    ...retained,
    releaseId: nextRelease.releaseId,
    mode: nextRelease.mode,
    domains: nextRelease.domains,
    compatibilityCommit: nextRelease.compatibilityCommit,
    uiCommit: nextRelease.uiCommit,
    phase: 'ownership-changed',
    controlRevision: oldState.controlRevision + 1,
    workerBuildId,
    workersVerifiedAt: at,
    sourceSupersession: {
      schemaVersion: 1,
      predecessorReleaseId: oldState.releaseId,
      archivePath: archive,
      archiveSHA256,
      inheritedCompatibility: {
        kind: 'predecessor-legacy-fence',
        releaseId: oldState.releaseId,
        commit: oldState.compatibilityCommit,
        sourceAlreadyDeployed: false,
      },
    },
    updatedAt: at,
  };
}

export function activityDrainIdentity(head) {
  if (
    head?.projectId !== 'urm-app-staging' ||
    typeof head.jobId !== 'string' ||
    !head.jobId ||
    !Number.isSafeInteger(head.attempt) ||
    head.attempt < 1 ||
    !head.worker?.instanceId ||
    !['workflowId', 'runId', 'activityId', 'activityType'].every((key) => typeof head[key] === 'string' && head[key]) ||
    !Number.isFinite(head.scheduledAt)
  )
    throw fail('SEARCH_SUPERSESSION_EXECUTION_UNCERTAIN');
  const id = hash(JSON.stringify([head.workflowId, head.runId, head.activityId, head.scheduledAt]));
  if (head.executionId !== id) throw fail('SEARCH_SUPERSESSION_EXECUTION_UNCERTAIN');
  return hash(JSON.stringify([head.projectId, head.jobId, id, head.attempt, head.worker.instanceId]));
}
export function assertWorkerSettled(head, drain) {
  activityDrainIdentity(head);
  if (
    drain?.schemaVersion !== 1 ||
    drain.projectId !== head.projectId ||
    drain.jobId !== head.jobId ||
    drain.executionId !== head.executionId ||
    drain.source !== 'worker_settled' ||
    drain.state !== 'drained' ||
    !same(
      drain.execution,
      Object.fromEntries(
        Object.entries(head).filter(
          ([key]) =>
            !['projectId', 'jobId', 'executionId', 'epoch', 'updatedAt', 'stepIds', 'countsAttempt'].includes(key)
        )
      )
    )
  )
    throw fail('SEARCH_SUPERSESSION_EXECUTION_UNSETTLED');
}

export async function confirmSettledHeads(db, tx) {
  const heads = await tx.get(
    db.collection('durableActivityExecutions').where('projectId', '==', 'urm-app-staging').limit(5001)
  );
  if (heads.size > 5000) throw fail('SEARCH_SUPERSESSION_EXECUTION_REVIEW_REQUIRED');
  for (const row of heads.docs) {
    const head = row.data(),
      drain = await tx.get(db.collection('durableActivityDrains').doc(activityDrainIdentity(head)));
    assertWorkerSettled(head, drain.data());
  }
}

function assertNativePair(expected, rows) {
  assertNativeSnapshot(expected.control, rows.control);
  assertNativeSnapshot(expected.state, rows.state);
}
async function readRows(db, tx) {
  const names = Object.keys(PATHS),
    values = await Promise.all(names.map((name) => tx.get(db.doc(PATHS[name]))));
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}
export async function inspectTransaction(db, input, { confirmHeads = confirmSettledHeads } = {}) {
  return db.runTransaction(async (tx) => {
    const rows = await readRows(db, tx),
      control = rows.control.data(),
      state = rows.state.data();
    validateCheckpoint(control, state, input.oldRelease, input.revision);
    if (rows.operation.exists) throw fail('SEARCH_SUPERSESSION_OPERATION_EXISTS');
    assertCompatibilityGraceElapsed(control, state, input.oldRelease, rows.control.readTime);
    if (!same(rows.readiness.data(), searchReadinessMarker(state.searchBootstrapProof, control.revision)))
      throw fail('SEARCH_SUPERSESSION_READINESS_CHANGED');
    const history = await tx.get(db.doc(providerUsageHistoryPath(state)));
    validateProviderUsageContinuity(
      input.oldRelease,
      control,
      state,
      rows.usage,
      history.data(),
      state.providerUsageEpoch
    );
    const options = {
      projectId: input.oldRelease.projectId,
      releaseId: input.oldRelease.releaseId,
      commit: input.oldRelease.compatibilityCommit,
      controlRevision: input.revision,
      operationId: '00000000-0000-4000-8000-000000000000',
    };
    // The pure deterministic identity validator requires UUID syntax; this value is never
    // written or passed to admission/authority validation. Inspect still requires op ABSENT.
    const jobs = await Promise.all(
      SEARCH_BOOTSTRAP_INSTANCES.map(async (instance, index) => {
        const identity = searchBootstrapIdentity(options, instance);
        const rows = await Promise.all([
          tx.get(db.collection('durableJobs').doc(identity.ref.jobId)),
          tx.get(db.collection('durableJobEntities').doc(searchBootstrapEntityKey(options, instance))),
          tx.get(db.collection('durableJobIntents').doc(identity.ref.jobId)),
        ]);
        const proof = { job: rows[0].data(), entity: rows[1].data(), intent: rows[2].data() };
        if (
          !validateSearchBootstrapProof(proof, options, instance) ||
          proof.job.jobId !== state.searchBootstrapProof.jobIds[index] ||
          proof.job.generation !== state.searchBootstrapProof.generations[index] ||
          proof.job.result.count !== state.searchBootstrapProof.counts[index]
        )
          throw fail('SEARCH_SUPERSESSION_BOOTSTRAP_NOT_CONVERGED');
        return proof;
      })
    );
    const unfinished = await tx.get(
      db.collection('durableJobs').where('state', 'not-in', ['succeeded', 'failed', 'cancelled', 'superseded']).limit(1)
    );
    if (unfinished.size) throw fail('SEARCH_SUPERSESSION_WORK_NOT_SETTLED');
    await confirmHeads(db, tx);
    return {
      control: nativeSnapshotProof(rows.control),
      state: nativeSnapshotProof(rows.state),
      readiness: nativeSnapshotProof(rows.readiness),
      usage: nativeSnapshotProof(rows.usage),
      history: { path: history.ref.path, proof: nativeSnapshotProof(history) },
      jobProofsSHA256: proofDigest(jobs),
      serverReadTime: rows.control.readTime,
    };
  });
}

export async function claimOperation(db, input, inspection, operationId, principal) {
  return db.runTransaction(async (tx) => {
    const rows = await readRows(db, tx);
    assertNativePair(inspection, rows);
    validateCheckpoint(rows.control.data(), rows.state.data(), input.oldRelease, input.revision);
    if (rows.operation.exists) throw fail('SEARCH_SUPERSESSION_OPERATION_EXISTS');
    const ref = db.doc(PATHS.operation);
    tx.create(ref, {
      operationId,
      action: ACTION,
      releaseId: input.oldRelease.releaseId,
      commit: input.oldRelease.compatibilityCommit,
      successorReleaseId: input.nextRelease.releaseId,
      successorCommit: input.nextRelease.compatibilityCommit,
      inputDigest: input.digest,
      inspection,
      principal,
    });
  });
}

export async function supersedeTransaction(
  db,
  input,
  inspection,
  operation,
  external,
  { confirmSearch = confirmSearchBootstrapInTransaction, confirmHeads = confirmSettledHeads, now = Date.now } = {}
) {
  return db.runTransaction(async (tx) => {
    const rows = await readRows(db, tx),
      control = rows.control.data(),
      state = rows.state.data();
    assertNativePair(inspection, rows);
    assertNativeSnapshot(operation.native, rows.operation);
    validateCheckpoint(control, state, input.oldRelease, input.revision);
    if (
      rows.operation.get('operationId') !== operation.operationId ||
      rows.operation.get('action') !== ACTION ||
      rows.operation.get('inputDigest') !== input.digest
    )
      throw fail('SEARCH_SUPERSESSION_OPERATION_CHANGED');
    assertCompatibilityGraceElapsed(control, state, input.oldRelease, rows.control.readTime);
    const observed = external.serverReadTime;
    if (external.workerBuildId !== input.nextRelease.compatibilityCommit)
      throw fail('SEARCH_SUPERSESSION_WORKERS_CHANGED');
    if (
      !observed ||
      rows.control.readTime.seconds - observed.seconds < 0 ||
      rows.control.readTime.seconds - observed.seconds >= 60
    )
      throw fail('SEARCH_SUPERSESSION_EXTERNAL_PROOF_STALE');
    assertNativeSnapshot(inspection.readiness, rows.readiness);
    assertNativeSnapshot(inspection.usage, rows.usage);
    const history = await tx.get(db.doc(inspection.history.path));
    assertNativeSnapshot(inspection.history.proof, history);
    validateProviderUsageContinuity(
      input.oldRelease,
      control,
      state,
      rows.usage,
      history.data(),
      state.providerUsageEpoch
    );
    if (!same(rows.readiness.data(), searchReadinessMarker(state.searchBootstrapProof, input.revision)))
      throw fail('SEARCH_SUPERSESSION_READINESS_CHANGED');
    const jobs = await confirmSearch(
      db,
      tx,
      {
        projectId: input.oldRelease.projectId,
        releaseId: input.oldRelease.releaseId,
        commit: input.oldRelease.compatibilityCommit,
        controlRevision: input.revision,
        operationId: operation.operationId,
      },
      state.searchBootstrapProof,
      { phase: 'search-ready', action: ACTION }
    );
    await confirmHeads(db, tx);
    const target = db.doc(archivePath(input.oldRelease.releaseId));
    if ((await tx.get(target)).exists) throw fail('SEARCH_SUPERSESSION_ARCHIVE_EXISTS');
    const at = now(),
      archive = {
        schemaVersion: 1,
        disposition: 'SUPERSEDED',
        notComplete: true,
        operationId: operation.operationId,
        inputDigest: input.digest,
        predecessorReleaseId: input.oldRelease.releaseId,
        successorReleaseId: input.nextRelease.releaseId,
        originalControl: control,
        originalState: state,
        originalReadiness: rows.readiness.data(),
        originalJobProofs: jobs,
        native: inspection,
        oldDescriptor: input.oldRelease,
        newDescriptor: input.nextRelease,
        oldDescriptorSHA256: input.oldDescriptorSHA256,
        newDescriptorSHA256: input.newDescriptorSHA256,
        operatorSource: input.source,
        review: input.review,
        external,
        archivedAt: at,
      };
    const archiveSHA256 = proofDigest(archive);
    const nextControl = {
      ...control,
      releaseId: input.nextRelease.releaseId,
      revision: input.revision + 1,
      updatedAt: at,
    };
    const nextState = successorState(state, input.nextRelease, external.workerBuildId, target.path, archiveSHA256, at);
    tx.create(target, archive);
    tx.set(db.doc(PATHS.control), nextControl);
    tx.set(db.doc(PATHS.state), nextState);
    tx.delete(db.doc(PATHS.readiness));
    return {
      archivePath: target.path,
      archiveSHA256,
      control: nativeSnapshotProof(rows.control),
      successorControl: nextControl,
      successorState: nextState,
    };
  });
}

export async function releaseOwnedOperation(db, operation, input, result) {
  await db.runTransaction(async (tx) => {
    const rows = await readRows(db, tx),
      archive = await tx.get(db.doc(result.archivePath));
    assertNativeSnapshot(operation.native, rows.operation);
    const archiveNative = archive.exists && nativeSnapshotProof(archive);
    if (
      !archive.exists ||
      proofDigest(archive.data()) !== result.archiveSHA256 ||
      !same(archiveNative.createTime, archiveNative.updateTime) ||
      !same(rows.control.data(), result.successorControl) ||
      !same(rows.state.data(), result.successorState) ||
      rows.readiness.exists ||
      archive.get('operationId') !== operation.operationId ||
      rows.operation.get('inputDigest') !== input.digest ||
      rows.operation.get('action') !== ACTION ||
      rows.operation.get('releaseId') !== input.oldRelease.releaseId
    )
      throw fail('SEARCH_SUPERSESSION_RECONCILIATION_CHANGED');
    tx.delete(db.doc(PATHS.operation));
  });
}

/** Cleanup-delete ACK may be lost after success. This branch is observational only. */
export async function confirmAlreadyReleased(db, input, operationId) {
  return db.runTransaction(async (tx) => {
    const rows = await readRows(db, tx);
    const archive = await tx.get(db.doc(archivePath(input.oldRelease.releaseId)));
    const saved = archive.data();
    const native = archive.exists && nativeSnapshotProof(archive);
    if (
      rows.operation.exists ||
      !archive.exists ||
      !same(native.createTime, native.updateTime) ||
      saved.schemaVersion !== 1 ||
      saved.disposition !== 'SUPERSEDED' ||
      saved.notComplete !== true ||
      saved.operationId !== operationId ||
      saved.inputDigest !== input.digest ||
      !same(saved.oldDescriptor, input.oldRelease) ||
      !same(saved.newDescriptor, input.nextRelease) ||
      saved.oldDescriptorSHA256 !== input.oldDescriptorSHA256 ||
      saved.newDescriptorSHA256 !== input.newDescriptorSHA256 ||
      !same(saved.operatorSource, input.source) ||
      !same(saved.review, input.review) ||
      saved.external?.workerBuildId !== input.nextRelease.compatibilityCommit
    )
      throw fail('SEARCH_SUPERSESSION_RECONCILIATION_CHANGED');
    const archiveSHA256 = proofDigest(saved);
    const expectedControl = {
      ...saved.originalControl,
      releaseId: input.nextRelease.releaseId,
      revision: input.revision + 1,
      updatedAt: saved.archivedAt,
    };
    const expectedState = successorState(
      saved.originalState,
      input.nextRelease,
      saved.external.workerBuildId,
      archive.ref.path,
      archiveSHA256,
      saved.archivedAt
    );
    if (rows.readiness.exists || !same(rows.control.data(), expectedControl) || !same(rows.state.data(), expectedState))
      throw fail('SEARCH_SUPERSESSION_RECONCILIATION_CHANGED');
    return {
      result: 'already-released-confirmed',
      operationId,
      archivePath: archive.ref.path,
      archiveSHA256,
      noMutation: true,
    };
  });
}

async function main(args) {
  const action = args.shift(),
    values = {};
  if (!['inspect', 'apply', 'reconcile'].includes(action)) throw fail('SEARCH_SUPERSESSION_ACTION_REQUIRED');
  for (let i = 0; i < args.length; i += 2) {
    if (
      ![
        '--old-release',
        '--new-release',
        '--revision',
        '--review',
        '--output',
        '--old-runtime-root',
        '--operation',
      ].includes(args[i]) ||
      !args[i + 1] ||
      values[args[i]]
    )
      throw fail('SEARCH_SUPERSESSION_ARGUMENTS_INVALID');
    values[args[i]] = args[i + 1];
  }
  for (const key of ['--old-release', '--new-release', '--revision', '--review', '--output', '--old-runtime-root'])
    if (!values[key]) throw fail('SEARCH_SUPERSESSION_ARGUMENTS_INVALID');
  if (action !== 'reconcile' && values['--operation']) throw fail('SEARCH_SUPERSESSION_ARGUMENTS_INVALID');
  if (Object.entries(process.env).some(([key, value]) => key.includes('EMULATOR') && value))
    throw fail('SEARCH_SUPERSESSION_LIVE_ENVIRONMENT_REQUIRED');
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const oldBytes = readFileSync(values['--old-release']),
    newBytes = readFileSync(values['--new-release']);
  const oldRelease = JSON.parse(oldBytes),
    nextRelease = JSON.parse(newBytes),
    review = JSON.parse(readFileSync(values['--review']));
  const binding = pinReleaseCheckouts(root, root, nextRelease),
    oldBinding = pinReleaseCheckouts(root, resolve(values['--old-runtime-root']), oldRelease);
  validateDescriptors(oldRelease, nextRelease, binding.operatorCommit);
  const revision = Number(values['--revision']);
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    review?.schemaVersion !== 1 ||
    review.oldReleaseId !== oldRelease.releaseId ||
    review.newReleaseId !== nextRelease.releaseId ||
    review.oldControlRevision !== revision ||
    typeof review.reason !== 'string' ||
    review.reason.trim().length < 20 ||
    !Number.isSafeInteger(review.candidateCiRunId) ||
    review.candidateCiRunId < 1
  )
    throw fail('SEARCH_SUPERSESSION_REVIEW_REQUIRED');
  for (const key of ['oldBootstrapTimeout', 'localValidation', 'replay', 'sourceImage']) {
    const artifact = review.artifacts?.[key];
    if (!artifact || !SHA.test(artifact.sha256 || '') || hash(readFileSync(artifact.path)) !== artifact.sha256)
      throw fail('SEARCH_SUPERSESSION_REVIEW_ARTIFACT_CHANGED');
  }
  const timeoutText = readFileSync(review.artifacts.oldBootstrapTimeout.path, 'utf8');
  if (
    !timeoutText.includes('SEARCH_BOOTSTRAP_TIMEOUT') ||
    review.timeoutControlRevision !== 28 ||
    review.timeoutReleaseId !== oldRelease.releaseId
  )
    throw fail('SEARCH_SUPERSESSION_TIMEOUT_ARCHIVE_REQUIRED');
  const run = (command, args, options = {}) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
      cwd: root,
      ...options,
    });
  const ci = JSON.parse(
    run('gh', [
      'run',
      'view',
      String(review.candidateCiRunId),
      '--repo',
      'upperroommedia/web-app',
      '--json',
      'headSha,status,conclusion',
    ])
  );
  if (ci.headSha !== nextRelease.compatibilityCommit || ci.status !== 'completed' || ci.conclusion !== 'success')
    throw fail('SEARCH_SUPERSESSION_CI_NOT_PASSED');
  const resource = loadReleaseResourceBinding(nextRelease),
    oldResource = loadReleaseResourceBinding(oldRelease);
  if (!same(resource.resources, oldResource.resources)) throw fail('SEARCH_SUPERSESSION_RESOURCE_CHANGED');
  const platform = JSON.parse(readFileSync(nextRelease.platformConfig));
  validateWorkerCoverage(nextRelease, platform);
  if (
    review.source?.commit !== nextRelease.compatibilityCommit ||
    review.source.workerImage !== resource.workerImage ||
    review.source.lockfileSHA256 !== hash(readFileSync(join(root, 'pnpm-lock.yaml'))) ||
    review.localValidation?.commit !== nextRelease.compatibilityCommit ||
    review.localValidation.result !== 'passed' ||
    review.replay?.oldCommit !== oldRelease.compatibilityCommit ||
    review.replay.newCommit !== nextRelease.compatibilityCommit ||
    review.replay.result !== 'passed' ||
    review.replay.sideEffectsDisabled !== true ||
    !same([...(review.replay.workflowTypes || [])].sort(), ['SearchBackfill', 'SearchDocument'])
  )
    throw fail('SEARCH_SUPERSESSION_SOURCE_REPLAY_REVIEW_CHANGED');
  if (
    platform.workerRoles.length !== 6 ||
    !['orchestration', 'controls', 'media', 'images', 'email', 'search'].every((role) =>
      platform.workerRoles.includes(role)
    )
  )
    throw fail('SEARCH_SUPERSESSION_ALL_WORKERS_REQUIRED');
  const input = {
    oldRelease,
    nextRelease,
    revision,
    review,
    oldDescriptorSHA256: hash(oldBytes),
    newDescriptorSHA256: hash(newBytes),
    source: {
      operatorCommit: binding.operatorCommit,
      closure: binding.operatorClosureDigest,
      runtimePins: binding.runtimePins,
      oldRuntimePins: oldBinding.runtimePins,
      resource,
    },
    digest: null,
  };
  input.digest = proofDigest({ ...input, digest: undefined });
  const assertInputs = () => {
    if (
      hash(readFileSync(values['--old-release'])) !== input.oldDescriptorSHA256 ||
      hash(readFileSync(values['--new-release'])) !== input.newDescriptorSHA256 ||
      !same(JSON.parse(readFileSync(values['--review'])), review) ||
      !same(loadReleaseResourceBinding(nextRelease), resource) ||
      !same(loadReleaseResourceBinding(oldRelease), oldResource) ||
      pinReleaseCheckouts(root, root, nextRelease).operatorClosureDigest !== binding.operatorClosureDigest ||
      !same(
        pinReleaseCheckouts(root, resolve(values['--old-runtime-root']), oldRelease).runtimePins,
        oldBinding.runtimePins
      )
    )
      throw fail('SEARCH_SUPERSESSION_SOURCE_INPUT_CHANGED');
    for (const artifact of Object.values(review.artifacts))
      if (!artifact || !SHA.test(artifact.sha256 || '') || hash(readFileSync(artifact.path)) !== artifact.sha256)
        throw fail('SEARCH_SUPERSESSION_REVIEW_ARTIFACT_CHANGED');
  };
  const output = openSync(values['--output'], 'wx', 0o600);
  let adc;
  try {
    adc = prepareLocalReleaseADC(root, nextRelease.projectId);
  } catch (error) {
    closeSync(output);
    throw error;
  }
  let sdk;
  try {
    sdk = firebaseAdmin(nextRelease.projectId, resource.resources.databaseUrl);
  } catch (error) {
    adc.close();
    closeSync(output);
    throw error;
  }
  await runWithCleanup(
    async () => {
      const db = sdk.firestore;
      if (sdk.credential !== adc.credential) throw fail('SEARCH_SUPERSESSION_CREDENTIAL_CHANGED');
      const principal = await verifyReleaseOperator(binding, sdk.credential);
      const api = async (url) => {
        const token = await sdk.credential.getAccessToken();
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token.access_token}`, 'X-Goog-User-Project': nextRelease.projectId },
          signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) throw fail('SEARCH_SUPERSESSION_READ_HTTP_' + response.status);
        return response.json();
      };
      const external = async (state) => {
        assertInputs();
        const identity = await verifyReleaseResourceIdentity(resource, api);
        const parent = `projects/${nextRelease.projectId}/locations/${nextRelease.location}/backends/${nextRelease.backendId}`;
        const traffic = await api(`https://firebaseapphosting.googleapis.com/v1beta/${parent}/traffic`);
        if (
          traffic.reconciling ||
          !traffic.etag ||
          traffic.rolloutPolicy?.disabled !== true ||
          !same(traffic.rolloutPolicy, { ...state.savedRolloutPolicy, disabled: true }) ||
          !same(traffic.current, state.savedUiTraffic) ||
          traffic.current?.splits?.length !== 1 ||
          traffic.current.splits[0].percent !== 100
        )
          throw fail('SEARCH_SUPERSESSION_UI_NOT_FROZEN');
        const buildName = traffic.current.splits[0].build;
        const build = await api(`https://firebaseapphosting.googleapis.com/v1beta/${buildName}`);
        if (
          !verifyAppHostingBuild(build, { buildName, uiCommit: ORIGINAL_UI }, identity.projectNumber) ||
          build.state !== 'READY' ||
          build.reconciling
        )
          throw fail('SEARCH_SUPERSESSION_ORIGINAL_UI_CHANGED');
        let pageToken;
        const rollouts = [];
        do {
          const page = await api(
            `https://firebaseapphosting.googleapis.com/v1beta/${parent}/rollouts?pageSize=100${
              pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''
            }`
          );
          rollouts.push(...(page.rollouts || []));
          pageToken = page.nextPageToken;
          if (rollouts.length > 1000) throw fail('SEARCH_SUPERSESSION_ROLLOUT_REVIEW_REQUIRED');
        } while (pageToken);
        if (rollouts.some((row) => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(row.state)))
          throw fail('SEARCH_SUPERSESSION_UI_ROLLOUT_ACTIVE');
        run(process.execPath, [
          join(root, 'scripts/deploy-temporal-platform.mjs'),
          'preflight',
          '--config',
          nextRelease.platformConfig,
          '--peer',
          nextRelease.platformPeerConfig,
        ]);
        const directory = mkdtempSync(join(tmpdir(), 'urm-search-supersession-'));
        try {
          const pods = JSON.parse(
            run('kubectl', [
              '--context',
              platform.context,
              'get',
              'pods',
              '-n',
              platform.namespace,
              '-l',
              `app.kubernetes.io/name=urm-temporal-worker,app.kubernetes.io/version=${platform.workerBuildId}`,
              '-o',
              'json',
            ])
          ).items;
          for (const role of platform.workerRoles) {
            const ready = pods.filter(
              (pod) =>
                pod.metadata?.labels?.['urm.temporal/role'] === role &&
                pod.status?.conditions?.some((row) => row.type === 'Ready' && row.status === 'True')
            );
            if (
              ready.length < platform.workerReplicas ||
              ready.some((pod) => {
                const worker = pod.spec?.containers?.find((container) => container.name === 'worker');
                return (
                  worker?.image !== platform.workerImage ||
                  (role === 'orchestration' &&
                    worker.env?.find((row) => row.name === 'TEMPORAL_DISPATCHER_ENABLED')?.value !== 'true')
                );
              })
            )
              throw fail('SEARCH_SUPERSESSION_LIVE_WORKER_IMAGE_CHANGED');
          }
          const output = join(directory, 'workers.json');
          run(
            process.execPath,
            [
              join(root, 'scripts/deploy-temporal-platform.mjs'),
              'worker-status',
              '--config',
              nextRelease.platformConfig,
              '--peer',
              nextRelease.platformPeerConfig,
              '--output',
              output,
              '--apply',
            ],
            { timeout: 960000 }
          );
          const workers = JSON.parse(readFileSync(output));
          if (
            workers.projectId !== nextRelease.projectId ||
            workers.buildId !== nextRelease.compatibilityCommit ||
            workers.current !== true ||
            workers.allQueuesRegistered !== true
          )
            throw fail('SEARCH_SUPERSESSION_WORKERS_CHANGED');
          await verifyFirebaseRtdbReadiness(
            platform,
            {
              configPath: nextRelease.platformConfig,
              peerPath: nextRelease.platformPeerConfig,
              output: join(directory, 'rtdb.json'),
            },
            {
              run: (args) => run(process.execPath, [join(root, 'scripts/deploy-temporal-platform.mjs'), ...args]),
              readProof: async (path) => JSON.parse(readFileSync(path)),
            }
          );
          assertInputs();
          const finalTraffic = await api(`https://firebaseapphosting.googleapis.com/v1beta/${parent}/traffic`);
          const finalIdentity = await verifyReleaseResourceIdentity(resource, api);
          if (!same(finalTraffic, traffic) || !same(finalIdentity, identity))
            throw fail('SEARCH_SUPERSESSION_EXTERNAL_AUTHORITY_CHANGED');
          const server = (await db.doc(PATHS.control).get()).readTime;
          return {
            resourceIdentity: identity,
            traffic,
            build,
            rollouts,
            workers,
            pods: pods.map((pod) => ({
              name: pod.metadata.name,
              uid: pod.metadata.uid,
              role: pod.metadata.labels['urm.temporal/role'],
              ready: pod.status.conditions?.some((row) => row.type === 'Ready' && row.status === 'True') === true,
              images: pod.spec.containers.map((container) => ({ name: container.name, image: container.image })),
              containerIds: pod.status.containerStatuses?.map((container) => container.containerID) || [],
            })),
            workerBuildId: workers.buildId,
            serverReadTime: server,
          };
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      };
      if (action === 'reconcile') {
        const operationId = values['--operation'];
        if (!UUID.test(operationId || '')) throw fail('SEARCH_SUPERSESSION_OPERATION_REQUIRED');
        const op = await db.doc(PATHS.operation).get(),
          archive = await db.doc(archivePath(oldRelease.releaseId)).get();
        if (!op.exists) {
          // Re-read operation absence together with the exact immutable archive and
          // successor checkpoint. Never recreate a lock or repeat the transition.
          const confirmed = await confirmAlreadyReleased(db, input, operationId);
          writeFileSync(output, JSON.stringify(confirmed) + '\n');
          return;
        }
        if (
          op.get('operationId') !== operationId ||
          op.get('action') !== ACTION ||
          op.get('releaseId') !== oldRelease.releaseId ||
          op.get('inputDigest') !== input.digest
        )
          throw fail('SEARCH_SUPERSESSION_RECONCILIATION_CHANGED');
        if (!archive.exists) {
          // Atomic archive absence means the handoff did not commit. Reuse only the
          // exact owned operation and its original native inspection, never rebase it.
          const inspection = op.get('inspection');
          if (!inspection) throw fail('SEARCH_SUPERSESSION_RECONCILIATION_CHANGED');
          const current = await db.runTransaction((tx) => readRows(db, tx));
          assertNativePair(inspection, current);
          validateCheckpoint(current.control.data(), current.state.data(), oldRelease, revision);
          await assertReleaseRuntimeSource(oldBinding, oldRelease, current.control.data());
          await assertReleaseRuntimeSource(binding, nextRelease, current.control.data());
          const proof = await external(current.state.data());
          assertInputs();
          const operation = { operationId, native: nativeSnapshotProof(op) };
          const result = await supersedeTransaction(db, input, inspection, operation, proof);
          await releaseOwnedOperation(db, operation, input, result);
          writeFileSync(
            output,
            JSON.stringify({
              result: 'inspected-uncommitted-handoff-completed',
              operationId,
              archivePath: result.archivePath,
              archiveSHA256: result.archiveSHA256,
              admission: 'paused',
            }) + '\n'
          );
          return;
        }
        if (
          archive.get('operationId') !== operationId ||
          archive.get('disposition') !== 'SUPERSEDED' ||
          !same(archive.get('newDescriptor'), nextRelease)
        )
          throw fail('SEARCH_SUPERSESSION_RECONCILIATION_CHANGED');
        const saved = archive.data(),
          nextState = successorState(
            saved.originalState,
            nextRelease,
            saved.external.workerBuildId,
            archive.ref.path,
            proofDigest(saved),
            saved.archivedAt
          );
        await releaseOwnedOperation(db, { operationId, native: nativeSnapshotProof(op) }, input, {
          archivePath: archive.ref.path,
          archiveSHA256: proofDigest(saved),
          successorControl: {
            ...saved.originalControl,
            releaseId: nextRelease.releaseId,
            revision: revision + 1,
            updatedAt: saved.archivedAt,
          },
          successorState: nextState,
        });
        writeFileSync(
          output,
          JSON.stringify({ result: 'owned-operation-reconciled', archivePath: archive.ref.path }) + '\n'
        );
        return;
      }
      const inspection = await inspectTransaction(db, input);
      const control = (await db.doc(PATHS.control).get()).data();
      await assertReleaseRuntimeSource(oldBinding, oldRelease, control);
      await assertReleaseRuntimeSource(binding, nextRelease, control);
      const state = (await db.doc(PATHS.state).get()).data(),
        observed = await external(state);
      if (action === 'inspect') {
        writeFileSync(
          output,
          JSON.stringify(
            {
              result: 'inspection-only',
              inputDigest: input.digest,
              inspection,
              external: observed,
              principal,
              noApplicationControlMutation: true,
              normalReadinessJobsMayBeCreated: true,
            },
            null,
            2
          ) + '\n'
        );
        return;
      }
      const operationId = randomUUID();
      // Once this claim is attempted, any failure leaves actual ownership for explicit inspection.
      await claimOperation(db, input, inspection, operationId, principal);
      console.log(
        JSON.stringify({ operationId, action: ACTION, releaseId: oldRelease.releaseId, admission: 'paused' })
      );
      const owned = await db.doc(PATHS.operation).get(),
        operation = { operationId, native: nativeSnapshotProof(owned) };
      const freshExternal = await external(state);
      if (
        !same(observed.traffic, freshExternal.traffic) ||
        !same(observed.resourceIdentity, freshExternal.resourceIdentity)
      )
        throw fail('SEARCH_SUPERSESSION_EXTERNAL_AUTHORITY_CHANGED');
      await assertReleaseRuntimeSource(oldBinding, oldRelease, control);
      await assertReleaseRuntimeSource(binding, nextRelease, control);
      assertInputs();
      const result = await supersedeTransaction(db, input, inspection, operation, freshExternal);
      // Unknown commit acknowledgement does not enter cleanup and never repeats the transition.
      await releaseOwnedOperation(db, operation, input, result);
      writeFileSync(
        output,
        JSON.stringify({
          result: 'superseded-search-ready-source',
          operationId,
          releaseId: nextRelease.releaseId,
          phase: 'ownership-changed',
          revision: revision + 1,
          archivePath: result.archivePath,
          archiveSHA256: result.archiveSHA256,
          admission: 'paused',
          newSourcesDeployed: false,
        }) + '\n'
      );
    },
    async () => {
      try {
        await sdk.close();
      } finally {
        adc.close();
        closeSync(output);
      }
    }
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      /^SEARCH_SUPERSESSION_[A-Z0-9_]+$/.test(error.code || '')
        ? error.code
        : 'SEARCH_SUPERSESSION_FAILED_INSPECT_AUTHORITY'
    );
    process.exitCode = 1;
  });
