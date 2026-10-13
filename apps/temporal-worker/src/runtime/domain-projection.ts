import type { DurableJob } from '@upperroom/contracts/temporal';
import type { DurableJobPatch } from '@upperroom/orchestration/job-store';
export interface DomainStepResult {
  state: string;
  code?: string;
  receiptId?: string;
  acknowledgementId?: string;
  blockingJobId?: string;
  mutationSessionId?: string;
  result?: Record<string, unknown>;
  cancelOnly?: boolean;
}
/** A source-certified stop finishes recovery, without claiming the desired deletion completed. */
export function createStoppedRepairProjection(
  job: Pick<DurableJob, 'revision' | 'result' | 'steps'>,
  result: { state: string; mode?: string; providerEffects?: string; contentPreserved?: boolean },
  now: number
): DurableJobPatch | undefined {
  if (
    result.state !== 'completed' ||
    result.mode !== 'partial_stop' ||
    result.contentPreserved !== true ||
    !['not_started', 'partial'].includes(result.providerEffects ?? '')
  )
    return;
  return {
    expectedRevision: job.revision,
    state: 'cancel_requested',
    actions: [],
    attention: undefined,
    error: undefined,
    result: {
      ...job.result,
      resolutionPurpose: 'cleanup',
      mode: 'partial_stop',
      providerEffects: result.providerEffects!,
      contentPreserved: true,
    },
    steps: job.steps
      .filter((step) => step.id !== 'cleanup' && !['succeeded', 'cancelled', 'superseded'].includes(step.state))
      .map((step) => {
        const { error, nextRetryAt, ...prior } = step;
        return { ...prior, state: 'cancelled' as const, finishedAt: now };
      }),
  };
}
/** Reviewed cancellation remains live until external changes are confirmed and cleaned. */
export function createDomainAttentionProjection(
  job: Pick<DurableJob, 'kind'> & Partial<Pick<DurableJob, 'state' | 'attention' | 'actions' | 'error' | 'result'>>,
  id: string,
  result: DomainStepResult
): DurableJobPatch {
  const temporary = [
    'PUBLISHING_AUDIO_PROCESSING',
    'PUBLISHING_TRANSIENT',
    'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
    'PUBLISHING_DELETION_SETTLEMENT_PENDING',
  ].includes(result.code ?? '');
  const blockedByJob =
    result.blockingJobId && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.blockingJobId)
      ? { blockingJobId: result.blockingJobId }
      : {};
  const allocationReview = result.code === 'PUBLISHING_PROVIDER_ALLOCATION_REVIEW_REQUIRED';
  const mutableUnresolved = [
    'PROVIDER_MUTATION_UNRESOLVED',
    'PUBLISHING_CANCEL_MUTATION_REVIEW_REQUIRED',
    'PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED',
  ].includes(result.code ?? '');
  const metadataDestinationsChanged = result.code === 'PUBLISHING_METADATA_DESTINATIONS_CHANGED';
  const allocationSourceChanged = result.code === 'PUBLISHING_ALLOCATION_SOURCE_CHANGED';
  const sourceFrozen = result.code === 'PUBLISHING_SOURCE_CLAIMS_FROZEN';
  const graphChangedUnsent = result.code === 'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT';
  const quarantinedResult = result.code === 'PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED';
  const mutationResult =
    result.mutationSessionId && /^[a-f0-9]{64}$/.test(result.mutationSessionId)
      ? { mutationSessionId: result.mutationSessionId }
      : {};
  if (!result.cancelOnly && temporary && job.state === 'needs_attention' && job.attention?.stepId !== id) {
    // A retry in another destination cannot hide an unresolved provider receipt.
    return {
      state: 'needs_attention',
      actions: job.actions ?? ['resolve', 'cancel'],
      attention: job.attention,
      ...(job.error ? { error: job.error } : {}),
      ...(job.result ? { result: job.result } : {}),
    };
  }
  const unknownAccountAccess = [
    'ACCOUNT_CLAIMS_RECONCILIATION_REQUIRED',
    'ACCOUNT_SESSIONS_RECONCILIATION_REQUIRED',
  ].includes(result.code ?? '');
  const account =
    job.kind.startsWith('invite.') || ['role.resolve', 'role.assign', 'speaker.resolve'].includes(job.kind);
  if (
    result.cancelOnly &&
    [
      'PUBLISHING_CANCEL_PROVIDER_FETCH_PENDING',
      'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING',
      'PUBLISHING_CRITICAL_REPAIR_PROJECTION_PENDING',
    ].includes(result.code ?? '')
  )
    return {
      state: 'cancel_requested',
      actions: [],
      attention: undefined,
      result: { resolutionPurpose: 'cleanup' },
      error: {
        code: result.code!,
        message:
          result.code === 'PUBLISHING_CRITICAL_REPAIR_PROJECTION_PENDING'
            ? 'Confirmed destination changes are being applied to tracking.'
            : result.code === 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING'
            ? 'Cancellation is waiting for protected resource references to be verified.'
            : 'Cancellation is waiting for the provider to finish fetching protected audio.',
        retryable: true,
      },
    };
  if (result.cancelOnly)
    return {
      state: 'cancel_requested',
      actions: mutableUnresolved || sourceFrozen ? [] : ['resolve'],
      result: {
        resolutionPurpose: 'cleanup',
        ...(result.receiptId ? { receiptId: result.receiptId } : {}),
        ...mutationResult,
      },
      attention: {
        kind: result.code === 'PUBLISHING_DRIFT' ? 'remote_drift' : 'external_result_unknown',
        stepId: id,
        ...(result.acknowledgementId && /^[a-f0-9]{64}$/.test(result.acknowledgementId)
          ? { acknowledgementId: result.acknowledgementId }
          : {}),
        ...(result.receiptId ? { receiptId: result.receiptId } : {}),
        message: quarantinedResult
          ? 'The destination response could not be safely recorded. Tracking needs review and cancellation remains pending.'
          : mutableUnresolved
          ? 'The original provider request may still arrive. Cancellation remains pending until its outcome is verified.'
          : 'Cancellation is waiting for confirmation and cleanup of external changes.',
      },
      error: {
        code: /^[A-Z0-9_]{1,100}$/.test(result.code ?? '') ? result.code! : 'CANCELLATION_REVIEW_REQUIRED',
        message: quarantinedResult
          ? 'The destination response could not be safely recorded. Tracking needs review and cancellation remains pending.'
          : mutableUnresolved
          ? 'The original provider request may still arrive. Cancellation remains pending until its outcome is verified.'
          : 'Review the external result so cancellation cleanup can finish.',
        retryable: false,
      },
    };
  return {
    state: temporary ? 'retrying' : 'needs_attention',
    actions:
      mutableUnresolved || sourceFrozen
        ? []
        : graphChangedUnsent || allocationSourceChanged || metadataDestinationsChanged
        ? ['cancel']
        : temporary
        ? ['cancel']
        : account
        ? unknownAccountAccess || (result.receiptId && result.state === 'needs_review')
          ? ['resolve']
          : ['resume']
        : result.state === 'needs_review'
        ? ['resolve', 'cancel']
        : ['resume', 'cancel'],
    ...(!temporary
      ? {
          attention: {
            kind: graphChangedUnsent
              ? 'remote_drift'
              : unknownAccountAccess || allocationReview || mutableUnresolved || result.state === 'needs_review'
              ? 'external_result_unknown'
              : 'permission_changed',
            stepId: id,
            ...(result.acknowledgementId && /^[a-f0-9]{64}$/.test(result.acknowledgementId)
              ? { acknowledgementId: result.acknowledgementId }
              : {}),
            ...(result.receiptId ? { receiptId: result.receiptId } : {}),
            message: metadataDestinationsChanged
              ? 'The selected destinations changed during this task. Cancel it to review any original update, then refresh and submit a new task.'
              : allocationSourceChanged
              ? 'The source changed while its destination result was being prepared. Cancel this task to review its original result, then refresh and submit a new task.'
              : sourceFrozen
              ? 'This task is paused while its destination changes are reviewed.'
              : graphChangedUnsent
              ? 'The destination changed before any request was sent. Refresh it and submit a new task.'
              : quarantinedResult
              ? 'The destination response could not be safely recorded. Tracking needs review before this task can continue.'
              : mutableUnresolved
              ? 'The original provider request may still arrive. Its outcome must be verified before this task can continue.'
              : allocationReview
              ? 'Review the earlier publishing task before this operation can continue.'
              : 'This operation needs review before it can continue.',
          },
        }
      : {}),
    ...(result.receiptId || Object.keys(blockedByJob).length || Object.keys(mutationResult).length
      ? { result: { ...(result.receiptId ? { receiptId: result.receiptId } : {}), ...blockedByJob, ...mutationResult } }
      : {}),
    error: {
      code: /^[A-Z0-9_]{1,100}$/.test(result.code ?? '') ? result.code! : 'DOMAIN_REVIEW_REQUIRED',
      message: metadataDestinationsChanged
        ? 'The selected destinations changed during this task. Cancel it to review any original update, then refresh and submit a new task.'
        : allocationSourceChanged
        ? 'The source changed while its destination result was being prepared. Cancel this task to review its original result, then refresh and submit a new task.'
        : sourceFrozen
        ? 'This task is paused while its destination changes are reviewed.'
        : graphChangedUnsent
        ? 'The destination changed before any request was sent. Refresh it and submit a new task.'
        : quarantinedResult
        ? 'The destination response could not be safely recorded. Tracking needs review before this task can continue.'
        : mutableUnresolved
        ? 'The original provider request may still arrive. Its outcome must be verified before this task can continue.'
        : result.code === 'PUBLISHING_PROVIDER_ALLOCATION_PENDING'
        ? 'Waiting for another publishing task to finish or be reviewed.'
        : result.code === 'PUBLISHING_DELETION_SETTLEMENT_PENDING'
        ? 'Confirming deletion tracking before completing this task.'
        : temporary
        ? 'This step is waiting to retry automatically.'
        : 'Review is required before continuing.',
      retryable: temporary,
    },
  };
}
/** Clear only the confirmed step's attention; concurrent destination waits remain visible. */
export function createDomainSuccessProjection(
  job: Pick<DurableJob, 'kind' | 'state' | 'attention' | 'result' | 'revision'>,
  id: string,
  result: DomainStepResult
): DurableJobPatch | undefined {
  if (
    result.cancelOnly ||
    job.result?.resolutionPurpose === 'cleanup' ||
    !['needs_attention', 'reconciling'].includes(job.state) ||
    job.attention?.stepId !== id
  )
    return;
  const account =
    job.kind.startsWith('invite.') || ['role.resolve', 'role.assign', 'speaker.resolve'].includes(job.kind);
  return { state: 'running', expectedRevision: job.revision, actions: account ? [] : ['cancel'] };
}
