/**
 * Inactive maintenance stage: no CLI/ADC/transport initialization, ownership acquisition or unlock.
 * A future reviewed CLI must supply pinned runtime readers and ordinary owned-operation proofs.
 * No caller may treat this stage alone as an executable incident recovery.
 */
import { createHash } from 'node:crypto';
import { validateControl, RELEASE_DOMAINS } from './temporal-release-lib.mjs';
import { assertNativeSnapshot, nativeSnapshotProof, proofDigest, canonical } from './temporal-release-runtime.mjs';
import { OWNED_SMOKE_INCIDENT as incident, ownedMirrorPaths } from './temporal-owned-smoke-plan.mjs';

export const OWNED_SMOKE_ACTION = 'reconcile-owned-staging-smoke';
const CONTROL = '_control/temporalRelease',
  STATE = '_control/temporalReleaseState';
const OPERATION = '_control/temporalReleaseOperation';
const same = (a, b) => proofDigest(a) === proofDigest(b);
const key = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need = (condition, code) => {
  if (!condition) throw Object.assign(new Error(`OWNED_SMOKE_${code}`), { code: `OWNED_SMOKE_${code}` });
};
const sha = (v) => /^[a-f0-9]{64}$/.test(v ?? '');
const uuid = (v) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v ?? '');

export function assertOwnedSmokeAuthority(control, state, release, revision) {
  validateControl(control);
  need(
    release?.environment === 'staging' &&
      release.projectId === incident.projectId &&
      release.mode === 'durable-upgrade' &&
      release.compatibilityCommit === incident.runtimeCommit &&
      release.uiCommit === incident.runtimeCommit &&
      uuid(release.releaseId) &&
      release.releaseId !== '09e0d630-f119-4da4-8f20-3db27ff08d17' &&
      same([...(release.domains ?? [])].sort(), ['emails', 'publishing', 'search']),
    'NEW_FIXED_DURABLE_RELEASE_REQUIRED'
  );
  need(
    Number.isSafeInteger(revision) &&
      revision > 48 &&
      control.revision === revision &&
      control.releaseId === release.releaseId &&
      control.admission === 'paused' &&
      RELEASE_DOMAINS.every((domain) => control.domains[domain]?.owner === 'temporal') &&
      release.domains.every((domain) => control.domains[domain]?.admission === 'paused') &&
      state?.releaseId === release.releaseId &&
      state.controlRevision === revision &&
      state.phase === 'ownership-changed' &&
      state.mode === release.mode &&
      state.compatibilityCommit === release.compatibilityCommit &&
      state.uiCommit === release.uiCommit &&
      same(state.domains, release.domains),
    'OWNERSHIP_CHANGED_AUTHORITY_REQUIRED'
  );
}

export function validateOwnedIndexPlan(plan) {
  need(
    plan?.schemaVersion === 1 &&
      plan.incidentDigest === proofDigest(incident) &&
      plan.edgeCreates === 6 &&
      plan.countUpdates === 2 &&
      plan.providerWrites === 0 &&
      plan.canonicalWrites === 0 &&
      sha(plan.markerNative?.dataDigest) &&
      Array.isArray(plan.aggregates) &&
      plan.aggregates.length === 2,
    'INDEX_PLAN_INVALID'
  );
  for (let i = 0; i < 2; i++) {
    const resource = incident.resources[i],
      group = plan.aggregates[i];
    const path = `temporalProviderUsage/${key([
      resource.projectId,
      resource.provider,
      resource.account,
      resource.remoteId,
    ])}/epochs/${incident.originalEpoch}`;
    const creates = ownedMirrorPaths().map((canonicalPath) => ({
      path: `${path}/edges/${key(canonicalPath)}`,
      data: { canonicalPath, projectId: incident.projectId },
    }));
    need(
      group?.aggregatePath === path &&
        Number.isSafeInteger(group.beforeCount) &&
        group.beforeCount >= 0 &&
        group.beforeCount <= 200 &&
        group.afterCount === group.beforeCount + 3 &&
        sha(group.aggregateNative?.dataDigest) &&
        sha(group.aggregateAfterDataDigest) &&
        same(group.creates, creates) &&
        Array.isArray(group.existingEdges) &&
        group.existingEdges.length === group.beforeCount &&
        new Set(group.existingEdges.map((row) => row.path)).size === group.beforeCount &&
        group.existingEdges.every(
          (row) =>
            row.path.startsWith(path + '/edges/') &&
            /^[a-f0-9]{64}$/.test(row.path.slice((path + '/edges/').length)) &&
            sha(row.native?.dataDigest)
        ) &&
        !group.existingEdges.some((row) => creates.some((create) => create.path === row.path)) &&
        Array.isArray(group.canonicals) &&
        group.canonicals.length === group.beforeCount + 3 &&
        new Set(group.canonicals.map((row) => row.path)).size === group.canonicals.length &&
        group.canonicals.every((row) => typeof row.path === 'string' && sha(row.native?.dataDigest)) &&
        ownedMirrorPaths().every((target) => group.canonicals.some((row) => row.path === target)),
      'FINITE_INDEX_SCOPE_CHANGED'
    );
  }
  return plan;
}

/** Transaction-bound ownership, including native full-document pins; no phase extension or CAS. */
export async function assertOwnedSmokeOperation(tx, db, release, manifest, operation) {
  need(
    manifest?.schemaVersion === 1 &&
      manifest.incidentDigest === proofDigest(incident) &&
      manifest.runtimeCommit === incident.runtimeCommit &&
      manifest.releaseId === release.releaseId &&
      sha(manifest.descriptorSHA256) &&
      uuid(operation?.operationId) &&
      manifest.authority?.control &&
      manifest.authority?.state &&
      operation.native &&
      Array.isArray(manifest.protectedDocuments),
    'OPERATION_BINDING_REQUIRED'
  );
  const [control, state, lock] = await Promise.all([CONTROL, STATE, OPERATION].map((path) => tx.get(db.doc(path))));
  assertOwnedSmokeAuthority(control.data(), state.data(), release, manifest.revision);
  assertNativeSnapshot(manifest.authority.control, control);
  assertNativeSnapshot(manifest.authority.state, state);
  assertNativeSnapshot(operation.native, lock);
  const value = lock.data();
  need(
    value?.schemaVersion === 1 &&
      value.operationId === operation.operationId &&
      value.action === OWNED_SMOKE_ACTION &&
      value.releaseId === release.releaseId &&
      value.manifestDigest === proofDigest(manifest) &&
      same(value.authority, manifest.authority) &&
      same(value.evidence, operation.evidence),
    'OWNED_OPERATION_CHANGED'
  );
  const seen = new Set();
  for (const row of manifest.protectedDocuments) {
    need(
      typeof row.path === 'string' && !seen.has(row.path) && ![CONTROL, STATE, OPERATION].includes(row.path),
      'PROTECTED_SET_INVALID'
    );
    seen.add(row.path);
    const snapshot = await tx.get(db.doc(row.path));
    if (row.exists === false) need(!snapshot.exists, 'PROTECTED_ABSENCE_CHANGED');
    else assertNativeSnapshot(row.native, snapshot);
  }
  return value;
}

/** Verify every old edge and canonical native stamp, exact new edge bytes and atomic commit stamps. */
export async function assertOwnedIndexPoststate(tx, db, plan, audit) {
  validateOwnedIndexPlan(plan);
  const marker = await tx.get(db.doc('_control/temporalProviderUsage'));
  assertNativeSnapshot(plan.markerNative, marker);
  for (const group of plan.aggregates) {
    const aggregate = await tx.get(db.doc(group.aggregatePath));
    need(
      aggregate.exists &&
        proofDigest(aggregate.data()) === group.aggregateAfterDataDigest &&
        same(canonical(aggregate.updateTime), canonical(audit.updateTime)),
      'INDEX_POSTSTATE_CHANGED'
    );
    const edges = await tx.get(db.collection(group.aggregatePath + '/edges').limit(204));
    need(edges.size === group.afterCount, 'INDEX_POSTSTATE_CHANGED');
    const old = new Map(group.existingEdges.map((row) => [row.path, row]));
    const created = new Map(group.creates.map((row) => [row.path, row]));
    const seen = new Set();
    for (const snapshot of edges.docs) {
      need(!seen.has(snapshot.ref.path), 'INDEX_POSTSTATE_CHANGED');
      seen.add(snapshot.ref.path);
      if (old.has(snapshot.ref.path)) assertNativeSnapshot(old.get(snapshot.ref.path).native, snapshot);
      else {
        const expected = created.get(snapshot.ref.path);
        need(
          expected &&
            same(snapshot.data(), expected.data) &&
            same(canonical(snapshot.createTime), canonical(audit.createTime)) &&
            same(canonical(snapshot.updateTime), canonical(audit.updateTime)),
          'INDEX_POSTSTATE_CHANGED'
        );
      }
    }
    need(
      [...old.keys(), ...created.keys()].every((path) => seen.has(path)),
      'INDEX_POSTSTATE_CHANGED'
    );
    for (const row of group.canonicals) assertNativeSnapshot(row.native, await tx.get(db.doc(row.path)));
  }
}

/**
 * One atomic stage only; ordinary operation remains owned afterward. An unknown ACK is allowed
 * to escape and MUST NOT trigger unlock or re-issuance. Resume proves the immutable audit/poststate.
 * The future CLI owns the trusted, source-pinned collector and full inventory/provenance checks.
 */
export async function applyOwnedIndexStage({
  db,
  release,
  manifest,
  operation,
  collectIndexPlan,
  assertSourceAndInventories,
  resume = false,
  now = Date.now,
}) {
  validateOwnedIndexPlan(manifest?.indexPlan);
  need(
    typeof collectIndexPlan === 'function' && typeof assertSourceAndInventories === 'function',
    'TRUSTED_READERS_REQUIRED'
  );
  await assertSourceAndInventories();
  const auditRef = db.doc(`_control/temporalOwnedSmoke-${operation.operationId}-index`);
  const expected = {
    schemaVersion: 1,
    stage: 'index',
    operationId: operation.operationId,
    releaseId: release.releaseId,
    manifestDigest: proofDigest(manifest),
    planDigest: proofDigest(manifest.indexPlan),
    edgeCreates: 6,
    countUpdates: 2,
    providerWrites: 0,
    canonicalWrites: 0,
  };
  await db.runTransaction(async (tx) => {
    await assertOwnedSmokeOperation(tx, db, release, manifest, operation);
    const prior = await tx.get(auditRef);
    if (prior.exists) {
      need(
        resume && Object.entries(expected).every(([key, value]) => same(prior.get(key), value)),
        'INDEX_AUDIT_CONFLICT'
      );
      await assertOwnedIndexPoststate(tx, db, manifest.indexPlan, prior);
      return;
    }
    const actual = await collectIndexPlan(tx);
    need(same(actual, manifest.indexPlan), 'INDEX_PRESTATE_CHANGED');
    for (const group of actual.aggregates) {
      for (const create of group.creates) tx.create(db.doc(create.path), create.data);
      tx.update(db.doc(group.aggregatePath), { referenceCount: group.afterCount });
    }
    tx.create(auditRef, { ...expected, recordedAtMillis: now() });
  });
  await assertSourceAndInventories();
  let auditNative;
  await db.runTransaction(async (tx) => {
    await assertOwnedSmokeOperation(tx, db, release, manifest, operation);
    const audit = await tx.get(auditRef);
    need(
      audit.exists && Object.entries(expected).every(([key, value]) => same(audit.get(key), value)),
      'INDEX_AUDIT_CONFLICT'
    );
    await assertOwnedIndexPoststate(tx, db, manifest.indexPlan, audit);
    auditNative = nativeSnapshotProof(audit);
  });
  return { stage: 'index', auditPath: auditRef.path, auditNative, ...expected, operationRetained: true };
}
