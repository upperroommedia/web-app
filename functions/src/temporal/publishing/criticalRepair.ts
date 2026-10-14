import {
  SERMON_DELETION_PARTIAL_STOPS,
  prepareSermonDeletionPartialStop,
  validateSermonDeletionPartialStopEvidence,
  validateSermonDeletionPartialStopOperation,
  runSermonDeletionPartialStop,
  validateSermonDeletionPartialStopRead,
  type SermonDeletionPartialStopOperation,
  type SermonDeletionPartialStopDependencies,
} from '../../helpers/sermonDeletionPartialStop';
import {
  PUBLISHING_ZERO_EFFECTS_STOPS,
  preparePublishingZeroEffectsStop,
  validatePublishingZeroEffectsStopEvidence,
  validatePublishingZeroEffectsStopOperation,
  runPublishingZeroEffectsStop,
  type PublishingZeroEffectsStopOperation,
} from './publishingZeroEffectsStop';
import { prepareDesiredProviderDeletionSettlement } from '../../../../packages/orchestration/src/provider-usage';
import {
  prepareCertifiedDeletionDisposition,
  certifiedDeletionDispositionDigest,
  type CertifiedDeletionFixedAbsenceRecord,
} from './certifiedDeletionDisposition';
import {
  createCertifiedPublishingDeletionGuard,
  certifiedPublishingDeletionSessionId,
  type CertifiedPublishingDeletionAuthorizationPhase,
  type CertifiedPublishingDeletionHandle,
} from './criticalDeletionGuard';
import { prepareListDeletionReady, readListDeletionReadyCompletion } from '../../helpers/listDeletionReady';
import {
  verifySermonDeletionDestinationCounts,
  type SermonDeletionDestinationRef,
} from '../../helpers/sermonDeletionDestinations';
import {
  readCertifiedCriticalRepairDeleteSet,
  validateCertifiedCriticalRepairDeleteSet,
  CRITICAL_REPAIR_CATALOGS,
  prepareCriticalRepairCatalog,
  readCertifiedCriticalRepairOperations,
  criticalRepairCatalogDigest,
  type CriticalRepairCatalogRoot,
} from './criticalRepairCatalog';
import { finalizeRetainedSoundCloudSermonDeletion } from './retainedSoundCloudSermonDeletion';
import { createHash } from 'node:crypto';
import axios from '../../providerSandbox/http';
import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import { DURABLE_COLLECTIONS } from '../../../../packages/orchestration/src/job-store';
import { authenticateSubsplash, createAxiosConfig } from '../../subsplashUtils';
import { runWithSoundCloudAccessToken } from '../../soundcloudSecrets';
import { deleteTrack, normalizeSoundCloudAccountId } from '../../soundcloudClient';
import { preparePublishingAllocationRetirement } from './allocationBarrier';
import { PUBLISHING_DELETION_RECEIPTS } from './providerDeletion';
import { PUBLISHING_EFFECT_PLANS, runCriticalPublishingRepair } from './durableOperationContext';
import {
  abortProvablyUnsentProviderMutationSessionsForJob,
  PROVIDER_MUTATION_SESSIONS,
  type ProviderMutationSession,
  type ProviderMutationReadyCanonicalCompletionValidator,
  type ProviderMutationReadyCanonicalCompletion,
  type ProviderMutationClosedEvidenceSeal,
  providerMutationFingerprint,
} from './providerMutationGuard';
import {
  ACKNOWLEDGED_PROJECTION_PLANS,
  validateAcknowledgedProjectionOperation,
  prepareAcknowledgedRepair,
  validateAcknowledgedProjectionEvidence,
  validateAcknowledgedRepairCandidateEvidence,
  validateAcknowledgedRepairProviderRead,
  readAcknowledgedRepairRequiredVerifications,
  commitAcknowledgedRepair,
  type AcknowledgedProjectionOperation,
  type FrozenProjectionRequest,
} from './criticalAcknowledgedRepair';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import type { PublishingStepResult } from './types';
import {
  LEGACY_SOUNDCLOUD_RETENTION_OBSERVATIONS,
  LEGACY_SOUNDCLOUD_RETENTION_CERTIFICATES,
  prepareLegacySoundCloudRetention,
  loadValidatedLegacySoundCloudRetentionCertificate,
  prepareLegacySoundCloudRetentionProjection,
  type LegacySoundCloudRetentionOperation,
} from './legacySoundCloudRetention';
import { abortCancelledDesiredProviderDeletions } from './desiredDeletionCancellation';
import {
  prepareLocalSermonDeletionRepair,
  runLocalSermonDeletionRepair,
  validateLocalSermonDeletionRepairEvidence,
  type LocalSermonDeletionRepairOperation,
} from './localSermonDeletionRepair';
import {
  SERMON_DELETION_MIRROR_PLANS,
  loadSermonDeletionMirrorPlan,
  removeSermonDeletionMirrors,
  validateSermonDeletionCompletion,
  validateSermonDeletionEffectsForClosing,
  readSermonDeletionCertifiedSourceHeaderInTransaction,
  validateSermonDeletionCertifiedEffectsForClosing,
} from '../../helpers/sermonDeletionMirrors';
import {
  loadFactualListDeletionCleanup,
  sealListDeletionCompletion,
  validateListDeletionCompletion,
  removeListDeletionMirrors,
} from '../../helpers/listDeletionMirrors';
import type { DurableJobIntent } from '../../../../packages/orchestration/src/job-store';
export const PUBLISHING_CRITICAL_REPAIRS = 'temporalPublishingCriticalRepairs';
export type RepairProvider = 'subsplash' | 'soundcloud';
export type RepairResourceType = 'media' | 'audio' | 'track' | 'series' | 'list' | 'list-row' | 'tag';
export interface RepairResource {
  provider: RepairProvider;
  resourceType: RepairResourceType;
  resourceId: string;
  accountId: string;
}
export type FixedRepairOperation =
  | SermonDeletionPartialStopOperation
  | PublishingZeroEffectsStopOperation
  | LocalSermonDeletionRepairOperation
  | LegacySoundCloudRetentionOperation
  | AcknowledgedProjectionOperation
  | (RepairResource & { kind: 'provider_read'; method: 'GET' })
  | (RepairResource & { kind: 'provider_delete'; method: 'DELETE' })
  | {
      kind: 'canonical_repair';
      path: string;
      field: 'subsplashId' | 'soundCloudTrackId' | 'uploadStatus.status' | 'publishedToSubsplash';
      expectedProviderId: string;
    };
export interface CriticalRepairCertificate {
  schemaVersion: 1;
  projectId: string;
  jobId: string;
  generation: number;
  workflowId: string;
  acceptedUserCancellation: boolean;
  intentFingerprint: string;
  criticalFingerprint: string;
  operations: FixedRepairOperation[];
  sourceEvidenceDigests: string[];
  catalog?: CriticalRepairCatalogRoot;
}
export interface CriticalRepairSourceEvidence {
  path: string;
  digest: string;
}
export interface CriticalRepairRecord {
  schemaVersion: 1;
  certificate: CriticalRepairCertificate;
  certificateId: string;
  digest: string;
  sourceEvidence: CriticalRepairSourceEvidence[];
  createdAtMillis: number;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const fail: (code?: string) => never = (code = 'PUBLISHING_CRITICAL_REPAIR_REQUIRED') => {
  throw Object.assign(new Error('Critical repair proof does not authorize this operation'), { code });
};
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256 && !/[\s/?#]/.test(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** Public Date/Timestamp APIs only; private SDK fields never participate in a certificate. */
function ordered(value: unknown): unknown {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) fail();
    return value.toISOString();
  }
  if (value && typeof value === 'object' && 'toMillis' in value && typeof value.toMillis === 'function') {
    const millis = value.toMillis();
    if (typeof millis !== 'number' || !Number.isFinite(millis)) fail();
    return millis;
  }
  if (Array.isArray(value)) return value.map((entry) => (entry === undefined ? null : ordered(entry)));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, ordered(entry)])
    );
  if (
    (typeof value === 'number' && !Number.isFinite(value)) ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  )
    fail();
  return value;
}
export const publishingCriticalRepairDigest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex');
export const criticalRepairDigest = publishingCriticalRepairDigest;
export function validateCriticalRepairOperation(value: unknown): value is FixedRepairOperation {
  const op = object(value);
  if (op.kind === 'sermon_deletion_partial_stop') return validateSermonDeletionPartialStopOperation(op);
  if (op.kind === 'publishing_zero_effects_stop') return validatePublishingZeroEffectsStopOperation(op);
  if (op.kind === 'local_sermon_delete') return Object.keys(op).length === 2 && sha(op.planId);
  if (op.kind === 'legacy_soundcloud_retain') return Object.keys(op).length === 2 && sha(op.certificateId);
  if (op.kind === 'acknowledged_projection') return validateAcknowledgedProjectionOperation(value);
  if (op.kind === 'canonical_repair')
    return (
      Object.keys(op).every((key) => ['kind', 'path', 'field', 'expectedProviderId'].includes(key)) &&
      typeof op.path === 'string' &&
      /^((sermons|lists|series|speakers)\/[^/]+)(\/(sermonLists|listItems|seriesItems)\/[^/]+)?$/.test(op.path) &&
      ['subsplashId', 'soundCloudTrackId', 'uploadStatus.status', 'publishedToSubsplash'].includes(String(op.field)) &&
      safeId(op.expectedProviderId)
    );
  if (
    !['provider_read', 'provider_delete'].includes(String(op.kind)) ||
    !Object.keys(op).every((key) =>
      ['kind', 'provider', 'resourceType', 'resourceId', 'accountId', 'method'].includes(key)
    ) ||
    !safeId(op.resourceId)
  )
    return false;
  if (op.method !== (op.kind === 'provider_read' ? 'GET' : 'DELETE')) return false;
  return op.provider === 'subsplash'
    ? op.accountId === 'app:9XTSHD' &&
        ['media', 'audio', 'series', 'list', 'list-row', 'tag'].includes(String(op.resourceType))
    : op.provider === 'soundcloud' &&
        op.resourceType === 'track' &&
        typeof op.accountId === 'string' &&
        /^soundcloud:users:[0-9]+$/.test(op.accountId);
}
function evidenceProjection(path: string, data: Record<string, unknown>): Record<string, unknown> {
  if (path.startsWith(`${PUBLISHING_DELETION_RECEIPTS}/`))
    return Object.fromEntries(
      [
        'projectId',
        'jobId',
        'sermonId',
        'provider',
        'remoteId',
        'originalAccount',
        'authorizedAtMillis',
        'ownershipConfirmedBeforeDelete',
        'sourceStepIds',
        'sourceParentRef',
      ].map((key) => [key, data[key]])
    );
  if (path.startsWith(`${PUBLISHING_EFFECT_PLANS}/`))
    return Object.fromEntries(
      [
        'schemaVersion',
        'projectId',
        'jobId',
        'reasonCode',
        'provider',
        'resourceType',
        'resourceId',
        'accountId',
        'method',
        'canonicalPaths',
        'requestFingerprint',
        'plannedAtMillis',
        'sourceStepIds',
        'sourceParentRef',
      ].map((key) => [key, data[key]])
    );
  return fail();
}
function checkCertificate(value: unknown, ref: DurableJobRef): asserts value is CriticalRepairCertificate {
  const cert = object(value);
  if (
    typeof cert.acceptedUserCancellation !== 'boolean' ||
    cert.schemaVersion !== 1 ||
    cert.projectId !== ref.projectId ||
    cert.jobId !== ref.jobId ||
    !Number.isSafeInteger(cert.generation) ||
    Number(cert.generation) < 1 ||
    !safeId(cert.workflowId) ||
    !sha(cert.intentFingerprint) ||
    !sha(cert.criticalFingerprint) ||
    !Array.isArray(cert.operations) ||
    cert.operations.length > 2000 ||
    !cert.operations.every(validateCriticalRepairOperation) ||
    (cert.operations.some((op) =>
      ['publishing_zero_effects_stop', 'sermon_deletion_partial_stop'].includes(String(object(op).kind))
    ) &&
      cert.operations.length !== 1) ||
    (cert.acceptedUserCancellation === true && cert.operations.some((op) => object(op).kind === 'provider_delete')) ||
    !Array.isArray(cert.sourceEvidenceDigests) ||
    !cert.sourceEvidenceDigests.every(sha)
  )
    fail();
}
/** Planner is read-only until commit(), so the command coordinator can finish all authority/audit reads first. */
export async function preparePublishingCriticalRepair(
  tx: Transaction,
  db: Firestore,
  input: { ref: DurableJobRef; expectedRevision: number }
): Promise<{ certificate: CriticalRepairCertificate; certificateId: string; digest: string; commit: () => void }> {
  const { ref } = input;
  if (!safeId(ref.projectId) || !safeId(ref.jobId)) fail();
  const [jobDoc, intentDoc, criticalDoc, cancelDoc] = await Promise.all([
    tx.get(db.collection(DURABLE_COLLECTIONS.jobs).doc(ref.jobId)),
    tx.get(db.collection(DURABLE_COLLECTIONS.intents).doc(ref.jobId)),
    tx.get(db.collection(DURABLE_COLLECTIONS.critical).doc(ref.jobId)),
    tx.get(db.collection('durableJobCancellationIntents').doc(ref.jobId)),
  ]);
  const job = object(jobDoc.data()),
    intent = object(intentDoc.data()),
    critical = object(criticalDoc.data()),
    cancellation = object(cancelDoc.data());
  const acceptedUserCancellation =
    cancelDoc.exists &&
    (cancellation.purpose !== 'critical_repair_cleanup' || cancellation.acceptedUserCancellation === true);
  if (
    !jobDoc.exists ||
    !intentDoc.exists ||
    !criticalDoc.exists ||
    job.projectId !== ref.projectId ||
    job.jobId !== ref.jobId ||
    intent.projectId !== ref.projectId ||
    intent.jobId !== ref.jobId ||
    critical.projectId !== ref.projectId ||
    critical.jobId !== ref.jobId ||
    job.generation !== intent.generation ||
    critical.generation !== job.generation ||
    critical.workflowId !== job.workflowId ||
    job.revision !== input.expectedRevision ||
    ['succeeded', 'failed', 'cancelled', 'superseded'].includes(String(job.state))
  )
    fail();
  // A dedicated cleanup authority pins the already-reviewed certificate. Mutable
  // journal progress and public reporting revisions must not change that plan.
  if (cancelDoc.exists && cancellation.purpose === 'critical_repair_cleanup') {
    if (!sha(cancellation.certificateId)) fail();
    const certificate = await loadValidatedPublishingCriticalRepairCertificate(db, ref, cancellation.certificateId, tx);
    if (
      certificate.generation !== job.generation ||
      certificate.workflowId !== job.workflowId ||
      certificate.intentFingerprint !== publishingCriticalRepairDigest(intent) ||
      certificate.criticalFingerprint !== publishingCriticalRepairDigest(critical) ||
      certificate.acceptedUserCancellation !== acceptedUserCancellation
    )
      fail();
    return {
      certificate,
      certificateId: cancellation.certificateId,
      digest: cancellation.certificateId,
      commit: () => {},
    };
  }
  const catalog = await prepareCriticalRepairCatalog(tx, db, ref);
  if (
    catalog.intentDigest !== publishingCriticalRepairDigest(intent) ||
    catalog.criticalDigest !== publishingCriticalRepairDigest(critical) ||
    catalog.acceptedUserCancellation !== acceptedUserCancellation
  )
    fail();
  const operations: FixedRepairOperation[] = [],
    sourceEvidence: CriticalRepairSourceEvidence[] = [],
    nestedCommits: Array<() => void> = [];
  const add = (op: FixedRepairOperation) => {
    if (!validateCriticalRepairOperation(op)) fail();
    if (!operations.some((existing) => publishingCriticalRepairDigest(existing) === publishingCriticalRepairDigest(op)))
      operations.push(op);
  };
  let zeroStop = false;
  if (intent.kind === 'sermon.delete' && !acceptedUserCancellation) {
    try {
      const stop = await preparePublishingZeroEffectsStop(tx, db, { ref, expectedRevision: input.expectedRevision });
      add(stop.operation);
      sourceEvidence.push(stop.sourceEvidence);
      nestedCommits.push(stop.commit);
      zeroStop = true;
    } catch (error) {
      if (object(error).code !== 'PUBLISHING_ZERO_EFFECTS_STOP_PROOF_REQUIRED') throw error;
    }
  }
  if (!zeroStop && intent.kind === 'sermon.delete' && !acceptedUserCancellation) {
    try {
      const stop = await prepareSermonDeletionPartialStop(tx, db, { ref, expectedRevision: input.expectedRevision });
      add(stop.operation);
      sourceEvidence.push(stop.sourceEvidence);
      nestedCommits.push(stop.commit);
      zeroStop = true;
    } catch (error) {
      if (object(error).code !== 'SERMON_DELETION_PARTIAL_STOP_PROOF_REQUIRED') throw error;
    }
  }
  if (!zeroStop) {
    const privateIntent = object(intent.payload),
      sermon = object(object(privateIntent.payload).sermon);
    if (
      intent.kind === 'sermon.delete' &&
      !sermon.subsplashId &&
      !sermon.soundCloudTrackId &&
      !acceptedUserCancellation
    ) {
      const local = await prepareLocalSermonDeletionRepair(tx, db, { ref, expectedRevision: input.expectedRevision });
      add(local.operation);
      sourceEvidence.push(local.sourceEvidence);
      nestedCommits.push(local.commit);
    }
    const legacyObservation = await tx.get(db.collection(LEGACY_SOUNDCLOUD_RETENTION_OBSERVATIONS).doc(ref.jobId));
    if (legacyObservation.exists) {
      const legacy = await prepareLegacySoundCloudRetention(tx, db, { ref, expectedRevision: input.expectedRevision });
      add({ kind: 'legacy_soundcloud_retain', certificateId: legacy.certificateId });
      sourceEvidence.push({
        path: `${LEGACY_SOUNDCLOUD_RETENTION_CERTIFICATES}/${legacy.certificateId}`,
        digest: legacy.digest,
      });
      nestedCommits.push(legacy.commit);
    }

    const sessions = await tx.get(
      db
        .collection(PROVIDER_MUTATION_SESSIONS)
        .where('scope.projectId', '==', ref.projectId)
        .where('scope.jobId', '==', ref.jobId)
        .where('state', '==', 'active')
    );
    for (const session of sessions.docs) {
      if (session.get('state') !== 'active') continue;
      try {
        const proof = await prepareAcknowledgedRepair(tx, db, ref, session.id);
        if (!proof.candidateId)
          for (const verification of proof.verifications)
            add({
              kind: 'provider_read',
              provider: verification.provider,
              resourceType: verification.resourceType,
              resourceId: verification.resourceId,
              accountId: verification.account,
              method: 'GET',
            });
        add(proof.operation);
        sourceEvidence.push(...proof.sourceEvidence);
      } catch (error) {
        if (
          ![
            'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED',
            'PUBLISHING_CRITICAL_ACK_CANDIDATE_PENDING',
            'PROVIDER_MUTATION_UNRESOLVED',
          ].includes(String(object(error).code))
        )
          throw error; /* Unknown or unfrozen effects remain held and actionable; current GET cannot supply original proof. */
      }
    }
  }
  // An empty plan authorizes no provider effect. The dedicated interpreter must
  // prove unsent-session abort under fresh cleanup authority, then the workflow
  // still drains scoped allocation receipts and cancellation barriers.

  sourceEvidence.sort((a, b) => a.path.localeCompare(b.path));
  sourceEvidence.push({
    path: `${CRITICAL_REPAIR_CATALOGS}/${catalog.catalogId}`,
    digest: criticalRepairCatalogDigest(catalog),
  });
  const certificate: CriticalRepairCertificate = {
    catalog,
    schemaVersion: 1,
    projectId: ref.projectId,
    jobId: ref.jobId,
    generation: Number(job.generation),
    workflowId: String(job.workflowId),
    acceptedUserCancellation,
    intentFingerprint: publishingCriticalRepairDigest(intent),
    criticalFingerprint: publishingCriticalRepairDigest(critical),
    operations,
    sourceEvidenceDigests: sourceEvidence.map((item) => item.digest),
  };
  checkCertificate(certificate, ref);
  const digest = publishingCriticalRepairDigest(certificate),
    certificateId = digest,
    target = db.collection(PUBLISHING_CRITICAL_REPAIRS).doc(certificateId),
    existing = await tx.get(target);
  if (existing.exists && object(existing.data()).digest !== digest) fail();
  const record: CriticalRepairRecord = {
    schemaVersion: 1,
    certificate,
    certificateId,
    digest,
    sourceEvidence,
    createdAtMillis: Date.now(),
  };
  if (JSON.stringify(record).length > 750_000) fail('PUBLISHING_CRITICAL_REPAIR_PLAN_TOO_LARGE');
  return {
    certificate,
    certificateId,
    digest,
    commit: () => {
      nestedCommits.forEach((commit) => commit());
      if (!existing.exists) tx.create(target, record);
    },
  };
}
/** Runtime may pass its fenced transaction; every certificate and immutable source fact is then reread atomically. */
export async function loadValidatedPublishingCriticalRepairCertificate(
  db: Firestore,
  ref: DurableJobRef,
  id: string,
  tx?: Transaction
): Promise<CriticalRepairCertificate> {
  if (!sha(id)) fail();
  const read = async (path: string) => {
    const target = db.doc(path);
    return tx ? tx.get(target) : target.get();
  };
  const snapshot = await read(`${PUBLISHING_CRITICAL_REPAIRS}/${id}`),
    record = object(snapshot.data()),
    cert = record.certificate;
  checkCertificate(cert, ref);
  if (
    record.certificateId !== id ||
    record.digest !== id ||
    publishingCriticalRepairDigest(cert) !== id ||
    !Array.isArray(record.sourceEvidence)
  )
    fail();
  const cancellation = object((await read(`durableJobCancellationIntents/${ref.jobId}`)).data());
  if (Object.keys(cancellation).length) {
    const ordinary =
      cancellation.purpose !== 'critical_repair_cleanup' || cancellation.acceptedUserCancellation === true;
    if (ordinary && cert.operations.some((op) => op.kind === 'provider_delete')) fail();
    if (cancellation.purpose === 'critical_repair_cleanup' && cancellation.certificateId !== id) fail();
  }
  const evidence = record.sourceEvidence.map((item) => object(item));
  if (evidence.length !== cert.sourceEvidenceDigests.length) fail();
  for (let index = 0; index < evidence.length; index++) {
    const item = evidence[index];
    if (typeof item.path !== 'string' || item.digest !== cert.sourceEvidenceDigests[index] || !sha(item.digest)) fail();
    if (item.path.startsWith(`${SERMON_DELETION_PARTIAL_STOPS}/`)) {
      const evidence = { path: item.path, digest: item.digest as string };
      if (tx) await validateSermonDeletionPartialStopEvidence(tx, db, ref, evidence);
      else await db.runTransaction((current) => validateSermonDeletionPartialStopEvidence(current, db, ref, evidence));
      continue;
    }
    if (item.path.startsWith(`${PUBLISHING_ZERO_EFFECTS_STOPS}/`)) {
      const evidence = { path: item.path, digest: item.digest as string };
      if (tx) await validatePublishingZeroEffectsStopEvidence(tx, db, ref, evidence);
      else
        await db.runTransaction((transaction) =>
          validatePublishingZeroEffectsStopEvidence(transaction, db, ref, evidence)
        );
      continue;
    }
    if (item.path.startsWith(`${CRITICAL_REPAIR_CATALOGS}/`)) {
      if (
        !cert.catalog ||
        item.path !== `${CRITICAL_REPAIR_CATALOGS}/${cert.catalog.catalogId}` ||
        item.digest !== criticalRepairCatalogDigest(cert.catalog)
      )
        fail();
      const catalog = tx
        ? await prepareCriticalRepairCatalog(tx, db, ref)
        : await db.runTransaction((current) => prepareCriticalRepairCatalog(current, db, ref));
      if (criticalRepairCatalogDigest(catalog) !== item.digest) fail();
      continue;
    }
    if (item.path.startsWith(`${SERMON_DELETION_MIRROR_PLANS}/`)) {
      const proof = { path: item.path, digest: item.digest as string };
      if (tx) await validateLocalSermonDeletionRepairEvidence(tx, db, ref, proof);
      else await db.runTransaction((current) => validateLocalSermonDeletionRepairEvidence(current, db, ref, proof));
      continue;
    }
    if (item.path.startsWith(`${LEGACY_SOUNDCLOUD_RETENTION_CERTIFICATES}/`)) {
      const id = item.path.slice(LEGACY_SOUNDCLOUD_RETENTION_CERTIFICATES.length + 1);
      const legacy = await (tx
        ? loadValidatedLegacySoundCloudRetentionCertificate(tx, db, ref, id)
        : db.runTransaction((transaction) =>
            loadValidatedLegacySoundCloudRetentionCertificate(transaction, db, ref, id)
          ));
      if (criticalRepairDigest(legacy) !== item.digest) fail();
      continue;
    }
    if (item.path.startsWith('temporalPublishingAcknowledgedRepairCandidates/')) {
      const proof = { path: item.path, digest: item.digest as string };
      if (tx) await validateAcknowledgedRepairCandidateEvidence(tx, db, ref, proof);
      else await db.runTransaction((current) => validateAcknowledgedRepairCandidateEvidence(current, db, ref, proof));
      continue;
    }
    if (item.path.startsWith(`${ACKNOWLEDGED_PROJECTION_PLANS}/`)) {
      const proof = { path: item.path, digest: item.digest as string };
      if (tx) await validateAcknowledgedProjectionEvidence(tx, db, ref, proof);
      else await db.runTransaction((current) => validateAcknowledgedProjectionEvidence(current, db, ref, proof));
      continue;
    }
    if (
      !new RegExp(`^${PUBLISHING_DELETION_RECEIPTS}/[a-f0-9]{64}$`).test(item.path) &&
      !item.path.startsWith(`${PUBLISHING_EFFECT_PLANS}/${ref.jobId}/operations/`)
    )
      fail();
    const source = object((await read(item.path)).data());
    if (
      source.projectId !== ref.projectId ||
      source.jobId !== ref.jobId ||
      publishingCriticalRepairDigest(evidenceProjection(item.path, source)) !== item.digest
    )
      fail();
  }
  return cert;
}
/** Runtime uses this only after independently rechecking the current administrator
 * and exact grant. A paged fixed read must be a member of the pinned READY source
 * candidate; supplying a resource identity cannot expand the certificate. */
export async function validatePublishingCriticalRepairDerivedRead(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  certificateId: string,
  operation: Extract<FixedRepairOperation, { kind: 'provider_read' }>
): Promise<void> {
  if (!validateCriticalRepairOperation(operation) || operation.kind !== 'provider_read') fail();
  const certificate = await loadValidatedPublishingCriticalRepairCertificate(db, ref, certificateId, tx);
  for (const projection of certificate.operations) {
    if (projection.kind !== 'acknowledged_projection') continue;
    try {
      await validateAcknowledgedRepairProviderRead(tx, db, ref, projection, operation);
      return;
    } catch (error) {
      if (
        object(error).code !== 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' &&
        object(error).code !== 'PUBLISHING_CRITICAL_ACK_CANDIDATE_PENDING'
      )
        throw error;
    }
  }
  fail();
}
export interface CriticalRepairObservation {
  state: 'present' | 'absent';
  providerId: string;
  accountId: string;
  body?: Record<string, unknown>;
  originalHttpStatus?: number;
}
export interface CriticalRepairDependencies {
  authorizePartialStopInTransaction?: SermonDeletionPartialStopDependencies['authorizeInTransaction'];
  prepareUnclaimedReservationDisposition?: SermonDeletionPartialStopDependencies['prepareUnclaimedReservationDisposition'];
  firestore: Firestore;
  loadCertificate(ref: DurableJobRef, id: string): Promise<CriticalRepairCertificate>;
  authorizeOperation(operation: FixedRepairOperation): Promise<void>;
  /** Runtime-only identity of this exact certificate-bound SDK activity attempt. */
  getRepairObservationScope?(): Promise<string>;
  prepareFinalSettlement?(
    tx: Transaction,
    session: ProviderMutationSession,
    validateSourceCompletion: ProviderMutationReadyCanonicalCompletionValidator
  ): Promise<{ alreadyCommitted: boolean; commit(): void }>;
  commitCurrent(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
  readProvider?(
    operation: Extract<FixedRepairOperation, { kind: 'provider_read' }>
  ): Promise<CriticalRepairObservation>;
  authorizeCertifiedDeletionInTransaction?(
    tx: Transaction,
    operation: Extract<FixedRepairOperation, { kind: 'provider_delete' }>,
    phase: CertifiedPublishingDeletionAuthorizationPhase
  ): Promise<void>;
  prepareDeleteProvider?(
    operation: Extract<FixedRepairOperation, { kind: 'provider_delete' }>
  ): Promise<() => Promise<{ status: number }>>;
}
export interface CriticalRepairResult extends PublishingStepResult {
  providerEffects?: 'not_started' | 'partial';
  contentPreserved?: true;
  planId?: string;
  sessionId?: string;
  settledUiStepIds?: string[];
  settledMutationSessionIds?: string[];
  mode?: 'reconciled' | 'partial_stop';
  readsCompleted?: number;
  writesCompleted?: number;
  deletesCompleted?: number;
}
const routes: Partial<Record<RepairResourceType, string>> = {
  media: 'media/v1/media-items',
  audio: 'files/v1/audios',
  series: 'media/v1/media-series',
  list: 'builder/v1/lists',
  'list-row': 'builder/v1/list-rows',
  tag: 'tags/v1/tags',
};
const absent = (error: unknown) => [404, 410].includes(Number(object(object(error).response).status));
/** HAL pagination is restricted to the same fixed list/account route. No first-page absence proof. */
async function readCompleteRepairListRows(listId: string, token: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [],
    ids = new Set<string>(),
    pages = new Set<string>();
  let pageNumber = 1,
    total: number | undefined;
  const base = new URL('https://core.subsplash.com/builder/v1/list-rows');
  base.searchParams.set('filter[app_key]', '9XTSHD');
  base.searchParams.set('filter[source_list]', listId);
  base.searchParams.set('filter[unlisted]', 'include');
  base.searchParams.set('page[size]', '200');
  base.searchParams.set('sort', 'position');
  let next = base.toString();
  for (;;) {
    if (pages.has(next)) fail();
    pages.add(next);
    const response = object((await axios({ ...createAxiosConfig(next, token, 'GET'), timeout: 30000 })).data),
      batch = object(response._embedded)['list-rows'];
    if (!Array.isArray(batch)) fail();
    if (response.total !== undefined) {
      if (
        !Number.isSafeInteger(response.total) ||
        Number(response.total) < 0 ||
        (total !== undefined && total !== response.total)
      )
        fail();
      total = Number(response.total);
    }
    for (const entry of batch) {
      const row = object(entry),
        source = object(object(row._embedded)['source-list']);
      if (
        !safeId(row.id) ||
        ids.has(row.id) ||
        source.id !== listId ||
        (row.app_key !== undefined && row.app_key !== '9XTSHD')
      )
        fail();
      ids.add(row.id);
      rows.push(row);
    }
    const href = object(object(response._links).next).href;
    if (href !== undefined) {
      if (typeof href !== 'string') fail();
      const target = new URL(href, base);
      if (
        target.origin !== base.origin ||
        target.pathname !== base.pathname ||
        target.searchParams.get('filter[app_key]') !== '9XTSHD' ||
        target.searchParams.get('filter[source_list]') !== listId ||
        target.searchParams.get('filter[unlisted]') !== 'include'
      )
        fail();
      next = target.toString();
      continue;
    }
    if (total !== undefined && rows.length >= total) {
      if (rows.length !== total) fail();
      return rows;
    }
    if (batch.length < 200) {
      if (total !== undefined && rows.length !== total) fail();
      return rows;
    }
    pageNumber += 1;
    const target = new URL(base);
    target.searchParams.set('page[number]', String(pageNumber));
    next = target.toString();
  }
}
/** Enumerate every supported status without a catalog-size ceiling. Query failures never prove root absence. */
async function readCompleteRepairSeriesItems(seriesId: string, token: string): Promise<Record<string, unknown>[]> {
  const items = new Map<string, Record<string, unknown>>();
  for (const status of ['published', 'draft', 'scheduled']) {
    const base = new URL('https://core.subsplash.com/media/v1/media-items');
    for (const [key, value] of Object.entries({
      'filter[app_key]': '9XTSHD',
      'filter[media_series]': seriesId,
      'filter[status]': status,
      'filter[unlisted]': 'include',
      'page[size]': '200',
      sort: '-position',
      include: 'media-series',
    }))
      base.searchParams.set(key, value);
    let next = base.toString(),
      pageNumber = 1,
      total: number | undefined,
      count = 0;
    const pages = new Set<string>(),
      seen = new Set<string>();
    for (;;) {
      if (pages.has(next)) fail();
      pages.add(next);
      const response = object((await axios({ ...createAxiosConfig(next, token, 'GET'), timeout: 30000 })).data),
        batch = object(response._embedded)['media-items'];
      if (!Array.isArray(batch)) fail();
      if (response.total !== undefined) {
        if (
          !Number.isSafeInteger(response.total) ||
          Number(response.total) < 0 ||
          (total !== undefined && total !== response.total)
        )
          fail();
        total = Number(response.total);
      }
      for (const entry of batch) {
        const item = object(entry),
          series = object(object(item._embedded)['media-series']);
        if (!safeId(item.id) || seen.has(item.id) || item.app_key !== '9XTSHD' || series.id !== seriesId) fail();
        seen.add(item.id);
        count++;
        const prior = items.get(item.id);
        if (prior && criticalRepairDigest(prior) !== criticalRepairDigest(item)) fail();
        items.set(item.id, item);
      }
      const href = object(object(response._links).next).href;
      if (href !== undefined) {
        if (typeof href !== 'string') fail();
        const target = new URL(href, base);
        if (
          target.origin !== base.origin ||
          target.pathname !== base.pathname ||
          ['filter[app_key]', 'filter[media_series]', 'filter[status]', 'filter[unlisted]'].some(
            (key) => target.searchParams.get(key) !== base.searchParams.get(key)
          )
        )
          fail();
        next = target.toString();
        continue;
      }
      if (total !== undefined && count >= total) {
        if (count !== total) fail();
        break;
      }
      if (batch.length < 200) {
        if (total !== undefined && count !== total) fail();
        break;
      }
      pageNumber++;
      const target = new URL(base);
      target.searchParams.set('page[number]', String(pageNumber));
      next = target.toString();
    }
  }
  return [...items.values()];
}
async function readConcrete(
  op: Extract<FixedRepairOperation, { kind: 'provider_read' }>
): Promise<CriticalRepairObservation> {
  if (op.provider === 'soundcloud')
    return runWithSoundCloudAccessToken(async (token) => {
      const headers = { Authorization: `OAuth ${token}`, Accept: 'application/json' },
        account = normalizeSoundCloudAccountId(
          object((await axios.get('https://api.soundcloud.com/me', { headers, timeout: 30000, maxRedirects: 0 })).data)
        );
      if (account !== op.accountId) fail();
      try {
        const body = object(
          (
            await axios.get(`https://api.soundcloud.com/tracks/${encodeURIComponent(op.resourceId)}`, {
              headers,
              timeout: 30000,
              maxRedirects: 0,
            })
          ).data
        );
        if (
          ![body.id, body.id_str, body.urn].some((value) => value !== undefined && String(value) === op.resourceId) ||
          normalizeSoundCloudAccountId(object(body.user)) !== account
        )
          fail();
        return { state: 'present', providerId: op.resourceId, accountId: account, body };
      } catch (error) {
        if (absent(error))
          return {
            state: 'absent',
            providerId: op.resourceId,
            accountId: account,
            originalHttpStatus: Number(object(object(error).response).status),
          };
        throw error;
      }
    });
  const token = await authenticateSubsplash(),
    path = routes[op.resourceType];
  if (!path) fail();
  let body: Record<string, unknown>;
  try {
    body = object(
      (
        await axios({
          ...createAxiosConfig(
            `https://core.subsplash.com/${path}/${encodeURIComponent(op.resourceId)}${
              op.resourceType === 'media'
                ? '?include=audio,images,media-series,tags'
                : op.resourceType === 'series'
                ? '?include=images'
                : ''
            }`,
            token,
            'GET'
          ),
          timeout: 30000,
        })
      ).data
    );
  } catch (error) {
    if (absent(error))
      return {
        state: 'absent',
        providerId: op.resourceId,
        accountId: op.accountId,
        originalHttpStatus: Number(object(object(error).response).status),
      };
    throw error;
  }
  if (body.id !== op.resourceId || body.app_key !== '9XTSHD') fail();
  if (op.resourceType === 'list') {
    const rows = await readCompleteRepairListRows(op.resourceId, token);
    body._embedded = { ...object(body._embedded), 'list-rows': rows };
  }
  if (op.resourceType === 'series') {
    const items = await readCompleteRepairSeriesItems(op.resourceId, token);
    body._embedded = { ...object(body._embedded), 'media-items': items };
  }
  return { state: 'present', providerId: op.resourceId, accountId: op.accountId, body };
}
/** Authenticate and verify the fixed account before a guarded DELETE claim.
 * The returned closure performs exactly one original transport and captures its status. */
export async function prepareCertifiedCriticalDeleteTransport(
  ref: DurableJobRef,
  op: Extract<FixedRepairOperation, { kind: 'provider_delete' }>,
  deps: CriticalRepairDependencies
): Promise<() => Promise<{ status: number }>> {
  const checkpoint = deps.firestore.collection(PUBLISHING_DELETION_RECEIPTS).doc(
    createHash('sha256')
      .update(JSON.stringify([ref.projectId, ref.jobId, op.provider, op.resourceId]))
      .digest('hex')
  );
  await deps.authorizeOperation({ ...op, kind: 'provider_read', method: 'GET' });
  const prior = object((await checkpoint.get()).data());
  const originalOwned =
    prior.projectId === ref.projectId &&
    prior.jobId === ref.jobId &&
    prior.provider === op.provider &&
    prior.remoteId === op.resourceId &&
    prior.originalAccount === op.accountId &&
    prior.ownershipConfirmedBeforeDelete === true;
  if (op.provider === 'soundcloud')
    return runWithSoundCloudAccessToken(async (token) => {
      const me = await axios.get('https://api.soundcloud.com/me', {
        headers: { Authorization: `OAuth ${token}` },
        timeout: 30000,
        maxRedirects: 0,
      });
      if (me.status !== 200 || normalizeSoundCloudAccountId(me.data) !== op.accountId) fail();
      try {
        const track = await axios.get(`https://api.soundcloud.com/tracks/${encodeURIComponent(op.resourceId)}`, {
          headers: { Authorization: `OAuth ${token}` },
          timeout: 30000,
          maxRedirects: 0,
        });
        if (
          track.status !== 200 ||
          String(track.data?.id) !== op.resourceId ||
          normalizeSoundCloudAccountId(track.data?.user) !== op.accountId
        )
          fail();
      } catch (error) {
        if (!absent(error) || !originalOwned) throw error;
      }
      return async () => {
        let status: number | undefined;
        try {
          await deleteTrack(token, op.resourceId, {
            onResponse: (response) => {
              status = response.status;
            },
          });
        } catch (error) {
          const original = Number(object(object(error).response).status);
          if (![404, 410].includes(original)) throw error;
          status = original;
        }
        if (status === undefined) fail();
        return { status };
      };
    });
  const route = routes[op.resourceType];
  if (!route || op.accountId !== 'app:9XTSHD') fail();
  const token = await authenticateSubsplash();
  try {
    const response = await axios({
      ...createAxiosConfig(`https://core.subsplash.com/${route}/${encodeURIComponent(op.resourceId)}`, token, 'GET'),
      timeout: 30000,
    });
    if (response.status !== 200 || response.data?.id !== op.resourceId || response.data?.app_key !== '9XTSHD') fail();
  } catch (error) {
    if (!absent(error) || !originalOwned) throw error;
  }
  return async () => {
    try {
      const response = await axios({
        ...createAxiosConfig(
          `https://core.subsplash.com/${route}/${encodeURIComponent(op.resourceId)}`,
          token,
          'DELETE'
        ),
        timeout: 30000,
      });
      return { status: response.status };
    } catch (error) {
      const status = Number(object(object(error).response).status);
      if (![404, 410].includes(status)) throw error;
      return { status };
    }
  };
}
/** Persist only a certified fixed-resource observation attached to its original owned deletion authorization. */
async function recordCriticalDeletionAbsence(
  ref: DurableJobRef,
  certificateId: string,
  op: Extract<FixedRepairOperation, { kind: 'provider_read' }>,
  deps: CriticalRepairDependencies,
  observation?: CriticalRepairObservation,
  observationScope?: string,
  generation?: number
): Promise<void> {
  if (!['media', 'track'].includes(op.resourceType)) return;
  await deps.authorizeOperation(op);
  const journal = deps.firestore.collection(PUBLISHING_DELETION_RECEIPTS).doc(
    createHash('sha256')
      .update(JSON.stringify([ref.projectId, ref.jobId, op.provider, op.resourceId]))
      .digest('hex')
  );
  const target = {
    provider: op.provider,
    account: op.accountId,
    resourceType: op.resourceType,
    resourceId: op.resourceId,
  };
  const immutable =
    observationScope && generation && [404, 410].includes(Number(observation?.originalHttpStatus))
      ? {
          schemaVersion: 1 as const,
          ...ref,
          certificateId,
          generation,
          target,
          state: 'absent' as const,
          originalHttpStatus: observation!.originalHttpStatus as 404 | 410,
          originalAccount: op.accountId,
          ownershipConfirmedBeforeDelete: true as const,
          proof: 'authenticated_fixed_id_get_404_410' as const,
          observationScope,
        }
      : undefined;
  const proof = immutable
    ? deps.firestore.doc(criticalDeletionAbsenceProofPath(ref, certificateId, observationScope!, target))
    : undefined;
  await deps.commitCurrent(ref, async (tx) => {
    const current = await tx.get(journal),
      prior = proof ? await tx.get(proof) : undefined;
    if (!current.exists) return;
    const value = object(current.data());
    if (
      value.projectId !== ref.projectId ||
      value.jobId !== ref.jobId ||
      value.remoteId !== op.resourceId ||
      value.provider !== op.provider ||
      value.originalAccount !== op.accountId ||
      value.ownershipConfirmedBeforeDelete !== true ||
      !['authorized', 'absence_confirmed', 'reconciled'].includes(String(value.state))
    )
      fail();
    tx.update(journal, {
      ...(value.state === 'reconciled' ? {} : { state: 'absence_confirmed' }),
      absenceProof: 'authenticated_fixed_id_get_404_410',
      absenceClassification: 'verified_remote_absence_after_authorization',
      absenceConfirmedAtMillis: Date.now(),
      absenceCertificateId: certificateId,
    });
    if (proof && immutable) {
      if (prior?.exists) {
        if (certifiedDeletionDispositionDigest(prior.data()) !== certifiedDeletionDispositionDigest(immutable)) fail();
      } else tx.create(proof, immutable);
    }
  });
}
export const CRITICAL_DELETION_ABSENCES = 'temporalPublishingCriticalDeletionAbsences';
export function criticalDeletionAbsenceProofPath(
  ref: DurableJobRef,
  certificateId: string,
  observationScope: string,
  target: CertifiedDeletionFixedAbsenceRecord['target']
): string {
  return `${CRITICAL_DELETION_ABSENCES}/${publishingCriticalRepairDigest([
    ref.projectId,
    ref.jobId,
    certificateId,
    observationScope,
    target,
  ])}`;
}
export async function readCertifiedCriticalDeletionAbsence(
  tx: Transaction,
  db: Firestore,
  input: {
    ref: DurableJobRef;
    certificateId: string;
    generation: number;
    target: CertifiedDeletionFixedAbsenceRecord['target'];
    observationScope: string;
  }
): Promise<{ proofPath: string; proofDigest: string; observationScope: string }> {
  const path = criticalDeletionAbsenceProofPath(input.ref, input.certificateId, input.observationScope, input.target),
    record = await tx.get(db.doc(path)),
    value = record.data() as CertifiedDeletionFixedAbsenceRecord | undefined;
  if (
    !value ||
    value.projectId !== input.ref.projectId ||
    value.jobId !== input.ref.jobId ||
    value.certificateId !== input.certificateId ||
    value.generation !== input.generation ||
    value.observationScope !== input.observationScope ||
    publishingCriticalRepairDigest(value.target) !== publishingCriticalRepairDigest(input.target) ||
    value.state !== 'absent' ||
    ![404, 410].includes(value.originalHttpStatus) ||
    value.originalAccount !== input.target.account ||
    value.ownershipConfirmedBeforeDelete !== true ||
    value.proof !== 'authenticated_fixed_id_get_404_410'
  )
    fail();
  return {
    proofPath: path,
    proofDigest: certifiedDeletionDispositionDigest(value),
    observationScope: input.observationScope,
  };
}
/** Finish only the private original deletion inventory after every frozen
 * canonical program committed. This cannot start a desired provider operation. */
async function sealAcknowledgedDeletionSource(
  ref: DurableJobRef,
  operation: AcknowledgedProjectionOperation,
  deps: CriticalRepairDependencies
): Promise<
  | ((
      tx: Transaction,
      closedSeal?: ProviderMutationClosedEvidenceSeal
    ) => Promise<void | ProviderMutationReadyCanonicalCompletion>)
  | undefined
> {
  const immutable = (await deps.firestore.doc(`durableJobIntents/${ref.jobId}`).get()).data() as
    | DurableJobIntent<unknown>
    | undefined;
  if (!immutable || immutable.projectId !== ref.projectId || immutable.jobId !== ref.jobId) fail();
  const fenced = (mutate: (tx: Transaction) => Promise<void>) =>
    deps.commitCurrent(ref, async (tx) => {
      await deps.authorizeOperation(operation);
      await mutate(tx);
    });
  if (immutable.kind === 'list.delete') {
    const { plan } = await loadFactualListDeletionCleanup(deps.firestore, ref, immutable);
    await runCriticalPublishingRepair(
      ref.jobId,
      async () => {
        await removeListDeletionMirrors(deps.firestore, plan);
        await sealListDeletionCompletion(deps.firestore, plan);
      },
      fenced
    );
    if (plan.remoteListIds.length)
      await prepareListDeletionReady(deps.firestore, ref, plan, {
        commitCurrent: async <T>(current: DurableJobRef, mutate: (tx: Transaction) => Promise<T>) => {
          let result: T;
          await deps.commitCurrent(current, async (tx) => {
            await deps.authorizeOperation(operation);
            result = await mutate(tx);
          });
          return result!;
        },
      });
    return async (tx, closedSeal) => {
      await validateListDeletionCompletion(tx, deps.firestore, plan);
      if (!closedSeal) fail();
      const original = await tx.get(deps.firestore.doc(`temporalProviderMutationSessions/${operation.sessionId}`));
      const session = {
        db: deps.firestore,
        id: operation.sessionId,
        scope: original.get('scope'),
        resources: original.get('resources'),
      };
      return readListDeletionReadyCompletion(tx, deps.firestore, plan, session, closedSeal);
    };
  }
  if (immutable.kind === 'sermon.delete') {
    const plan = await loadSermonDeletionMirrorPlan(deps.firestore, ref, immutable.entity.id);
    await runCriticalPublishingRepair(
      ref.jobId,
      () =>
        removeSermonDeletionMirrors(deps.firestore, plan, {
          assertOriginalProviderEffects: async (tx) => {
            await deps.authorizeOperation(operation);
            await validateSermonDeletionEffectsForClosing(tx, deps.firestore, plan);
          },
        }),
      fenced
    );
    return (tx, closedSeal) => validateSermonDeletionCompletion(tx, deps.firestore, plan, closedSeal);
  }
  return undefined;
}
/** Dedicated certificate interpreter. No callable, desired handler, new POST, PUT, or arbitrary PATCH can run here. */
export async function repairPublishingCritical(
  ref: DurableJobRef,
  certificateId: string,
  deps: CriticalRepairDependencies
): Promise<CriticalRepairResult> {
  const certificate = await deps.loadCertificate(ref, certificateId);
  checkCertificate(certificate, ref);
  if (publishingCriticalRepairDigest(certificate) !== certificateId) fail();
  const zeroStop = certificate.operations.find(
    (operation): operation is PublishingZeroEffectsStopOperation => operation.kind === 'publishing_zero_effects_stop'
  );
  if (zeroStop) {
    if (certificate.operations.length !== 1) fail();
    await deps.authorizeOperation(zeroStop);
    const stopped = await runPublishingZeroEffectsStop(ref, zeroStop, {
      firestore: deps.firestore,
      authorizeInTransaction: async () => deps.authorizeOperation(zeroStop),
      commitCurrent: deps.commitCurrent,
    });
    return {
      ...stopped,
      settledMutationSessionIds: [zeroStop.sessionId],
      readsCompleted: 0,
      writesCompleted: 0,
      deletesCompleted: 0,
    };
  }
  const partialStopOperation = certificate.operations.find(
    (op): op is SermonDeletionPartialStopOperation => op.kind === 'sermon_deletion_partial_stop'
  );
  if (partialStopOperation) {
    if (
      certificate.operations.length !== 1 ||
      !deps.authorizePartialStopInTransaction ||
      !deps.prepareUnclaimedReservationDisposition
    )
      fail();
    await deps.authorizeOperation(partialStopOperation);
    const stopped = await runSermonDeletionPartialStop(ref, partialStopOperation, {
      firestore: deps.firestore,
      commitCurrent: deps.commitCurrent,
      authorizeInTransaction: deps.authorizePartialStopInTransaction,
      prepareUnclaimedReservationDisposition: deps.prepareUnclaimedReservationDisposition,
      authorizeRead: async (read) => {
        await deps.authorizeOperation(partialStopOperation);
        await deps.firestore.runTransaction((tx) =>
          validateSermonDeletionPartialStopRead(tx, deps.firestore, ref, partialStopOperation, read)
        );
      },
      readProvider: async (read) => {
        const op = { ...read, kind: 'provider_read' };
        if (!validateCriticalRepairOperation(op) || op.kind !== 'provider_read') fail();
        return deps.readProvider ? deps.readProvider(op) : readConcrete(op);
      },
    });
    return { ...stopped, providerEffects: 'partial', readsCompleted: 0, writesCompleted: 0, deletesCompleted: 0 };
  }
  const catalogDeletes = certificate.catalog
    ? await readCertifiedCriticalRepairDeleteSet(deps.firestore, ref, certificate.catalog)
    : { operations: [] as Extract<FixedRepairOperation, { kind: 'provider_delete' }>[], count: 0, digest: '' };
  const directDeletes = certificate.operations.filter(
      (op): op is Extract<FixedRepairOperation, { kind: 'provider_delete' }> => op.kind === 'provider_delete'
    ),
    deleteOperations = [...catalogDeletes.operations, ...directDeletes];
  const certifiedDeleteId = deleteOperations.length
    ? certifiedPublishingDeletionSessionId({
        ref,
        certificateId,
        generation: certificate.generation,
        operations: deleteOperations,
      })
    : undefined;
  // A read-only partial stop cannot settle an acknowledged but unprojected
  // mutable effect, or infer completion from a matching current GET.
  const certifiedSessions = new Set(
    certificate.operations
      .filter((op): op is AcknowledgedProjectionOperation => op.kind === 'acknowledged_projection')
      .map((op) => op.sessionId)
  );
  const held = (
    await abortProvablyUnsentProviderMutationSessionsForJob(
      deps.firestore,
      ref,
      async (mutate) => {
        let result: Awaited<ReturnType<typeof mutate>> | undefined;
        await deps.commitCurrent(ref, async (tx) => {
          result = await mutate(tx);
        });
        return result!;
      },
      { preserveSessionIds: certifiedDeleteId ? [certifiedDeleteId] : [] }
    )
  ).find(
    (session) =>
      session.state === 'active' && !certifiedSessions.has(session.sessionId) && session.sessionId !== certifiedDeleteId
  );
  if (held)
    return { state: 'blocked', code: 'PUBLISHING_CANCEL_MUTATION_REVIEW_REQUIRED', mutationSessionId: held.sessionId };
  if (certifiedDeleteId) {
    const persisted = await deps.firestore.doc(`${PROVIDER_MUTATION_SESSIONS}/${certifiedDeleteId}`).get();
    if (persisted.get('state') === 'committed') {
      const immutable = await deps.firestore.doc(`durableJobIntents/${ref.jobId}`).get();
      if (immutable.get('kind') !== 'sermon.delete' || !deps.prepareFinalSettlement)
        fail('PUBLISHING_CRITICAL_REPAIR_FINAL_SETTLEMENT_REQUIRED');
      const plan = await loadSermonDeletionMirrorPlan(deps.firestore, ref, immutable.get('entity.id'));
      const session = {
        db: deps.firestore,
        id: certifiedDeleteId,
        scope: persisted.get('scope'),
        resources: persisted.get('resources'),
      };
      await deps.commitCurrent(ref, async (tx) => {
        if (!deps.authorizeCertifiedDeletionInTransaction) fail('PUBLISHING_CRITICAL_DELETE_AUTHORITY_REQUIRED');
        for (const operation of deleteOperations)
          await deps.authorizeCertifiedDeletionInTransaction(tx, operation, 'settle');
        if (certificate.catalog)
          await validateCertifiedCriticalRepairDeleteSet(tx, deps.firestore, ref, certificate.catalog, catalogDeletes);
        const settled = await deps.prepareFinalSettlement!(tx, session, (transaction, _session, seal) =>
          validateSermonDeletionCompletion(transaction, deps.firestore, plan, seal)
        );
        if (!settled.alreadyCommitted) fail('PUBLISHING_CRITICAL_REPAIR_FINAL_SETTLEMENT_REQUIRED');
      });
      return {
        state: 'completed',
        mode: 'partial_stop',
        settledMutationSessionIds: [certifiedDeleteId],
        readsCompleted: 0,
        writesCompleted: 0,
        deletesCompleted: 0,
      };
    }
  }
  const deleteGuard = deleteOperations.length
    ? await createCertifiedPublishingDeletionGuard({
        ref,
        certificateId,
        generation: certificate.generation,
        firestore: deps.firestore,
        commitCurrent: deps.commitCurrent,
        getRepairObservationScope: async () => {
          if (!deps.getRepairObservationScope) fail('PUBLISHING_CRITICAL_DELETE_EXECUTION_SCOPE_REQUIRED');
          return deps.getRepairObservationScope();
        },
        readCompleteDeleteSet: async () => deleteOperations,
        validateCompleteDeleteSetInTransaction: async (tx, actual) => {
          if (publishingCriticalRepairDigest(actual) !== publishingCriticalRepairDigest(deleteOperations)) fail();
          if (certificate.catalog)
            await validateCertifiedCriticalRepairDeleteSet(
              tx,
              deps.firestore,
              ref,
              certificate.catalog,
              catalogDeletes
            );
        },
        authorizeCertifiedDeletionInTransaction: async (tx, operation, phase) => {
          if (!deps.authorizeCertifiedDeletionInTransaction) fail('PUBLISHING_CRITICAL_DELETE_AUTHORITY_REQUIRED');
          await deps.authorizeCertifiedDeletionInTransaction(tx, operation, phase);
        },
      })
    : undefined;
  const certifiedHandles = new Map<string, CertifiedPublishingDeletionHandle>();
  const completedDeletes = new Set<string>(),
    deleteKeys = new Set(
      deleteOperations.map((op) =>
        publishingCriticalRepairDigest({
          provider: op.provider,
          resourceType: op.resourceType,
          resourceId: op.resourceId,
          accountId: op.accountId,
        })
      )
    );
  const observations = new Map<string, CriticalRepairObservation>();
  const providerObservations: import('./criticalAcknowledgedRepair').AcknowledgedProviderObservation[] = [];
  const settledUiSteps = new Set<string>(),
    settledSessions = new Set<string>();
  let readsCompleted = 0,
    writesCompleted = 0,
    deletesCompleted = 0,
    partialStop = false,
    factualPrefixPreservesContent = false;
  const key = (resource: RepairResource) => publishingCriticalRepairDigest(resource);
  const read = async (op: Extract<FixedRepairOperation, { kind: 'provider_read' }>, persistAbsence = true) => {
    await deps.authorizeOperation(op);
    const value = await (deps.readProvider ?? readConcrete)(op);
    if (
      value.providerId !== op.resourceId ||
      value.accountId !== op.accountId ||
      !['present', 'absent'].includes(value.state)
    )
      fail();
    observations.set(
      key({ provider: op.provider, resourceType: op.resourceType, resourceId: op.resourceId, accountId: op.accountId }),
      value
    );
    const previous = providerObservations.findIndex(
      (item) =>
        item.provider === op.provider &&
        item.account === op.accountId &&
        item.resourceType === op.resourceType &&
        item.resourceId === op.resourceId
    );
    if (previous >= 0) providerObservations.splice(previous, 1);
    providerObservations.push({
      provider: op.provider,
      account: op.accountId,
      resourceType: op.resourceType,
      resourceId: op.resourceId,
      state: value.state,
      ...(value.body ? { body: value.body } : {}),
    });
    readsCompleted++;
    if (value.state === 'absent' && persistAbsence)
      await recordCriticalDeletionAbsence(
        ref,
        certificateId,
        op,
        deps,
        value,
        observationScope,
        certificate.generation
      );
    return value;
  };
  const operationStream = async function* () {
    if (certificate.catalog) {
      let cursor = 0;
      do {
        const page = await deps.firestore.runTransaction((tx) =>
          readCertifiedCriticalRepairOperations(tx, deps.firestore, ref, certificate.catalog!, cursor)
        );
        for (const entry of page.entries) yield entry.operation;
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      } while (true);
    }
    for (const operation of certificate.operations) yield operation;
  };
  const observationScope = deps.getRepairObservationScope ? await deps.getRepairObservationScope() : undefined;
  for await (const op of operationStream()) {
    if (!validateCriticalRepairOperation(op)) fail();
    if (op.kind === 'publishing_zero_effects_stop' || op.kind === 'sermon_deletion_partial_stop') fail();
    if (op.kind === 'local_sermon_delete') {
      await deps.authorizeOperation(op);
      await runLocalSermonDeletionRepair(ref, op, {
        firestore: deps.firestore,
        commitCurrent: deps.commitCurrent,
        authorizeInTransaction: async () => deps.authorizeOperation(op),
      });
      writesCompleted++;
      partialStop = true;
      continue;
    }
    if (op.kind === 'legacy_soundcloud_retain') {
      await deps.authorizeOperation(op);
      await abortCancelledDesiredProviderDeletions(deps.firestore, ref, deps);
      await deps.commitCurrent(ref, async (tx) => {
        const projection = await prepareLegacySoundCloudRetentionProjection(tx, deps.firestore, {
          ref,
          certificateId: op.certificateId,
          authorize: async () => deps.authorizeOperation(op),
        });
        projection.commit();
      });
      writesCompleted++;
      partialStop = true;
      const immutable = await deps.firestore.doc(`durableJobIntents/${ref.jobId}`).get();
      if (immutable.get('kind') === 'sermon.delete') {
        if (!deps.prepareFinalSettlement) fail('PUBLISHING_CRITICAL_REPAIR_FINAL_SETTLEMENT_REQUIRED');
        const finalized = await finalizeRetainedSoundCloudSermonDeletion(ref, op, {
          firestore: deps.firestore,
          commitCurrent: deps.commitCurrent,
          authorizeInTransaction: async () => deps.authorizeOperation(op),
          prepareFinalSettlement: deps.prepareFinalSettlement,
          verifyOtherProviderAbsent: async (target) => {
            const observed = await read({
              kind: 'provider_read',
              provider: target.provider,
              resourceType: target.resourceType,
              resourceId: target.resourceId,
              accountId: target.account,
              method: 'GET',
            });
            if (observed.state !== 'absent') fail();
          },
        });
        settledSessions.add(finalized.settledMutationSessionId);
      }
      continue;
    }
    if (op.kind === 'acknowledged_projection') {
      const immutable = await deps.firestore.doc(`durableJobIntents/${ref.jobId}`).get();
      if (immutable.get('kind') === 'sermon.delete') {
        const plan = await loadSermonDeletionMirrorPlan(deps.firestore, ref, immutable.get('entity.id'));
        const header = await deps.firestore.doc(`temporalSermonDeletionMirrorPlans/${plan.planId}`).get(),
          destination = header.get('destinationProgram') as SermonDeletionDestinationRef | undefined;
        if (destination) {
          await deps.authorizeOperation(op);
          await runCriticalPublishingRepair(
            ref.jobId,
            async () => {
              const token = await authenticateSubsplash();
              await verifySermonDeletionDestinationCounts(deps.firestore, destination, token, {
                authorizeRead: (target) =>
                  deps.authorizeOperation({
                    kind: 'provider_read',
                    provider: target.provider,
                    resourceType: target.resourceType,
                    resourceId: target.resourceId,
                    accountId: target.account,
                    method: 'GET',
                  }),
              });
            },
            (mutate) =>
              deps.commitCurrent(ref, async (tx) => {
                await deps.authorizeOperation(op);
                await mutate(tx);
              })
          );
        }
      }
      const source = await deps.firestore.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${op.sessionId}`).get();
      let committed: Awaited<ReturnType<typeof commitAcknowledgedRepair>> | undefined,
        validateSourceCompletion:
          | ((
              tx: Transaction,
              closedSeal?: ProviderMutationClosedEvidenceSeal
            ) => Promise<void | ProviderMutationReadyCanonicalCompletion>)
          | undefined;
      do {
        providerObservations.length = 0;
        if (source.get('schemaVersion') === 2) {
          if (!observationScope) fail('PUBLISHING_CRITICAL_ACK_EXECUTION_SCOPE_REQUIRED');
          const page = await deps.firestore.runTransaction((tx) =>
            readAcknowledgedRepairRequiredVerifications(tx, deps.firestore, ref, op, { observationScope })
          );
          for (const verification of page.verifications)
            await read({
              kind: 'provider_read',
              provider: verification.provider,
              resourceType: verification.resourceType,
              resourceId: verification.resourceId,
              accountId: verification.account,
              method: 'GET',
            });
        } else
          for (const verificationRead of certificate.operations)
            if (verificationRead.kind === 'provider_read') await read(verificationRead);
        await deps.authorizeOperation(op);
        await deps.commitCurrent(ref, async (tx) => {
          committed = await commitAcknowledgedRepair(tx, deps.firestore, ref, op, providerObservations, {
            observationScope,
            validateSourceCompletion,
          });
        });
        if (!committed) fail();
        writesCompleted += committed.writesCompleted;
        partialStop ||= committed.partialStop === true;
        if (committed.needsSourceCompletion) {
          validateSourceCompletion = await sealAcknowledgedDeletionSource(ref, op, deps);
          if (!validateSourceCompletion) fail();
          continue;
        }
        // Verification/proof pages stay within this exact SDK attempt. Return only
        // after a canonical page committed, so a new attempt can refresh its reads.
        if (committed.needsContinuation && committed.writesCompleted > 0)
          return {
            state: 'blocked',
            code: 'PUBLISHING_CRITICAL_REPAIR_PROJECTION_PENDING',
            readsCompleted,
            writesCompleted,
            deletesCompleted,
          };
      } while (committed.needsContinuation || committed.needsSourceCompletion);
      settledSessions.add(op.sessionId);
      // Only the immutable candidate's explicit root/reference preservation
      // proof may suppress cleanup. A generic partial result is insufficient.
      factualPrefixPreservesContent ||= committed.factualNonDestructiveStop === true;
      if (!committed.partialStop) for (const step of committed.settledUiStepIds ?? []) settledUiSteps.add(step);
      continue;
    }
    if (op.kind === 'provider_read') {
      await read(
        op,
        !deleteKeys.has(
          key({
            provider: op.provider,
            resourceType: op.resourceType,
            resourceId: op.resourceId,
            accountId: op.accountId,
          })
        ) ||
          completedDeletes.has(
            key({
              provider: op.provider,
              resourceType: op.resourceType,
              resourceId: op.resourceId,
              accountId: op.accountId,
            })
          )
      );
      continue;
    }
    if (op.kind === 'provider_delete') {
      const readOp: Extract<FixedRepairOperation, { kind: 'provider_read' }> = {
        ...op,
        kind: 'provider_read',
        method: 'GET',
      };
      if (!deleteGuard) fail('PUBLISHING_CRITICAL_DELETE_GUARD_REQUIRED');
      const send = deps.prepareDeleteProvider
        ? await deps.prepareDeleteProvider(op)
        : await prepareCertifiedCriticalDeleteTransport(ref, op, deps);
      const handle = await deleteGuard.execute(op, send);
      certifiedHandles.set(
        key({
          provider: op.provider,
          resourceType: op.resourceType,
          resourceId: op.resourceId,
          accountId: op.accountId,
        }),
        handle
      );
      deletesCompleted++;
      if ((await read(readOp)).state !== 'absent')
        return {
          state: 'blocked',
          code: 'PUBLISHING_CRITICAL_REPAIR_REQUIRED',
          mutationSessionId: deleteGuard.lease.session.id,
        };
      completedDeletes.add(
        key({
          provider: op.provider,
          resourceType: op.resourceType,
          resourceId: op.resourceId,
          accountId: op.accountId,
        })
      );
      continue;
    }
    // Membership metadata has no generic setter. Unsupported projections require a reviewed partial stop.
    if (op.field !== 'subsplashId' && op.field !== 'soundCloudTrackId')
      return { state: 'blocked', code: 'PUBLISHING_CRITICAL_REPAIR_REQUIRED' };
    const provider = op.field === 'subsplashId' ? 'subsplash' : 'soundcloud',
      fixedObservation = providerObservations.find(
        (value) => value.provider === provider && value.resourceId === op.expectedProviderId
      ),
      readOp =
        (certificate.operations.find(
          (candidate) =>
            candidate.kind === 'provider_read' &&
            candidate.provider === provider &&
            candidate.resourceId === op.expectedProviderId
        ) as Extract<FixedRepairOperation, { kind: 'provider_read' }> | undefined) ??
        (fixedObservation
          ? {
              kind: 'provider_read' as const,
              provider,
              resourceType: provider === 'subsplash' ? ('media' as const) : ('track' as const),
              resourceId: op.expectedProviderId,
              accountId: fixedObservation.account,
              method: 'GET' as const,
            }
          : undefined);
    if (
      !readOp ||
      !(await read(readOp)) ||
      observations.get(
        key({
          provider: readOp.provider,
          resourceType: readOp.resourceType,
          resourceId: readOp.resourceId,
          accountId: readOp.accountId,
        })
      )?.state !== 'absent'
    )
      return { state: 'blocked', code: 'PUBLISHING_CRITICAL_REPAIR_REQUIRED' };
    await deps.authorizeOperation(op);
    await deps.commitCurrent(ref, async (tx) => {
      const target = deps.firestore.doc(op.path),
        current = await tx.get(target);
      if (!current.exists || current.get(op.field) !== op.expectedProviderId) return;
      if (!/^sermons\/[^/]+$/.test(op.path)) fail();
      const sermonId = target.id;
      const retire = await preparePublishingAllocationRetirement(
        tx,
        deps.firestore,
        { ref, sermonId, provider },
        op.expectedProviderId
      );
      const patch =
        provider === 'subsplash'
          ? { subsplashId: FieldValue.delete(), 'status.subsplash': uploadStatus.NOT_UPLOADED }
          : {
              soundCloudTrackId: FieldValue.delete(),
              soundCloudTrackUrl: FieldValue.delete(),
              soundCloudPublication: FieldValue.delete(),
              'status.soundCloud': uploadStatus.NOT_UPLOADED,
            };
      tx.update(target, patch);
      retire();
      writesCompleted++;
    });
  }
  if (deleteGuard) {
    const immutable = await deps.firestore.doc(`durableJobIntents/${ref.jobId}`).get();
    if (immutable.get('kind') === 'sermon.delete') {
      if (!observationScope || !deps.authorizeCertifiedDeletionInTransaction) fail();
      const plan = await loadSermonDeletionMirrorPlan(deps.firestore, ref, immutable.get('entity.id'));
      const header = await deps.firestore.doc(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`).get(),
        requests = header.get('requests') as FrozenProjectionRequest[];
      if (!Array.isArray(requests) || !requests.length || typeof plan.operation !== 'string') fail();
      const originalSessionId = providerMutationFingerprint({
        projectId: ref.projectId,
        jobId: ref.jobId,
        operation: plan.operation,
      });
      const authorize = (
        tx: Transaction,
        operation: Extract<FixedRepairOperation, { kind: 'provider_delete' }>,
        phase: CertifiedPublishingDeletionAuthorizationPhase
      ) => deps.authorizeCertifiedDeletionInTransaction!(tx, operation, phase);
      for (const originalRequest of requests) {
        const target = originalRequest.target;
        if (originalRequest.method !== 'DELETE' || !target) fail('PUBLISHING_CRITICAL_DELETE_SOURCE_COVERAGE_REQUIRED');
        const handle = certifiedHandles.get(
          publishingCriticalRepairDigest({
            provider: target.provider,
            resourceType: target.resourceType,
            resourceId: target.resourceId,
            accountId: target.account,
          })
        );
        if (!handle) fail('PUBLISHING_CRITICAL_DELETE_SOURCE_COVERAGE_REQUIRED');
        await deps.commitCurrent(ref, async (tx) => {
          const disposition = await prepareCertifiedDeletionDisposition(tx, deps.firestore, {
            ref,
            certificateId,
            generation: certificate.generation,
            originalSessionId,
            originalRequest,
            certifiedHandle: handle,
            authorizeInTransaction: (transaction, authority, phase) =>
              authorize(transaction, authority.operation, phase),
            validateSourceHeaderInTransaction: (transaction, request) =>
              readSermonDeletionCertifiedSourceHeaderInTransaction(transaction, deps.firestore, {
                ref,
                sermonId: plan.sermonId,
                originalSessionId,
                originalRequest: request,
              }),
            validateFixedAbsenceInTransaction: (transaction, current) =>
              readCertifiedCriticalDeletionAbsence(transaction, deps.firestore, {
                ref,
                certificateId,
                generation: certificate.generation,
                target: {
                  provider: current.operation.provider,
                  account: current.operation.accountId,
                  resourceType: current.operation.resourceType,
                  resourceId: current.operation.resourceId,
                },
                observationScope,
              }),
          });
          disposition.commit();
        });
      }
      await deps.commitCurrent(ref, async (tx) => {
        const closure = await deleteGuard.prepareEffectsClosed(tx, async (transaction, lease) =>
          validateSermonDeletionCertifiedEffectsForClosing(transaction, deps.firestore, {
            plan,
            session: lease.session,
          })
        );
        closure.commit();
      });
      const fenced = (mutate: (tx: Transaction) => Promise<void>) =>
        deps.commitCurrent(ref, async (tx) => {
          for (const operation of deleteOperations) await authorize(tx, operation, 'close');
          await mutate(tx);
        });
      await runCriticalPublishingRepair(
        ref.jobId,
        () =>
          removeSermonDeletionMirrors(deps.firestore, plan, {
            assertOriginalProviderEffects: async (tx) => {
              for (const operation of deleteOperations) await authorize(tx, operation, 'close');
              await validateSermonDeletionCertifiedEffectsForClosing(tx, deps.firestore, {
                plan,
                session: deleteGuard.lease.session,
              });
            },
          }),
        fenced
      );
      await deps.commitCurrent(ref, async (tx) => {
        const settlement = await deleteGuard.prepareFinalSettlement(tx, (transaction, _session, seal) =>
          validateSermonDeletionCompletion(transaction, deps.firestore, plan, seal)
        );
        if (settlement.alreadyCommitted) return;
        const indexes = [];
        for (const operation of deleteOperations) {
          if (operation.resourceType !== 'media' && operation.resourceType !== 'track') fail();
          indexes.push(
            await prepareDesiredProviderDeletionSettlement(tx, deps.firestore, {
              resource: {
                projectId: ref.projectId,
                provider: operation.provider,
                account: operation.provider === 'subsplash' ? 'app:9XTSHD' : 'configured-account',
                remoteId: operation.resourceId,
              },
              jobId: ref.jobId,
              resourceType: operation.resourceType,
            })
          );
        }
        for (const commit of indexes) commit();
        settlement.commit();
      });
      settledSessions.add(deleteGuard.lease.session.id);
      return {
        state: 'completed',
        mode: 'partial_stop',
        settledMutationSessionIds: [...settledSessions].sort(),
        readsCompleted,
        writesCompleted,
        deletesCompleted,
      };
    }
  }
  if (deleteGuard)
    return {
      state: 'blocked',
      code: 'PUBLISHING_CRITICAL_REPAIR_FINAL_SETTLEMENT_REQUIRED',
      mutationSessionId: deleteGuard.lease.session.id,
      readsCompleted,
      writesCompleted,
      deletesCompleted,
    };
  return {
    state: 'completed',
    ...(settledSessions.size ? { settledMutationSessionIds: [...settledSessions].sort() } : {}),
    ...(!partialStop && settledUiSteps.size ? { settledUiStepIds: [...settledUiSteps].sort() } : {}),
    ...(partialStop &&
    factualPrefixPreservesContent &&
    deletesCompleted === 0 &&
    certificate.operations.filter((op) => op.kind === 'acknowledged_projection').length === 1 &&
    certificate.operations.every((op) => op.kind === 'acknowledged_projection' || op.kind === 'provider_read')
      ? { providerEffects: 'partial' as const, contentPreserved: true as const }
      : {}),
    mode:
      !partialStop &&
      certificate.operations.some((op) => op.kind === 'canonical_repair' || op.kind === 'acknowledged_projection')
        ? 'reconciled'
        : 'partial_stop',
    readsCompleted,
    writesCompleted,
    deletesCompleted,
  };
}
