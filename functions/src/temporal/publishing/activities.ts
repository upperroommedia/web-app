import type {
  PrivatePublishingIntent,
  PublishingDomainDependencies,
  PublishingJobRef,
  PublishingPlan,
  PublishingStep,
  PublishingStepResult,
} from './types';
import { listProviderReceiptsForJob } from './providerReceipts';
import { runDurablePublishingOperation } from './durableOperationContext';

/** Domain composition remains outside Firebase/Temporal transports and is testable with provider adapters. */
export function createPublishingActivities(dependencies: PublishingDomainDependencies) {
  const execute = async (
    ref: PublishingJobRef,
    step: PublishingStep,
    operation: keyof Pick<
      PublishingDomainDependencies,
      | 'ensureSubsplashMedia'
      | 'ensureSoundCloudTrack'
      | 'awaitSubsplashReady'
      | 'awaitSoundCloudReady'
      | 'mutateLists'
      | 'mutateSeries'
      | 'updateMetadata'
      | 'updateMemberships'
      | 'replaceAudio'
      | 'prepareDeletePlan'
      | 'deleteProviders'
      | 'commitProjection'
      | 'reconcile'
    >
  ): Promise<PublishingStepResult> => {
    const intent = await dependencies.loadIntent(ref);
    try {
      await dependencies.assertCurrent(ref, intent);
      await runDurablePublishingOperation(
        ref.jobId,
        () => dependencies[operation](ref, intent),
        dependencies.commitCurrent ? (mutate) => dependencies.commitCurrent!(ref, mutate) : undefined,
        {
          getSourceStepIds: dependencies.getSourceStepIds,
          prepareProviderMutationEffectsClosed: dependencies.prepareProviderMutationEffectsClosed
            ? (tx, plan) => dependencies.prepareProviderMutationEffectsClosed!(ref, tx, plan)
            : undefined,
          purpose: operation === 'commitProjection' ? 'factual_cleanup' : 'desired',
          abortProviderMutationPlan: dependencies.abortProviderMutationPlan
            ? (plan) => dependencies.abortProviderMutationPlan!(ref, plan)
            : undefined,
          prepareAcknowledgedProjectionPlan: dependencies.prepareAcknowledgedProjectionPlan
            ? (tx, plan) => dependencies.prepareAcknowledgedProjectionPlan!(ref, tx, plan)
            : undefined,
          beginProviderMutationPlan: dependencies.beginProviderMutationPlan
            ? (plan) => dependencies.beginProviderMutationPlan!(ref, plan)
            : undefined,
          runPublishingProviderMutation: dependencies.runPublishingProviderMutation
            ? (request) => dependencies.runPublishingProviderMutation!(ref, request)
            : undefined,
          prepareProviderMutationPlanCommit: dependencies.prepareProviderMutationPlanCommit
            ? (tx, plan) => dependencies.prepareProviderMutationPlanCommit!(ref, tx, plan)
            : undefined,
          markCritical: dependencies.markCritical
            ? (reasonCode, prepare) => dependencies.markCritical!(ref, reasonCode, prepare)
            : undefined,
        }
      );
      const result: PublishingStepResult = { state: 'completed' };
      await dependencies.recordStep(ref, step, result);
      return result;
    } catch (error) {
      const candidate =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : undefined;
      const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
      const reason = details && typeof details === 'object' && 'reason' in details ? details.reason : undefined;
      let receiptId =
        details &&
        typeof details === 'object' &&
        'receiptId' in details &&
        typeof details.receiptId === 'string' &&
        /^[a-f0-9]{64}$/.test(details.receiptId)
          ? details.receiptId
          : undefined;
      const blockingJobId =
        details &&
        typeof details === 'object' &&
        'blockingJobId' in details &&
        typeof details.blockingJobId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(details.blockingJobId)
          ? details.blockingJobId
          : undefined;
      const mutationSessionId =
        error &&
        typeof error === 'object' &&
        'mutationSessionId' in error &&
        typeof error.mutationSessionId === 'string' &&
        /^[a-f0-9]{64}$/.test(error.mutationSessionId)
          ? error.mutationSessionId
          : details &&
            typeof details === 'object' &&
            'mutationSessionId' in details &&
            typeof details.mutationSessionId === 'string' &&
            /^[a-f0-9]{64}$/.test(details.mutationSessionId)
          ? details.mutationSessionId
          : undefined;
      const detailCode = details && typeof details === 'object' && 'code' in details ? details.code : undefined;
      const responseStatus =
        error &&
        typeof error === 'object' &&
        'response' in error &&
        error.response &&
        typeof error.response === 'object' &&
        'status' in error.response
          ? error.response.status
          : undefined;
      const transportTransient =
        ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ERR_NETWORK', 'EAI_AGAIN'].includes(candidate ?? '') ||
        (typeof responseStatus === 'number' && (responseStatus === 429 || responseStatus >= 500));
      const code = ['PROVIDER_MUTATION_UNRESOLVED', 'PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED'].includes(
        String(candidate ?? detailCode)
      )
        ? String(candidate ?? detailCode)
        : ['PROVIDER_MUTATION_UNRESOLVED', 'PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED'].includes(String(detailCode))
        ? String(detailCode)
        : ['PERMISSION_CHANGED', 'permission-denied', 'PUBLISHING_PERMISSION_CHANGED'].includes(candidate ?? '')
        ? 'PUBLISHING_PERMISSION_CHANGED'
        : ['STALE_GENERATION', 'STALE_EXECUTION'].includes(candidate ?? '')
        ? 'PUBLISHING_SUPERSEDED'
        : reason === 'PROVIDER_RESULT_AMBIGUOUS'
        ? 'PROVIDER_CREATE_AMBIGUOUS'
        : detailCode === 'PUBLISHING_SOURCE_CLAIMS_FROZEN'
        ? 'PUBLISHING_SOURCE_CLAIMS_FROZEN'
        : detailCode === 'SOUNDCLOUD_RECONNECT_REQUIRED'
        ? 'SOUNDCLOUD_RECONNECT_REQUIRED'
        : detailCode === 'PUBLISHED_LIST_DRIFT_BLOCKED'
        ? 'PUBLISHING_DRIFT'
        : reason === 'PROVIDER_UPLOAD_SLOT_UNAVAILABLE'
        ? 'PUBLISHING_PROVIDER_REPAIR_REQUIRED'
        : transportTransient
        ? 'PUBLISHING_TRANSIENT'
        : candidate && ['unavailable', 'deadline-exceeded', 'resource-exhausted', 'aborted'].includes(candidate)
        ? 'PUBLISHING_TRANSIENT'
        : candidate &&
          [
            'PUBLISHING_METADATA_DESTINATIONS_CHANGED',
            'PUBLISHING_ALLOCATION_SOURCE_CHANGED',
            'PUBLISHING_SOURCE_CLAIMS_FROZEN',
            'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT',
            'PROVIDER_CREATE_AMBIGUOUS',
            'PUBLISHING_DRIFT',
            'SOUNDCLOUD_RECONNECT_REQUIRED',
            'PUBLISHING_SUPERSEDED',
            'PUBLISHING_PROVIDER_REPAIR_REQUIRED',
            'PUBLISHING_AUDIO_PROCESSING',
            'PUBLISHING_AUDIO_SUPERSEDED',
            'PUBLISHING_AUDIO_TRANSCODE_FAILED',
            'PUBLISHING_SOUNDCLOUD_DECISION_REQUIRED',
            'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
            'PUBLISHING_DELETION_SETTLEMENT_PENDING',
            'PUBLISHING_LEGACY_SOUNDCLOUD_RETENTION_REQUIRED',
          ].includes(candidate)
        ? candidate
        : 'PUBLISHING_OPERATION_FAILED';
      if (['PUBLISHING_PERMISSION_CHANGED', 'PUBLISHING_ALLOCATION_SOURCE_CHANGED'].includes(code) && !receiptId) {
        try {
          const receipts = await listProviderReceiptsForJob(ref);
          receiptId =
            (code === 'PUBLISHING_ALLOCATION_SOURCE_CHANGED'
              ? receipts.find(
                  (value) =>
                    value.receipt.state === 'confirmed' &&
                    ['subsplash-media-item', 'soundcloud-track'].includes(value.receipt.step)
                )?.receiptId
              : undefined) ??
            receipts.find((value) => value.receipt.state === 'executing' || value.receipt.state === 'needs_review')
              ?.receiptId ??
            receipts.find((value) => value.receipt.state === 'confirmed')?.receiptId;
        } catch {}
      }
      // Provider messages may contain credentials or URLs. Only stable classifications enter history.
      const result: PublishingStepResult = {
        state:
          code === 'PROVIDER_CREATE_AMBIGUOUS' || code === 'PUBLISHING_DRIFT'
            ? 'needs_review'
            : [
                'PUBLISHING_METADATA_DESTINATIONS_CHANGED',
                'PUBLISHING_ALLOCATION_SOURCE_CHANGED',
                'PUBLISHING_SOURCE_CLAIMS_FROZEN',
                'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT',
                'PROVIDER_MUTATION_UNRESOLVED',
                'PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED',
              ].includes(code) ||
              code === 'SOUNDCLOUD_RECONNECT_REQUIRED' ||
              code === 'PUBLISHING_PERMISSION_CHANGED' ||
              code === 'PUBLISHING_SUPERSEDED' ||
              code === 'PUBLISHING_PROVIDER_REPAIR_REQUIRED' ||
              code === 'PUBLISHING_AUDIO_SUPERSEDED' ||
              code === 'PUBLISHING_SOUNDCLOUD_DECISION_REQUIRED' ||
              code === 'PUBLISHING_LEGACY_SOUNDCLOUD_RETENTION_REQUIRED'
            ? 'blocked'
            : 'failed',
        code,
        ...(receiptId ? { receiptId } : {}),
        ...(blockingJobId ? { blockingJobId } : {}),
        ...(mutationSessionId ? { mutationSessionId } : {}),
      };
      await dependencies.recordStep(ref, step, result);
      return result;
    }
  };
  return {
    async loadPublishingPlan(ref: PublishingJobRef): Promise<PublishingPlan> {
      const intent = await dependencies.loadIntent(ref);
      await dependencies.assertCurrent(ref, intent);
      const removals = intent.payload.removals as Partial<PrivatePublishingIntent['destinations']> | undefined;
      return {
        sermonId: intent.sermonId,
        action: intent.action,
        generation: intent.generation,
        lists: intent.destinations.listIds.length > 0 || Boolean(removals?.listIds?.length),
        series: Boolean(intent.destinations.seriesId || removals?.seriesId),
        soundcloud: intent.destinations.soundcloud || removals?.soundcloud === true,
        needsMedia: intent.destinations.listIds.length > 0 || Boolean(intent.destinations.seriesId),
        requiresAudio: intent.action === 'update' && Boolean(intent.payload.processAudio),
        needsSoundCloud: intent.destinations.soundcloud,
        requiresMemberships: intent.action === 'update' && intent.payload.hasMembershipSelection === true,
      };
    },
    async reportPublishingCancellationFailure(ref: PublishingJobRef): Promise<PublishingStepResult> {
      let receiptId: string | undefined;
      try {
        const receipts = await listProviderReceiptsForJob(ref);
        receiptId = (
          receipts.find((value) => value.receipt.state === 'executing' || value.receipt.state === 'needs_review') ??
          receipts.find((value) => value.receipt.state === 'confirmed')
        )?.receiptId;
      } catch {
        /* Missing evidence retains the cancellation barrier. */
      }
      const result: PublishingStepResult = {
        state: 'blocked',
        code: 'PUBLISHING_CANCEL_REPAIR_REQUIRED',
        cancelOnly: true,
        ...(receiptId ? { receiptId } : {}),
      };
      await dependencies.recordStep(ref, 'cleanup', result);
      return result;
    },
    async cleanupCancelledPublishing(ref: PublishingJobRef): Promise<PublishingStepResult> {
      const intent = await dependencies.loadIntent(ref);
      await dependencies.assertCurrent(ref, intent);
      let result: PublishingStepResult;
      try {
        result = await runDurablePublishingOperation(
          ref.jobId,
          () => dependencies.cancelEffects(ref, intent),
          dependencies.commitCurrent ? (mutate) => dependencies.commitCurrent!(ref, mutate) : undefined,
          { cancelOnly: true }
        );
      } catch {
        result = { state: 'blocked', code: 'PUBLISHING_CANCEL_REPAIR_REQUIRED' };
      }
      const outcome: PublishingStepResult = { ...result, cancelOnly: true };
      await dependencies.recordStep(ref, 'cleanup', outcome);
      return outcome;
    },
    async recoverPublishingActivityFailure(
      ref: PublishingJobRef,
      step: string,
      failureType?: string
    ): Promise<PublishingStepResult> {
      // This is report-only: loss of the original actor's role cannot hide private receipt facts.
      let receipts: Awaited<ReturnType<typeof listProviderReceiptsForJob>>;
      try {
        receipts = await listProviderReceiptsForJob(ref);
      } catch {
        const blocked: PublishingStepResult = { state: 'blocked', code: 'PUBLISHING_PROVIDER_REPAIR_REQUIRED' };
        await dependencies.recordStep(
          ref,
          step === 'memberships'
            ? 'lists'
            : step === 'metadata' || step === 'reconciliation'
            ? 'projection'
            : (step as PublishingStep),
          blocked
        );
        return blocked;
      }
      const unknown = receipts.find(
        (value) => value.receipt.state === 'executing' || value.receipt.state === 'needs_review'
      );
      const result: PublishingStepResult = unknown
        ? { state: 'needs_review', code: 'PROVIDER_CREATE_AMBIGUOUS', receiptId: unknown.receiptId }
        : failureType &&
          ['PERMISSION_CHANGED', 'PUBLISHING_PERMISSION_CHANGED', 'permission-denied'].includes(failureType)
        ? { state: 'blocked', code: 'PUBLISHING_PERMISSION_CHANGED' }
        : { state: 'failed', code: 'PUBLISHING_TRANSIENT' };
      const known: PublishingStep[] = [
        'subsplash-media',
        'soundcloud-track',
        'lists',
        'series',
        'projection',
        'cleanup',
        'provider-audio',
        'delete-plan',
      ];
      const logical =
        step === 'memberships'
          ? 'lists'
          : known.includes(step as PublishingStep)
          ? (step as PublishingStep)
          : 'projection';
      await dependencies.recordStep(ref, logical, result);
      return result;
    },
    async projectPublishingAttention(
      ref: PublishingJobRef,
      step: string,
      code:
        | 'PUBLISHING_RETRY_EXHAUSTED'
        | 'PUBLISHING_PROVIDER_ALLOCATION_REVIEW_REQUIRED'
        | 'PUBLISHING_DELETION_SETTLEMENT_REVIEW_REQUIRED' = 'PUBLISHING_RETRY_EXHAUSTED',
      blockingJobId?: string
    ): Promise<void> {
      const known: PublishingStep[] = [
        'subsplash-media',
        'soundcloud-track',
        'lists',
        'series',
        'projection',
        'cleanup',
        'provider-audio',
        'delete-plan',
      ];
      await dependencies.recordStep(
        ref,
        known.includes(step as PublishingStep) ? (step as PublishingStep) : 'projection',
        {
          state: 'failed',
          code,
          ...(blockingJobId && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(blockingJobId) ? { blockingJobId } : {}),
        }
      );
    },
    ensurePublishingMedia: (ref: PublishingJobRef) => execute(ref, 'subsplash-media', 'ensureSubsplashMedia'),
    ensurePublishingSoundCloud: (ref: PublishingJobRef) => execute(ref, 'soundcloud-track', 'ensureSoundCloudTrack'),
    checkPublishingMediaReady: (ref: PublishingJobRef) => execute(ref, 'subsplash-media', 'awaitSubsplashReady'),
    checkPublishingSoundCloudReady: (ref: PublishingJobRef) => execute(ref, 'soundcloud-track', 'awaitSoundCloudReady'),
    applyPublishingLists: (ref: PublishingJobRef) => execute(ref, 'lists', 'mutateLists'),
    applyPublishingSeries: (ref: PublishingJobRef) => execute(ref, 'series', 'mutateSeries'),
    replacePublishingAudio: (ref: PublishingJobRef) => execute(ref, 'provider-audio', 'replaceAudio'),
    updatePublishingMemberships: (ref: PublishingJobRef) => execute(ref, 'lists', 'updateMemberships'),
    updatePublishingMetadata: (ref: PublishingJobRef) => execute(ref, 'projection', 'updateMetadata'),
    preparePublishingDeletePlan: (ref: PublishingJobRef) => execute(ref, 'delete-plan', 'prepareDeletePlan'),
    cleanupPublishingProviders: (ref: PublishingJobRef) => execute(ref, 'cleanup', 'deleteProviders'),
    commitPublishingProjection: (ref: PublishingJobRef) => execute(ref, 'projection', 'commitProjection'),
    reconcilePublishingState: (ref: PublishingJobRef) => execute(ref, 'projection', 'reconcile'),
  };
}
