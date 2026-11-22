import { randomUUID } from 'node:crypto';
import { CONTROL_PATH, RELEASE_DOMAINS, validateControl, validateProviderUsageMarker } from './temporal-release-lib.mjs';
import { assertNativeSnapshot, assertNativeSnapshotSuccessor, hash, nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { observeStagingPredecessorPool } from './temporal-staging-predecessor-pool.mjs';

export const predecessorReleaseId = '417a472a-c79b-4c3b-bb85-f3d9e4d04696';
export const predecessorOperationId = '842f1974-4e17-41c6-b2e0-51891326dbd1';
const predecessorBuild = 'b008afa426291ad2aa94cb8319d4bf06afdce1e0';
const projectId = 'urm-app-staging';
const revision = 65;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const commit = /^[a-f0-9]{40}$/;

export const predecessorPaths = Object.freeze({
  control: CONTROL_PATH,
  state: '_control/temporalReleaseState',
  operation: '_control/temporalReleaseOperation',
  providerUsage: '_control/temporalProviderUsage',
  success: `_control/temporalCloudPoolPreparation-${predecessorOperationId}`,
  noSend: `_control/temporalCloudPoolPreSendAbort-${predecessorOperationId}`,
  archive: `_control/temporalStagingMediaSupersession-${predecessorOperationId}`,
});
const identityReceiptIds = Object.freeze({
  runner: '5c565071-8d00-41c1-9a2a-95a075f702ff',
  scaler: '3e74709f-a7db-4395-b184-a3dcb806e3c0',
});
const maxFenceAgeMs = 5_000;
const maxWorkExclusionAgeMs = 30_000;
const authorityKeys = ['control', 'state', 'operation', 'providerUsage'];
const absentKeys = ['success', 'noSend', 'archive'];

function fail() {
  throw new Error('STAGING_MEDIA_SUCCESSOR_BOUNDARY_UNCONFIRMED');
}

const iamAccountUrl = (uniqueId) =>
  `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/${uniqueId}`;

const iamAttemptPath = (kind) =>
  `_control/temporalStagingMediaIdentityFence-${predecessorOperationId}-${kind}`;

function assertFreshSample(wallTime, monotonicTime, now, maxAgeMs = maxFenceAgeMs) {
  for (const age of [now() - wallTime, performance.now() - monotonicTime]) {
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) fail();
  }
}

async function sampleWorkExclusion(observe, boundary, now, previous) {
  const started = now(), monotonic = performance.now();
  const proof = await observe(boundary);
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) fail();
  const withoutClock = (value) => {
    if (!value) return value;
    const { observedAt: _observedAt, ...identity } = value;
    return identity;
  };
  const digest = proofDigest({
    temporal: withoutClock(proof.temporal), dispatch: withoutClock(proof.dispatch),
  });
  if (previous && previous.digest !== digest) fail();
  const assertFresh = () => assertFreshSample(started, monotonic, now, maxWorkExclusionAgeMs);
  assertFresh();
  return { proof, digest, assertFresh };
}

// Build the transition only. The live operator must separately verify native
// predecessor isolation, exact candidate provenance, and all snapshot stamps
// before committing these documents together.
export function planStagingMediaSuccessor({ control, state, operation, providerUsage, successor }, now) {
  validateControl(control);
  if (!Number.isFinite(now) ||
    successor?.environment !== 'staging' || successor.projectId !== projectId ||
    successor.backendId !== 'web-staging' || successor.mode !== 'durable-upgrade' ||
    !uuid.test(successor.releaseId ?? '') || successor.releaseId === predecessorReleaseId ||
    !commit.test(successor.compatibilityCommit ?? '') || successor.uiCommit !== successor.compatibilityCommit ||
    !Array.isArray(successor.domains) || proofDigest(successor.domains) !== proofDigest(RELEASE_DOMAINS))
    fail();

  const oldNames = serverlessResourceNames(predecessorBuild, 'media');
  const newNames = serverlessResourceNames(successor.compatibilityCommit, 'media');
  if (newNames.poolName === oldNames.poolName) fail();
  if (control.releaseId !== predecessorReleaseId || control.revision !== revision || control.admission !== 'paused' ||
    RELEASE_DOMAINS.some((domain) => control.domains[domain].owner !== 'temporal' || control.domains[domain].admission !== 'paused') ||
    state?.releaseId !== predecessorReleaseId || state.controlRevision !== revision ||
    state.phase !== 'provider-usage-ready' || state.mode !== 'durable-upgrade' ||
    state.compatibilityCommit !== predecessorBuild || state.uiCommit !== predecessorBuild ||
    proofDigest(state.domains) !== proofDigest(RELEASE_DOMAINS) ||
    state.savedRolloutPolicy?.codebaseBranch !== 'staging' || !state.savedUiTraffic ||
    !state.appHostingFreezeRequestId || !state.appHostingFreezeETag || !state.appHostingFrozenETag ||
    !Number.isSafeInteger(state.maximumLegacyExecutionSeconds) || state.maximumLegacyExecutionSeconds < 0 ||
    !state.providerUsageEpoch || state.providerUsageBackfillRevision !== providerUsage?.controlRevision)
    fail();
  validateProviderUsageMarker(successor, providerUsage, state.providerUsageEpoch);

  const attempt = operation?.cloudPoolPreparation;
  const body = attempt?.plan?.body;
  if (operation?.operationId !== predecessorOperationId || operation.releaseId !== predecessorReleaseId ||
    operation.action !== 'prepare-cloud-run-pool' ||
    proofDigest(operation.operatorIdentity) !== operation.bindingDigest ||
    operation.operatorIdentity?.runtimeCommit !== predecessorBuild ||
    attempt?.stage !== 'attempted' || attempt.nativeOperation || attempt.sendFenceVersion || attempt.noSendReason ||
    !Number.isFinite(Date.parse(attempt.attemptedAt)) || attempt.plan.operationId !== predecessorOperationId ||
    attempt.plan.releaseId !== predecessorReleaseId || attempt.plan.role !== 'media' ||
    attempt.plan.buildId !== predecessorBuild || attempt.plan.runner !== oldNames.runnerServiceAccount ||
    body?.name !== `projects/${projectId}/locations/us-central1/workerPools/${oldNames.poolName}` ||
    body.template?.serviceAccount !== oldNames.runnerServiceAccount ||
    body.annotations?.['urm.upperroom.media/preparation'] !== predecessorOperationId ||
    proofDigest(body.scaling) !== proofDigest({ manualInstanceCount: 0 }))
    fail();

  const nextRevision = revision + 1;
  return {
    control: { ...control, releaseId: successor.releaseId, revision: nextRevision, updatedAt: now },
    state: {
      releaseId: successor.releaseId,
      controlRevision: nextRevision,
      mode: successor.mode,
      domains: successor.domains,
      phase: 'ui-frozen',
      compatibilityCommit: successor.compatibilityCommit,
      ...(successor.mosesActivation && { mosesActivationPolicySHA256: proofDigest(successor.mosesActivation) }),
      uiCommit: successor.uiCommit,
      savedRolloutPolicy: state.savedRolloutPolicy,
      savedUiTraffic: state.savedUiTraffic,
      appHostingFreezeRequestId: state.appHostingFreezeRequestId,
      appHostingFreezeETag: state.appHostingFreezeETag,
      appHostingFrozenETag: state.appHostingFrozenETag,
      maximumLegacyExecutionSeconds: state.maximumLegacyExecutionSeconds,
      stagingMediaSupersessionArchive: predecessorPaths.archive,
      updatedAt: now,
    },
    oldNames,
    newNames,
  };
}

async function readBoundaryDocuments(db, tx) {
  const paths = Object.entries(predecessorPaths);
  const snapshots = await tx.getAll(...paths.map(([, path]) => db.doc(path)));
  return Object.fromEntries(paths.map(([name], index) => [name, snapshots[index]]));
}

function assertOriginalDocuments(documents) {
  if (!authorityKeys.every((name) => documents[name]?.exists) ||
    !absentKeys.every((name) => documents[name]?.exists === false))
    fail();
}

export async function readStagingMediaSuccessorBoundary(db, successor, now = Date.now) {
  return db.runTransaction(async (tx) => {
    const documents = await readBoundaryDocuments(db, tx);
    assertOriginalDocuments(documents);
    const original = Object.fromEntries(authorityKeys.map(name => [name, documents[name].data()]));
    const authority = Object.fromEntries(authorityKeys.map(name => [name, nativeSnapshotProof(documents[name])]));
    return { original, authority, transition: planStagingMediaSuccessor({ ...original, successor }, now()) };
  }, { readOnly: true });
}

// Resolve by numeric IAM ID so a deleted/recreated email cannot stand in for
// the identity in the predecessor's immutable preparation receipt.
export async function observeStagingPredecessorAccounts(db, api, originalPlan) {
  const names = serverlessResourceNames(predecessorBuild, 'media');
  const accounts = await Promise.all(Object.entries(identityReceiptIds).map(async ([kind, receiptId]) => {
    const snapshot = await db.doc(`_control/temporalCloudIdentityPreparation-${receiptId}`).get();
    if (!snapshot.exists) fail();
    const authority = nativeSnapshotProof(snapshot);
    const receipt = snapshot.data();
    const identity = receipt.identityState;
    const email = kind === 'runner' ? names.runnerServiceAccount : names.invokerServiceAccount;
    const uniqueId = identity?.account?.uniqueId;
    if (proofDigest(authority.createTime) !== proofDigest(authority.updateTime) ||
      receipt.operationId !== receiptId || receipt.releaseId !== predecessorReleaseId ||
      identity?.stage !== 'completed' || identity.plan?.operationId !== receiptId ||
      identity.plan.role !== 'media' || identity.plan.kind !== kind || identity.plan.buildId !== predecessorBuild ||
      identity.plan.email !== email || identity.plan.evidenceDigest !== originalPlan.evidenceDigest ||
      identity.account?.email !== email || !/^[0-9]{10,30}$/.test(uniqueId ?? '') ||
      (kind === 'runner' && hash(JSON.stringify(receipt)) !== originalPlan.identityReceiptSHA256))
      fail();
    const account = await api(iamAccountUrl(uniqueId));
    if (account?.projectId !== projectId || account.email !== email || account.uniqueId !== uniqueId ||
      account.description !== identity.account.description ||
      (account.disabled !== undefined && typeof account.disabled !== 'boolean'))
      fail();
    return { kind, email, uniqueId, disabled: account.disabled === true, receiptId, authority };
  }));
  if (accounts[0].uniqueId === accounts[1].uniqueId) fail();
  return accounts;
}

async function assertOriginalAuthority(db, tx, boundary, accounts) {
  const documents = await readBoundaryDocuments(db, tx);
  assertOriginalDocuments(documents);
  for (const name of authorityKeys) assertNativeSnapshot(boundary.authority[name], documents[name]);
  for (const account of accounts) {
    const receipt = await tx.get(db.doc(`_control/temporalCloudIdentityPreparation-${account.receiptId}`));
    assertNativeSnapshot(account.authority, receipt);
  }
  return documents;
}

// The source-owned release command calls this after candidate verification.
// An existing attempt permits native readback only, even if the account is
// still enabled. The journal survives a missing HTTP or Firestore response.
export async function fenceStagingPredecessorAccounts({
  db, api, boundary, successor, candidate, resourceBinding, observeWorkExclusion, assertPrivateWorkIdle, now = Date.now,
  observePool = observeStagingPredecessorPool,
}) {
  if (db.projectId !== projectId || db.databaseId !== '(default)' ||
    candidate?.commit !== successor.compatibilityCommit)
    fail();
  const plan = boundary.original.operation.cloudPoolPreparation.plan;
  const { verifiedAt: _verifiedAt, ...candidateIdentity } = candidate;
  const observeAccounts = () => observeStagingPredecessorAccounts(db, api, plan);
  const journals = [];
  for (const kind of ['runner', 'scaler']) {
    const ref = db.doc(iamAttemptPath(kind));
    const accounts = await observeAccounts();
    const account = accounts.find((item) => item.kind === kind);
    const url = `${iamAccountUrl(account.uniqueId)}:disable`;
    const binding = {
      schemaVersion: 1, projectId, predecessorOperationId, successorReleaseId: successor.releaseId,
      successorDigest: proofDigest(successor), candidateDigest: proofDigest(candidateIdentity),
      resourceBindingDigest: proofDigest(resourceBinding),
      authority: boundary.authority, accountReceipt: account.authority,
      kind, uniqueId: account.uniqueId, request: { method: 'POST', url, body: {} },
    };
    const bindingDigest = proofDigest(binding);
    function readJournal(snapshot) {
      if (!snapshot.exists) return null;
      const proof = nativeSnapshotProof(snapshot);
      const journal = snapshot.data();
      if (proofDigest(proof.createTime) !== proofDigest(proof.updateTime) ||
        journal.bindingDigest !== bindingDigest || proofDigest(journal.binding) !== bindingDigest ||
        !['attempted', 'observed-disabled'].includes(journal.stage) || !Number.isFinite(journal.recordedAt))
        fail();
      return proof;
    }
    const existing = await db.runTransaction((tx) => tx.get(ref), { readOnly: true });
    const existingProof = readJournal(existing);
    if (existingProof) {
      if (!account.disabled) fail();
      journals.push(existingProof);
      continue;
    }

    const before = await sampleWorkExclusion(observeWorkExclusion, boundary, now);
    const recordAttempt = async () => {
      const work = await sampleWorkExclusion(observeWorkExclusion, boundary, now, before);
      const sampledAt = now();
      const sampledMonotonic = performance.now();
      const [currentAccounts] = await Promise.all([
        observeAccounts(),
        observePool({ plan, api }),
      ]);
      const current = currentAccounts.find((item) => item.kind === kind);
      if (proofDigest(current) !== proofDigest(account)) fail();
      const proposal = { binding, bindingDigest, recordedAt: now(), attemptId: randomUUID(),
        stage: account.disabled ? 'observed-disabled' : 'attempted' };
      const authorize = async (tx) => {
        await assertOriginalAuthority(db, tx, boundary, currentAccounts);
        const snapshot = await tx.get(ref);
        await assertPrivateWorkIdle(tx, work.proof);
        work.assertFresh();
        assertFreshSample(sampledAt, sampledMonotonic, now);
        return snapshot;
      };
      try {
        await db.runTransaction(async (tx) => {
          if ((await authorize(tx)).exists) fail();
          tx.create(ref, proposal);
        }, { maxAttempts: 1 });
      } catch {
        // Only this callback knows the freshly generated attempt ID. Exact
        // readback permits its first POST after a Firestore ACK loss.
        await db.runTransaction(async (tx) => {
          const snapshot = await authorize(tx);
          if (readJournal(snapshot)?.dataDigest !== proofDigest(proposal)) fail();
        }, { readOnly: true });
      }
      work.assertFresh();
      assertFreshSample(sampledAt, sampledMonotonic, now);
    };
    if (account.disabled) {
      await recordAttempt();
    } else {
      try {
        await api(url, 'POST', {}, recordAttempt);
      } catch {
        // Reconcile by readback only. A still-enabled account cannot authorize
        // a second POST after the durable attempt.
      }
    }
    const journal = readJournal(await db.runTransaction((tx) => tx.get(ref), { readOnly: true }));
    const observed = (await observeAccounts()).find((item) => item.kind === kind);
    if (!journal || !observed.disabled ||
      proofDigest(observed) !== proofDigest({ ...account, disabled: true }))
      fail();
    journals.push(journal);
  }
  return journals;
}

// Internal transaction boundary. The command must supply its own authenticated
// API, native observers and CI verification, never descriptor-provided proofs.
export async function transferStagingMediaSuccessor({
  db, api, successor, resourceBinding, verifyCandidate, observeWorkExclusion, assertPrivateWorkIdle, now = Date.now,
}) {
  if (db.projectId !== projectId || db.databaseId !== '(default)') fail();
  const boundary = await readStagingMediaSuccessorBoundary(db, successor, now);
  const candidate = await verifyCandidate();
  if (candidate?.schemaVersion !== 1 || candidate.commit !== successor.compatibilityCommit ||
    !commit.test(candidate.tree ?? '') ||
    resourceBinding?.workerBuildId !== candidate.commit || resourceBinding.workerImage !== candidate.image ||
    !/^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(candidate.image ?? ''))
    fail();

  const plan = boundary.original.operation.cloudPoolPreparation.plan;
  const before = await sampleWorkExclusion(observeWorkExclusion, boundary, now);
  const iamJournals = await fenceStagingPredecessorAccounts({
    db, api, boundary, successor, candidate, observeWorkExclusion, assertPrivateWorkIdle, now, resourceBinding,
  });
  const work = await sampleWorkExclusion(observeWorkExclusion, boundary, now, before);
  const sampleStartedAt = now();
  const sampleStartedMonotonic = performance.now();
  const [accounts, pool] = await Promise.all([
    observeStagingPredecessorAccounts(db, api, plan),
    observeStagingPredecessorPool({ plan, api }),
  ]);
  return commitStagingMediaSuccessor({
    db, boundary, successor, candidate, resourceBinding, accounts, pool, workExclusion: work.proof,
    assertPrivateWorkIdle, iamJournals, assertWorkExclusionFresh: work.assertFresh,
    sampleStartedAt, sampleStartedMonotonic, now,
  });
}

// Called only after the source-owned observers have bound the exact identities.
export async function commitStagingMediaSuccessor({
  db, boundary, successor, candidate, resourceBinding, accounts, pool, workExclusion, assertPrivateWorkIdle,
  sampleStartedAt, sampleStartedMonotonic, now = Date.now, iamJournals, assertWorkExclusionFresh,
}) {
  const names = boundary.transition.oldNames;
  if (db.projectId !== projectId || db.databaseId !== '(default)' ||
    candidate?.commit !== successor.compatibilityCommit || resourceBinding?.projectId !== projectId ||
    resourceBinding.workerBuildId !== candidate.commit || resourceBinding.workerImage !== candidate.image ||
    iamJournals?.length !== 2 || typeof assertWorkExclusionFresh !== 'function' ||
    accounts?.length !== 2 ||
    new Set(accounts.map(account => account.uniqueId)).size !== 2 ||
    !accounts.every(({ kind, email, disabled, receiptId }) =>
      Object.hasOwn(identityReceiptIds, kind) && receiptId === identityReceiptIds[kind] &&
      email === (kind === 'runner' ? names.runnerServiceAccount : names.invokerServiceAccount) && disabled === true) ||
    new Set(accounts.map(account => account.kind)).size !== 2 ||
    pool?.createDisposition !== 'unknown' || !['absent', 'matching-manual-zero'].includes(pool.state) ||
    pool.name !== boundary.original.operation.cloudPoolPreparation.plan.body.name)
    fail();
  const observedAt = now();
  const transition = planStagingMediaSuccessor({ ...boundary.original, successor }, observedAt);
  const record = {
    schemaVersion: 1, projectId, predecessorReleaseId, predecessorOperationId,
    original: boundary.original, originalAuthority: boundary.authority,
    createDisposition: 'unknown', accounts, pool, workExclusion,
    iamJournals,
    successor: { releaseId: successor.releaseId, controlRevision: transition.control.revision, candidate, resourceBinding,
      reviewDigest: proofDigest(successor) },
    observedAt,
  };
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > 700_000) fail();
  const expectedArchiveDigest = proofDigest(record);
  transition.state.stagingMediaSupersessionArchiveDigest = expectedArchiveDigest;
  try {
    await db.runTransaction(async (tx) => {
      const documents = await assertOriginalAuthority(db, tx, boundary, accounts);
      const snapshots = await tx.getAll(...['runner', 'scaler'].map(kind => db.doc(iamAttemptPath(kind))));
      snapshots.forEach((snapshot, index) => assertNativeSnapshot(iamJournals[index], snapshot));
      await assertPrivateWorkIdle(tx, workExclusion);
      assertWorkExclusionFresh();
      assertFreshSample(sampleStartedAt, sampleStartedMonotonic, now);
      tx.create(db.doc(predecessorPaths.archive), record);
      tx.set(db.doc(predecessorPaths.control), transition.control);
      tx.set(db.doc(predecessorPaths.state), transition.state);
      tx.delete(db.doc(predecessorPaths.operation), { lastUpdateTime: documents.operation.updateTime });
    }, { maxAttempts: 1 });
  } catch {
    // An unacknowledged transaction may be confirmed only by exact native
    // readback of this archive and its paired successor documents.
  }
  return db.runTransaction(async (tx) => {
    const documents = await readBoundaryDocuments(db, tx);
    if (documents.operation.exists !== false || documents.success.exists !== false ||
      documents.noSend.exists !== false || !documents.archive.exists)
      fail();
    assertNativeSnapshot(boundary.authority.providerUsage, documents.providerUsage);
    const control = assertNativeSnapshotSuccessor(boundary.authority.control, proofDigest(transition.control), documents.control);
    const state = assertNativeSnapshotSuccessor(boundary.authority.state, proofDigest(transition.state), documents.state);
    const archive = nativeSnapshotProof(documents.archive);
    if (archive.dataDigest !== expectedArchiveDigest ||
      proofDigest(archive.createTime) !== proofDigest(archive.updateTime) ||
      proofDigest(archive.createTime) !== proofDigest(control.updateTime) ||
      proofDigest(archive.createTime) !== proofDigest(state.updateTime))
      fail();
    return { phase: transition.state.phase, revision: transition.control.revision,
      releaseId: successor.releaseId, archivePath: predecessorPaths.archive };
  }, { readOnly: true });
}

export async function assertStagingMediaSuccessorLineage(db, state, config, reader, resourceBinding) {
  const path = state.stagingMediaSupersessionArchive;
  const digest = state.stagingMediaSupersessionArchiveDigest;
  if (path === undefined && digest === undefined) return;
  if (db.projectId !== projectId || db.databaseId !== '(default)' ||
    config.projectId !== projectId || config.environment !== 'staging' ||
    path !== predecessorPaths.archive || !/^[a-f0-9]{64}$/.test(digest ?? ''))
    fail();
  const [archive, providerUsage] = await reader.getAll(db.doc(path), db.doc(predecessorPaths.providerUsage));
  if (!archive.exists || !providerUsage.exists) fail();
  const proof = nativeSnapshotProof(archive);
  const record = archive.data();
  if (proof.dataDigest !== digest || proofDigest(proof.createTime) !== proofDigest(proof.updateTime) ||
    record.schemaVersion !== 1 || record.projectId !== projectId ||
    record.predecessorReleaseId !== predecessorReleaseId || record.predecessorOperationId !== predecessorOperationId ||
    record.createDisposition !== 'unknown' ||
    record.successor?.releaseId !== config.releaseId || record.successor.releaseId !== state.releaseId ||
    record.successor.candidate?.commit !== config.compatibilityCommit ||
    resourceBinding?.workerBuildId !== config.compatibilityCommit ||
    resourceBinding.workerImage !== record.successor.candidate.image ||
    proofDigest(record.successor.resourceBinding) !== proofDigest(resourceBinding) ||
    record.successor.reviewDigest !== proofDigest(config))
    fail();
  assertNativeSnapshot(record.originalAuthority.providerUsage, providerUsage);
  return record;
}

export async function verifyStagingMediaPredecessorStillIsolated(db, api, record) {
  if (!record) return;
  const plan = record.original.operation.cloudPoolPreparation.plan;
  const [accounts] = await Promise.all([
    observeStagingPredecessorAccounts(db, api, plan),
    observeStagingPredecessorPool({ plan, api }),
  ]);
  if (proofDigest(accounts) !== proofDigest(record.accounts)) fail();
}

// Recover acknowledgement after a process exit while the successor is still
// at the transferred checkpoint. Later phases use the normal lineage guard.
export async function observeStagingMediaSuccessorTransfer(db, successor, resourceBinding) {
  return db.runTransaction(async (tx) => {
    const docs = await readBoundaryDocuments(db, tx);
    if (!docs.archive.exists || !docs.state.exists || !docs.control.exists ||
      ['operation', 'success', 'noSend'].some(name => docs[name].exists !== false))
      fail();
    const state = docs.state.data();
    const archive = docs.archive.data();
    const transferTime = proofDigest(nativeSnapshotProof(docs.archive).createTime);
    if (state.phase !== 'ui-frozen' || state.controlRevision !== revision + 1 ||
      proofDigest(nativeSnapshotProof(docs.state).updateTime) !== transferTime ||
      proofDigest(nativeSnapshotProof(docs.control).updateTime) !== transferTime)
      fail();
    await assertStagingMediaSuccessorLineage(db, state, successor, tx, resourceBinding);
    const transition = planStagingMediaSuccessor({ ...archive.original, successor }, archive.observedAt);
    transition.state.stagingMediaSupersessionArchiveDigest = state.stagingMediaSupersessionArchiveDigest;
    if (proofDigest(transition.state) !== proofDigest(state) ||
      proofDigest(transition.control) !== proofDigest(docs.control.data()))
      fail();
    return { phase: state.phase, revision: state.controlRevision, releaseId: state.releaseId,
      archivePath: predecessorPaths.archive };
  }, { readOnly: true });
}
