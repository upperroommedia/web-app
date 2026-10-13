import { CancelledFailure } from '@temporalio/common';
import { AwaitSermonAudio, DrainSermonAudio } from '../media';
import type { MediaJobRef } from '../../../../../apps/process-audio/src/temporal/types';
import { awaitPublishingReview, receivePublishingEvidence } from './review';
export { publishingEvidenceAvailable } from './review';
import { withDurableLifecycle } from '../lifecycle';
import {
  ActivityCancellationType,
  ApplicationFailure,
  CancellationScope,
  isCancellation,
  continueAsNew,
  makeContinueAsNewFunc,
  workflowInfo,
  condition,
  executeChild,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type { createPublishingActivities } from '../../../../../functions/src/temporal/publishing/activities';
import type {
  PublishingJobRef,
  PublishingPlan,
  PublishingStepResult,
} from '../../../../../functions/src/temporal/publishing/types';

type Activities = ReturnType<typeof createPublishingActivities>;
const read = proxyActivities<Pick<Activities, 'loadPublishingPlan'>>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 5 },
});
// Membership mutations may create overflow resources. Retries are explicit after
// receipts/reconciliation, never implicit whole-operation replays.
const mutate = proxyActivities<Omit<Activities, 'loadPublishingPlan'>>({
  startToCloseTimeout: '20 minutes',
  heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 1 },
});
const media = proxyActivities<{ preparePublishingAudio(ref: PublishingJobRef): Promise<MediaJobRef> }>({
  startToCloseTimeout: '1 minute',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 5 },
});
const deletion = proxyActivities<{
  preparePublishingDeletion(ref: PublishingJobRef): Promise<MediaJobRef | null>;
  prepareDeletionEffects(ref: PublishingJobRef): Promise<void>;
  clearPublishingDeletionGuard(ref: PublishingJobRef): Promise<void>;
  releaseDeletedSermonArtifacts(ref: PublishingJobRef): Promise<void>;
}>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '1 minute',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 5 },
});
const attention = proxyActivities<Pick<Activities, 'projectPublishingAttention'>>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '1 minute',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 5 },
});
const recovery = proxyActivities<
  Pick<Activities, 'recoverPublishingActivityFailure' | 'reportPublishingCancellationFailure'>
>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '1 minute',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 5 },
});
const release = proxyActivities<{ releasePublishingAudio(ref: PublishingJobRef): Promise<{ released: boolean }> }>({
  startToCloseTimeout: '20 minutes',
  heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 3 },
});
const criticalRepair = proxyActivities<{
  repairPublishingCritical(
    ref: PublishingJobRef,
    certificateId: string
  ): Promise<PublishingStepResult & { mode?: string; providerEffects?: string; contentPreserved?: boolean }>;
}>({
  startToCloseTimeout: '20 minutes',
  heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 1 },
});
const createReview = proxyActivities<{
  savePublishingCreateReviewCheckpoint(
    ref: PublishingJobRef,
    input: { workflow: 'publishing'; waitingStep: string; completedStages: string[] }
  ): Promise<{ checkpointId: string } | undefined>;
  loadPublishingCreateReviewContinuation(
    ref: PublishingJobRef,
    checkpointId: string
  ): Promise<
    | {
        workflow: 'publishing' | 'publishingEntity';
        waitingStep: string;
        completedStages: string[];
        plan: PublishingPlan;
      }
    | undefined
  >;
}>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '1 minute',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 12 },
});
export const publishingCriticalRepair = defineSignal<[{ certificateId: string }]>('publishingCriticalRepair');
export const publishingResume = defineSignal('publishingResume');
export const publishingStatus = defineQuery<{ state: string; step: string; code?: string }>('publishingStatus');

export interface PublishingContinuation {
  reviewOnly?: { step: string; checkpointId?: string; resumeRequested?: true };
  cleanupOnly?: true;
  criticalRepairCertificateId?: string;
}
async function executePublishingWorkflow(
  ref: PublishingJobRef,
  continuation: PublishingContinuation = {}
): Promise<{ state: 'completed' }> {
  let continuing = false;
  let preservedStop = false;
  let reviewedDesired = false;
  let reviewedPlan: PublishingPlan | undefined;
  const completedStages = new Set<string>();
  let criticalCertificateId = continuation.criticalRepairCertificateId;
  const desiredScope = new CancellationScope();
  let resumeVersion = continuation.reviewOnly?.resumeRequested ? 1 : 0;
  let consumedReviewResume = 0;
  let reviewCheckpointId = continuation.reviewOnly?.checkpointId;
  const evidenceVersion = receivePublishingEvidence(ref);
  const reviewRotate = async (step: string): Promise<never> => {
    let saved: { checkpointId: string } | undefined;
    try {
      saved = await createReview.savePublishingCreateReviewCheckpoint(ref, {
        workflow: 'publishing',
        waitingStep: step,
        completedStages: [
          'ensurePublishingSoundCloud',
          'checkPublishingSoundCloudReady',
          'ensurePublishingMedia',
          'checkPublishingMediaReady',
          'applyPublishingLists',
          'applyPublishingSeries',
          'commitPublishingProjection',
        ].filter((stage) => completedStages.has(stage)),
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      await sleep('1 hour');
    }
    const checkpointId =
      saved?.checkpointId ??
      (!reviewedDesired && continuation.reviewOnly?.step === step ? reviewCheckpointId : undefined);
    continuing = true;
    const rotate = workflowInfo().targetWorkerDeploymentVersionChanged
      ? makeContinueAsNewFunc<typeof publishingWorkflow>({ initialVersioningBehavior: 'AUTO_UPGRADE' })
      : continueAsNew<typeof publishingWorkflow>;
    return rotate(ref, {
      reviewOnly: {
        step,
        ...(checkpointId ? { checkpointId } : {}),
        ...(!reviewedDesired && resumeVersion > consumedReviewResume ? { resumeRequested: true as const } : {}),
      },
    });
  };
  let status: { state: string; step: string; code?: string } = { state: 'running', step: 'plan' };
  setHandler(publishingCriticalRepair, ({ certificateId }) => {
    if (/^[a-f0-9]{64}$/.test(certificateId)) {
      criticalCertificateId = certificateId;
      resumeVersion++;
      desiredScope.cancel();
    }
  });
  setHandler(publishingResume, () => {
    resumeVersion += 1;
  });
  setHandler(publishingStatus, () => status);
  const run = async (
    step: string,
    operation: () => Promise<PublishingStepResult>,
    activityStage?: string
  ): Promise<void> => {
    if (activityStage && completedStages.has(activityStage)) return;
    let automaticRetries = 0;
    let encodingChecks = 0;
    for (;;) {
      status = { state: 'running', step };
      const beforeAttempt = resumeVersion;
      let result: PublishingStepResult;
      try {
        result = await operation();
      } catch (error) {
        if (isCancellation(error)) throw error;
        const failureType = (error as { cause?: { type?: unknown } })?.cause?.type;
        result = await recovery.recoverPublishingActivityFailure(
          ref,
          step,
          typeof failureType === 'string' && /^[A-Z_]{1,100}$/.test(failureType) ? failureType : undefined
        );
      }
      if (result.state === 'completed') {
        if (activityStage) completedStages.add(activityStage);
        return;
      }
      status = { state: result.state, step, ...(result.code ? { code: result.code } : {}) };
      if (
        [
          'PUBLISHING_AUDIO_PROCESSING',
          'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
          'PUBLISHING_DELETION_SETTLEMENT_PENDING',
        ].includes(result.code ?? '') &&
        encodingChecks < 120
      ) {
        encodingChecks += 1;
        await sleep('30 seconds');
        continue;
      }
      if (result.code === 'PUBLISHING_TRANSIENT' && automaticRetries < 5) {
        await sleep(Math.min(60_000, 1000 * 2 ** automaticRetries));
        automaticRetries += 1;
        continue;
      }
      if (
        result.code === 'PUBLISHING_AUDIO_PROCESSING' ||
        result.code === 'PUBLISHING_TRANSIENT' ||
        result.code === 'PUBLISHING_PROVIDER_ALLOCATION_PENDING' ||
        result.code === 'PUBLISHING_DELETION_SETTLEMENT_PENDING'
      ) {
        const exhausted =
          result.code === 'PUBLISHING_DELETION_SETTLEMENT_PENDING'
            ? 'PUBLISHING_DELETION_SETTLEMENT_REVIEW_REQUIRED'
            : result.code === 'PUBLISHING_PROVIDER_ALLOCATION_PENDING'
            ? 'PUBLISHING_PROVIDER_ALLOCATION_REVIEW_REQUIRED'
            : 'PUBLISHING_RETRY_EXHAUSTED';
        status = { state: 'failed', step, code: exhausted };
        await attention.projectPublishingAttention(ref, step, exhausted, result.blockingJobId);
      }
      // An authenticated control action must reconcile receipt ambiguity or
      // reconnect authorization before sending this signal.
      await awaitPublishingReview(ref, {
        resumed: () => resumeVersion > beforeAttempt,
        evidenceVersion,
        rotate: () => reviewRotate(step),
      });
      automaticRetries = 0;
      encodingChecks = 0;
    }
  };
  return withDurableLifecycle(
    ref,
    async () => {
      try {
        if (continuation.reviewOnly && !criticalCertificateId) {
          status = { state: 'needs_review', step: continuation.reviewOnly.step };
          await desiredScope.run(async () => {
            while (!criticalCertificateId) {
              await awaitPublishingReview(ref, {
                resumed: () => Boolean(criticalCertificateId) || resumeVersion > consumedReviewResume,
                evidenceVersion,
                rotate: () => reviewRotate(continuation.reviewOnly!.step),
              });
              if (criticalCertificateId) break;
              if (!reviewCheckpointId) {
                try {
                  reviewCheckpointId = (
                    await createReview.savePublishingCreateReviewCheckpoint(ref, {
                      workflow: 'publishing',
                      waitingStep: continuation.reviewOnly!.step,
                      completedStages: [
                        'ensurePublishingSoundCloud',
                        'checkPublishingSoundCloudReady',
                        'ensurePublishingMedia',
                        'checkPublishingMediaReady',
                        'applyPublishingLists',
                        'applyPublishingSeries',
                        'commitPublishingProjection',
                      ].filter((stage) => completedStages.has(stage)),
                    })
                  )?.checkpointId;
                } catch (error) {
                  if (isCancellation(error)) throw error;
                  await sleep('30 seconds');
                  continue;
                }
              }
              const checkpointId = reviewCheckpointId;
              if (!checkpointId) {
                consumedReviewResume = resumeVersion;
                continue;
              }
              let restored: Awaited<ReturnType<typeof createReview.loadPublishingCreateReviewContinuation>>;
              try {
                restored = await createReview.loadPublishingCreateReviewContinuation(ref, checkpointId);
              } catch (error) {
                if (isCancellation(error)) throw error;
                await sleep('1 hour');
                await reviewRotate(continuation.reviewOnly!.step);
              }
              consumedReviewResume = resumeVersion;
              if (
                !restored ||
                restored.workflow !== 'publishing' ||
                restored.waitingStep !== continuation.reviewOnly!.step
              )
                continue;
              reviewedPlan = restored.plan;
              restored.completedStages.forEach((stage) => completedStages.add(stage));
              reviewedDesired = true;
              break;
            }
          });
          if (!reviewedDesired) throw new CancelledFailure('Begin certified repair');
        }
        if (continuation.cleanupOnly || criticalCertificateId)
          throw new CancelledFailure('Continue cancellation cleanup');
        return await desiredScope.run(async () => {
          const plan = reviewedPlan ?? (await read.loadPublishingPlan(ref));
          if (plan.action === 'publish') {
            const soundcloud = plan.soundcloud
              ? (async () => {
                  await run(
                    'soundcloud-track',
                    () => mutate.ensurePublishingSoundCloud(ref),
                    'ensurePublishingSoundCloud'
                  );
                  if (plan.needsSoundCloud)
                    await run(
                      'soundcloud-track',
                      () => mutate.checkPublishingSoundCloudReady(ref),
                      'checkPublishingSoundCloudReady'
                    );
                })()
              : Promise.resolve();
            const subsplash = async () => {
              if (!plan.lists && !plan.series) return;
              if (plan.needsMedia) {
                await run('subsplash-media', () => mutate.ensurePublishingMedia(ref), 'ensurePublishingMedia');
                await run('subsplash-media', () => mutate.checkPublishingMediaReady(ref), 'checkPublishingMediaReady');
              }
              if (plan.lists) await run('lists', () => mutate.applyPublishingLists(ref), 'applyPublishingLists');
              if (plan.series) await run('series', () => mutate.applyPublishingSeries(ref), 'applyPublishingSeries');
            };
            // All destination work settles before local completion; each records its own progress.
            const destinations = await Promise.allSettled([soundcloud, subsplash()]);
            const failed = destinations.find(
              (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
            );
            if (failed) throw failed.reason;
          } else if (plan.action === 'unpublish') {
            if (plan.lists) await run('lists', () => mutate.applyPublishingLists(ref), 'applyPublishingLists');
            if (plan.series) await run('series', () => mutate.applyPublishingSeries(ref), 'applyPublishingSeries');
            if (plan.soundcloud)
              await run('cleanup', () => mutate.cleanupPublishingProviders(ref), 'cleanupPublishingProviders');
          } else if (plan.action === 'delete') {
            try {
              status = { state: 'running', step: 'audio-drain' };
              const audioRef = await deletion.preparePublishingDeletion(ref);
              if (audioRef)
                await executeChild(DrainSermonAudio, {
                  workflowId: `publishing-drain:${ref.projectId}:${ref.jobId}`,
                  args: [{ ref: audioRef, mediaTaskQueue: 'urm-media', controlTaskQueue: 'urm-controls' }],
                });
              await run('delete-plan', () => mutate.preparePublishingDeletePlan(ref), 'preparePublishingDeletePlan');
              await run('delete-plan', async () => {
                await deletion.prepareDeletionEffects(ref);
                return { state: 'completed' };
              });
              await run('cleanup', () => mutate.cleanupPublishingProviders(ref), 'cleanupPublishingProviders');
              await run('projection', async () => {
                await deletion.releaseDeletedSermonArtifacts(ref);
                return { state: 'completed' };
              });
            } catch (error) {
              if (isCancellation(error))
                await CancellationScope.nonCancellable(() => deletion.clearPublishingDeletionGuard(ref));
              throw error;
            }
          } else if (plan.action === 'update') {
            if (plan.requiresAudio) {
              status = { state: 'running', step: 'audio-dependency' };
              const audioRef = await media.preparePublishingAudio(ref);
              const outcome = await executeChild(AwaitSermonAudio, {
                workflowId: `publishing-audio:${ref.projectId}:${ref.jobId}`,
                args: [{ ref: audioRef, mediaTaskQueue: 'urm-media', controlTaskQueue: 'urm-controls' }],
              });
              if (outcome.kind !== 'succeeded')
                throw ApplicationFailure.nonRetryable(
                  'Required audio processing did not complete.',
                  'PUBLISHING_AUDIO_DEPENDENCY_FAILED'
                );
              await run('provider-audio', () => mutate.replacePublishingAudio(ref), 'replacePublishingAudio');
            }
            if (plan.requiresMemberships)
              await run('lists', () => mutate.updatePublishingMemberships(ref), 'updatePublishingMemberships');
            await run('projection', () => mutate.updatePublishingMetadata(ref), 'updatePublishingMetadata');
          } else {
            await run('projection', () => mutate.reconcilePublishingState(ref), 'reconcilePublishingState');
          }
          await run('projection', () => mutate.commitPublishingProjection(ref), 'commitPublishingProjection');
          status = { state: 'completed', step: 'projection' };
          return { state: 'completed' as const };
        });
      } catch (error) {
        if (!isCancellation(error)) throw error;
        await CancellationScope.nonCancellable(async () => {
          if (criticalCertificateId && !continuation.cleanupOnly) {
            for (;;) {
              const before = resumeVersion;
              status = { state: 'running', step: 'critical-repair' };
              let result: PublishingStepResult & {
                mode?: string;
                providerEffects?: string;
                contentPreserved?: boolean;
              };
              try {
                result = await criticalRepair.repairPublishingCritical(ref, criticalCertificateId);
              } catch {
                try {
                  result = await recovery.reportPublishingCancellationFailure(ref);
                } catch {
                  await sleep('30 seconds');
                  continue;
                }
              }
              if (result.state === 'completed') {
                preservedStop =
                  result.mode === 'partial_stop' &&
                  result.contentPreserved === true &&
                  ['not_started', 'partial'].includes(result.providerEffects ?? '');
                break;
              }
              if (result.code === 'PUBLISHING_CRITICAL_REPAIR_PROJECTION_PENDING') {
                status = { state: 'running', step: 'critical-repair', code: result.code };
                await sleep('30 seconds');
              } else {
                status = { state: 'needs_review', step: 'critical-repair', code: result.code };
                await condition(() => resumeVersion > before, '5 minutes');
              }
              if (workflowInfo().continueAsNewSuggested || workflowInfo().targetWorkerDeploymentVersionChanged) {
                continuing = true;
                const rotate = workflowInfo().targetWorkerDeploymentVersionChanged
                  ? makeContinueAsNewFunc<typeof publishingWorkflow>({ initialVersioningBehavior: 'AUTO_UPGRADE' })
                  : continueAsNew<typeof publishingWorkflow>;
                return rotate(ref, { criticalRepairCertificateId: criticalCertificateId });
              }
            }
          }
          if (preservedStop) {
            status = { state: 'cancel_requested', step: 'critical-repair' };
            return;
          }
          let fetchChecks = 0,
            cleanupChecks = 0;
          for (;;) {
            if (
              cleanupChecks >= 200 ||
              workflowInfo().continueAsNewSuggested ||
              workflowInfo().targetWorkerDeploymentVersionChanged
            ) {
              continuing = true;
              const rotate = workflowInfo().targetWorkerDeploymentVersionChanged
                ? makeContinueAsNewFunc<typeof publishingWorkflow>({ initialVersioningBehavior: 'AUTO_UPGRADE' })
                : continueAsNew<typeof publishingWorkflow>;
              return rotate(ref, {
                cleanupOnly: true,
                ...(criticalCertificateId ? { criticalRepairCertificateId: criticalCertificateId } : {}),
              });
            }
            cleanupChecks++;
            const before = resumeVersion;
            status = { state: 'cancel_requested', step: 'cleanup' };
            let result: PublishingStepResult;
            try {
              result = await mutate.cleanupCancelledPublishing(ref);
            } catch {
              try {
                result = await recovery.reportPublishingCancellationFailure(ref);
              } catch {
                await sleep('30 seconds');
                continue;
              }
            }
            if (result.state === 'completed') break;
            status = { state: 'cancel_requested', step: 'cleanup', code: result.code };
            if (result.code === 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING') {
              await sleep('30 seconds');
              continue;
            }
            if (result.code === 'PUBLISHING_CANCEL_PROVIDER_FETCH_PENDING' && fetchChecks < 120) {
              fetchChecks++;
              await sleep('30 seconds');
              continue;
            }
            if (result.code === 'PUBLISHING_CANCEL_PROVIDER_FETCH_PENDING')
              await recovery.reportPublishingCancellationFailure(ref);
            await condition(() => resumeVersion > before, '5 minutes');
            fetchChecks = 0;
          }
        });
        throw error;
      } finally {
        // Proof failure retains the source lease; cleanup unavailability must not rewrite provider success.
        if (!continuing && !preservedStop)
          await CancellationScope.nonCancellable(async () => {
            try {
              await release.releasePublishingAudio(ref);
            } catch {
              /* Scoped retention reconciliation keeps unreleased references protected. */
            }
          });
      }
    },
    {
      reviewOnly: Boolean(continuation.reviewOnly),
      reviewedDesiredResume: () => reviewedDesired,
      cleanupOnly: continuation.cleanupOnly,
      ...(criticalCertificateId ? { criticalRepairCertificateId: criticalCertificateId } : {}),
    }
  );
}

export async function publishingWorkflow(
  ref: PublishingJobRef,
  continuation: PublishingContinuation = {}
): Promise<{ state: 'completed' }> {
  return executePublishingWorkflow(ref, continuation);
}
