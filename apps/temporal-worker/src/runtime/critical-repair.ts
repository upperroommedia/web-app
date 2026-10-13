import type { Auth } from 'firebase-admin/auth';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { DurableActivityExecution, DurableJobIntent } from '@upperroom/orchestration/job-store';

export interface CriticalRepairScope {
  schemaVersion: 1;
  projectId: string;
  jobId: string;
  generation: number;
  workflowId: string;
  intentFingerprint: string;
  criticalFingerprint: string;
  operations: readonly unknown[];
  sourceEvidenceDigests: unknown;
}
interface Dependencies<C extends CriticalRepairScope> {
  firestore: Firestore;
  auth: Pick<Auth, 'getUser'>;
  projectId: string;
  getExecution(): DurableActivityExecution | undefined;
  digest(value: unknown): string;
  /** Source owns immutable journal/resource evidence validation, including inside a transaction. */
  loadValidatedCertificate(ref: DurableJobRef, certificateId: string, transaction?: Transaction): Promise<C>;
  authorizeDerivedOperation?(ref: DurableJobRef, certificate: C, operation: unknown): Promise<void>;
  authorizeCertifiedDeletionInTransaction?(
    transaction: Transaction,
    ref: DurableJobRef,
    certificate: C,
    operation: unknown,
    phase: 'acquire' | 'replay' | 'claim' | 'close' | 'settle'
  ): Promise<void>;
  assertExecution(ref: DurableJobRef, transaction?: Transaction): Promise<unknown>;
  authorizeDeletedCanonicalCleanup?(
    intent: DurableJobIntent<unknown>,
    execution: DurableActivityExecution,
    transaction?: Transaction
  ): Promise<void>;
}
const deny = (): never => {
  throw Object.assign(new Error('Critical repair authority is unavailable'), { code: 'PERMISSION_CHANGED' });
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** A repair grant is authority for exact source-certified facts, never permission to replay an intent. */
export function createCriticalRepairAuthority<C extends CriticalRepairScope>(dependencies: Dependencies<C>) {
  const { firestore, auth, projectId, getExecution, digest, loadValidatedCertificate } = dependencies;
  async function validate(ref: DurableJobRef, certificateId?: string, transaction?: Transaction): Promise<C> {
    const execution = getExecution();
    if (
      ref.projectId !== projectId ||
      !execution ||
      !['repairPublishingCritical', 'beginDurableCriticalRepair'].includes(execution.activityType)
    )
      deny();
    await dependencies.assertExecution(ref, transaction);
    const read = (collection: string) => {
      const doc = firestore.collection(collection).doc(ref.jobId);
      return transaction ? transaction.get(doc) : doc.get();
    };
    const [jobSnapshot, intentSnapshot, criticalSnapshot, grantSnapshot, cancellation] = await Promise.all([
      read('durableJobs'),
      read('durableJobIntents'),
      read('durableJobCriticalSections'),
      read('durableJobCriticalRepairGrants'),
      read('durableJobCancellationIntents'),
    ]);
    const job = jobSnapshot.data(),
      intent = intentSnapshot.data(),
      critical = criticalSnapshot.data(),
      grant = grantSnapshot.data();
    const cancellationProof = cancellation.data();
    const repairCleanup =
      cancellation.exists &&
      cancellationProof?.schemaVersion === 1 &&
      cancellationProof.projectId === projectId &&
      cancellationProof.jobId === ref.jobId &&
      cancellationProof.workflowId === execution!.workflowId &&
      cancellationProof.generation === job?.generation &&
      cancellationProof.purpose === 'critical_repair_cleanup' &&
      cancellationProof.certificateId === grant?.certificateId &&
      cancellationProof.actorUid === grant?.actorUid &&
      Number.isFinite(cancellationProof.authorizedAt) &&
      cancellationProof.authorizedAt > 0;
    if (
      !job ||
      !intent ||
      !critical ||
      !grant ||
      (cancellation.exists && !repairCleanup) ||
      ['succeeded', 'failed', 'cancelled', 'superseded'].includes(job.state) ||
      ((job.state === 'cancel_requested' || job.result?.resolutionPurpose === 'cleanup') && !repairCleanup) ||
      grant.schemaVersion !== 1 ||
      grant.projectId !== projectId ||
      grant.jobId !== ref.jobId ||
      grant.workflowId !== execution!.workflowId ||
      job.workflowId !== execution!.workflowId ||
      intent.projectId !== projectId ||
      intent.jobId !== ref.jobId ||
      critical.projectId !== projectId ||
      critical.jobId !== ref.jobId ||
      critical.workflowId !== execution!.workflowId ||
      grant.generation !== job.generation ||
      intent.generation !== job.generation ||
      critical.generation !== job.generation ||
      typeof grant.actorUid !== 'string' ||
      !grant.actorUid ||
      typeof grant.commandId !== 'string' ||
      !grant.commandId ||
      typeof grant.reason !== 'string' ||
      !grant.reason.trim() ||
      typeof grant.evidenceReference !== 'string' ||
      !grant.evidenceReference.trim() ||
      !Number.isFinite(grant.createdAtMillis) ||
      grant.createdAtMillis <= 0 ||
      typeof grant.certificateId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(grant.certificateId) ||
      (certificateId !== undefined && certificateId !== grant.certificateId) ||
      digest(intent) !== grant.intentFingerprint ||
      digest(critical) !== grant.criticalFingerprint
    )
      deny();
    const certificate = await loadValidatedCertificate(ref, grant!.certificateId, transaction);
    if (
      certificate.schemaVersion !== 1 ||
      certificate.projectId !== projectId ||
      certificate.jobId !== ref.jobId ||
      certificate.generation !== job!.generation ||
      certificate.workflowId !== execution!.workflowId ||
      certificate.intentFingerprint !== grant!.intentFingerprint ||
      certificate.criticalFingerprint !== grant!.criticalFingerprint ||
      digest(certificate) !== grant!.certificateDigest ||
      digest(certificate.operations) !== digest(grant!.operations) ||
      digest(certificate.sourceEvidenceDigests) !== digest(grant!.sourceEvidenceDigests)
    )
      deny();
    const reviewer = await auth.getUser(grant!.actorUid).catch((error) => {
      if (error?.code === 'auth/user-not-found') deny();
      throw error;
    });
    if (reviewer.disabled || reviewer.customClaims?.role !== 'admin') deny();
    if (
      execution!.activityType === 'repairPublishingCritical' &&
      ((intent!.kind === 'sermon.delete' && intent!.entity?.type === 'sermon') ||
        (intent!.kind === 'list.delete' && intent!.entity?.type === 'list'))
    ) {
      const root = firestore.collection(intent!.entity.type === 'sermon' ? 'sermons' : 'lists').doc(intent!.entity.id);
      const canonical = transaction ? await transaction.get(root) : await root.get();
      if (!canonical.exists) {
        if (!dependencies.authorizeDeletedCanonicalCleanup) deny();
        await dependencies.authorizeDeletedCanonicalCleanup!(
          intent as DurableJobIntent<unknown>,
          execution!,
          transaction
        );
      }
    }
    return certificate;
  }
  return {
    loadCertificate: (ref: DurableJobRef, certificateId: string) => validate(ref, certificateId),
    assertCurrentInTransaction: (transaction: Transaction, ref: DurableJobRef, certificateId: string) =>
      validate(ref, certificateId, transaction),
    authorizeIntent: async (intent: DurableJobIntent<unknown>, transaction?: Transaction) => {
      await validate(intent, undefined, transaction);
    },
    async authorizePartialStopInTransaction(
      transaction: Transaction,
      ref: DurableJobRef,
      certificateId: string,
      operation: unknown
    ): Promise<void> {
      if (getExecution()?.activityType !== 'repairPublishingCritical') deny();
      const certificate = await validate(ref, certificateId, transaction),
        descriptor = object(operation);
      if (
        !descriptor ||
        descriptor.kind !== 'sermon_deletion_partial_stop' ||
        Object.keys(descriptor).sort().join(',') !== 'kind,planId,sessionId' ||
        typeof descriptor.planId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(descriptor.planId) ||
        typeof descriptor.sessionId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(descriptor.sessionId) ||
        certificate.operations.length !== 1 ||
        digest(certificate.operations[0]) !== digest(operation)
      )
        deny();
      await validate(ref, certificateId, transaction);
    },
    async authorizeCertifiedDeletionInTransaction(
      transaction: Transaction,
      ref: DurableJobRef,
      certificateId: string,
      operation: unknown,
      phase: 'acquire' | 'replay' | 'claim' | 'close' | 'settle'
    ): Promise<void> {
      if (
        getExecution()?.activityType !== 'repairPublishingCritical' ||
        !['acquire', 'replay', 'claim', 'close', 'settle'].includes(phase)
      )
        deny();
      const descriptor = object(operation);
      if (
        !descriptor ||
        descriptor.kind !== 'provider_delete' ||
        (descriptor.method !== undefined && descriptor.method !== 'DELETE') ||
        !dependencies.authorizeCertifiedDeletionInTransaction
      )
        deny();
      const certificate = await validate(ref, certificateId, transaction);
      if (
        certificate.operations.some((op) =>
          ['publishing_zero_effects_stop', 'sermon_deletion_partial_stop'].includes(String(object(op)?.kind))
        )
      )
        deny();
      // The source validator distinguishes new claims from exact original fact
      // replay and owns fixed journal/catalogue membership in this same transaction.
      await dependencies.authorizeCertifiedDeletionInTransaction!(transaction, ref, certificate, operation, phase);
      await validate(ref, certificateId, transaction);
    },
    async authorizeOperation(ref: DurableJobRef, certificateId: string, operation: unknown): Promise<void> {
      if (getExecution()?.activityType !== 'repairPublishingCritical') deny();
      const certificate = await validate(ref, certificateId);
      const descriptor = object(operation);
      if (
        !descriptor ||
        ![
          'provider_read',
          'canonical_repair',
          'provider_delete',
          'acknowledged_projection',
          'legacy_soundcloud_retain',
          'local_sermon_delete',
          'publishing_zero_effects_stop',
          'sermon_deletion_partial_stop',
        ].includes(String(descriptor.kind))
      )
        deny();
      const approvedDescriptor = descriptor!;
      const zeroStop = certificate.operations.find((op) => object(op)?.kind === 'publishing_zero_effects_stop');
      if (zeroStop && (certificate.operations.length !== 1 || digest(operation) !== digest(zeroStop))) deny();
      const partialStop = certificate.operations.find((op) => object(op)?.kind === 'sermon_deletion_partial_stop');
      if (
        partialStop &&
        (certificate.operations.length !== 1 ||
          (approvedDescriptor.kind !== 'provider_read' && digest(operation) !== digest(partialStop)))
      )
        deny();
      // Default transports independently enforce fixed URLs and original provider accounts.
      if (
        approvedDescriptor.kind === 'provider_read' &&
        approvedDescriptor.method !== undefined &&
        approvedDescriptor.method !== 'GET'
      )
        deny();
      if (
        approvedDescriptor.kind === 'provider_delete' &&
        approvedDescriptor.method !== undefined &&
        approvedDescriptor.method !== 'DELETE'
      )
        deny();
      if (approvedDescriptor.kind === 'provider_delete') {
        const intent = await firestore.collection('durableJobIntents').doc(ref.jobId).get();
        const entity = intent.get('entity');
        if (
          (intent.get('kind') === 'sermon.delete' &&
            entity?.type === 'sermon' &&
            !(await firestore.collection('sermons').doc(entity.id).get()).exists) ||
          (intent.get('kind') === 'list.delete' &&
            entity?.type === 'list' &&
            !(await firestore.collection('lists').doc(entity.id).get()).exists)
        )
          deny();
        const cancellation = await firestore.collection('durableJobCancellationIntents').doc(ref.jobId).get();
        if (cancellation.exists && cancellation.get('purpose') !== 'critical_repair_cleanup') deny();
      }
      if (approvedDescriptor.kind === 'canonical_repair' && approvedDescriptor.method !== undefined) deny();
      if (
        approvedDescriptor.kind === 'acknowledged_projection' &&
        (Object.keys(approvedDescriptor).some((key) => !['kind', 'sessionId', 'projectionDigest'].includes(key)) ||
          typeof approvedDescriptor.sessionId !== 'string' ||
          !/^[a-f0-9]{64}$/.test(approvedDescriptor.sessionId) ||
          typeof approvedDescriptor.projectionDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(approvedDescriptor.projectionDigest))
      )
        deny();
      if (
        approvedDescriptor.kind === 'legacy_soundcloud_retain' &&
        (Object.keys(approvedDescriptor).sort().join(',') !== 'certificateId,kind' ||
          typeof approvedDescriptor.certificateId !== 'string' ||
          !/^[a-f0-9]{64}$/.test(approvedDescriptor.certificateId))
      )
        deny();
      if (
        approvedDescriptor.kind === 'local_sermon_delete' &&
        (Object.keys(approvedDescriptor).sort().join(',') !== 'kind,planId' ||
          typeof approvedDescriptor.planId !== 'string' ||
          !/^[a-f0-9]{64}$/.test(approvedDescriptor.planId))
      )
        deny();
      if (
        ['publishing_zero_effects_stop', 'sermon_deletion_partial_stop'].includes(String(approvedDescriptor.kind)) &&
        (Object.keys(approvedDescriptor).sort().join(',') !== 'kind,planId,sessionId' ||
          typeof approvedDescriptor.planId !== 'string' ||
          !/^[a-f0-9]{64}$/.test(approvedDescriptor.planId) ||
          typeof approvedDescriptor.sessionId !== 'string' ||
          !/^[a-f0-9]{64}$/.test(approvedDescriptor.sessionId))
      )
        deny();
      const fingerprint = digest(operation);
      if (!certificate.operations.some((approved) => digest(approved) === fingerprint)) {
        if (!dependencies.authorizeDerivedOperation) deny();
        await dependencies.authorizeDerivedOperation!(ref, certificate, operation);
        await validate(ref, certificateId);
      }
    },
  };
}
