/** Inactive component only: a reviewed CLI must provide ownership, pinned readers and the real store. */
import { createHash } from 'node:crypto';
import { proofDigest, nativeSnapshotProof, assertNativeSnapshot, canonical } from './temporal-release-runtime.mjs';
import { OWNED_SMOKE_INCIDENT as incident, capturedEmailProjection } from './temporal-owned-smoke-plan.mjs';
import { assertOwnedSmokeOperation } from './temporal-owned-smoke-index-stage.mjs';

const same = (a, b) => proofDigest(a) === proofDigest(b);
const need = (ok, code) => {
  if (!ok) throw Object.assign(new Error(`OWNED_SMOKE_${code}`), { code: `OWNED_SMOKE_${code}` });
};
const jobPath = `durableJobs/${incident.emailJobId}`;
const intentPath = `durableJobIntents/${incident.emailJobId}`;
const criticalPath = `durableJobCriticalSections/${incident.emailJobId}`;
const entityPath = `durableJobEntities/${createHash('sha256')
  .update(JSON.stringify([incident.projectId, 'mail', `mail/${incident.mailId}`, 'email']))
  .digest('hex')}`;
const storeReads = new Set([jobPath, intentPath, criticalPath, entityPath]);
const keysExactly = (value, keys) =>
  value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort());
function assertSafeEmailProofs(jobNative, native, acceptedCapture) {
  const stamp = (value) =>
    keysExactly(value, ['seconds', 'nanoseconds']) &&
    Number.isSafeInteger(value.seconds) &&
    Number.isInteger(value.nanoseconds) &&
    value.nanoseconds >= 0 &&
    value.nanoseconds < 1e9;
  need(
    keysExactly(jobNative, ['dataDigest', 'createTime', 'updateTime']) &&
      /^[a-f0-9]{64}$/.test(jobNative.dataDigest ?? '') &&
      stamp(jobNative.createTime) &&
      stamp(jobNative.updateTime),
    'EMAIL_PRIVATE_PROOF_REJECTED'
  );
  need(
    keysExactly(native, [
      'workflowId',
      'runId',
      'latestRunId',
      'status',
      'failureType',
      'pendingActivities',
      'terminalEventType',
      'historyDigest',
    ]) &&
      keysExactly(acceptedCapture, [
        'mailId',
        'mailState',
        'receiptAccepted',
        'captureId',
        'payloadSha256',
        'payloadHashMatches',
        'externalDelivery',
        'profileId',
        'profileVersion',
        'projectId',
      ]),
    'EMAIL_PRIVATE_PROOF_REJECTED'
  );
}

/** Public facts only. The private capture/receipt/intent provenance reader is a separate boundary. */
export function planOwnedEmailProjection({ job, native, acceptedCapture }) {
  need(job?.path === jobPath && job.native?.dataDigest === proofDigest(job.data), 'EMAIL_SNAPSHOT_REQUIRED');
  assertSafeEmailProofs(job.native, native, acceptedCapture);
  return {
    schemaVersion: 1,
    jobNative: structuredClone(job.native),
    patch: capturedEmailProjection({ job: job.data, native, acceptedCapture }),
    native: structuredClone(native),
    acceptedCapture: structuredClone(acceptedCapture),
  };
}

function expectedJob(before, patch, time) {
  const { expectedRevision, ...values } = patch;
  return {
    ...before,
    ...values,
    revision: before.revision + 1,
    updatedAt: time,
    finishedAt: before.finishedAt ?? time,
  };
}

async function verifyPoststate(tx, db, audit, expected) {
  need(audit.exists, 'EMAIL_AUDIT_REQUIRED');
  const data = audit.data();
  need(
    Object.entries(expected).every(([key, value]) => same(data[key], value)),
    'EMAIL_AUDIT_CONFLICT'
  );
  need(
    Object.keys(data).sort().join('|') ===
      [...Object.keys(expected), 'jobAfterDigest', 'recordedAtMillis'].sort().join('|') &&
      /^[a-f0-9]{64}$/.test(data.jobAfterDigest ?? '') &&
      Number.isSafeInteger(data.recordedAtMillis),
    'EMAIL_AUDIT_CONFLICT'
  );
  const job = await tx.get(db.doc(jobPath));
  need(
    job.exists &&
      proofDigest(job.data()) === data.jobAfterDigest &&
      same(canonical(job.updateTime), canonical(audit.updateTime)),
    'EMAIL_POSTSTATE_CHANGED'
  );
  return nativeSnapshotProof(job);
}

/**
 * Project through the actual fixed store in one owned transaction. The adapter allows exactly one
 * public job set and no other store writes. The store callback cannot commit independently. An
 * unknown ACK escapes with ownership retained; resume reads the atomic audit and exact poststate.
 * No CLI, credentials, operation acquisition/release, workflow or mail transport is provided here.
 */
export async function applyOwnedEmailStage({
  db,
  release,
  manifest,
  operation,
  createStore,
  collectEmailPlan,
  assertSourceAndInventories,
  describeOriginalEmail,
  resume = false,
  now = Date.now,
}) {
  need(
    [createStore, collectEmailPlan, assertSourceAndInventories, describeOriginalEmail].every(
      (fn) => typeof fn === 'function'
    ),
    'TRUSTED_EMAIL_READERS_REQUIRED'
  );
  const plan = manifest.emailPlan;
  need(plan?.schemaVersion === 1 && plan.patch?.expectedRevision > 0, 'EMAIL_PLAN_REQUIRED');
  need(keysExactly(plan, ['schemaVersion', 'jobNative', 'patch', 'native', 'acceptedCapture']), 'EMAIL_PLAN_REQUIRED');
  assertSafeEmailProofs(plan.jobNative, plan.native, plan.acceptedCapture);
  // Revalidate fixed identity, native failure and safe capture facts, even on audit resume.
  need(
    same(
      plan.patch,
      capturedEmailProjection({
        job: {
          projectId: incident.projectId,
          jobId: incident.emailJobId,
          kind: 'email.deliver',
          state: 'running',
          revision: plan.patch.expectedRevision,
          generation: incident.emailGeneration,
          workflowId: incident.emailWorkflowId,
          entity: { type: 'mail', id: `mail/${incident.mailId}` },
        },
        native: plan.native,
        acceptedCapture: plan.acceptedCapture,
      })
    ),
    'EMAIL_PATCH_CHANGED'
  );
  need(!manifest.protectedDocuments?.some((row) => row.path === jobPath), 'MUTABLE_EMAIL_JOB_CANNOT_BE_PROTECTED');
  await assertSourceAndInventories();
  need(same(await describeOriginalEmail(), plan.native), 'EMAIL_NATIVE_CHANGED');
  const auditRef = db.doc(`_control/temporalOwnedSmoke-${operation.operationId}-email`);
  const expected = {
    schemaVersion: 1,
    stage: 'email',
    operationId: operation.operationId,
    releaseId: release.releaseId,
    manifestDigest: proofDigest(manifest),
    planDigest: proofDigest(plan),
    originalNativeStatus: 'FAILED',
    originalRunId: incident.emailRunId,
    historyDigest: plan.native.historyDigest,
    publicJobWrites: 1,
    emailSends: 0,
    providerWrites: 0,
  };
  await db.runTransaction(async (tx) => {
    await assertOwnedSmokeOperation(tx, db, release, manifest, operation);
    const audit = await tx.get(auditRef);
    if (audit.exists) {
      need(resume, 'EMAIL_AUDIT_CONFLICT');
      await verifyPoststate(tx, db, audit, expected);
      return;
    }
    need(same(await collectEmailPlan(tx), plan), 'EMAIL_PRESTATE_CHANGED');
    const before = await tx.get(db.doc(jobPath));
    assertNativeSnapshot(plan.jobNative, before);
    const intent = await tx.get(db.doc(intentPath));
    const critical = await tx.get(db.doc(criticalPath));
    need(intent.exists && !critical.exists, 'EMAIL_INTENT_OR_CRITICAL_CHANGED');
    // Only the real store may produce the projection; its read/write scope is still constrained.
    let pending,
      invoked = false;
    const time = now();
    need(Number.isSafeInteger(time), 'EMAIL_CLOCK_INVALID');
    const facade = {
      // Reference tokens expose no SDK transport or independent read/write methods.
      collection: (path) => ({
        doc: (id) => {
          const target = `${path}/${id}`;
          need(storeReads.has(target), 'EMAIL_STORE_REFERENCE_SCOPE');
          return Object.freeze({ path: target });
        },
      }),
      runTransaction: async (callback) => {
        need(!invoked, 'EMAIL_STORE_TRANSACTION_COUNT');
        invoked = true;
        const view = {
          get: async (ref) => {
            need(!pending && storeReads.has(ref.path), 'EMAIL_STORE_READ_SCOPE');
            const snapshot = await tx.get(db.doc(ref.path));
            // The fixed store needs document contents, not an SDK snapshot.ref/firestore escape.
            const data = snapshot.exists ? structuredClone(snapshot.data()) : undefined;
            return Object.freeze({
              exists: snapshot.exists,
              data: () => structuredClone(data),
              get: (field) => structuredClone(field.split('.').reduce((value, key) => value?.[key], data)),
            });
          },
          set: (ref, value, options) => {
            need(!pending && ref.path === jobPath && options === undefined, 'EMAIL_STORE_WRITE_SCOPE');
            pending = structuredClone(value);
            return view;
          },
        };
        return callback(view);
      },
    };
    const result = await createStore({
      firestore: facade,
      projectId: incident.projectId,
      now: () => time,
      getExecution: () => undefined,
    }).project({ projectId: incident.projectId, jobId: incident.emailJobId }, plan.patch);
    need(
      invoked && pending && same(pending, result) && same(result, expectedJob(before.data(), plan.patch, time)),
      'EMAIL_STORE_PROJECTION_CHANGED'
    );
    tx.set(db.doc(jobPath), pending);
    tx.create(auditRef, { ...expected, jobAfterDigest: proofDigest(pending), recordedAtMillis: time });
  });
  // Native failure stays FAILED; do not manufacture native success from a public projection.
  need(same(await describeOriginalEmail(), plan.native), 'EMAIL_NATIVE_CHANGED');
  await assertSourceAndInventories();
  let auditNative, jobNative;
  await db.runTransaction(async (tx) => {
    await assertOwnedSmokeOperation(tx, db, release, manifest, operation);
    const audit = await tx.get(auditRef);
    jobNative = await verifyPoststate(tx, db, audit, expected);
    auditNative = nativeSnapshotProof(audit);
  });
  return { ...expected, auditPath: auditRef.path, auditNative, jobNative, operationRetained: true };
}
