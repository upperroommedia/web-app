#!/usr/bin/env node
// Narrow checkpoint migration. This command never deploys, resumes admission,
// deletes legacy work, changes owners, or replaces the original control documents.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
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
const { Timestamp } = createRequire(new URL('../functions/package.json', import.meta.url))('firebase-admin/firestore');
const plainTimestamp = (value) =>
  value &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === 2 &&
  Object.hasOwn(value, 'seconds') &&
  Object.hasOwn(value, 'nanoseconds');
const timestampShape = (value) =>
  (value instanceof Timestamp &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, '_seconds') &&
    Object.hasOwn(value, '_nanoseconds')) ||
  plainTimestamp(value);
export const canonical = (value) =>
  timestampShape(value)
    ? JSON.stringify(nativeRecoveryTimestamp(value))
    : Array.isArray(value)
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
    oldRelease.compatibilityCommit !== oldRelease.uiCommit ||
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
    Object.hasOwn(state, 'legacySettlingCutoff') ||
    Object.hasOwn(state, 'legacySettlingGraceSeconds') ||
    Object.hasOwn(state, 'compatibilityEvidenceAt') ||
    !state.appHostingFreezeRequestId ||
    !Number.isSafeInteger(state.maximumLegacyExecutionSeconds) ||
    state.maximumLegacyExecutionSeconds < 540 ||
    !state.savedRolloutPolicy ||
    state.savedRolloutPolicy.codebaseBranch !== 'staging' ||
    !state.savedUiTraffic
  )
    throw new Error('Recovery cannot rewrite a cutoff, completed compatibility gate, or missing freeze metadata');
  const previous = state.recoveryPredecessorReleaseId;
  if (
    previous !== undefined &&
    (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(previous) ||
      previous === state.releaseId ||
      state.recoveryArchivePath !== `_control/temporalCompatibilityRecovery-${previous}`)
  )
    throw new Error('Recovery ancestry pointer is malformed');
  if (
    previous === undefined &&
    [
      'recoveryArchivePath',
      'recoveryArchiveSha256',
      'recoveryOriginReleaseId',
      'recoveryOriginalOperatorUid',
      'recoveryOriginalIdentitySha256',
    ].some((key) => Object.hasOwn(state, key))
  )
    throw new Error('Recovery ancestry metadata has no predecessor');
}
const FREEZE_FIELDS = [
  'appHostingFreezeRequestId',
  'maximumLegacyExecutionSeconds',
  'savedRolloutPolicy',
  'savedUiTraffic',
  'domains',
];
const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function nativeRecoveryTimestamp(value) {
  if (
    !timestampShape(value) ||
    !Number.isSafeInteger(value.seconds) ||
    value.seconds < -62135596800 ||
    value.seconds > 253402300799 ||
    !Number.isSafeInteger(value.nanoseconds) ||
    value.nanoseconds < 0 ||
    value.nanoseconds >= 1_000_000_000
  )
    throw new Error('Native original recovery document timestamps are required');
  return { seconds: value.seconds, nanoseconds: value.nanoseconds };
}
const stampEqual = (a, b) => same(nativeRecoveryTimestamp(a), nativeRecoveryTimestamp(b));
/** Read each immutable archive independently. Final CAS uses its exact updateTime, avoiding rereading
 * unbounded runtime payloads in a transaction while still rejecting ANY intervening archive mutation. */
export async function validateRecoveryAncestry(input, loadArchive) {
  const {
    control,
    state,
    oldRelease,
    controlCreateTime,
    stateCreateTime,
    originalOperatorUid,
    originalIdentitySha256,
  } = input;
  validateReleaseConfig(oldRelease);
  if (
    oldRelease.environment !== 'staging' ||
    oldRelease.mode !== 'initial-cutover' ||
    oldRelease.compatibilityCommit !== oldRelease.uiCommit
  )
    throw new Error('Recovery ancestry supports staging initial cutover with exact source pins only');
  validateRecoveryCheckpoint(control, state, oldRelease, control.revision);
  nativeRecoveryTimestamp(controlCreateTime);
  nativeRecoveryTimestamp(stateCreateTime);
  if (!originalOperatorUid || !sha256(originalIdentitySha256))
    throw new Error('Original browser identity artifact is required for ancestry');
  const visited = new Set([oldRelease.releaseId]),
    commits = new Set([oldRelease.compatibilityCommit]),
    archives = [];
  let descriptor = oldRelease,
    currentControl = control,
    currentState = state,
    expectedHash = state.recoveryArchiveSha256;
  let originDescriptor = oldRelease;
  while (currentState.recoveryPredecessorReleaseId !== undefined) {
    const predecessor = currentState.recoveryPredecessorReleaseId,
      path = `_control/temporalCompatibilityRecovery-${predecessor}`;
    if (currentState.recoveryArchivePath !== path || visited.has(predecessor))
      throw new Error('Missing, cyclic or foreign recovery ancestry');
    visited.add(predecessor);
    const snapshot = await loadArchive(path);
    if (!snapshot?.exists) throw new Error('Required protected recovery archive is missing');
    if (!stampEqual(snapshot.createTime, snapshot.updateTime))
      throw new Error('Protected recovery archive was modified after its immutable creation');
    const archive = snapshot.data(),
      hash = digest(archive),
      prior = archive?.oldDescriptor,
      next = archive?.newDescriptor;
    if (expectedHash !== undefined && (!sha256(expectedHash) || expectedHash !== hash))
      throw new Error('Protected recovery archive hash changed');
    if (
      !archive ||
      archive.schemaVersion !== 1 ||
      archive.predecessorReleaseId !== predecessor ||
      archive.successorReleaseId !== descriptor.releaseId ||
      !same(next, descriptor) ||
      archive.oldDescriptorSha256 !== digest(prior) ||
      archive.newDescriptorSha256 !== digest(next)
    )
      throw new Error('Recovery archive descriptor or UUID continuity changed');
    validateRecoveryDescriptors(prior, next, next.compatibilityCommit);
    if (commits.has(prior.compatibilityCommit)) throw new Error('Recovery source ancestry contains a cycle');
    commits.add(prior.compatibilityCommit);
    const oc = archive.originalControl,
      os = archive.originalState;
    validateRecoveryCheckpoint(oc, os, prior, oc?.revision);
    if (
      currentControl.revision !== oc.revision + 1 ||
      currentState.controlRevision !== currentControl.revision ||
      (archive.successorControlRevision !== undefined && archive.successorControlRevision !== currentControl.revision)
    )
      throw new Error('Recovery archive revisions do not form the exact successor chain');
    if (
      !stampEqual(archive.originalControlCreateTime, controlCreateTime) ||
      !stampEqual(archive.originalStateCreateTime, stateCreateTime) ||
      FREEZE_FIELDS.some((key) => !same(os[key], state[key])) ||
      !same(oc.domains, control.domains)
    )
      throw new Error('Original recovery freeze or native createTime continuity changed');
    const identityArtifacts = Array.isArray(archive.artifacts)
      ? archive.artifacts.filter((artifact) => artifact.label === 'original-operator-identity')
      : undefined;
    if (
      archive.originalFreezePreserved !== true ||
      archive.admissionsOpened !== false ||
      archive.ownersChanged !== false ||
      archive.reviewedBrowserActorUid !== originalOperatorUid ||
      identityArtifacts?.length !== 1 ||
      identityArtifacts[0].sha256 !== originalIdentitySha256 ||
      archive.candidateCi?.headSha !== next.compatibilityCommit ||
      archive.candidateCi.status !== 'completed' ||
      archive.candidateCi.conclusion !== 'success' ||
      (recoveryMode(archive) === 'failed-deployment' &&
        (archive.settledGuard?.releaseId !== prior.releaseId ||
          archive.settledGuard.commit !== prior.compatibilityCommit ||
          archive.settledGuard.action !== 'controlled-backend-deploy')) ||
      !sha256(archive.reviewSha256)
    )
      throw new Error('Recovery archive lacks exact reviewed original identity and successful candidate evidence');
    if (recoveryMode(archive) === PLANNED_SUPERSESSION) {
      if (
        !archive.plannedReview ||
        archive.plannedReview.oldControlRevision !== oc.revision ||
        archive.plannedReview.originalOperatorUid !== originalOperatorUid ||
        !same(
          archive.artifacts,
          archive.plannedReview.artifacts.map(({ label, sha256 }) => ({ label, sha256 }))
        ) ||
        digest(archive.plannedReview) !== archive.reviewSha256 ||
        !same(archive.plannedSourceSupersession, archive.plannedReview.plannedSourceSupersession)
      )
        throw new Error('Planned archive requires its exact typed reviewed proof');
      validateRecoveryReview(archive.plannedReview, prior, next, Date.parse(archive.observedAt));
      validatePlannedSourceProof(
        archive.plannedDeployedSourceProof,
        archive.plannedReview,
        prior,
        Date.parse(archive.observedAt)
      );
      if (
        !Array.isArray(archive.plannedExpectedFunctions) ||
        !same([...archive.plannedExpectedFunctions].sort(), archive.runtime?.map((r) => r.name).sort()) ||
        !same(archive.runtime, archive.plannedReview.runtime) ||
        archive.plannedOperationLockAbsent !== true ||
        !Array.isArray(archive.plannedSuccessfulBuilds) ||
        new Set(archive.plannedSuccessfulBuilds.map((b) => b.name)).size !== archive.plannedSuccessfulBuilds.length ||
        !same(
          archive.plannedSuccessfulBuilds.map((b) => b.name).sort(),
          [...new Set(archive.runtime.map((r) => r.build))].sort()
        ) ||
        archive.plannedSuccessfulBuilds.some(
          (b) => b.status !== 'SUCCESS' || !archive.runtime.some((r) => r.build === b.name)
        )
      )
        throw new Error('Planned archive successful runtime/build proof changed');
    }
    if (
      (archive.ancestry !== undefined || archive.successorControlRevision !== undefined) &&
      (expectedHash === undefined ||
        !archive.ancestry ||
        !Number.isSafeInteger(archive.successorControlRevision) ||
        currentState.recoveryOriginReleaseId !== archive.ancestry.originReleaseId ||
        currentState.recoveryOriginalOperatorUid !== originalOperatorUid ||
        currentState.recoveryOriginalIdentitySha256 !== originalIdentitySha256)
    )
      throw new Error('Pinned recovery head requires exact persisted ancestry identity');
    const parent = os.recoveryPredecessorReleaseId;
    if (parent !== undefined) {
      if (
        archive.predecessorArchive?.path !== os.recoveryArchivePath ||
        !sha256(archive.predecessorArchive?.digest) ||
        (os.recoveryArchiveSha256 !== undefined && archive.predecessorArchive.digest !== os.recoveryArchiveSha256) ||
        expectedHash === undefined
      )
        throw new Error('Repeated recovery requires protected predecessor hash pins');
    } else {
      // Compatibility with the genuine first recovery emitted before archive hash pins existed.
      // An unpinned multi-hop history or a claimed parent can never use this bootstrap.
      if (archive.predecessorArchive !== undefined && archive.predecessorArchive !== null)
        throw new Error('Genesis recovery cannot claim an earlier archive');
      if (
        expectedHash === undefined &&
        (archives.length !== 0 || archive.successorControlRevision !== undefined || archive.ancestry !== undefined)
      )
        throw new Error('Only the original first-recovery archive may lack a head hash');
    }
    if (
      archive.ancestry &&
      (archive.ancestry.originalOperatorUid !== originalOperatorUid ||
        archive.ancestry.originalIdentitySha256 !== originalIdentitySha256 ||
        !stampEqual(archive.ancestry.originalControlCreateTime, controlCreateTime) ||
        !stampEqual(archive.ancestry.originalStateCreateTime, stateCreateTime))
    )
      throw new Error('Archived recovery ancestry identity changed');
    archives.push({
      path,
      digest: hash,
      ancestry: archive.ancestry,
      createTime: nativeRecoveryTimestamp(snapshot.createTime),
      updateTime: nativeRecoveryTimestamp(snapshot.updateTime),
    });
    originDescriptor = prior;
    descriptor = prior;
    currentControl = oc;
    currentState = os;
    expectedHash = archive.predecessorArchive?.digest ?? os.recoveryArchiveSha256;
  }
  if (
    (state.recoveryOriginReleaseId !== undefined && state.recoveryOriginReleaseId !== originDescriptor.releaseId) ||
    (state.recoveryOriginalOperatorUid !== undefined && state.recoveryOriginalOperatorUid !== originalOperatorUid) ||
    (state.recoveryOriginalIdentitySha256 !== undefined &&
      state.recoveryOriginalIdentitySha256 !== originalIdentitySha256)
  )
    throw new Error('Live original recovery identity changed');
  for (let index = 0; index < archives.length; index++) {
    const claimed = archives[index].ancestry;
    if (!claimed) {
      if (index !== archives.length - 1) throw new Error('Only the original bootstrap archive may omit ancestry');
      continue;
    }
    const tail = archives.slice(index + 1);
    const expected = {
      originReleaseId: originDescriptor.releaseId,
      originCompatibilityCommit: originDescriptor.compatibilityCommit,
      originalOperatorUid,
      originalIdentitySha256,
      originalControlCreateTime: nativeRecoveryTimestamp(controlCreateTime),
      originalStateCreateTime: nativeRecoveryTimestamp(stateCreateTime),
      archiveCount: tail.length,
      chainDigest: digest(tail.map(({ path, digest }) => ({ path, digest }))),
    };
    if (!same(claimed, expected))
      throw new Error('Archived ancestry summary does not match the immutable predecessor chain');
  }
  const summary = {
    originReleaseId: originDescriptor.releaseId,
    originCompatibilityCommit: originDescriptor.compatibilityCommit,
    originalOperatorUid,
    originalIdentitySha256,
    originalControlCreateTime: nativeRecoveryTimestamp(controlCreateTime),
    originalStateCreateTime: nativeRecoveryTimestamp(stateCreateTime),
    archiveCount: archives.length,
    chainDigest: digest(archives.map(({ path, digest }) => ({ path, digest }))),
  };
  if (
    input.newRelease &&
    (visited.has(input.newRelease.releaseId) || commits.has(input.newRelease.compatibilityCommit))
  )
    throw new Error('A recovery cannot reuse any ancestor release UUID or source commit');
  return { summary, archives, originDescriptor, releaseIds: [...visited], commits: [...commits] };
}
export async function assertRecoveryAncestryUnchanged(tx, db, ancestry) {
  if (!ancestry || !Array.isArray(ancestry.archives)) throw new Error('Validated recovery ancestry is required');
  for (let offset = 0; offset < ancestry.archives.length; offset += 100) {
    const batch = ancestry.archives.slice(offset, offset + 100),
      snapshots = await tx.getAll(...batch.map((entry) => db.doc(entry.path)), { fieldMask: ['schemaVersion'] });
    for (let index = 0; index < batch.length; index++) {
      const snapshot = snapshots[index],
        entry = batch[index];
      if (
        !snapshot.exists ||
        !stampEqual(snapshot.createTime, entry.createTime) ||
        !stampEqual(snapshot.updateTime, entry.updateTime)
      )
        throw new Error('Protected recovery archive changed after ancestry verification');
    }
  }
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
const PLANNED_SUPERSESSION = 'planned-source-supersession';
const FAILED_REVIEW_FIELDS = ['settledGuard', 'guardSettlementVerified', 'failedCompatibilityDeploymentVerified'];
export function recoveryMode(review) {
  if (review.recoveryMode === undefined && !Object.hasOwn(review, 'recoveryMode')) {
    if (Object.hasOwn(review, 'plannedSourceSupersession'))
      throw new Error('Planned proof requires an explicit recovery mode');
    return 'failed-deployment';
  }
  if (review.recoveryMode !== PLANNED_SUPERSESSION) throw new Error('Unknown explicit recovery mode');
  if (FAILED_REVIEW_FIELDS.some((key) => Object.hasOwn(review, key)))
    throw new Error('Planned supersession cannot claim a failed deployment or guard');
  return PLANNED_SUPERSESSION;
}
export function validatePlannedSourceSupersession(review, oldRelease) {
  if (recoveryMode(review) !== PLANNED_SUPERSESSION) throw new Error('Explicit planned source supersession required');
  const proof = review.plannedSourceSupersession;
  if (
    !proof ||
    proof.schemaVersion !== 1 ||
    proof.predecessorCommit !== oldRelease.compatibilityCommit ||
    proof.predecessorControlRevision !== review.oldControlRevision ||
    proof.operationLockAbsent !== true ||
    !sha256(proof.sourceAuditSha256) ||
    !sha256(proof.deployedSourceProofSha256)
  )
    throw new Error('Exact planned predecessor source, revision, no-lock observation and artifact pins required');
  for (const [label, hash] of [
    ['planned-source-audit', proof.sourceAuditSha256],
    ['deployed-source-provenance', proof.deployedSourceProofSha256],
  ]) {
    const artifacts = review.artifacts?.filter((a) => a.label === label);
    if (artifacts?.length !== 1 || artifacts[0].sha256 !== hash) throw new Error('Planned source artifact pin changed');
  }
  if (
    !Array.isArray(review.runtime) ||
    !review.runtime.length ||
    review.runtime.some(
      (r) =>
        r.state !== 'ACTIVE' ||
        typeof r.revision !== 'string' ||
        !r.revision ||
        typeof r.build !== 'string' ||
        !r.build ||
        r.releaseCommit !== oldRelease.compatibilityCommit ||
        !r.source ||
        typeof r.source.bucket !== 'string' ||
        !r.source.bucket ||
        typeof r.source.object !== 'string' ||
        !r.source.object ||
        !/^[0-9]+$/.test(r.source.generation || '')
    ) ||
    new Set(review.runtime.map((r) => r.name)).size !== review.runtime.length
  )
    throw new Error('Planned supersession requires complete successful source-bound runtime observations');
  return proof;
}
export function validatePlannedSourceProof(proof, review, oldRelease, now = Date.now()) {
  validatePlannedSourceSupersession(review, oldRelease);
  if (
    !proof ||
    proof.schemaVersion !== 1 ||
    proof.scope !== 'managed-functions-source-identities' ||
    proof.result !== 'passed' ||
    proof.projectId !== oldRelease.projectId ||
    proof.releaseId !== oldRelease.releaseId ||
    proof.commit !== oldRelease.compatibilityCommit ||
    proof.controlRevision !== review.oldControlRevision ||
    !fresh(proof.verifiedAt, now) ||
    proof.runtimeSha256 !== digest(review.runtime)
  )
    throw new Error('Fresh actual deployed predecessor source proof required');
}
export function expectedPlannedFunctionNames(root, oldRelease) {
  const read = (path) =>
    execFileSync('git', ['show', `${oldRelease.compatibilityCommit}:${path}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const names = [];
  for (const codebase of ['core', 'media', 'image', 'integrations']) {
    const source = read(`functions-${codebase}/src/index.ts`);
    const before = names.length;
    names.push(...[...source.matchAll(/^exports\.([A-Za-z_$][\w$]*)\s*=/gm)].map((match) => match[1]));
    for (const match of source.matchAll(/^export\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/gm)) {
      for (const entry of match[1].split(',')) {
        const name = entry
          .trim()
          .split(/\s+as\s+/)
          .at(-1);
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error('Unsupported predecessor named export');
        names.push(name);
      }
    }
    if (names.length === before || /^export\s+(?:const|function|default|\*)/m.test(source))
      throw new Error('Unsupported predecessor function export surface');
  }
  const firebase = JSON.parse(read('firebase.json'));
  for (const config of firebase.functions.filter((entry) => entry.kit)) {
    if (!config.instances || !Object.keys(config.instances).length)
      throw new Error('Missing predecessor kit instances');
    if (config.kit === 'image-processing-api')
      names.push(...Object.keys(config.instances).map((id) => `kit-${id}-handler`));
    else if (config.kit === 'firestore-send-email')
      names.push(...Object.keys(config.instances).map((id) => `kit-${id}-processQueue`));
    else if (config.kit === 'firestore-algolia-search') {
      if (oldRelease.domains.includes('search'))
        names.push(
          ...Object.keys(config.instances).flatMap((id) => [
            `kit-${id}-executeIndexOperation`,
            `kit-${id}-executeFullIndexOperation`,
          ])
        );
    } else throw new Error('Unreviewed predecessor kit export surface');
  }
  if (new Set(names).size !== names.length) throw new Error('Duplicate predecessor function export');
  return names
    .map((name) => `projects/${oldRelease.projectId}/locations/${oldRelease.location}/functions/${name}`)
    .sort();
}
// Cloud Run returns full revision resources for readiness and bare revision IDs in trafficStatuses.
// Resolve only within this exact service; a matching final path segment is not identity proof.
function canonicalServiceRevision(reference, serviceName) {
  if (typeof reference !== 'string') return undefined;
  const prefix = `${serviceName}/revisions/`;
  const revision = reference.startsWith(prefix) ? reference.slice(prefix.length) : reference;
  return /^[a-z][a-z0-9-]{0,62}$/.test(revision) ? `${prefix}${revision}` : undefined;
}
export function validatePlannedRuntimeInventory(functions, services, review, oldRelease, expectedNames) {
  validatePlannedSourceSupersession(review, oldRelease);
  if (
    !Array.isArray(expectedNames) ||
    !expectedNames.length ||
    new Set(expectedNames).size !== expectedNames.length ||
    !same([...expectedNames].sort(), review.runtime.map((r) => r.name).sort())
  )
    throw new Error('Review must cover exact immutable predecessor export surface');
  const managed = functions.filter((f) => expectedNames.includes(f.name));
  if (
    managed.length !== expectedNames.length ||
    new Set(managed.map((f) => f.name)).size !== managed.length ||
    functions.some(
      (f) => f.serviceConfig?.environmentVariables?.TEMPORAL_RELEASE_COMMIT && !expectedNames.includes(f.name)
    )
  )
    throw new Error('Complete managed Functions source inventory required');
  for (const expected of review.runtime) {
    const actual = managed.find((f) => f.name === expected.name),
      service = services.find((s) => s.name === actual?.serviceConfig?.service),
      servicePrefix = `projects/${oldRelease.projectId}/locations/${oldRelease.location}/services/`,
      serviceId = service?.name?.startsWith(servicePrefix) ? service.name.slice(servicePrefix.length) : '',
      expectedRevision = service && canonicalServiceRevision(expected.revision, service.name),
      readyRevision = service && canonicalServiceRevision(service.latestReadyRevision, service.name);
    if (
      !actual ||
      actual.state !== 'ACTIVE' ||
      actual.serviceConfig.environmentVariables.TEMPORAL_RELEASE_COMMIT !== oldRelease.compatibilityCommit ||
      actual.buildConfig?.build !== expected.build ||
      actual.serviceConfig?.revision !== expected.revision ||
      !same(actual.buildConfig?.source?.storageSource, expected.source) ||
      !service ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(serviceId) ||
      !expectedRevision ||
      service.reconciling ||
      service.terminalCondition?.state !== 'CONDITION_SUCCEEDED' ||
      service.latestCreatedRevision !== service.latestReadyRevision ||
      readyRevision !== expectedRevision ||
      !Array.isArray(service.trafficStatuses) ||
      !service.trafficStatuses.length ||
      service.trafficStatuses.some(
        (t) =>
          !t ||
          canonicalServiceRevision(t.revision, service.name) !== readyRevision ||
          !Number.isInteger(t.percent) ||
          t.percent < 0 ||
          t.percent > 100
      ) ||
      service.trafficStatuses.reduce((total, t) => total + t.percent, 0) !== 100
    )
      throw new Error('Planned predecessor runtime is not fully ready on its exact successful source');
  }
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
  const mode = recoveryMode(review);
  if (mode === PLANNED_SUPERSESSION) validatePlannedSourceSupersession(review, oldRelease);
  const g = review.settledGuard,
    i = review.operatorIdentity;
  if (
    (mode === 'failed-deployment' &&
      (g?.action !== 'controlled-backend-deploy' ||
        g.releaseId !== oldRelease.releaseId ||
        g.commit !== oldRelease.compatibilityCommit ||
        !/^[a-f0-9-]{36}$/.test(g.operationId || '') ||
        !Number.isSafeInteger(g.createdAt) ||
        g.createdAt > now ||
        review.guardSettlementVerified !== true ||
        review.failedCompatibilityDeploymentVerified !== true)) ||
    !i?.actorUid ||
    !Number.isFinite(Date.parse(i.authTime)) ||
    !fresh(i.verifiedAt, now) ||
    i.actorUid !== review.originalOperatorUid
  )
    throw new Error('Matching settled failed deployment and unchanged reviewed operator are required');
  if (
    !Array.isArray(review.operations) ||
    (mode === 'failed-deployment' && !review.operations.length) ||
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
export function buildRecoveryArchive({ archive, oldRelease, newRelease, verified }) {
  const record = {
    ...archive,
    predecessorReleaseId: oldRelease.releaseId,
    successorReleaseId: newRelease.releaseId,
    originalControl: verified.control,
    originalState: verified.state,
    originalControlCreateTime: verified.controlCreateTime,
    originalStateCreateTime: verified.stateCreateTime,
    predecessorArchive: verified.ancestry.archives[0]
      ? { path: verified.ancestry.archives[0].path, digest: verified.ancestry.archives[0].digest }
      : null,
    successorControlRevision: verified.control.revision + 1,
    ancestry: verified.ancestry.summary,
  };
  if (Buffer.byteLength(canonical(record), 'utf8') > 750000)
    throw new Error('Recovery archive exceeds reviewed document byte budget');
  return record;
}
export async function migrateRecoveryCheckpoint(
  db,
  { oldRelease, newRelease, review, operationId, verified, archive }
) {
  validateRecoveryDescriptors(oldRelease, newRelease, newRelease.compatibilityCommit);
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
    if (!stampEqual(cs.createTime, verified.controlCreateTime) || !stampEqual(ss.createTime, verified.stateCreateTime))
      throw new Error('Native original checkpoint createTimes changed');
    if (
      verified.ancestry?.releaseIds?.includes(newRelease.releaseId) ||
      verified.ancestry?.commits?.includes(newRelease.compatibilityCommit)
    )
      throw new Error('Recovery cannot reuse an ancestor release or source');
    await assertRecoveryAncestryUnchanged(tx, db, verified.ancestry);
    assertSafeRecoveryLeases(leases.docs.map((d) => d.data()));
    const archiveRecord = buildRecoveryArchive({ archive, oldRelease, newRelease, verified });
    tx.create(db.doc(archivePath), archiveRecord);
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
      recoveryArchiveSha256: digest(archiveRecord),
      recoveryOriginReleaseId: verified.ancestry.summary.originReleaseId,
      recoveryOriginalOperatorUid: verified.ancestry.summary.originalOperatorUid,
      recoveryOriginalIdentitySha256: verified.ancestry.summary.originalIdentitySha256,
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
    let originalIdentity, originalIdentitySha256, plannedDeployedSourceProof;
    for (const artifact of review.artifacts) {
      const bytes = await readFile(artifact.path);
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
        throw new Error('Reviewed runtime/settlement artifact changed');
      await writeFile(`${archiveDir}/${artifact.label}.artifact`, bytes, { mode: 0o600, flag: 'wx' });
      if (artifact.label === 'deployed-source-provenance')
        plannedDeployedSourceProof = JSON.parse(bytes.toString('utf8'));
      if (artifact.label === 'original-operator-identity') {
        if (originalIdentity) throw new Error('Exactly one original identity artifact is required');
        originalIdentity = JSON.parse(bytes.toString('utf8'));
        originalIdentitySha256 = artifact.sha256;
      }
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
    const mode = recoveryMode(review);
    if (mode === PLANNED_SUPERSESSION) validatePlannedSourceProof(plannedDeployedSourceProof, review, oldRelease);
    const { firestore: db, database, credential } = firebaseAdmin(oldRelease.projectId, oldRelease.databaseUrl);
    clients = { db, database };
    const operationId = randomUUID(),
      apply = args.includes('--apply');
    const [ancestryControl, ancestryState] = await db.getAll(db.doc(CONTROL_PATH), db.doc(STATE_PATH));
    const ancestry = await validateRecoveryAncestry(
      {
        control: ancestryControl.data(),
        state: ancestryState.data(),
        oldRelease,
        controlCreateTime: ancestryControl.createTime,
        stateCreateTime: ancestryState.createTime,
        originalOperatorUid: review.originalOperatorUid,
        originalIdentitySha256,
        newRelease,
      },
      (path) => db.doc(path).get()
    );
    let verified;
    await db.runTransaction(async (tx) => {
      const [cs, ss, lock] = await Promise.all([
        tx.get(db.doc(CONTROL_PATH)),
        tx.get(db.doc(STATE_PATH)),
        tx.get(db.doc(OPERATION_PATH)),
      ]);
      validateRecoveryCheckpoint(cs.data(), ss.data(), oldRelease, review.oldControlRevision);
      if (
        !same(cs.data(), ancestryControl.data()) ||
        !same(ss.data(), ancestryState.data()) ||
        !stampEqual(cs.createTime, ancestryControl.createTime) ||
        !stampEqual(ss.createTime, ancestryState.createTime)
      )
        throw new Error('Recovery checkpoint changed during ancestry verification');
      await assertRecoveryAncestryUnchanged(tx, db, ancestry);
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
        ancestry,
      };
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
    if (mode === 'failed-deployment') assertFailedDeploymentAfterGuard(settled, review.settledGuard.createdAt);
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
    if (mode === PLANNED_SUPERSESSION)
      validatePlannedRuntimeInventory(
        functions,
        services,
        review,
        oldRelease,
        expectedPlannedFunctionNames(root, oldRelease)
      );
    const plannedExpectedFunctions =
      mode === PLANNED_SUPERSESSION ? expectedPlannedFunctionNames(root, oldRelease) : undefined;
    const plannedSuccessfulBuilds = [];
    const runtime = [];
    for (const expected of review.runtime) {
      const actual = functions.find((f) => f.name === expected.name);
      const projection = {
        name: actual?.name,
        state: actual?.state,
        build: actual?.buildConfig?.build ?? null,
        revision: actual?.serviceConfig?.revision ?? null,
      };
      if (mode === PLANNED_SUPERSESSION) {
        projection.releaseCommit = actual.serviceConfig.environmentVariables.TEMPORAL_RELEASE_COMMIT;
        projection.source = actual.buildConfig.source.storageSource;
        if (!plannedSuccessfulBuilds.some((b) => b.name === projection.build)) {
          const build = await api(`https://cloudbuild.googleapis.com/v1/${projection.build}`);
          if (build.status !== 'SUCCESS') throw new Error('Planned predecessor build did not succeed');
          plannedSuccessfulBuilds.push({ name: projection.build, status: build.status });
        }
      }
      if (!same(projection, expected))
        throw new Error('Observed failed runtime identity changed; review actual settlement again');
      runtime.push(projection);
    }
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
      ...(mode === 'failed-deployment'
        ? { settledGuard: review.settledGuard }
        : {
            recoveryMode: PLANNED_SUPERSESSION,
            plannedSourceSupersession: review.plannedSourceSupersession,
            plannedReview: review,
            plannedDeployedSourceProof,
            plannedOperationLockAbsent: true,
            plannedSuccessfulBuilds,
            plannedExpectedFunctions,
          }),
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
    buildRecoveryArchive({ archive, oldRelease, newRelease, verified });
    await writeFile(
      `${archiveDir}/observations.json`,
      JSON.stringify(buildRecoveryArchive({ archive, oldRelease, newRelease, verified }), null, 2),
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
    // All deterministic validation, including the complete document budget, precedes lock acquisition.
    validateRecoveryReview(review, oldRelease, newRelease);
    await db.runTransaction(async (tx) => {
      const [cs, ss, lock] = await tx.getAll(db.doc(CONTROL_PATH), db.doc(STATE_PATH), db.doc(OPERATION_PATH));
      if (lock.exists) throw new Error('Recovery never steals an existing operation lock');
      validateRecoveryCheckpoint(cs.data(), ss.data(), oldRelease, review.oldControlRevision);
      if (
        !same(cs.data(), verified.control) ||
        !same(ss.data(), verified.state) ||
        !stampEqual(cs.createTime, verified.controlCreateTime) ||
        !stampEqual(ss.createTime, verified.stateCreateTime)
      )
        throw new Error('Recovery checkpoint changed before lock acquisition');
      await assertRecoveryAncestryUnchanged(tx, db, ancestry);
      assertCheckoutSource(root, commit, { project: newRelease.projectId, control: cs.data() });
      buildRecoveryArchive({ archive, oldRelease, newRelease, verified });
      tx.create(db.doc(OPERATION_PATH), {
        operationId,
        action: 'recover-initial-compatibility',
        releaseId: oldRelease.releaseId,
        newReleaseId: newRelease.releaseId,
        commit,
        createdAt: Date.now(),
      });
    });
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
