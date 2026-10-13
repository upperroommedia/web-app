#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { firebaseAdmin, CONTROL_PATH, validateControl } from './temporal-release-lib.mjs';

export function validateLeaseReview(review, lease, now = Date.now()) {
  if (!['urm-app', 'urm-app-staging'].includes(review.projectId) || lease.projectId !== review.projectId)
    throw new Error('Lease/project identity mismatch');
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(review.reviewId ?? '') ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(review.leaseId ?? '') ||
    lease.leaseId !== review.leaseId
  )
    throw new Error('Concrete review UUID and lease ID are required');
  if (
    !['completed_no_effects', 'completed_verified_effects'].includes(review.decision) ||
    typeof review.reason !== 'string' ||
    review.reason.length < 30 ||
    review.reason.length > 2000
  )
    throw new Error('Explicit audited decision and substantive reason are required');
  if (
    !Array.isArray(review.evidenceReferences) ||
    !review.evidenceReferences.length ||
    review.evidenceReferences.some((v) => typeof v !== 'string' || !/^(https:\/\/|gs:\/\/)/.test(v) || v.length > 1000)
  )
    throw new Error('Immutable provider/canonical verification evidence references are required');
  const verifiedAt = Date.parse(review.verifiedAt);
  if (
    !Number.isFinite(verifiedAt) ||
    verifiedAt > now ||
    now - verifiedAt > 3600000 ||
    review.runtimeEndedVerified !== true ||
    review.providerEffectsVerified !== true
  )
    throw new Error('Fresh verified runtime-ended and provider-effect evidence is required');
  for (const key of ['state', 'acquiredAt', 'effectsStarted', 'releaseRevision', 'heartbeatAt', 'diagnosticExpiresAt'])
    if (review.observed?.[key] !== lease[key]) throw new Error(`Lease changed since evidence: ${key}`);
  if (!['active', 'needs_attention'].includes(lease.state)) throw new Error('Only unresolved leases may be reviewed');
  if (
    lease.state === 'active' &&
    (!Number.isFinite(lease.heartbeatAt) ||
      now - lease.heartbeatAt < 300000 ||
      !Number.isFinite(lease.diagnosticExpiresAt) ||
      lease.diagnosticExpiresAt >= now)
  )
    throw new Error('A recently heartbeating/live lease cannot be administratively completed');
  return review;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/temporal-reconcile-legacy-lease.mjs --review PRIVATE_JSON [--apply]');
    return;
  }
  const file = args[args.indexOf('--review') + 1];
  if (!args.includes('--review') || !file) throw new Error('An explicit private review JSON is required');
  const review = JSON.parse(await readFile(resolve(file), 'utf8'));
  const { firestore, credential } = firebaseAdmin(review.projectId);
  const leaseRef = firestore.collection('legacyAdmissionLeases').doc(review.leaseId);
  const lease = await leaseRef.get();
  if (!lease.exists) throw new Error('Lease does not exist');
  validateLeaseReview(review, lease.data());
  if (!args.includes('--apply')) {
    console.log('Audited lease review validates; no remote changes made.');
    return;
  }
  // Introspect the SAME ADC identity used for Firestore. Never trust a supplied actor or CLI account label.
  const { access_token: token } = await credential.getAccessToken();
  let identity;
  try {
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error();
    identity = await response.json();
  } catch {
    throw new Error('Unable to verify the ADC IAM actor; no lease changed');
  }
  if (!identity.email || ![true, 'true'].includes(identity.email_verified) || Number(identity.expires_in) <= 0)
    throw new Error('ADC token does not provide a verified, unexpired IAM email identity');
  const auditRef = firestore.collection('legacyAdmissionLeaseReviews').doc(review.reviewId);
  await firestore.runTransaction(async (tx) => {
    const [current, controlDoc, audit] = await Promise.all([
      tx.get(leaseRef),
      tx.get(firestore.doc(CONTROL_PATH)),
      tx.get(auditRef),
    ]);
    if (!current.exists || audit.exists) throw new Error('Lease missing or review ID already used');
    const control = validateControl(controlDoc.data());
    if (control.admission !== 'paused' || control.domains[current.data().domain]?.admission !== 'paused')
      throw new Error('Global and lease-domain admissions must remain paused during reconciliation');
    validateLeaseReview(review, current.data());
    const completedAt = Date.now();
    const verifiedReview = {
      ...review,
      actorPrincipal: identity.email,
      completedAt,
      controlRevision: control.revision,
    };
    tx.create(auditRef, { schemaVersion: 1, ...verifiedReview, originalLease: current.data() });
    tx.update(leaseRef, {
      state: 'completed',
      completedAt,
      outcome: review.decision === 'completed_no_effects' ? 'rejected_no_effect' : 'succeeded',
      review: { reviewId: review.reviewId, actorPrincipal: identity.email, decision: review.decision, completedAt },
    });
  });
  console.log('Legacy lease reconciled with immutable audit evidence; no provider operation was retried.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Legacy lease reconciliation failed; review validated evidence and private operator diagnostics.');
    process.exitCode = 1;
  });
}
