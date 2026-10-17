/** Ordinary owned maintenance lifecycle component. No CLI, credentials, stage writes or guard extension. */
import { proofDigest, nativeSnapshotProof, assertNativeSnapshot } from './temporal-release-runtime.mjs';
import {
  assertOwnedSmokeAuthority,
  assertOwnedSmokeOperation,
  OWNED_SMOKE_ACTION,
} from './temporal-owned-smoke-index-stage.mjs';
import { OWNED_SMOKE_INCIDENT as incident } from './temporal-owned-smoke-plan.mjs';
const paths = ['_control/temporalRelease', '_control/temporalReleaseState', '_control/temporalReleaseOperation'];
const same = (a, b) => proofDigest(a) === proofDigest(b);
const need = (ok, code) => {
  if (!ok) throw Object.assign(new Error(`OWNED_SMOKE_${code}`), { code: `OWNED_SMOKE_${code}` });
};
const auditPath = (id) => `_control/temporalOwnedSmoke-${id}-complete`;
const uuid = (id) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id ?? '');
const exactKeys = (value, keys) =>
  value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort());
function nativeProof(value) {
  need(
    exactKeys(value, ['createTime', 'dataDigest', 'updateTime']) && /^[a-f0-9]{64}$/.test(value.dataDigest ?? ''),
    'SAFE_NATIVE_PROOF_REQUIRED'
  );
  for (const stamp of [value.createTime, value.updateTime])
    need(
      exactKeys(stamp, ['nanoseconds', 'seconds']) &&
        Number.isSafeInteger(stamp.seconds) &&
        Number.isInteger(stamp.nanoseconds) &&
        stamp.nanoseconds >= 0 &&
        stamp.nanoseconds < 1e9,
      'SAFE_NATIVE_PROOF_REQUIRED'
    );
}
function identity(release, manifest, operationId, evidence, manifestSHA256) {
  need(
    uuid(operationId) &&
      /^[a-f0-9]{64}$/.test(manifestSHA256 ?? '') &&
      exactKeys(evidence, [
        'descriptorSHA256',
        'operatorCommit',
        'operatorClosureDigest',
        'runtimeCommit',
        'runtimeTree',
        'resourceIdentityDigest',
        'principalDigest',
      ]) &&
      ['descriptorSHA256', 'operatorClosureDigest', 'resourceIdentityDigest', 'principalDigest'].every((key) =>
        /^[a-f0-9]{64}$/.test(evidence[key] ?? '')
      ) &&
      /^[a-f0-9]{40}$/.test(evidence.operatorCommit ?? '') &&
      evidence.runtimeCommit === incident.runtimeCommit &&
      evidence.runtimeTree === incident.runtimeTree &&
      evidence.descriptorSHA256 === manifest.descriptorSHA256,
    'SAFE_OPERATION_IDENTITY_REQUIRED'
  );
  need(exactKeys(manifest.authority, ['control', 'state']), 'SAFE_NATIVE_PROOF_REQUIRED');
  nativeProof(manifest.authority.control);
  nativeProof(manifest.authority.state);
  return {
    schemaVersion: 1,
    operationId,
    action: OWNED_SMOKE_ACTION,
    releaseId: release.releaseId,
    manifestDigest: proofDigest(manifest),
    manifestSHA256,
    authority: structuredClone(manifest.authority),
    evidence: structuredClone(evidence),
  };
}
async function authority(tx, db, release, manifest) {
  const [control, state, lock] = await Promise.all(paths.map((path) => tx.get(db.doc(path))));
  assertOwnedSmokeAuthority(control.data(), state.data(), release, manifest.revision);
  assertNativeSnapshot(manifest.authority.control, control);
  assertNativeSnapshot(manifest.authority.state, state);
  return lock;
}
const requiredReaders = (...readers) =>
  need(
    readers.every((r) => typeof r === 'function'),
    'COMPLETE_MAINTENANCE_READERS_REQUIRED'
  );
function assertOperationData(data, expected) {
  need(
    data &&
      Object.keys(data).sort().join('|') === [...Object.keys(expected), 'createdAtMillis'].sort().join('|') &&
      Object.entries(expected).every(([key, value]) => same(data[key], value)) &&
      Number.isSafeInteger(data.createdAtMillis) &&
      data.createdAtMillis > 0,
    'OPERATION_IDENTITY_CHANGED'
  );
}

/** Unknown acquisition ACK propagates. Only explicit same-identity resume may inspect an owned lock. */
export async function acquireOwnedSmokeOperation({
  db,
  release,
  manifest,
  operationId,
  manifestSHA256,
  evidence,
  validateManifest,
  assertSourceAndInventories,
  assertProtectedState,
  resume = false,
  now = Date.now,
}) {
  requiredReaders(validateManifest, assertSourceAndInventories, assertProtectedState);
  await validateManifest(manifest);
  await assertSourceAndInventories();
  const expected = identity(release, manifest, operationId, evidence, manifestSHA256);
  let operationData;
  await db.runTransaction(async (tx) => {
    const lock = await authority(tx, db, release, manifest);
    const [completed, index, email] = await Promise.all([
      tx.get(db.doc(auditPath(operationId))),
      tx.get(db.doc(`_control/temporalOwnedSmoke-${operationId}-index`)),
      tx.get(db.doc(`_control/temporalOwnedSmoke-${operationId}-email`)),
    ]);
    await assertProtectedState(tx);
    need(!completed.exists, 'OPERATION_ALREADY_COMPLETED');
    if (resume) {
      need(lock.exists, 'OWNED_OPERATION_MISSING');
      assertOperationData(lock.data(), expected);
      operationData = lock.data();
    } else {
      need(!lock.exists && !index.exists && !email.exists, 'OPERATION_HELD_OR_STAGE_EXISTS');
      operationData = { ...expected, createdAtMillis: now() };
      assertOperationData(operationData, expected);
      tx.create(db.doc(paths[2]), operationData);
    }
  });
  const acquired = await db.doc(paths[2]).get();
  need(acquired.exists && same(acquired.data(), operationData), 'OPERATION_ACQUISITION_CHANGED');
  const operation = {
    operationId,
    manifestSHA256,
    evidence: structuredClone(expected.evidence),
    native: nativeSnapshotProof(acquired),
  };
  // Verify complete owned identity and native preservation after acquisition; failures retain owner.
  await assertSourceAndInventories();
  await db.runTransaction(async (tx) => {
    await assertOwnedSmokeOperation(tx, db, release, manifest, operation);
    await assertProtectedState(tx);
  });
  return operation;
}

function assertFinalProof(proof) {
  const keys = [
    'indexAuditNative',
    'emailAuditNative',
    'publicEmailNative',
    'inventoryDigest',
    'protectedDigest',
    'nativeEmailHistoryDigest',
  ];
  need(
    proof &&
      same(Object.keys(proof).sort(), keys.sort()) &&
      ['inventoryDigest', 'protectedDigest', 'nativeEmailHistoryDigest'].every((k) =>
        /^[a-f0-9]{64}$/.test(proof[k] ?? '')
      ),
    'FINAL_PROOF_REQUIRED'
  );
  for (const key of ['indexAuditNative', 'emailAuditNative', 'publicEmailNative']) {
    nativeProof(proof[key]);
  }
}

/**
 * Completion audit and owned operation release commit together, only after actual stage poststate
 * verification supplied by a pinned complete collector. This component never unlocks in finally.
 * An explicit resume of a lost final ACK verifies the same audit/poststate with no acquisition.
 */
export async function finishOwnedSmokeOperation({
  db,
  release,
  manifest,
  operation,
  validateManifest,
  assertSourceAndInventories,
  assertProtectedState,
  describeOriginalEmail,
  verifyFinalState,
  resume = false,
  now = Date.now,
}) {
  requiredReaders(
    validateManifest,
    assertSourceAndInventories,
    assertProtectedState,
    describeOriginalEmail,
    verifyFinalState
  );
  await validateManifest(manifest);
  await assertSourceAndInventories();
  need(same(await describeOriginalEmail(), manifest.emailPlan.native), 'EMAIL_NATIVE_CHANGED');
  const expected = identity(release, manifest, operation.operationId, operation.evidence, operation.manifestSHA256);
  const ref = db.doc(auditPath(operation.operationId));
  let committed;
  await db.runTransaction(async (tx) => {
    const lock = await authority(tx, db, release, manifest);
    const audit = await tx.get(ref);
    await assertProtectedState(tx);
    if (audit.exists) {
      need(resume && !lock.exists, 'COMPLETION_AUDIT_CONFLICT');
      committed = audit.data();
      need(
        Object.keys(committed).sort().join('|') ===
          [...Object.keys(expected), 'finalProof', 'completedAtMillis'].sort().join('|') &&
          Object.entries(expected).every(([key, value]) => same(committed[key], value)) &&
          Number.isSafeInteger(committed.completedAtMillis),
        'COMPLETION_AUDIT_CONFLICT'
      );
      assertFinalProof(committed.finalProof);
      need(
        committed.finalProof.nativeEmailHistoryDigest === manifest.emailPlan.native.historyDigest,
        'FINAL_NATIVE_HISTORY_CHANGED'
      );
      need(same(await verifyFinalState(tx), committed.finalProof), 'FINAL_POSTSTATE_CHANGED');
      return;
    }
    await assertOwnedSmokeOperation(tx, db, release, manifest, operation);
    assertOperationData(lock.data(), expected);
    const finalProof = await verifyFinalState(tx);
    assertFinalProof(finalProof);
    need(
      finalProof.nativeEmailHistoryDigest === manifest.emailPlan.native.historyDigest,
      'FINAL_NATIVE_HISTORY_CHANGED'
    );
    committed = { ...expected, finalProof, completedAtMillis: now() };
    need(
      Number.isSafeInteger(committed.completedAtMillis) && committed.completedAtMillis > 0,
      'COMPLETION_CLOCK_INVALID'
    );
    tx.create(ref, committed);
    tx.delete(db.doc(paths[2]));
  });
  // A failure after a known or unknown completion never acquires a replacement operation.
  need(same(await describeOriginalEmail(), manifest.emailPlan.native), 'EMAIL_NATIVE_CHANGED');
  await assertSourceAndInventories();
  let auditNative;
  await db.runTransaction(async (tx) => {
    const lock = await authority(tx, db, release, manifest);
    const audit = await tx.get(ref);
    need(!lock.exists && audit.exists && same(audit.data(), committed), 'COMPLETION_POSTSTATE_CHANGED');
    await assertProtectedState(tx);
    need(same(await verifyFinalState(tx), committed.finalProof), 'FINAL_POSTSTATE_CHANGED');
    auditNative = nativeSnapshotProof(audit);
  });
  return {
    operationId: operation.operationId,
    auditPath: ref.path,
    auditNative,
    completed: true,
    originalNativeEmailStatus: 'FAILED',
    noProviderRequests: true,
  };
}
