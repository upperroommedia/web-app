import { FieldPath, FieldValue, type Firestore, type Transaction, type Query } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import { getPublishingSourceStepIds } from './durableOperationContext';
import { localSermonDeletionHeaderProjection } from './localSermonDeletionRepair';
import { acknowledgedProjectionDigest } from './criticalAcknowledgedRepair';
import {
  PROVIDER_MUTATION_SESSIONS,
  providerMutationFingerprint,
  validateProviderMutationOriginalCompletion,
  type ProviderMutationSession,
} from './providerMutationGuard';
import {
  prepareReviewedLegacySoundCloudRetentionBinding,
  PROVIDER_USAGE_CONTROL,
  PROVIDER_USAGE_COLLECTION,
  assertProviderUsageMarker,
  providerResourceKey,
  providerEdgeKey,
  desiredProviderDeletionDocumentFingerprint,
  type ProviderResource,
} from '../../../../packages/orchestration/src/provider-usage';

export const LEGACY_SOUNDCLOUD_RETENTION_OBSERVATIONS = 'temporalLegacySoundCloudRetentionObservations';
export const LEGACY_SOUNDCLOUD_RETENTION_CERTIFICATES = 'temporalLegacySoundCloudRetentionCertificates';
export const LEGACY_SOUNDCLOUD_RETENTIONS = 'temporalLegacySoundCloudRetentions';
const PAGE_SIZE = 64;
const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
const id = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256 && !/[\s/?#]/.test(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (code = 'LEGACY_SOUNDCLOUD_RETENTION_PROOF_REQUIRED'): never => {
  throw Object.assign(new Error(code), { code });
};
export type LegacySoundCloudRetentionOperation = Readonly<{ kind: 'legacy_soundcloud_retain'; certificateId: string }>;
export interface LegacySoundCloudRetentionCertificate {
  schemaVersion: 1;
  projectId: string;
  jobId: string;
  generation: number;
  workflowId: string;
  sermonId: string;
  trackId: string;
  intentFingerprint: string;
  canonicalDocumentDigest: string;
  observationDigest: string;
  originalOwner: 'unverified';
  observedCurrentAccount: string;
  disposition: 'permanent_retention_without_absence_claim';
  resource: ProviderResource;
  sourceStepIds: string[];
  sourceParentRef: DurableJobRef;
  mirrorStepEvidence?: { path: string; digest: string };
}
interface InitialMissingObservation {
  schemaVersion: 1;
  projectId: string;
  jobId: string;
  generation: number;
  workflowId: string;
  sermonId: string;
  trackId: string;
  intentFingerprint: string;
  canonicalDocumentDigest: string;
  originalHttpStatus: 404;
  observedCurrentAccount: string;
  originalOwner: 'unverified';
  providerMutationSent: false;
  sourceStepIds: string[];
  sourceParentRef: DurableJobRef;
}
function validateSourceSteps(value: unknown, parent: unknown, ref: DurableJobRef): string[] {
  const scoped = object(parent);
  if (
    Object.keys(scoped).length !== 2 ||
    scoped.projectId !== ref.projectId ||
    scoped.jobId !== ref.jobId ||
    !Array.isArray(value) ||
    !value.length ||
    value.length > 32 ||
    value.some((step) => typeof step !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(step)) ||
    new Set(value).size !== value.length
  )
    return fail('LEGACY_SOUNDCLOUD_RETENTION_STEP_AUTHORITY_REQUIRED');
  return [...value].sort();
}
/** Only original no-SEND observation/header metadata can authorize UI steps. */
export async function readLegacySoundCloudRetentionStepAuthority(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  certificate: LegacySoundCloudRetentionCertificate
): Promise<{ sourceStepIds: string[]; sourceParentRef: DurableJobRef }> {
  const observation = await tx.get(db.doc(`${LEGACY_SOUNDCLOUD_RETENTION_OBSERVATIONS}/${ref.jobId}`));
  if (
    !observation.exists ||
    acknowledgedProjectionDigest(observation.data()) !== certificate.observationDigest ||
    observation.get('projectId') !== ref.projectId ||
    observation.get('jobId') !== ref.jobId ||
    observation.get('generation') !== certificate.generation ||
    observation.get('workflowId') !== certificate.workflowId ||
    observation.get('intentFingerprint') !== certificate.intentFingerprint ||
    observation.get('trackId') !== certificate.trackId
  )
    return fail();
  const intent = await tx.get(db.doc(`durableJobIntents/${ref.jobId}`));
  if (
    !intent.exists ||
    acknowledgedProjectionDigest(intent.data()) !== certificate.intentFingerprint ||
    (intent.get('kind') === 'sermon.delete' && !certificate.mirrorStepEvidence)
  )
    return fail();
  const ids = validateSourceSteps(observation.get('sourceStepIds'), observation.get('sourceParentRef'), ref);
  if (certificate.mirrorStepEvidence) {
    const evidence = certificate.mirrorStepEvidence,
      header = object((await tx.get(db.doc(evidence.path))).data());
    if (
      header.projectId !== ref.projectId ||
      header.jobId !== ref.jobId ||
      header.generation !== certificate.generation ||
      header.workflowId !== certificate.workflowId ||
      header.sermonId !== certificate.sermonId ||
      header.originalRoot?.soundCloudTrackId !== certificate.trackId ||
      acknowledgedProjectionDigest(localSermonDeletionHeaderProjection(header)) !== evidence.digest
    )
      return fail();
    ids.push(...validateSourceSteps(header.sourceStepIds, header.sourceParentRef, ref));
  }
  const actual = [...new Set(ids)].sort(),
    expected = validateSourceSteps(certificate.sourceStepIds, certificate.sourceParentRef, ref);
  if (acknowledgedProjectionDigest(actual) !== acknowledgedProjectionDigest(expected)) return fail();
  return { sourceStepIds: actual, sourceParentRef: { projectId: ref.projectId, jobId: ref.jobId } };
}
async function* transactionPages(tx: Transaction, query: Query) {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    const ordered = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    const page = await tx.get(cursor ? ordered.startAfter(cursor) : ordered);
    if (page.empty) return;
    yield page.docs;
    cursor = page.docs[page.docs.length - 1];
    if (page.size < PAGE_SIZE) return;
  }
}
const scIdentity = (path: string, data: unknown): Record<string, unknown> => {
  const value = object(data);
  return {
    path,
    soundCloudTrackId: value.soundCloudTrackId,
    soundCloudTrackUrl: value.soundCloudTrackUrl,
    soundCloudPublication: value.soundCloudPublication,
    statusSoundCloud: object(value.status).soundCloud,
  };
};
async function source(
  tx: Transaction,
  db: Firestore,
  input: { ref: DurableJobRef; expectedRevision?: number },
  allowDetached = false,
  allowCertifiedCancel = false
) {
  const { ref } = input;
  if (!id(ref.projectId) || !id(ref.jobId)) return fail();
  const [jobSnapshot, intentSnapshot] = await Promise.all([
    tx.get(db.doc(`durableJobs/${ref.jobId}`)),
    tx.get(db.doc(`durableJobIntents/${ref.jobId}`)),
  ]);
  const job = object(jobSnapshot.data()),
    intent = object(intentSnapshot.data());
  const privateIntent = object(intent.payload),
    privatePayload = object(privateIntent.payload),
    admitted = object(privatePayload.sermon);
  const sermonId = object(intent.entity).id,
    trackId = admitted.soundCloudTrackId;
  const allowedKind = ['sermon.delete', 'sermon.unpublish', 'sermon.update'].includes(intent.kind);
  const approvedRemoval =
    privateIntent.action === 'delete' ||
    (privateIntent.action === 'unpublish' && object(privateIntent.destinations).soundcloud === true) ||
    (privateIntent.action === 'publish' &&
      (object(privatePayload.removals).soundcloud === true ||
        object(privatePayload.processAudio).soundcloudPolicy === 'recreate_track'));
  if (
    !jobSnapshot.exists ||
    !intentSnapshot.exists ||
    job.projectId !== ref.projectId ||
    job.jobId !== ref.jobId ||
    intent.projectId !== ref.projectId ||
    intent.jobId !== ref.jobId ||
    job.generation !== intent.generation ||
    job.kind !== intent.kind ||
    object(job.entity).type !== 'sermon' ||
    object(intent.entity).type !== 'sermon' ||
    object(job.entity).id !== sermonId ||
    privateIntent.sermonId !== sermonId ||
    privateIntent.generation !== intent.generation ||
    !allowedKind ||
    !approvedRemoval ||
    !Number.isSafeInteger(intent.generation) ||
    intent.generation < 1 ||
    !id(job.workflowId) ||
    !id(sermonId) ||
    !id(trackId) ||
    (!['running', 'retrying', 'reconciling', 'needs_attention'].includes(job.state) &&
      !(allowCertifiedCancel && job.state === 'cancel_requested')) ||
    (input.expectedRevision !== undefined && job.revision !== input.expectedRevision)
  )
    return fail();
  const canonical = await tx.get(db.doc(`sermons/${sermonId}`));
  const allocation = await tx.get(
    db
      .collection('temporalPublishingAllocations')
      .doc(providerMutationFingerprint([ref.projectId, sermonId, 'soundcloud']))
  );
  if (
    allocation.exists &&
    (allocation.get('state') === 'allocating' ||
      (allocation.get('state') === 'bound' && allocation.get('remoteId') === trackId))
  )
    return fail('LEGACY_SOUNDCLOUD_RETENTION_ORIGINAL_OWNER_BOUND');
  if (
    !canonical.exists ||
    (canonical.get('soundCloudTrackId') !== trackId &&
      !(allowDetached && canonical.get('soundCloudTrackId') === undefined))
  )
    return fail('LEGACY_SOUNDCLOUD_RETENTION_CANONICAL_CHANGED');
  return {
    job,
    intent,
    canonical,
    sermonId: sermonId as string,
    trackId: trackId as string,
    generation: intent.generation as number,
    workflowId: job.workflowId as string,
    intentFingerprint: acknowledgedProjectionDigest(intent),
    canonicalDocumentDigest: acknowledgedProjectionDigest(scIdentity(canonical.ref.path, canonical.data())),
  };
}
/** Every mutable original request is checked. This protocol never overrides a pending
 * RPC, positive but unprojectable response, or original create execution.
 */
async function assertNoSoundCloudSendOrUnsafeWork(tx: Transaction, db: Firestore, ref: DurableJobRef): Promise<void> {
  const sessions = db
    .collection(PROVIDER_MUTATION_SESSIONS)
    .where('scope.projectId', '==', ref.projectId)
    .where('scope.jobId', '==', ref.jobId);
  for await (const page of transactionPages(tx, sessions))
    for (const row of page) {
      const value = object(row.data()),
        scope = object(value.scope);
      if (
        scope.projectId !== ref.projectId ||
        scope.jobId !== ref.jobId ||
        providerMutationFingerprint(scope) !== row.id ||
        !['active', 'committed', 'aborted'].includes(value.state) ||
        !Array.isArray(value.resources)
      )
        return fail();
      const session: ProviderMutationSession = {
        db,
        id: row.id,
        scope: scope as ProviderMutationSession['scope'],
        resources: value.resources,
      };
      for await (const requests of transactionPages(tx, row.ref.collection('requests'))) {
        if (requests.some((request) => !['acknowledged', 'rejected_no_effect'].includes(request.get('state'))))
          return fail('LEGACY_SOUNDCLOUD_RETENTION_UNSETTLED_RPC');
        await validateProviderMutationOriginalCompletion(tx, session, requests);
        const planned = await tx.getAll(
          ...requests.map((request) =>
            db.doc(
              `temporalPublishingAcknowledgedProjections/${row.id}/requestIndex/${providerMutationFingerprint(
                request.get('step')
              )}`
            )
          )
        );
        planned.forEach((record, index) => {
          const request = object(record.get('request')),
            target = object(request.target);
          if (
            !record.exists ||
            request.step !== requests[index].get('step') ||
            request.method !== requests[index].get('method') ||
            request.fingerprint !== requests[index].get('fingerprint')
          )
            return fail();
          if (target.provider === 'soundcloud')
            return fail('LEGACY_SOUNDCLOUD_RETENTION_PROVIDER_REQUEST_ALREADY_SENT');
        });
      }
    }
  const receipts = db
    .collection('temporalProviderReceipts')
    .where('projectId', '==', ref.projectId)
    .where('jobId', '==', ref.jobId);
  for await (const page of transactionPages(tx, receipts))
    for (const row of page) {
      const receipt = object(row.data());
      if (receipt.state === 'executing' || receipt.state === 'needs_review')
        return fail('LEGACY_SOUNDCLOUD_RETENTION_UNSETTLED_CREATE');
      if (receipt.step === 'soundcloud-track' && receipt.state !== 'prepared')
        return fail('LEGACY_SOUNDCLOUD_RETENTION_ORIGINAL_OWNER_BOUND');
    }
  const journals = db
    .collection('temporalPublishingDeletionReceipts')
    .where('projectId', '==', ref.projectId)
    .where('jobId', '==', ref.jobId);
  for await (const page of transactionPages(tx, journals))
    if (page.some((row) => row.get('provider') === 'soundcloud'))
      return fail('LEGACY_SOUNDCLOUD_RETENTION_ORIGINAL_OWNER_BOUND');
}

/** Source-only observation of an initial exact-ID GET404. It asserts neither actual
 * absence nor the original owner's identity and grants no local or remote mutation.
 */
export async function prepareLegacySoundCloudInitialMissingObservation(
  tx: Transaction,
  db: Firestore,
  input: {
    ref: DurableJobRef;
    requestedTrackId: string;
    originalHttpStatus: 404;
    observedCurrentAccount: string;
  }
): Promise<{ observation: InitialMissingObservation; digest: string; commit(): void }> {
  const state = await source(tx, db, input);
  if (
    input.requestedTrackId !== state.trackId ||
    input.originalHttpStatus !== 404 ||
    !/^soundcloud:users:[0-9]+$/.test(input.observedCurrentAccount)
  )
    return fail();
  await assertNoSoundCloudSendOrUnsafeWork(tx, db, input.ref);
  const observation: InitialMissingObservation = {
    schemaVersion: 1,
    projectId: input.ref.projectId,
    jobId: input.ref.jobId,
    generation: state.generation,
    workflowId: state.workflowId,
    sermonId: state.sermonId,
    trackId: state.trackId,
    intentFingerprint: state.intentFingerprint,
    canonicalDocumentDigest: state.canonicalDocumentDigest,
    originalHttpStatus: 404,
    observedCurrentAccount: input.observedCurrentAccount,
    originalOwner: 'unverified',
    providerMutationSent: false,
    sourceStepIds: getPublishingSourceStepIds(input.ref.jobId),
    sourceParentRef: { projectId: input.ref.projectId, jobId: input.ref.jobId },
  };
  const digest = acknowledgedProjectionDigest(observation),
    target = db.collection(LEGACY_SOUNDCLOUD_RETENTION_OBSERVATIONS).doc(input.ref.jobId),
    previous = await tx.get(target);
  if (previous.exists && acknowledgedProjectionDigest(previous.data()) !== digest) return fail();
  return {
    observation,
    digest,
    commit: () => {
      if (!previous.exists) tx.create(target, observation);
    },
  };
}

/** Read-only until commit, allowing the operator coordinator to atomically grant a
 * reviewed capability. Account and resource identities come exclusively from source.
 */
export async function prepareLegacySoundCloudRetention(
  tx: Transaction,
  db: Firestore,
  input: { ref: DurableJobRef; expectedRevision?: number }
): Promise<{
  certificate: LegacySoundCloudRetentionCertificate;
  certificateId: string;
  digest: string;
  commit(): void;
}> {
  const state = await source(tx, db, input);
  await assertNoSoundCloudSendOrUnsafeWork(tx, db, input.ref);
  const observationSnapshot = await tx.get(
      db.collection(LEGACY_SOUNDCLOUD_RETENTION_OBSERVATIONS).doc(input.ref.jobId)
    ),
    observation = object(observationSnapshot.data());
  if (
    !observationSnapshot.exists ||
    observation.schemaVersion !== 1 ||
    observation.projectId !== input.ref.projectId ||
    observation.jobId !== input.ref.jobId ||
    observation.generation !== state.generation ||
    observation.workflowId !== state.workflowId ||
    observation.sermonId !== state.sermonId ||
    observation.trackId !== state.trackId ||
    observation.intentFingerprint !== state.intentFingerprint ||
    observation.canonicalDocumentDigest !== state.canonicalDocumentDigest ||
    observation.originalHttpStatus !== 404 ||
    observation.originalOwner !== 'unverified' ||
    observation.providerMutationSent !== false ||
    typeof observation.observedCurrentAccount !== 'string' ||
    !/^soundcloud:users:[0-9]+$/.test(observation.observedCurrentAccount)
  )
    return fail();
  const sourceStepIds = validateSourceSteps(observation.sourceStepIds, observation.sourceParentRef, input.ref);
  let mirrorStepEvidence: { path: string; digest: string } | undefined;
  if (state.intent.kind === 'sermon.delete') {
    const { sermonDeletionMirrorPlanId, SERMON_DELETION_MIRROR_PLANS } = await import(
      '../../helpers/sermonDeletionMirrors'
    );
    const path = `${SERMON_DELETION_MIRROR_PLANS}/${sermonDeletionMirrorPlanId(input.ref, state.sermonId)}`,
      header = object((await tx.get(db.doc(path))).data());
    if (
      header.schemaVersion !== 1 ||
      header.projectId !== input.ref.projectId ||
      header.jobId !== input.ref.jobId ||
      header.sermonId !== state.sermonId ||
      header.generation !== state.generation ||
      header.workflowId !== state.workflowId ||
      header.originalRoot?.soundCloudTrackId !== state.trackId ||
      header.originalRootDigest !== acknowledgedProjectionDigest(header.originalRoot) ||
      header.intentFingerprint !== desiredProviderDeletionDocumentFingerprint(state.intent)
    )
      return fail();
    sourceStepIds.push(...validateSourceSteps(header.sourceStepIds, header.sourceParentRef, input.ref));
    mirrorStepEvidence = { path, digest: acknowledgedProjectionDigest(localSermonDeletionHeaderProjection(header)) };
  }
  const certificate: LegacySoundCloudRetentionCertificate = {
    schemaVersion: 1,
    projectId: input.ref.projectId,
    jobId: input.ref.jobId,
    generation: state.generation,
    workflowId: state.workflowId,
    sermonId: state.sermonId,
    trackId: state.trackId,
    intentFingerprint: state.intentFingerprint,
    canonicalDocumentDigest: state.canonicalDocumentDigest,
    observationDigest: acknowledgedProjectionDigest(observation),
    originalOwner: 'unverified',
    observedCurrentAccount: observation.observedCurrentAccount,
    disposition: 'permanent_retention_without_absence_claim',
    resource: {
      projectId: input.ref.projectId,
      provider: 'soundcloud',
      account: 'configured-account',
      remoteId: state.trackId,
    },
    sourceStepIds: [...new Set(sourceStepIds)].sort(),
    sourceParentRef: { projectId: input.ref.projectId, jobId: input.ref.jobId },
    ...(mirrorStepEvidence ? { mirrorStepEvidence } : {}),
  };
  validateSourceSteps(certificate.sourceStepIds, certificate.sourceParentRef, input.ref);
  const digest = acknowledgedProjectionDigest(certificate),
    target = db.collection(LEGACY_SOUNDCLOUD_RETENTION_CERTIFICATES).doc(digest),
    previous = await tx.get(target);
  if (previous.exists && acknowledgedProjectionDigest(previous.data()) !== digest) return fail();
  return {
    certificate,
    certificateId: digest,
    digest,
    commit: () => {
      if (!previous.exists) tx.create(target, certificate);
    },
  };
}

export async function loadValidatedLegacySoundCloudRetentionCertificate(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  certificateId: string
): Promise<LegacySoundCloudRetentionCertificate> {
  if (!sha(certificateId)) return fail();
  const row = await tx.get(db.collection(LEGACY_SOUNDCLOUD_RETENTION_CERTIFICATES).doc(certificateId)),
    certificate = object(row.data());
  if (
    !row.exists ||
    acknowledgedProjectionDigest(certificate) !== certificateId ||
    certificate.schemaVersion !== 1 ||
    certificate.projectId !== ref.projectId ||
    certificate.jobId !== ref.jobId ||
    !Number.isSafeInteger(certificate.generation) ||
    certificate.generation < 1 ||
    !id(certificate.workflowId) ||
    !id(certificate.sermonId) ||
    !id(certificate.trackId) ||
    !sha(certificate.intentFingerprint) ||
    !sha(certificate.canonicalDocumentDigest) ||
    !sha(certificate.observationDigest) ||
    certificate.originalOwner !== 'unverified' ||
    certificate.disposition !== 'permanent_retention_without_absence_claim' ||
    !/^soundcloud:users:[0-9]+$/.test(certificate.observedCurrentAccount) ||
    object(certificate.resource).projectId !== ref.projectId ||
    certificate.resource.provider !== 'soundcloud' ||
    certificate.resource.account !== 'configured-account' ||
    certificate.resource.remoteId !== certificate.trackId
  )
    return fail();
  validateSourceSteps(certificate.sourceStepIds, certificate.sourceParentRef, ref);
  if (
    certificate.mirrorStepEvidence !== undefined &&
    (!sha(certificate.mirrorStepEvidence.digest) ||
      typeof certificate.mirrorStepEvidence.path !== 'string' ||
      !/^temporalSermonDeletionMirrorPlans\/[a-f0-9]{64}$/.test(certificate.mirrorStepEvidence.path))
  )
    return fail();
  return certificate as LegacySoundCloudRetentionCertificate;
}
/** No HTTP or completion fact. Permanent index retention and local detachment share
 * one fresh-admin authorized, generation/SDK-fenced indexed transaction supplied by runtime.
 */
export async function prepareLegacySoundCloudRetentionProjection(
  tx: Transaction,
  db: Firestore,
  input: {
    ref: DurableJobRef;
    certificateId: string;
    authorize(tx: Transaction, certificate: LegacySoundCloudRetentionCertificate): Promise<void>;
  }
): Promise<{ certificate: LegacySoundCloudRetentionCertificate; commit(): void }> {
  if (typeof input.authorize !== 'function') return fail('LEGACY_SOUNDCLOUD_RETENTION_AUTHORITY_REQUIRED');
  const certificate = await loadValidatedLegacySoundCloudRetentionCertificate(tx, db, input.ref, input.certificateId);
  await input.authorize(tx, certificate);
  const grant = await tx.get(db.collection('durableJobCriticalRepairGrants').doc(input.ref.jobId));
  const review = object(grant.data());
  if (
    !grant.exists ||
    review.schemaVersion !== 1 ||
    review.projectId !== input.ref.projectId ||
    review.jobId !== input.ref.jobId ||
    review.generation !== certificate.generation ||
    review.workflowId !== certificate.workflowId ||
    review.intentFingerprint !== certificate.intentFingerprint ||
    review.retentionAcknowledged !== true ||
    !Array.isArray(review.sourceCertificateIds) ||
    !review.sourceCertificateIds.includes(input.certificateId) ||
    !id(review.actorUid) ||
    !id(review.commandId) ||
    typeof review.reason !== 'string' ||
    !review.reason.trim() ||
    review.reason.length > 2000 ||
    typeof review.evidenceReference !== 'string' ||
    !review.evidenceReference.trim() ||
    review.evidenceReference.length > 2000 ||
    !Array.isArray(review.operations) ||
    !review.operations.some((operation: unknown) => {
      const op = object(operation);
      return (
        op.kind === 'legacy_soundcloud_retain' &&
        op.certificateId === input.certificateId &&
        Object.keys(op).length === 2
      );
    })
  )
    return fail('LEGACY_SOUNDCLOUD_RETENTION_OPERATOR_REVIEW_REQUIRED');
  const audit = db.collection(LEGACY_SOUNDCLOUD_RETENTIONS).doc(input.certificateId),
    previous = await tx.get(audit);
  const state = await source(tx, db, input, previous.exists, true);
  if (state.job.state === 'cancel_requested') {
    const cancellation = await tx.get(db.doc(`durableJobCancellationIntents/${input.ref.jobId}`));
    if (
      !cancellation.exists ||
      cancellation.get('purpose') !== 'critical_repair_cleanup' ||
      cancellation.get('projectId') !== input.ref.projectId ||
      cancellation.get('jobId') !== input.ref.jobId ||
      cancellation.get('generation') !== certificate.generation ||
      cancellation.get('workflowId') !== certificate.workflowId ||
      !sha(review.certificateId) ||
      cancellation.get('certificateId') !== review.certificateId
    )
      return fail('LEGACY_SOUNDCLOUD_RETENTION_REVIEWED_CLEANUP_REQUIRED');
  }
  if (
    certificate.generation !== state.generation ||
    certificate.workflowId !== state.workflowId ||
    certificate.sermonId !== state.sermonId ||
    certificate.trackId !== state.trackId ||
    certificate.intentFingerprint !== state.intentFingerprint ||
    (!previous.exists && certificate.canonicalDocumentDigest !== state.canonicalDocumentDigest)
  )
    return fail();
  await assertNoSoundCloudSendOrUnsafeWork(tx, db, input.ref);
  const observation = await tx.get(db.collection(LEGACY_SOUNDCLOUD_RETENTION_OBSERVATIONS).doc(input.ref.jobId));
  if (!observation.exists || acknowledgedProjectionDigest(observation.data()) !== certificate.observationDigest)
    return fail();
  if (previous.exists) {
    if (
      previous.get('certificateId') !== input.certificateId ||
      previous.get('certificateDigest') !== input.certificateId ||
      previous.get('projectId') !== input.ref.projectId ||
      previous.get('jobId') !== input.ref.jobId ||
      previous.get('canonicalAfterDigest') !== state.canonicalDocumentDigest ||
      state.canonical.get('soundCloudTrackId') !== undefined
    )
      return fail();
    // Recheck/re-establish the same permanent retention edge; canonical replay has no new write.
    const retain = await prepareReviewedLegacySoundCloudRetentionBinding(tx, db, {
      ref: input.ref,
      certificateId: input.certificateId,
      resource: certificate.resource,
    });
    return { certificate, commit: retain };
  }
  // A separate, non-workflow owner prevents ordinary terminal binding cleanup from
  // releasing this deliberately permanent retention edge.
  const retain = await prepareReviewedLegacySoundCloudRetentionBinding(tx, db, {
    ref: input.ref,
    certificateId: input.certificateId,
    resource: certificate.resource,
  });
  const after = { ...object(state.canonical.data()) };
  delete after.soundCloudTrackId;
  delete after.soundCloudTrackUrl;
  delete after.soundCloudPublication;
  after.status = { ...object(after.status), soundCloud: 'NOT_UPLOADED' };
  const canonicalAfterDigest = acknowledgedProjectionDigest(scIdentity(state.canonical.ref.path, after));
  return {
    certificate,
    commit: () => {
      retain(); // Permanent retained reference is written before local reference removal.
      tx.update(state.canonical.ref, {
        soundCloudTrackId: FieldValue.delete(),
        soundCloudTrackUrl: FieldValue.delete(),
        soundCloudPublication: FieldValue.delete(),
        'status.soundCloud': 'NOT_UPLOADED',
      });
      tx.create(audit, {
        schemaVersion: 1,
        projectId: input.ref.projectId,
        jobId: input.ref.jobId,
        certificateId: input.certificateId,
        certificateDigest: input.certificateId,
        canonicalAfterDigest,
        resource: certificate.resource,
        retentionOwner: `retention:${input.certificateId}`,
        bindingId: 'permanent-legacy-soundcloud',
        disposition: certificate.disposition,
        projectedAtMillis: Date.now(),
      });
    },
  };
}

/** Qualifies only an explicitly reviewed no-SEND retention. A missing GET response
 * or browser flag never substitutes for the immutable certificate and permanent edge.
 */
export async function validateLegacySoundCloudRetentionDisposition(
  tx: Transaction,
  db: Firestore,
  input: { ref: DurableJobRef; trackId: string }
): Promise<
  | {
      certificateId: string;
      sealedProofDigest: string;
    }
  | undefined
> {
  if (!id(input.ref.projectId) || !id(input.ref.jobId) || !id(input.trackId)) return fail();
  const grantSnapshot = await tx.get(db.doc(`durableJobCriticalRepairGrants/${input.ref.jobId}`)),
    grant = object(grantSnapshot.data());
  if (!grantSnapshot.exists || !Array.isArray(grant.sourceCertificateIds) || !Array.isArray(grant.operations))
    return undefined;
  const candidates = grant.operations.filter((value: unknown) => {
    const op = object(value);
    return (
      op.kind === 'legacy_soundcloud_retain' &&
      Object.keys(op).length === 2 &&
      sha(op.certificateId) &&
      grant.sourceCertificateIds.includes(op.certificateId)
    );
  });
  if (!candidates.length) return undefined;
  for (const operation of candidates) {
    const certificateId = object(operation).certificateId as string;
    const certificate = await loadValidatedLegacySoundCloudRetentionCertificate(tx, db, input.ref, certificateId);
    if (certificate.trackId !== input.trackId) continue;
    if (
      grant.schemaVersion !== 1 ||
      grant.projectId !== input.ref.projectId ||
      grant.jobId !== input.ref.jobId ||
      grant.generation !== certificate.generation ||
      grant.workflowId !== certificate.workflowId ||
      grant.intentFingerprint !== certificate.intentFingerprint ||
      grant.retentionAcknowledged !== true ||
      !id(grant.actorUid) ||
      !id(grant.commandId) ||
      !sha(grant.certificateId) ||
      typeof grant.reason !== 'string' ||
      !grant.reason.trim() ||
      grant.reason.length > 2000 ||
      typeof grant.evidenceReference !== 'string' ||
      !grant.evidenceReference.trim() ||
      grant.evidenceReference.length > 2000
    )
      return fail();
    const [intentSnapshot, jobSnapshot, observation, auditSnapshot] = await Promise.all([
      tx.get(db.doc(`durableJobIntents/${input.ref.jobId}`)),
      tx.get(db.doc(`durableJobs/${input.ref.jobId}`)),
      tx.get(db.collection(LEGACY_SOUNDCLOUD_RETENTION_OBSERVATIONS).doc(input.ref.jobId)),
      tx.get(db.collection(LEGACY_SOUNDCLOUD_RETENTIONS).doc(certificateId)),
    ]);
    const intent = object(intentSnapshot.data()),
      job = object(jobSnapshot.data()),
      audit = object(auditSnapshot.data());
    if (
      !intentSnapshot.exists ||
      !jobSnapshot.exists ||
      intent.projectId !== input.ref.projectId ||
      intent.jobId !== input.ref.jobId ||
      job.projectId !== input.ref.projectId ||
      job.jobId !== input.ref.jobId ||
      intent.generation !== certificate.generation ||
      job.generation !== certificate.generation ||
      job.workflowId !== certificate.workflowId ||
      acknowledgedProjectionDigest(intent) !== certificate.intentFingerprint ||
      !observation.exists ||
      acknowledgedProjectionDigest(observation.data()) !== certificate.observationDigest ||
      !auditSnapshot.exists ||
      audit.schemaVersion !== 1 ||
      audit.projectId !== input.ref.projectId ||
      audit.jobId !== input.ref.jobId ||
      audit.certificateId !== certificateId ||
      audit.certificateDigest !== certificateId ||
      audit.disposition !== certificate.disposition ||
      audit.retentionOwner !== `retention:${certificateId}` ||
      audit.bindingId !== 'permanent-legacy-soundcloud' ||
      acknowledgedProjectionDigest(audit.resource) !== acknowledgedProjectionDigest(certificate.resource) ||
      !sha(audit.canonicalAfterDigest)
    )
      return fail();
    await assertNoSoundCloudSendOrUnsafeWork(tx, db, input.ref);
    const canonical = await tx.get(db.doc(`sermons/${certificate.sermonId}`));
    if (canonical.exists) {
      if (
        canonical.get('soundCloudTrackId') !== undefined ||
        acknowledgedProjectionDigest(scIdentity(canonical.ref.path, canonical.data())) !== audit.canonicalAfterDigest
      )
        return fail();
    } else {
      // Root deletion continuation is authorized only by its original private checkpoint.
      const { sermonDeletionMirrorPlanId, SERMON_DELETION_MIRROR_PLANS } = await import(
        '../../helpers/sermonDeletionMirrors'
      );
      const planId = sermonDeletionMirrorPlanId(input.ref, certificate.sermonId),
        header = await tx.get(db.doc(`${SERMON_DELETION_MIRROR_PLANS}/${planId}`));
      const checkpoint = object(header.get('rootRemoval')),
        original = object(header.get('originalRoot')),
        requests = header.get('requests');
      const pointerCleared: Record<string, any> = { ...original, status: { ...object(original.status) } };
      if (!Array.isArray(requests)) return fail();
      for (const request of requests) {
        if (object(object(request).target).provider === 'subsplash') {
          delete pointerCleared.subsplashId;
          pointerCleared.status.subsplash = 'NOT_UPLOADED';
        } else if (object(object(request).target).provider === 'soundcloud') {
          delete pointerCleared.soundCloudTrackId;
          delete pointerCleared.soundCloudTrackUrl;
          delete pointerCleared.soundCloudPublication;
          pointerCleared.status.soundCloud = 'NOT_UPLOADED';
        } else return fail();
      }
      if (
        intent.kind !== 'sermon.delete' ||
        object(intent.payload).action !== 'delete' ||
        !header.exists ||
        header.get('planId') !== planId ||
        header.get('projectId') !== input.ref.projectId ||
        header.get('jobId') !== input.ref.jobId ||
        header.get('sermonId') !== certificate.sermonId ||
        header.get('generation') !== certificate.generation ||
        header.get('workflowId') !== certificate.workflowId ||
        !['root_removed', 'completed'].includes(header.get('state')) ||
        object(header.get('originalRoot')).soundCloudTrackId !== input.trackId ||
        checkpoint.schemaVersion !== 1 ||
        checkpoint.generation !== certificate.generation ||
        checkpoint.workflowId !== certificate.workflowId ||
        header.get('intentFingerprint') !== desiredProviderDeletionDocumentFingerprint(intent) ||
        header.get('originalRootDigest') !== acknowledgedProjectionDigest(original) ||
        header.get('pointerClearRootDigest') !== acknowledgedProjectionDigest(pointerCleared) ||
        acknowledgedProjectionDigest(scIdentity(`sermons/${certificate.sermonId}`, original)) !==
          certificate.canonicalDocumentDigest ||
        checkpoint.intentFingerprint !== header.get('intentFingerprint') ||
        !sha(checkpoint.originalEvidenceDigest) ||
        ![header.get('originalRootDigest'), header.get('pointerClearRootDigest')].includes(checkpoint.rootSourceDigest)
      )
        return fail();
    }
    const marker = assertProviderUsageMarker(
      (await tx.get(db.doc(PROVIDER_USAGE_CONTROL))).data(),
      input.ref.projectId
    );
    const aggregate = db.doc(
      `${PROVIDER_USAGE_COLLECTION}/${providerResourceKey(certificate.resource)}/epochs/${marker.epoch}`
    );
    const path = `providerBindings/retention:${certificateId}/permanent-legacy-soundcloud`,
      edgeRef = aggregate.collection('edges').doc(providerEdgeKey(path));
    const [resource, edge] = await Promise.all([tx.get(aggregate), tx.get(edgeRef)]);
    if (
      !resource.exists ||
      resource.get('projectId') !== input.ref.projectId ||
      resource.get('provider') !== 'soundcloud' ||
      resource.get('account') !== 'configured-account' ||
      resource.get('remoteId') !== input.trackId ||
      resource.get('epoch') !== marker.epoch ||
      resource.get('state') !== 'active' ||
      !Number.isSafeInteger(resource.get('referenceCount')) ||
      resource.get('referenceCount') < 1 ||
      !edge.exists ||
      edge.get('projectId') !== input.ref.projectId ||
      edge.get('canonicalPath') !== path ||
      edge.get('jobId') !== `retention:${certificateId}` ||
      edge.get('bindingId') !== 'permanent-legacy-soundcloud' ||
      edge.get('state') !== 'pending_effect'
    )
      return fail();
    return {
      certificateId,
      sealedProofDigest: acknowledgedProjectionDigest({
        certificateId,
        certificate,
        audit: {
          projectId: input.ref.projectId,
          jobId: input.ref.jobId,
          certificateId,
          canonicalAfterDigest: audit.canonicalAfterDigest,
          disposition: audit.disposition,
          retentionOwner: audit.retentionOwner,
          bindingId: audit.bindingId,
          resource: audit.resource,
        },
        edge: {
          projectId: input.ref.projectId,
          canonicalPath: path,
          jobId: `retention:${certificateId}`,
          bindingId: 'permanent-legacy-soundcloud',
        },
        epoch: marker.epoch,
      }),
    };
  }
  return undefined;
}
