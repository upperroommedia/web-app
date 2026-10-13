import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import { publishingCriticalRepairDigest, type CriticalRepairCertificate } from './criticalRepair';
import { readCriticalRepairCatalogStepAuthority } from './criticalRepairCatalog';
import {
  ACKNOWLEDGED_PROJECTION_PLANS,
  acknowledgedProjectionDigest,
  validateAcknowledgedProjectionEvidence,
} from './criticalAcknowledgedRepair';
import {
  loadValidatedLegacySoundCloudRetentionCertificate,
  readLegacySoundCloudRetentionStepAuthority,
} from './legacySoundCloudRetention';
import {
  SERMON_DELETION_PARTIAL_STOPS,
  validateSermonDeletionPartialStopEvidence,
} from '../../helpers/sermonDeletionPartialStop';
import { PUBLISHING_ZERO_EFFECTS_STOPS, validatePublishingZeroEffectsStopEvidence } from './publishingZeroEffectsStop';
import { PROVIDER_MUTATION_SESSIONS } from './providerMutationGuard';
import { SERMON_DELETION_MIRROR_PLANS, sermonDeletionMirrorPlanId } from '../../helpers/sermonDeletionMirrors';
import {
  localSermonDeletionHeaderProjection,
  validateLocalSermonDeletionRepairEvidence,
} from './localSermonDeletionRepair';

type Data = Record<string, unknown>;
const object = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const step = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,99}$/.test(value);
const fail = (): never => {
  throw Object.assign(new Error('PUBLISHING_CRITICAL_STEP_AUTHORITY_REQUIRED'), {
    code: 'PUBLISHING_CRITICAL_STEP_AUTHORITY_REQUIRED',
  });
};
function parent(value: unknown, ref: DurableJobRef): void {
  const scoped = object(value);
  if (Object.keys(scoped).length !== 2 || scoped.projectId !== ref.projectId || scoped.jobId !== ref.jobId) fail();
}
function explicitSteps(value: unknown, allowed: Set<string>, requireNonempty = false): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    (requireNonempty && value.length === 0) ||
    value.some((id) => !step(id) || !allowed.has(id)) ||
    new Set(value).size !== value.length
  )
    return fail();
  return [...value].sort();
}
async function readSteps(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  certificate: CriticalRepairCertificate
): Promise<string[]> {
  if (
    certificate.schemaVersion !== 1 ||
    !sha(certificate.intentFingerprint) ||
    !sha(certificate.criticalFingerprint) ||
    certificate.projectId !== ref.projectId ||
    certificate.jobId !== ref.jobId ||
    !Number.isSafeInteger(certificate.generation) ||
    certificate.generation < 1 ||
    !Array.isArray(certificate.operations) ||
    !Array.isArray(certificate.sourceEvidenceDigests)
  )
    fail();
  const certificateId = publishingCriticalRepairDigest(certificate),
    [jobSnapshot, intentSnapshot, recordSnapshot] = await Promise.all([
      tx.get(db.doc(`durableJobs/${ref.jobId}`)),
      tx.get(db.doc(`durableJobIntents/${ref.jobId}`)),
      tx.get(db.doc(`temporalPublishingCriticalRepairs/${certificateId}`)),
    ]);
  const job = object(jobSnapshot.data()),
    intent = object(intentSnapshot.data()),
    record = object(recordSnapshot.data());
  if (
    !jobSnapshot.exists ||
    !intentSnapshot.exists ||
    !recordSnapshot.exists ||
    record.schemaVersion !== 1 ||
    record.certificateId !== certificateId ||
    record.digest !== certificateId ||
    publishingCriticalRepairDigest(record.certificate) !== certificateId ||
    job.projectId !== ref.projectId ||
    job.jobId !== ref.jobId ||
    intent.projectId !== ref.projectId ||
    intent.jobId !== ref.jobId ||
    job.generation !== certificate.generation ||
    intent.generation !== certificate.generation ||
    job.workflowId !== certificate.workflowId ||
    publishingCriticalRepairDigest(intent) !== certificate.intentFingerprint
  )
    fail();
  if (!Array.isArray(job.steps) || job.steps.length > 32 || job.steps.some((value) => !step(object(value).id)))
    return fail();
  const steps = job.steps,
    allowed = new Set(steps.map((value) => object(value).id as string));
  if (allowed.size !== steps.length) fail();
  const result = new Set<string>();
  const add = (ids: string[]) => {
    for (const id of ids) result.add(id);
    if (result.size > 32) fail();
  };
  if (certificate.catalog) {
    const summary = await readCriticalRepairCatalogStepAuthority(tx, db, ref, certificate.catalog);
    parent(summary.sourceParentRef, ref);
    add(explicitSteps(summary.sourceStepIds, allowed, Number(summary.sourceCount) > 0));
  }
  const acknowledged = certificate.operations.filter((operation) => operation.kind === 'acknowledged_projection');
  if (acknowledged.length > 32) fail();
  for (const operation of acknowledged) {
    if (
      operation.kind !== 'acknowledged_projection' ||
      !sha(operation.sessionId) ||
      !sha(operation.projectionDigest) ||
      !certificate.sourceEvidenceDigests.includes(operation.projectionDigest)
    )
      fail();
    const path = `${ACKNOWLEDGED_PROJECTION_PLANS}/${operation.sessionId}`,
      snapshot = await tx.get(db.doc(path)),
      manifest = object(snapshot.data());
    if (
      !snapshot.exists ||
      manifest.schemaVersion !== 2 ||
      manifest.projectId !== ref.projectId ||
      manifest.jobId !== ref.jobId ||
      manifest.sessionId !== operation.sessionId ||
      manifest.intentFingerprint !== acknowledgedProjectionDigest(intent)
    )
      fail();
    let authoritative = manifest;
    if (acknowledgedProjectionDigest(manifest) !== operation.projectionDigest) {
      const held = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${operation.sessionId}`));
      const beforeSeal = { ...manifest, completesActivity: false };
      if (
        manifest.completesActivity !== true ||
        held.get('state') !== 'committed' ||
        held.get('scope.projectId') !== ref.projectId ||
        held.get('scope.jobId') !== ref.jobId ||
        acknowledgedProjectionDigest(beforeSeal) !== operation.projectionDigest
      )
        fail();
      authoritative = beforeSeal;
    } else await validateAcknowledgedProjectionEvidence(tx, db, ref, { path, digest: operation.projectionDigest });
    add(explicitSteps(authoritative.uiStepIds, allowed, true));
  }
  const local = certificate.operations.filter((operation) => operation.kind === 'local_sermon_delete');
  if (local.length > 1) fail();
  for (const operation of local) {
    if (operation.kind !== 'local_sermon_delete' || !sha(operation.planId)) fail();
    const path = `${SERMON_DELETION_MIRROR_PLANS}/${operation.planId}`,
      snapshot = await tx.get(db.doc(path)),
      header = object(snapshot.data()),
      projection = localSermonDeletionHeaderProjection(header),
      digest = acknowledgedProjectionDigest(projection);
    if (
      !snapshot.exists ||
      !certificate.sourceEvidenceDigests.includes(digest) ||
      projection.sourceStepIds === undefined ||
      projection.sourceParentRef === undefined
    )
      fail();
    await validateLocalSermonDeletionRepairEvidence(tx, db, ref, { path, digest });
    parent(projection.sourceParentRef, ref);
    add(explicitSteps(projection.sourceStepIds, allowed, true));
  }
  const zero = certificate.operations.filter((operation) => operation.kind === 'publishing_zero_effects_stop');
  if (zero.length > 1) fail();
  for (const operation of zero) {
    if (operation.kind !== 'publishing_zero_effects_stop' || !sha(operation.planId) || !sha(operation.sessionId))
      fail();
    const path = `${PUBLISHING_ZERO_EFFECTS_STOPS}/${operation.planId}`,
      snapshot = await tx.get(db.doc(path)),
      saved = object(snapshot.data());
    const { state, stoppedAtMillis, ...identity } = saved,
      digest = acknowledgedProjectionDigest(identity);
    if (
      !snapshot.exists ||
      saved.planId !== operation.planId ||
      saved.sessionId !== operation.sessionId ||
      saved.projectId !== ref.projectId ||
      saved.jobId !== ref.jobId ||
      saved.generation !== certificate.generation ||
      saved.workflowId !== certificate.workflowId ||
      saved.intentFingerprint !== certificate.intentFingerprint ||
      !certificate.sourceEvidenceDigests.includes(digest)
    )
      fail();
    await validatePublishingZeroEffectsStopEvidence(tx, db, ref, { path, digest });
    const headerSnapshot = await tx.get(db.doc(`${SERMON_DELETION_MIRROR_PLANS}/${operation.planId}`)),
      header = object(headerSnapshot.data());
    const projection = {
      ...localSermonDeletionHeaderProjection(header),
      ...Object.fromEntries(
        [
          'destinationProgram',
          'frozenProgramDigest',
          'canonicalPageCount',
          'canonicalChainDigest',
          'immutableCanonicalCatalogDigest',
        ]
          .filter((key) => header[key] !== undefined)
          .map((key) => [key, header[key]])
      ),
    };
    if (!headerSnapshot.exists || acknowledgedProjectionDigest(projection) !== saved.headerDigest) fail();
    parent(header.sourceParentRef, ref);
    add(explicitSteps(header.sourceStepIds, allowed, true));
  }
  const partial = certificate.operations.filter((operation) => operation.kind === 'sermon_deletion_partial_stop');
  if (partial.length > 1) fail();
  for (const operation of partial) {
    if (operation.kind !== 'sermon_deletion_partial_stop' || !sha(operation.planId) || !sha(operation.sessionId))
      fail();
    const path = `${SERMON_DELETION_PARTIAL_STOPS}/${operation.planId}`,
      snapshot = await tx.get(db.doc(path)),
      saved = object(snapshot.data()),
      identity = object(saved.identity);
    const digest = acknowledgedProjectionDigest({
      identity,
      immutableCatalogueDigest: saved.immutableCatalogueDigest,
      effectChainDigest: saved.effectChainDigest,
      canonicalPageCount: saved.canonicalPageCount,
      canonicalChainDigest: saved.canonicalChainDigest,
    });
    if (
      !snapshot.exists ||
      !['ready', 'completed'].includes(String(saved.state)) ||
      identity.planId !== operation.planId ||
      identity.sessionId !== operation.sessionId ||
      identity.projectId !== ref.projectId ||
      identity.jobId !== ref.jobId ||
      identity.generation !== certificate.generation ||
      identity.workflowId !== certificate.workflowId ||
      identity.intentFingerprint !== certificate.intentFingerprint ||
      typeof identity.sermonId !== 'string' ||
      identity.sermonId !== object(intent.entity).id ||
      identity.headerPath !== `${SERMON_DELETION_MIRROR_PLANS}/${sermonDeletionMirrorPlanId(ref, identity.sermonId)}` ||
      !certificate.sourceEvidenceDigests.includes(digest)
    )
      fail();
    await validateSermonDeletionPartialStopEvidence(tx, db, ref, { path, digest });
    const headerSnapshot = await tx.get(db.doc(String(identity.headerPath))),
      header = object(headerSnapshot.data());
    const projection = {
      ...localSermonDeletionHeaderProjection(header),
      destinationProgram: header.destinationProgram ?? null,
      frozenProgramDigest: header.frozenProgramDigest,
      canonicalPageCount: header.canonicalPageCount,
      canonicalChainDigest: header.canonicalChainDigest,
      immutableCanonicalCatalogDigest: header.immutableCanonicalCatalogDigest,
    };
    if (!headerSnapshot.exists || acknowledgedProjectionDigest(projection) !== identity.headerDigest) fail();
    parent(header.sourceParentRef, ref);
    add(explicitSteps(header.sourceStepIds, allowed, true));
  }
  const legacy = certificate.operations.filter((operation) => operation.kind === 'legacy_soundcloud_retain');
  if (legacy.length > 1) fail();
  for (const operation of legacy) {
    if (
      operation.kind !== 'legacy_soundcloud_retain' ||
      !sha(operation.certificateId) ||
      !certificate.sourceEvidenceDigests.includes(operation.certificateId)
    )
      fail();
    const sourceCertificate = await loadValidatedLegacySoundCloudRetentionCertificate(
        tx,
        db,
        ref,
        operation.certificateId
      ),
      authority = await readLegacySoundCloudRetentionStepAuthority(tx, db, ref, sourceCertificate);
    parent(authority.sourceParentRef, ref);
    add(explicitSteps(authority.sourceStepIds, allowed, true));
  }
  if (!result.size) fail();
  return [...result].sort();
}
/** Fixed-size source summaries and pinned ACK roots only; no catalogue-page scan,
 * child-step expansion or guessed fallback names participate in this authority. */
export async function readAuthoritativeCriticalRepairStepIds(
  ref: DurableJobRef,
  certificate: CriticalRepairCertificate,
  db: Firestore
): Promise<string[]> {
  return db.runTransaction((tx) => readSteps(tx, db, ref, certificate));
}
