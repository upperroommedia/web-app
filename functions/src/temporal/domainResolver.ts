import { createHash } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { DurableJobRef, DurableCommandReceipt } from '@upperroom/contracts/temporal';
import type { ProviderResource } from '@upperroom/orchestration/provider-usage';
import {
  createDurableJobStore,
  durableActivityDrainKey,
  type DurableActivityExecution,
} from '@upperroom/orchestration/job-store';

export interface IntentionalResourceAdoption {
  decision: 'adopt_existing_resource';
  remoteId: string;
  duplicateRiskAcknowledged: true;
  evidenceReference: string;
  reason: string;
}
export interface ExistingResourceRetention extends Omit<IntentionalResourceAdoption, 'decision'> {
  decision: 'retain_existing_resource';
}
export interface ImageCleanupReview extends Omit<IntentionalResourceAdoption, 'decision'> {
  decision: 'retain_existing_resource' | 'confirm_existing_resource_absent';
}
export interface DurableDomainResolutionInput {
  actorUid: string;
  jobId: string;
  expectedRevision: number;
  requestId: string;
  resolution: Record<string, unknown>;
}
export interface DurableDomainResolutionResult {
  signal: { name: string; args: unknown[] };
  replacementJobRef?: DurableJobRef;
  commandReceipt?: DurableCommandReceipt;
  cleanupOnly?: true;
  criticalRepairCertificateId?: string;
}
export interface DurableResolutionCommitHooks {
  /** READ ONLY; return a closure which only writes. Invoked after domain reads, before any writes. */
  prepareCommand(tx: Transaction, result: DurableDomainResolutionResult): Promise<() => DurableCommandReceipt>;
}
export interface DomainResolutionDependencies {
  firestore: Firestore;
  projectId: string;
  getActor(
    uid: string
  ): Promise<{ disabled: boolean; customClaims?: Record<string, unknown>; tokensValidAfterTime?: string }>;
  prepareCriticalRepair?(
    tx: Transaction,
    input: { ref: DurableJobRef; expectedRevision: number }
  ): Promise<{
    certificate: import('./publishing/criticalRepair').CriticalRepairCertificate;
    certificateId: string;
    digest: string;
    commit(): void;
  }>;
  publishing(input: {
    ref: DurableJobRef;
    receiptId: string;
    actorUid: string;
    commandId: string;
    cleanupOnly?: boolean;
    review: IntentionalResourceAdoption | ExistingResourceRetention;
    fence(tx: Transaction): Promise<void>;
    commit(tx: Transaction): Promise<void>;
  }): Promise<void>;
  prepareKnownRetention?(
    tx: Transaction,
    input: { ref: DurableJobRef; receiptId: string; remoteId: string }
  ): Promise<{ resource: ProviderResource; commit(): void }>;
  verifyOrphanAbsent?(input: { receipt: Record<string, unknown>; remoteId: string }): Promise<boolean>;
  prepareOrphanDisposition?(
    tx: Transaction,
    input: {
      ref: DurableJobRef;
      acknowledgementId: string;
      receipt: Record<string, unknown>;
      fact: Record<string, unknown>;
      decision: 'retain_after_review' | 'cleanup_verified';
    }
  ): Promise<{ resource: ProviderResource; commit(): void }>;
  verifyOrphanResource?(input: { receipt: Record<string, unknown>; remoteId: string }): Promise<unknown>;
  imageDeletion?(input: {
    ref: DurableJobRef;
    actorUid: string;
    commandId: string;
    expectedRevision: number;
    expectedGeneration: number;
    review: ImageCleanupReview;
    fence(tx: Transaction): Promise<void>;
    commit(tx: Transaction): Promise<void>;
  }): Promise<void>;
  image(input: {
    ref: DurableJobRef;
    actorUid: string;
    commandId: string;
    expectedRevision: number;
    expectedGeneration: number;
    review: IntentionalResourceAdoption | ImageCleanupReview;
    fence(tx: Transaction): Promise<void>;
    commit(tx: Transaction): Promise<void>;
  }): Promise<void>;
  email(input: {
    ref: DurableJobRef;
    actorUid: string;
    commandId: string;
    expectedRevision: number;
    expectedGeneration: number;
    expectedReceiptToken: string;
    resolution: Record<string, unknown>;
    fence(tx: Transaction): Promise<void>;
    commit(
      tx: Transaction,
      result: { state: 'confirmed' | 'failed' | 'resent'; replacementJobId?: string }
    ): Promise<void>;
  }): Promise<{ state: 'confirmed' | 'failed' | 'resent'; replacementJobId?: string }>;
}
const fail = (
  code: 'invalid-argument' | 'permission-denied' | 'not-found' | 'aborted' | 'failed-precondition' | 'already-exists',
  message: string
): never => {
  throw new HttpsError(code, message);
};
function identifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value))
    fail('invalid-argument', `Invalid ${name}.`);
}
function reviewText(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 1024 ||
    /[\u0000-\u001f]|bearer\s|-----BEGIN|\beyJ[A-Za-z0-9_-]{12,}\.|\bya29\.[A-Za-z0-9_-]{12,}|[?&](?:token|key|signature)=/i.test(
      value
    )
  )
    fail('invalid-argument', `A safe ${name} is required.`);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    );
  return value;
}
function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)) ?? 'undefined')
    .digest('hex');
}
export function validateIntentionalResourceAdoption(value: Record<string, unknown>): IntentionalResourceAdoption {
  if (value.decision !== 'adopt_existing_resource' || value.duplicateRiskAcknowledged !== true)
    fail(
      'failed-precondition',
      'Select intentional adoption and acknowledge that the original request may have created another resource.'
    );
  identifier(value.remoteId, 'provider resource ID');
  reviewText(value.evidenceReference, 'provider review reference');
  reviewText(value.reason, 'review reason');
  return {
    decision: 'adopt_existing_resource',
    remoteId: value.remoteId,
    duplicateRiskAcknowledged: true,
    evidenceReference: value.evidenceReference.trim(),
    reason: value.reason.trim(),
  };
}
function validateImageCleanupReview(value: Record<string, unknown>): ImageCleanupReview {
  if (!['retain_existing_resource', 'confirm_existing_resource_absent'].includes(String(value.decision)))
    fail('invalid-argument', 'Select explicit retention or verified absence for this shared image.');
  return {
    ...validateIntentionalResourceAdoption({ ...value, decision: 'adopt_existing_resource' }),
    decision: value.decision as ImageCleanupReview['decision'],
  };
}
function validateEmailReview(value: Record<string, unknown>): Record<string, unknown> {
  if (!['confirm_accepted', 'mark_failed_after_review', 'resend_after_review'].includes(String(value.decision)))
    fail('invalid-argument', 'Select an email review decision.');
  if (value.decision === 'resend_after_review' && value.duplicateRiskAcknowledged !== true)
    fail('failed-precondition', 'Acknowledge the risk of duplicate email before sending a new reviewed delivery.');
  reviewText(value.evidenceReference, 'mail provider review reference');
  reviewText(value.reason, 'review reason');
  return {
    decision: value.decision,
    evidenceReference: value.evidenceReference.trim(),
    reason: value.reason.trim(),
    ...(value.duplicateRiskAcknowledged === true ? { duplicateRiskAcknowledged: true } : {}),
  };
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('failed-precondition', message);
  return value as Record<string, unknown>;
}
/** A stopped caller is not proof of a completed remote mutation. This only proves no future calls. */
export function validateAccountDrainProof(
  proofValue: unknown,
  ref: DurableJobRef,
  execution: DurableActivityExecution
): void {
  if (
    !execution ||
    !['workflowId', 'runId', 'activityId', 'activityType'].every(
      (key) =>
        typeof execution[key as keyof DurableActivityExecution] === 'string' &&
        execution[key as keyof DurableActivityExecution]
    ) ||
    !Number.isSafeInteger(execution.attempt) ||
    execution.attempt < 1 ||
    !Number.isFinite(execution.scheduledAt)
  )
    fail('failed-precondition', 'The originating account execution identity is invalid.');
  const proof = object(proofValue, 'The originating account execution has no verified completion witness.');
  const id = createHash('sha256')
    .update(JSON.stringify([execution.workflowId, execution.runId, execution.activityId, execution.scheduledAt]))
    .digest('hex');
  if (
    proof.schemaVersion !== 1 ||
    proof.projectId !== ref.projectId ||
    proof.jobId !== ref.jobId ||
    proof.executionId !== id ||
    proof.state !== 'drained' ||
    fingerprint(proof.execution) !== fingerprint(execution) ||
    typeof proof.drainedAt !== 'number' ||
    !Number.isFinite(proof.drainedAt)
  )
    fail('failed-precondition', 'The account execution completion witness does not match this operation.');
  if (proof.source === 'worker_settled') return;
  if (proof.source !== 'operator_verified_pod_termination')
    fail('failed-precondition', 'Unsupported account execution completion witness.');
  const worker = execution.worker;
  if (
    !worker ||
    !worker.podUid ||
    !worker.podName ||
    !worker.namespace ||
    !worker.clusterId ||
    !worker.nodeUid ||
    !worker.nodeName ||
    !worker.containerIds?.length ||
    !execution.temporalNamespace
  )
    return fail('failed-precondition', 'The originating worker has no complete platform identity for recovery.');
  const attestation = object(proof.attestation, 'A verified worker termination attestation is required.');
  if (
    attestation.kind !== 'verified_pod_termination' ||
    attestation.projectId !== ref.projectId ||
    attestation.temporalNamespace !== execution.temporalNamespace ||
    attestation.remoteRpcCompletionProven !== false
  )
    fail('failed-precondition', 'The worker termination attestation is invalid.');
  for (const key of [
    'clusterId',
    'namespace',
    'podUid',
    'podName',
    'nodeUid',
    'nodeName',
    'instanceId',
    'buildId',
  ] as const)
    if (attestation[key] !== worker[key])
      fail('failed-precondition', 'The terminated worker identity does not match the originating account request.');
  if (
    !Array.isArray(attestation.containerIds) ||
    fingerprint([...attestation.containerIds].sort()) !== fingerprint([...worker.containerIds].sort())
  )
    fail('failed-precondition', 'The originating worker containers were not all verified stopped.');
  for (const key of ['kubePodResourceVersion', 'kubeNodeResourceVersion', 'namespaceUid', 'evidenceDigest'] as const)
    if (typeof attestation[key] !== 'string' || !attestation[key])
      fail('failed-precondition', 'The worker termination evidence is incomplete.');
  const google = object(attestation.googleOperator, 'An authenticated Google operator identity is required.');
  const kubernetes = object(attestation.kubernetesOperator, 'An authenticated cluster operator identity is required.');
  if (
    typeof google.subject !== 'string' ||
    !google.subject ||
    proof.operatorUid !== `google:${google.subject}` ||
    typeof kubernetes.username !== 'string' ||
    !kubernetes.username ||
    !Array.isArray(kubernetes.groups) ||
    typeof attestation.verifiedAt !== 'number' ||
    !Number.isFinite(attestation.verifiedAt)
  )
    fail('failed-precondition', 'The worker termination operator identity is invalid.');
  if (
    typeof proof.evidenceReference !== 'string' ||
    !/^durableAccountExecutionAudits\/[A-Za-z0-9_-]+$/.test(proof.evidenceReference)
  )
    fail('failed-precondition', 'A private worker termination audit is required.');
}
function validateAccountClaimsReview(value: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(value).some((key) => !['decision', 'evidenceReference', 'reason'].includes(key)))
    fail(
      'invalid-argument',
      'Unexpected account review detail. Completion witnesses are read privately by the server.'
    );
  if (!['confirm_access_applied', 'confirm_sessions_revoked'].includes(String(value.decision)))
    fail(
      'failed-precondition',
      'Only an already applied account change can be confirmed. An uncertain access request cannot be replayed.'
    );
  reviewText(value.evidenceReference, 'account review reference');
  reviewText(value.reason, 'review reason');
  return { decision: value.decision, evidenceReference: value.evidenceReference.trim(), reason: value.reason.trim() };
}
/** All resolution entrypoints share fresh authorization, immutable job fencing and private audit.
 * Adoption is an intentional operator reassociation, never proof that an unknown POST failed.
 * Each domain commits its provider receipt inside a transaction calling the supplied fence. */
export function createDurableDomainResolver(deps: DomainResolutionDependencies) {
  const store = createDurableJobStore({ firestore: deps.firestore, projectId: deps.projectId });
  async function administrator(actorUid: string): Promise<void> {
    const actor = await deps.getActor(actorUid);
    if (actor.disabled || actor.customClaims?.role !== 'admin')
      fail('permission-denied', 'An active administrator must review this external result.');
  }
  return async function resolve(
    input: DurableDomainResolutionInput,
    hooks?: DurableResolutionCommitHooks
  ): Promise<DurableDomainResolutionResult> {
    if (!hooks) fail('failed-precondition', 'Reviewed resolution requires an atomic command transaction.');
    if (
      typeof input.actorUid !== 'string' ||
      !input.actorUid ||
      input.actorUid.length > 128 ||
      /[\u0000-\u001f]/.test(input.actorUid)
    )
      fail('invalid-argument', 'Invalid actor.');
    identifier(input.jobId, 'job');
    identifier(input.requestId, 'review request');
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      !input.resolution ||
      typeof input.resolution !== 'object' ||
      Array.isArray(input.resolution)
    )
      fail('invalid-argument', 'Invalid review request.');
    const allowed = new Set([
      'receiptId',
      'remoteId',
      'decision',
      'duplicateRiskAcknowledged',
      'evidenceReference',
      'reason',
      'acknowledgementId',
      'certificateId',
      'retentionAcknowledged',
    ]);
    if (Object.keys(input.resolution).some((key) => !allowed.has(key)))
      fail('invalid-argument', 'Unexpected review detail. Provider receipt tokens are read privately by the server.');
    await administrator(input.actorUid);
    const ref = { projectId: deps.projectId, jobId: input.jobId };
    const job = await store.loadJob(ref);
    const criticalRepair = input.resolution.decision === 'continue_critical_repair';
    if (
      criticalRepair &&
      (typeof input.resolution.certificateId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.resolution.certificateId) ||
        Object.keys(input.resolution).some(
          (key) => !['decision', 'certificateId', 'evidenceReference', 'reason', 'retentionAcknowledged'].includes(key)
        ))
    )
      fail('invalid-argument', 'A server-certified repair and safe review evidence are required.');
    if (
      criticalRepair &&
      input.resolution.retentionAcknowledged !== undefined &&
      input.resolution.retentionAcknowledged !== true
    )
      fail('invalid-argument', 'Explicit retention acknowledgement must be true.');
    if (
      criticalRepair &&
      (job.attention?.resolutionKind !== 'critical_repair' ||
        job.attention.certificateId !== input.resolution.certificateId)
    )
      fail('aborted', 'The current operation does not advertise this certified repair. Refresh its state.');
    if (criticalRepair) {
      reviewText(input.resolution.evidenceReference, 'repair review reference');
      reviewText(input.resolution.reason, 'repair review reason');
    }
    const independentOrphan = job.kind === 'provider.orphan_review';
    const email = job.kind === 'email.deliver';
    const privateIntent =
      job.kind === 'image.delete' ||
      job.kind === 'speaker.resolve' ||
      ['role.assign', 'role.resolve', 'invite.claim'].includes(job.kind)
        ? await store.loadIntent<{
            operation?: string;
            action?: string;
            assignmentId?: string;
            requestId?: string;
            inviteId?: string;
            targetUid?: string;
            claimantUid?: string;
          }>(ref)
        : undefined;
    const accountClaims =
      ['role.assign', 'role.resolve', 'invite.claim'].includes(job.kind) &&
      ['role-assign', 'role-accept', 'invite-claim'].includes(privateIntent?.payload.action ?? '');
    const retainExisting = input.resolution.decision === 'retain_existing_resource';
    const orphanReview = ['retain_orphan', 'confirm_orphan_cleanup'].includes(String(input.resolution.decision));
    const accountSession = accountClaims && input.resolution.decision === 'confirm_sessions_revoked';
    const accountSpeaker = job.kind === 'speaker.resolve' && privateIntent?.payload.action === 'speaker-accept';
    const imageDeletion = job.kind === 'image.delete' && privateIntent?.payload.operation === 'delete';
    const imageReconcile = job.kind === 'image.delete' && privateIntent?.payload.operation === 'reconcile';
    const imageReview =
      ((imageDeletion || imageReconcile) &&
        ['retain_existing_resource', 'confirm_existing_resource_absent'].includes(String(input.resolution.decision))) ||
      (job.kind === 'image.ingest' && input.resolution.decision === 'retain_existing_resource');
    if (job.kind === 'image.ingest' && !imageReview)
      fail(
        'failed-precondition',
        'An uncertain shared image allocation can only be retained; reviewed adoption cannot authorize overwriting it.'
      );
    const image =
      imageDeletion ||
      job.kind === 'image.ingest' ||
      (job.kind === 'image.delete' && privateIntent?.payload.operation === 'reconcile');
    const publishingCancellation =
      !email && !image && !accountClaims && !accountSpeaker
        ? await deps.firestore.collection('durableJobCancellationIntents').doc(ref.jobId).get()
        : undefined;
    const cleanupOnly = publishingCancellation?.exists === true;
    if (
      cleanupOnly &&
      (publishingCancellation.get('projectId') !== deps.projectId ||
        publishingCancellation.get('workflowId') !== job.workflowId ||
        publishingCancellation.get('generation') !== job.generation)
    )
      fail('failed-precondition', 'Cancellation authority does not match this operation.');
    const cancellationFingerprint = cleanupOnly ? fingerprint(publishingCancellation.data()) : undefined;
    if (retainExisting && !imageReview && (!cleanupOnly || accountSpeaker || accountClaims || email || image))
      fail('failed-precondition', 'Known-resource retention requires a scoped publishing cancellation.');
    if (orphanReview && ((!independentOrphan && !cleanupOnly) || accountSpeaker || accountClaims || email || image))
      fail(
        'failed-precondition',
        'Additional allocations can only be retained during a scoped publishing cancellation review.'
      );
    if (orphanReview) {
      if (
        Object.keys(input.resolution).some(
          (key) =>
            !['acknowledgementId', 'decision', 'duplicateRiskAcknowledged', 'evidenceReference', 'reason'].includes(key)
        ) ||
        input.resolution.duplicateRiskAcknowledged !== true
      )
        fail(
          'invalid-argument',
          'Acknowledge deliberate retention of the additional resource with safe review evidence.'
        );
      identifier(input.resolution.acknowledgementId, 'provider acknowledgement');
      reviewText(input.resolution.evidenceReference, 'provider retention review reference');
      reviewText(input.resolution.reason, 'retention review reason');
    }
    const review = criticalRepair
      ? {
          decision: 'continue_critical_repair',
          certificateId: input.resolution.certificateId,
          evidenceReference: input.resolution.evidenceReference,
          reason: input.resolution.reason,
          ...(input.resolution.retentionAcknowledged === true ? { retentionAcknowledged: true } : {}),
        }
      : imageReview
      ? validateImageCleanupReview(input.resolution)
      : orphanReview
      ? {
          decision: input.resolution.decision,
          duplicateRiskAcknowledged: true,
          acknowledgementId: input.resolution.acknowledgementId,
          evidenceReference: input.resolution.evidenceReference,
          reason: input.resolution.reason,
        }
      : accountClaims
      ? validateAccountClaimsReview(input.resolution)
      : email
      ? validateEmailReview(input.resolution)
      : retainExisting
      ? {
          ...validateIntentionalResourceAdoption({ ...input.resolution, decision: 'adopt_existing_resource' }),
          decision: 'retain_existing_resource' as const,
        }
      : validateIntentionalResourceAdoption(input.resolution);
    const hash = fingerprint({
      actorUid: input.actorUid,
      ref,
      expectedRevision: input.expectedRevision,
      review,
      receiptId: input.resolution.receiptId ?? null,
    });
    const commandId = fingerprint([deps.projectId, input.jobId, input.actorUid, input.requestId]);
    const audit = deps.firestore.collection('durableJobResolutionRequests').doc(commandId);
    async function fence(tx: Transaction): Promise<void> {
      await store.assertCurrentInTransaction(tx, ref);
      const fresh = await tx.get(deps.firestore.collection('durableJobs').doc(ref.jobId));
      if (
        !fresh.exists ||
        fresh.get('generation') !== job.generation ||
        fresh.get('revision') !== input.expectedRevision
      )
        fail('aborted', 'This operation changed during review. Refresh its state before acting.');
      if (
        criticalRepair &&
        (fresh.get('attention')?.resolutionKind !== 'critical_repair' ||
          fresh.get('attention')?.certificateId !== input.resolution.certificateId)
      )
        fail('aborted', 'The certified repair capability changed during review.');
      if (
        !['needs_attention', 'waiting_for_auth', 'reconciling', 'cancel_requested'].includes(fresh.get('state')) ||
        !((fresh.get('actions') ?? []) as string[]).includes('resolve')
      )
        fail('failed-precondition', 'This operation is no longer waiting for a reviewed resolution.');
      if (cleanupOnly) {
        const cancellation = await tx.get(deps.firestore.collection('durableJobCancellationIntents').doc(ref.jobId));
        if (!cancellation.exists || fingerprint(cancellation.data()) !== cancellationFingerprint)
          fail('aborted', 'Cancellation authority changed during review.');
      }
      const currentAudit = await tx.get(audit);
      if (currentAudit.exists && currentAudit.get('inputHash') !== hash)
        fail('already-exists', 'Review request ID was already used for a different decision.');
    }
    const replay = await deps.firestore.runTransaction(async (tx) => {
      const previous = await tx.get(audit);
      if (previous.exists) {
        if (previous.get('inputHash') !== hash)
          fail('already-exists', 'Review request ID was already used for a different decision.');
        if (previous.get('state') === 'completed') return previous.get('result') as DurableDomainResolutionResult;
      }
      await fence(tx);
      if (!previous.exists)
        tx.create(audit, {
          schemaVersion: 1,
          ...ref,
          actorUid: input.actorUid,
          requestId: input.requestId,
          inputHash: hash,
          generation: job.generation,
          expectedRevision: input.expectedRevision,
          decision: review,
          state: 'verifying',
          createdAt: Date.now(),
        });
      return undefined;
    });
    if (replay) return replay;
    // Auth is fetched again by the final transaction fence, after potentially slow provider GETs.
    const authorizedFence = async (tx: Transaction) => {
      await administrator(input.actorUid);
      await fence(tx);
    };
    let result: DurableDomainResolutionResult | undefined;
    async function commit(tx: Transaction, resolved: DurableDomainResolutionResult): Promise<void> {
      await authorizedFence(tx);
      const writeCommand = await hooks!.prepareCommand(tx, resolved);
      const commandReceipt = writeCommand();
      result = { ...resolved, ...(commandReceipt ? { commandReceipt } : {}) };
      tx.update(audit, { state: 'completed', result, completedAt: Date.now() });
    }
    if (criticalRepair) {
      if (!deps.prepareCriticalRepair) fail('failed-precondition', 'Certified repair planning is unavailable.');
      await deps.firestore.runTransaction(async (tx) => {
        // Public revisions can advance while the initial review audit is saved.
        // Reject that race as a stale command before deriving its source proof.
        await authorizedFence(tx);
        const prepared = await deps.prepareCriticalRepair!(tx, { ref, expectedRevision: input.expectedRevision });
        if (
          prepared.certificateId !== input.resolution.certificateId ||
          prepared.digest !== prepared.certificateId ||
          prepared.certificate.projectId !== ref.projectId ||
          prepared.certificate.jobId !== ref.jobId ||
          prepared.certificate.generation !== job.generation ||
          prepared.certificate.workflowId !== job.workflowId
        )
          fail('aborted', 'The certified repair changed. Refresh before approving it.');
        const sourceCertificateIds = prepared.certificate.operations
          .filter((operation) => String(operation.kind) === 'legacy_soundcloud_retain')
          .map((operation) => {
            const id = (operation as unknown as { certificateId?: unknown }).certificateId;
            if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
              return fail('failed-precondition', 'The source retention certificate is invalid.');
            return id;
          });
        if (sourceCertificateIds.length && input.resolution.retentionAcknowledged !== true)
          fail(
            'failed-precondition',
            'Acknowledge permanent retention of the provider resource without asserting its absence or ownership.'
          );
        await commit(tx, {
          signal: { name: 'publishingCriticalRepair', args: [{ certificateId: prepared.certificateId }] },
          cleanupOnly: true,
          criticalRepairCertificateId: prepared.certificateId,
        });
        prepared.commit();
        tx.set(deps.firestore.collection('durableJobCriticalRepairGrants').doc(ref.jobId), {
          schemaVersion: 1,
          ...ref,
          generation: job.generation,
          workflowId: job.workflowId,
          actorUid: input.actorUid,
          commandId,
          certificateId: prepared.certificateId,
          certificateDigest: prepared.digest,
          intentFingerprint: prepared.certificate.intentFingerprint,
          criticalFingerprint: prepared.certificate.criticalFingerprint,
          operations: prepared.certificate.operations,
          sourceEvidenceDigests: prepared.certificate.sourceEvidenceDigests,
          ...(sourceCertificateIds.length
            ? { retentionAcknowledged: true, sourceCertificateIds: [...new Set(sourceCertificateIds)] }
            : {}),
          evidenceReference: input.resolution.evidenceReference,
          reason: input.resolution.reason,
          createdAtMillis: Date.now(),
        });
      });
    } else if (orphanReview) {
      const acknowledgementId = input.resolution.acknowledgementId as string;
      let sourceRef = ref;
      let orphanIntentFingerprint: string | undefined;
      if (independentOrphan) {
        const orphan = await import('./publishing/orphanReview');
        const validated = await orphan.loadValidatedProviderOrphanReview(deps.firestore, ref);
        if (validated.intent.payload.sourceAcknowledgementId !== acknowledgementId)
          fail('permission-denied', 'The review case is bound to a different acknowledgement.');
        sourceRef = { projectId: ref.projectId, jobId: validated.intent.payload.sourceJobId };
        orphanIntentFingerprint = fingerprint(validated.intent);
      }
      const ackRef = deps.firestore.collection('temporalProviderAcknowledgements').doc(acknowledgementId);
      const reviewRef = deps.firestore.collection('temporalProviderAcknowledgementReviews').doc(acknowledgementId);
      const acknowledgement = await ackRef.get();
      const fact = object(acknowledgement.data(), 'The additional provider allocation evidence is unavailable.');
      if (
        fact.schemaVersion !== 1 ||
        fact.projectId !== sourceRef.projectId ||
        fact.jobId !== sourceRef.jobId ||
        fact.disposition !== 'orphaned' ||
        typeof fact.receiptId !== 'string' ||
        typeof fact.remoteId !== 'string' ||
        !Number.isSafeInteger(fact.claimRevision) ||
        typeof fact.attemptOwner !== 'string'
      )
        fail('permission-denied', 'The additional provider allocation does not belong to this exact operation.');
      if (fact.review !== undefined)
        fail('already-exists', 'This additional allocation already has a reviewed disposition.');
      identifier(fact.remoteId, 'additional provider resource');
      identifier(fact.receiptId, 'original provider receipt');
      if (fingerprint([fact.receiptId, fact.attemptOwner, fact.claimRevision, fact.remoteId]) !== acknowledgementId)
        fail('failed-precondition', 'The provider acknowledgement identity is invalid.');
      const receiptRef = deps.firestore.collection('temporalProviderReceipts').doc(fact.receiptId);
      const receiptSnapshot = await receiptRef.get();
      const receipt = object(receiptSnapshot.data(), 'The original allocation intent is unavailable.');
      if (
        receipt.projectId !== sourceRef.projectId ||
        receipt.jobId !== sourceRef.jobId ||
        typeof receipt.operationKey !== 'string' ||
        !receipt.operationKey.startsWith(`durable:${sourceRef.projectId}:${sourceRef.jobId}:`) ||
        receipt.step !== fact.step ||
        receipt.fingerprint !== fact.payloadFingerprint ||
        fingerprint(receipt.providerAccount) !== fingerprint(fact.providerAccount)
      )
        fail('failed-precondition', 'The additional allocation does not match its immutable provider intent.');
      const disposition =
        input.resolution.decision === 'confirm_orphan_cleanup' ? 'cleanup_verified' : 'retain_after_review';
      if (disposition === 'cleanup_verified') {
        if (!deps.verifyOrphanAbsent || !(await deps.verifyOrphanAbsent({ receipt, remoteId: fact.remoteId })))
          fail('failed-precondition', 'The additional provider resource has not been authoritatively verified absent.');
      } else {
        if (!deps.verifyOrphanResource) fail('failed-precondition', 'Provider retention verification is unavailable.');
        const verified = await deps.verifyOrphanResource!({ receipt, remoteId: fact.remoteId });
        if (verified === undefined || verified === null)
          fail('failed-precondition', 'The additional provider resource could not be verified.');
      }
      if (!deps.prepareOrphanDisposition)
        fail('failed-precondition', 'Provider resource disposition protection is unavailable.');
      const factBefore = fingerprint(fact),
        receiptBefore = fingerprint(receipt);
      await deps.firestore.runTransaction(async (tx) => {
        const [freshFact, freshReceipt, priorReview] = await Promise.all([
          tx.get(ackRef),
          tx.get(receiptRef),
          tx.get(reviewRef),
        ]);
        if (fingerprint(freshFact.data()) !== factBefore || fingerprint(freshReceipt.data()) !== receiptBefore)
          fail('aborted', 'Additional allocation evidence changed during verification.');
        if (priorReview.exists)
          fail('already-exists', 'This additional allocation already has a reviewed disposition.');
        if (independentOrphan) {
          const [childIntent, originalIntent] = await Promise.all([
            tx.get(deps.firestore.collection('durableJobIntents').doc(ref.jobId)),
            tx.get(deps.firestore.collection('durableJobIntents').doc(sourceRef.jobId)),
          ]);
          if (
            fingerprint(childIntent.data()) !== orphanIntentFingerprint ||
            originalIntent.get('projectId') !== sourceRef.projectId ||
            originalIntent.get('jobId') !== sourceRef.jobId ||
            originalIntent.get('actorUid') !== childIntent.get('actorUid')
          )
            fail('aborted', 'The independent review ownership changed.');
        }
        const usage = await deps.prepareOrphanDisposition!(tx, {
          ref: sourceRef,
          acknowledgementId,
          receipt,
          fact,
          decision: disposition,
        });
        await commit(tx, {
          signal: { name: independentOrphan ? 'providerOrphanReviewResume' : 'publishingResume', args: [] },
        });
        usage.commit();
        const dispositionReview = {
          decision: disposition,
          duplicateRiskAcknowledged: true,
          actorUid: input.actorUid,
          commandId,
          acknowledgementFingerprint: factBefore,
          evidenceReference: input.resolution.evidenceReference,
          reason: input.resolution.reason,
          reviewedAtMillis: Date.now(),
        };
        tx.create(reviewRef, {
          schemaVersion: 1,
          ...sourceRef,
          ...(independentOrphan ? { reviewCaseJobId: ref.jobId } : {}),
          acknowledgementId,
          resource: usage.resource,
          ...(fact.providerAccount ? { providerAccount: fact.providerAccount } : {}),
          ...dispositionReview,
        });
        tx.update(ackRef, { review: dispositionReview });
      });
    } else if (accountClaims) {
      if (job.entity.type !== 'user')
        fail('failed-precondition', 'The account operation has no canonical user identity.');
      const uid = job.entity.id;
      const intent = privateIntent!.payload;
      const sourceId =
        intent.action === 'role-assign'
          ? intent.assignmentId
          : intent.action === 'invite-claim'
          ? intent.inviteId
          : intent.requestId;
      if (typeof sourceId !== 'string' || !sourceId || sourceId.includes('/'))
        return fail('failed-precondition', 'The account operation has no canonical source.');
      if (
        (intent.action === 'role-assign' && intent.targetUid !== uid) ||
        (intent.action === 'invite-claim' && intent.claimantUid !== uid)
      )
        fail('failed-precondition', 'The account target does not match its immutable request.');
      const source = deps.firestore
        .collection(
          intent.action === 'role-assign'
            ? '_durableAccountAssignments'
            : intent.action === 'invite-claim'
            ? 'roleInvites'
            : 'roleRequests'
        )
        .doc(sourceId);
      const resource = deps.firestore
        .collection('_durableAccountClaimResources')
        .doc(createHash('sha256').update(`${deps.projectId}:${uid}`).digest('hex'));
      const snapshot = await resource.get();
      const saved = object(snapshot.data(), 'The uncertain account request receipt is unavailable.');
      if (
        saved.projectId !== deps.projectId ||
        saved.uid !== uid ||
        saved.jobId !== ref.jobId ||
        (accountSession
          ? saved.state !== 'applied' ||
            saved.sessionState !== 'started' ||
            saved.sessionTransport !== 'single_shot_identity_toolkit'
          : saved.state !== 'started' || saved.transport !== 'single_shot_identity_toolkit')
      )
        fail('failed-precondition', 'This account request cannot be safely reconciled as a single observed operation.');
      const execution = object(
        accountSession ? saved.sessionExecution : saved.execution,
        'The account request has no originating execution identity.'
      ) as unknown as DurableActivityExecution;
      if (execution.workflowId !== job.workflowId)
        fail('failed-precondition', 'The originating execution belongs to a different workflow.');
      const proofRef = deps.firestore
        .collection('durableActivityDrains')
        .doc(durableActivityDrainKey(deps.projectId, ref.jobId, execution));
      const proof = await proofRef.get();
      validateAccountDrainProof(proof.data(), ref, execution);
      const claims = object(saved.claims, 'The frozen account claims are unavailable.');
      if (claims.temporalAccountClaimJobId !== ref.jobId)
        fail('failed-precondition', 'The account operation marker is unavailable.');
      // This GET follows proof that the originating caller cannot send more writes.
      // Exact positive observation is required; lack of a marker never proves absence.
      const target = await deps.getActor(uid);
      if (accountSession) {
        const sessionClaims = object(saved.sessionClaims, 'The unique frozen session mutation proof is unavailable.');
        if (
          typeof saved.sessionOperationId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(saved.sessionOperationId) ||
          sessionClaims.temporalAccountSessionOperationId !== saved.sessionOperationId ||
          target.customClaims?.temporalAccountSessionOperationId !== saved.sessionOperationId ||
          fingerprint(target.customClaims) !== fingerprint(sessionClaims)
        )
          fail(
            'failed-precondition',
            'Current account sessions do not show this exact uniquely marked revocation. Keep this operation blocked for investigation.'
          );
        const cutoff =
          typeof saved.sessionCutoffSeconds === 'string' && /^\d{1,16}$/.test(saved.sessionCutoffSeconds)
            ? Number(saved.sessionCutoffSeconds)
            : NaN;
        const observed =
          typeof target.tokensValidAfterTime === 'string' ? Date.parse(target.tokensValidAfterTime) / 1000 : NaN;
        if (!Number.isSafeInteger(cutoff) || cutoff < 0 || !Number.isFinite(observed) || observed < cutoff)
          fail(
            'failed-precondition',
            'Current account sessions do not show the frozen revocation cutoff. Keep this operation blocked for investigation.'
          );
      } else if (
        target.customClaims?.temporalAccountClaimJobId !== ref.jobId ||
        fingerprint(target.customClaims) !== fingerprint(claims)
      )
        fail(
          'failed-precondition',
          'Current account access does not exactly match the frozen applied request. Keep this operation blocked for investigation.'
        );
      const before = fingerprint(saved),
        proofBefore = fingerprint(proof.data());
      await deps.firestore.runTransaction(async (tx) => {
        const [freshResource, freshProof, freshSource] = await Promise.all([
          tx.get(resource),
          tx.get(proofRef),
          tx.get(source),
        ]);
        if (
          fingerprint(freshResource.data()) !== before ||
          fingerprint(freshProof.data()) !== proofBefore ||
          !freshSource.exists
        )
          fail('aborted', 'Account recovery evidence changed during verification.');
        validateAccountDrainProof(freshProof.data(), ref, execution);
        if (
          freshSource.get('temporalClaimsRequestedJobId') !== ref.jobId ||
          (intent.action === 'role-accept' && freshSource.get('requesterUid') !== uid) ||
          (intent.action === 'role-assign' && freshSource.get('targetUid') !== uid) ||
          (intent.action === 'invite-claim' && freshSource.get('claimedByUid') !== uid)
        )
          fail('failed-precondition', 'The account source no longer owns this change.');
        if (accountSession && freshSource.get('temporalClaimsAppliedJobId') !== ref.jobId)
          fail('failed-precondition', 'The account claims checkpoint is not confirmed for this session revocation.');
        await commit(tx, { signal: { name: 'accountResume', args: [] } });
        if (accountSession) {
          tx.update(resource, {
            sessionState: 'applied',
            sessionReviewedBy: input.actorUid,
            sessionReviewCommandId: commandId,
            sessionReviewedAt: Date.now(),
            sessionDrainProofId: proofRef.id,
          });
          tx.update(source, { temporalSessionsRevokedJobId: ref.jobId });
        } else {
          const previousCutoff =
            typeof saved.sessionCutoffSeconds === 'string' && /^\d{1,16}$/.test(saved.sessionCutoffSeconds)
              ? Number(saved.sessionCutoffSeconds)
              : 0;
          if (!Number.isSafeInteger(previousCutoff))
            fail('failed-precondition', 'The previous session cutoff is invalid.');
          tx.update(resource, {
            state: 'applied',
            reviewedBy: input.actorUid,
            reviewCommandId: commandId,
            reviewedAt: Date.now(),
            drainProofId: proofRef.id,
            sessionState: 'pending',
            sessionCutoffSeconds: String(Math.max(Math.floor(Date.now() / 1000), previousCutoff)),
          });
          tx.update(source, { temporalClaimsAppliedJobId: ref.jobId });
        }
      });
    } else if (email) {
      const receipt = await deps.firestore.collection('durableEmailReceipts').doc(ref.jobId).get();
      const token = receipt.get('token');
      if (typeof token !== 'string' || !token) fail('failed-precondition', 'The private email receipt is unavailable.');
      const resolved = await deps.email({
        ref,
        actorUid: input.actorUid,
        commandId,
        expectedRevision: input.expectedRevision,
        expectedGeneration: job.generation,
        expectedReceiptToken: token,
        resolution: review as Record<string, unknown>,
        fence: authorizedFence,
        commit: async (tx, emailResult) => {
          await commit(tx, {
            signal: { name: 'emailResume', args: [] },
            ...(emailResult.replacementJobId
              ? { replacementJobRef: { projectId: deps.projectId, jobId: emailResult.replacementJobId } }
              : {}),
          });
        },
      });
      const emailCommit =
        result ?? fail('failed-precondition', 'Email resolution did not atomically commit the resume command.');
      if (resolved.replacementJobId && emailCommit.replacementJobRef?.jobId !== resolved.replacementJobId)
        fail('failed-precondition', 'Reviewed email replacement did not match its command.');
    } else if (image) {
      if (input.resolution.receiptId !== undefined && input.resolution.receiptId !== ref.jobId)
        fail('permission-denied', 'The image receipt does not belong to this operation.');
      const imageInput = {
        ref,
        actorUid: input.actorUid,
        commandId,
        expectedRevision: input.expectedRevision,
        expectedGeneration: job.generation,
        fence: authorizedFence,
        commit: (tx: Transaction) => commit(tx, { signal: { name: 'image.resume', args: [] } }),
      };
      if (imageDeletion) {
        if (!deps.imageDeletion) fail('failed-precondition', 'Image deletion review is unavailable.');
        await deps.imageDeletion!({ ...imageInput, review: validateImageCleanupReview(input.resolution) });
      } else await deps.image({ ...imageInput, review: review as IntentionalResourceAdoption | ImageCleanupReview });
    } else {
      identifier(input.resolution.receiptId, 'provider receipt');
      const receipt = await deps.firestore.collection('temporalProviderReceipts').doc(input.resolution.receiptId).get();
      const operationKey = receipt.get('operationKey');
      if (
        typeof operationKey !== 'string' ||
        ![`durable:${deps.projectId}:${ref.jobId}:`].some((prefix) => operationKey.startsWith(prefix))
      )
        fail('permission-denied', 'The provider receipt does not belong to this operation.');
      if (receipt.get('step') === 'image-create' && !cleanupOnly)
        fail(
          'failed-precondition',
          'An uncertain shared image cannot be adopted for overwrite. Review retention during cleanup and submit a fresh owned image intent.'
        );
      if (retainExisting) {
        const saved = receipt.get('result');
        const ids =
          typeof saved === 'string'
            ? [saved]
            : saved && typeof saved === 'object'
            ? [saved.id, saved.audioId, saved.listId, saved.tagId, saved.trackIdentifier, saved.soundCloudTrackId]
            : [];
        if (receipt.get('state') !== 'confirmed' || !ids.includes(input.resolution.remoteId))
          fail('failed-precondition', 'Retention requires the same already confirmed resource.');
      }
      await deps.publishing({
        ref,
        receiptId: input.resolution.receiptId,
        actorUid: input.actorUid,
        commandId,
        cleanupOnly,
        review: review as IntentionalResourceAdoption | ExistingResourceRetention,
        fence: authorizedFence,
        commit: async (tx) => {
          const retention = retainExisting
            ? await (
                deps.prepareKnownRetention ??
                (() => fail('failed-precondition', 'Provider retention protection is unavailable.'))
              )(tx, {
                ref,
                receiptId: input.resolution.receiptId as string,
                remoteId: (review as IntentionalResourceAdoption | ExistingResourceRetention).remoteId,
              })
            : undefined;
          const retainedReceipt = retainExisting
            ? await tx.get(
                deps.firestore.collection('temporalProviderReceipts').doc(input.resolution.receiptId as string)
              )
            : undefined;
          await commit(tx, { signal: { name: accountSpeaker ? 'accountResume' : 'publishingResume', args: [] } });
          retention?.commit();
          if (retention && retainedReceipt)
            tx.create(deps.firestore.collection('temporalProviderRetentions').doc(commandId), {
              schemaVersion: 1,
              ...ref,
              receiptId: input.resolution.receiptId,
              remoteId: (review as IntentionalResourceAdoption | ExistingResourceRetention).remoteId,
              resource: retention.resource,
              bindingId: `retained-existing:${input.resolution.receiptId}`,
              providerReceiptFingerprint: retainedReceipt.get('fingerprint'),
              receiptRevision: (retainedReceipt.get('revision') ?? 0) + 1,
              actorUid: input.actorUid,
              commandId,
              decision: 'retain_existing_resource',
              evidenceReference: input.resolution.evidenceReference,
              reason: input.resolution.reason,
              reviewedAtMillis: Date.now(),
            });
        },
      });
    }
    return result ?? fail('failed-precondition', 'Resolution did not atomically commit the resume command.');
  };
}

/** Lazy domain imports keep isolated SMTP configuration out of Firebase discovery. */
export async function resolveDurableDomain(
  input: DurableDomainResolutionInput,
  hooks: DurableResolutionCommitHooks
): Promise<DurableDomainResolutionResult> {
  const { default: admin } = await import('@upperroom/shared/firebase/firebaseAdmin');
  const projectId =
    admin.app().options.projectId ??
    process.env.GCLOUD_PROJECT ??
    fail('failed-precondition', 'Firebase project is unavailable.');
  const firestore = admin.firestore(),
    store = createDurableJobStore({ firestore, projectId });
  const resolver = createDurableDomainResolver({
    firestore,
    projectId,
    getActor: async (uid) => admin.auth().getUser(uid),
    prepareCriticalRepair: async (tx, value) => {
      const source = await import('./publishing/criticalRepair');
      return source.preparePublishingCriticalRepair(tx, firestore, value);
    },
    publishing: async (value) => {
      const publishing = await import('./publishing/receiptResolution');
      await publishing.resolvePublishingProviderReceipt({
        receiptId: value.receiptId,
        actorUid: value.actorUid,
        commandId: value.commandId,
        cleanupOnly: value.cleanupOnly,
        expectedJobRef: value.ref,
        assertCurrentInTransaction: value.fence,
        onResolutionCommit: value.commit,
        ...value.review,
      });
    },
    prepareKnownRetention: async (tx, value) => {
      const usage = await import('@upperroom/orchestration/provider-usage');
      const receipt = await tx.get(firestore.collection('temporalProviderReceipts').doc(value.receiptId));
      const resource = usage.extractProviderResources(
        value.ref.projectId,
        'durableJobIntents/review',
        receipt.get('step') === 'soundcloud-track'
          ? { soundCloudTrackId: value.remoteId }
          : { subsplashId: value.remoteId }
      )[0];
      if (!resource) fail('failed-precondition', 'The retained resource identity is invalid.');
      const apply = await usage.prepareProviderBinding(tx, firestore, {
        resource,
        jobId: value.ref.jobId,
        bindingId: `retained-existing:${value.receiptId}`,
      });
      return { resource, commit: apply };
    },
    verifyOrphanAbsent: async (value) => {
      const publishing = await import('./publishing/receiptResolution');
      return publishing.verifyAcknowledgedResourceAbsent(
        value.receipt as import('./publishing/providerReceipts').ProviderReceipt,
        value.remoteId
      );
    },
    prepareOrphanDisposition: async (tx, value) => {
      const usage = await import('@upperroom/orchestration/provider-usage');
      const resource = usage.extractProviderResources(
        value.ref.projectId,
        'durableJobIntents/review',
        value.fact.step === 'soundcloud-track'
          ? { soundCloudTrackId: value.fact.remoteId }
          : { subsplashId: value.fact.remoteId }
      )[0];
      if (!resource) fail('failed-precondition', 'The original resource identity is invalid.');
      const apply = await usage.prepareProviderAcknowledgementDisposition(tx, firestore, {
        resource,
        jobId: value.ref.jobId,
        acknowledgementId: value.acknowledgementId,
        factFingerprint: fingerprint(value.fact),
        decision: value.decision,
        pendingBinding: {
          jobId: fingerprint(['provider-orphan-review', value.ref.projectId, value.acknowledgementId]),
          bindingId: `pending-provider-ack:${value.acknowledgementId}`,
        },
      });
      return { resource, commit: apply };
    },
    verifyOrphanResource: async (value) => {
      const publishing = await import('./publishing/receiptResolution');
      return publishing.verifyPublishingRemoteResource(
        value.receipt as import('./publishing/providerReceipts').ProviderReceipt,
        value.remoteId,
        { inspectOnly: true }
      );
    },
    imageDeletion: async (value) => {
      const images = await import('./images/activities');
      await images.resolveImageDeletionReview(
        {
          firestore,
          loadIntent: (ref) => store.loadIntent<import('./images/types').ImageIntent>(ref),
          assertCurrent: async (ref) => {
            await store.assertCurrent(ref);
          },
          assertCurrentInTransaction: async (tx: Transaction, ref: DurableJobRef) =>
            store.assertCurrentInTransaction(tx, ref),
        },
        value.ref,
        {
          actorUid: value.actorUid,
          commandId: value.commandId,
          expectedJobRevision: value.expectedRevision,
          expectedGeneration: value.expectedGeneration,
          assertCurrentInTransaction: value.fence,
          onResolutionCommit: value.commit,
          ...value.review,
        }
      );
    },
    image: async (value) => {
      const images = await import('./images/activities');
      await images.resolveImageAllocation(
        {
          firestore,
          loadIntent: (ref) => store.loadIntent<import('./images/types').ImageIntent>(ref),
          assertCurrent: async (ref) => {
            await store.assertCurrent(ref);
          },
          assertCurrentInTransaction: async (tx: Transaction, ref: DurableJobRef) =>
            store.assertCurrentInTransaction(tx, ref),
        },
        value.ref,
        value.review.remoteId,
        {
          actorUid: value.actorUid,
          commandId: value.commandId,
          expectedJobRevision: value.expectedRevision,
          expectedGeneration: value.expectedGeneration,
          assertCurrentInTransaction: value.fence,
          onResolutionCommit: value.commit,
          ...value.review,
        }
      );
    },
    email: async (value) => {
      const email = await import('../../../function-kits/firestore-send-email/src/temporal/resolution');
      return email.resolveDurableEmail(firestore, {
        ref: value.ref,
        actorUid: value.actorUid,
        commandId: value.commandId,
        expectedJobRevision: value.expectedRevision,
        expectedGeneration: value.expectedGeneration,
        expectedReceiptToken: value.expectedReceiptToken,
        assertCurrentInTransaction: value.fence,
        onResolutionCommit: value.commit,
        ...value.resolution,
      } as Parameters<typeof email.resolveDurableEmail>[1]);
    },
  });
  return resolver(input, hooks);
}
