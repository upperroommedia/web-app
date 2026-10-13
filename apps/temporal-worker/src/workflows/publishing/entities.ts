import { CancelledFailure } from '@temporalio/common';
import {
  ActivityCancellationType,
  CancellationScope,
  condition,
  continueAsNew,
  makeContinueAsNewFunc,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import type { DurableJobRef } from '../../../../../packages/contracts/temporal';
import type { createPublishingEntityActivities } from '../../../../../functions/src/temporal/publishing/entityActivities';
import { awaitPublishingReview, receivePublishingEvidence } from './review';
import { withDurableLifecycle } from '../lifecycle';
import { publishingResume, publishingCriticalRepair } from './index';
const activities = proxyActivities<ReturnType<typeof createPublishingEntityActivities>>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 1 },
});
const recovery = proxyActivities<
  Pick<
    ReturnType<typeof createPublishingEntityActivities>,
    'recoverPublishingEntityFailure' | 'reportPublishingEntityCancellationFailure' | 'projectPublishingEntityAttention'
  >
>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '1 minute',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 5 },
});
const cleanup = proxyActivities<
  Pick<ReturnType<typeof createPublishingEntityActivities>, 'cleanupCancelledPublishingEntity'>
>({
  taskQueue: 'urm-orchestration',
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 1 },
});
async function waitForEntityRetry(
  ref: DurableJobRef,
  outcome: { code?: string },
  attempt: { audio: number; allocation: number; settlement: number; transient: number },
  resumed: () => boolean,
  evidenceVersion: () => number,
  rotate: () => Promise<never>
): Promise<void> {
  if (outcome.code === 'PUBLISHING_DELETION_SETTLEMENT_PENDING' && attempt.settlement < 120) {
    attempt.settlement++;
    await sleep('30 seconds');
    return;
  }
  if (outcome.code === 'PUBLISHING_PROVIDER_ALLOCATION_PENDING' && attempt.allocation < 120) {
    attempt.allocation += 1;
    await sleep('30 seconds');
    return;
  }
  if (outcome.code === 'PUBLISHING_AUDIO_PROCESSING' && attempt.audio < 120) {
    attempt.audio += 1;
    await sleep('30 seconds');
    return;
  }
  if (outcome.code === 'PUBLISHING_TRANSIENT' && attempt.transient < 5) {
    await sleep(Math.min(60_000, 1000 * 2 ** attempt.transient));
    attempt.transient += 1;
    return;
  }
  if (outcome.code === 'PUBLISHING_DELETION_SETTLEMENT_PENDING')
    await recovery.projectPublishingEntityAttention(ref, 'PUBLISHING_DELETION_SETTLEMENT_REVIEW_REQUIRED');
  if (
    outcome.code === 'PUBLISHING_PROVIDER_ALLOCATION_PENDING' ||
    outcome.code === 'PUBLISHING_AUDIO_PROCESSING' ||
    outcome.code === 'PUBLISHING_TRANSIENT'
  )
    await recovery.projectPublishingEntityAttention(ref);
  await awaitPublishingReview(ref, { resumed, evidenceVersion, rotate });
  attempt.settlement = 0;
  attempt.audio = 0;
  attempt.allocation = 0;
  attempt.transient = 0;
}
export interface PublishingEntityContinuation {
  reviewOnly?: true;
  createReviewCheckpointId?: string;
  resumeRequested?: true;
  cleanupOnly?: true;
  criticalRepairCertificateId?: string;
}
const createReview = proxyActivities<{
  savePublishingCreateReviewCheckpoint(
    ref: DurableJobRef,
    input: { workflow: 'publishingEntity'; waitingStep: 'entity'; completedStages: string[] }
  ): Promise<{ checkpointId: string } | undefined>;
  loadPublishingCreateReviewContinuation(
    ref: DurableJobRef,
    checkpointId: string
  ): Promise<{ workflow: 'publishing' | 'publishingEntity'; waitingStep: string } | undefined>;
}>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '1 minute',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 12 },
});
const criticalRepair = proxyActivities<{
  repairPublishingCritical(
    ref: DurableJobRef,
    certificateId: string
  ): Promise<{ state: string; code?: string; mode?: string; providerEffects?: string; contentPreserved?: boolean }>;
}>({
  taskQueue: 'urm-orchestration',
  startToCloseTimeout: '20 minutes',
  heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 1 },
});
async function waitForEntityCriticalRepair(
  ref: DurableJobRef,
  certificate: () => string | undefined,
  version: () => number,
  rotate: () => Promise<never>
): Promise<boolean> {
  return CancellationScope.nonCancellable(async () => {
    let polls = 0;
    for (;;) {
      const id = certificate();
      if (!id) return false;
      if (
        polls++ >= 200 ||
        workflowInfo().continueAsNewSuggested ||
        workflowInfo().targetWorkerDeploymentVersionChanged
      )
        return rotate();
      const before = version();
      let result: { state: string; code?: string; mode?: string; providerEffects?: string; contentPreserved?: boolean };
      try {
        result = await criticalRepair.repairPublishingCritical(ref, id);
      } catch {
        try {
          result = await recovery.reportPublishingEntityCancellationFailure(ref);
        } catch {
          await sleep('30 seconds');
          continue;
        }
      }
      if (result.state === 'completed')
        return (
          result.mode === 'partial_stop' &&
          result.contentPreserved === true &&
          ['not_started', 'partial'].includes(result.providerEffects ?? '')
        );
      if (result.code === 'PUBLISHING_CRITICAL_REPAIR_PROJECTION_PENDING') {
        await sleep('30 seconds');
        continue;
      }
      await condition(() => version() > before, '5 minutes');
    }
  });
}
async function waitForEntityCancellation(
  ref: DurableJobRef,
  version: () => number,
  continueCleanup: () => Promise<never>
): Promise<void> {
  await CancellationScope.nonCancellable(async () => {
    let fetchChecks = 0,
      polls = 0;
    for (;;) {
      if (polls >= 200 || workflowInfo().continueAsNewSuggested || workflowInfo().targetWorkerDeploymentVersionChanged)
        return continueCleanup();
      polls += 1;
      const before = version();
      let outcome;
      try {
        outcome = await cleanup.cleanupCancelledPublishingEntity(ref);
      } catch {
        try {
          outcome = await recovery.reportPublishingEntityCancellationFailure(ref);
        } catch {
          await sleep('30 seconds');
          continue;
        }
      }
      if (outcome.state === 'completed') return;
      if (outcome.code === 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING') {
        await sleep('30 seconds');
        continue;
      }
      if (outcome.code === 'PUBLISHING_CANCEL_PROVIDER_FETCH_PENDING' && fetchChecks < 120) {
        fetchChecks += 1;
        await sleep('30 seconds');
        continue;
      }
      if (outcome.code === 'PUBLISHING_CANCEL_PROVIDER_FETCH_PENDING') {
        try {
          await recovery.reportPublishingEntityCancellationFailure(ref);
        } catch {
          await sleep('30 seconds');
          continue;
        }
      }
      await condition(() => version() > before, '5 minutes');
      fetchChecks = 0;
    }
  });
}
export async function publishingEntityWorkflow(
  ref: DurableJobRef,
  continuation: PublishingEntityContinuation = {}
): Promise<Record<string, unknown>> {
  let version = continuation.resumeRequested ? 1 : 0;
  let consumedReviewResume = 0;
  let checkpointId = continuation.createReviewCheckpointId;
  let reviewedDesired = false;
  const reviewRotate = async (): Promise<never> => {
    let saved: { checkpointId: string } | undefined;
    try {
      saved = await createReview.savePublishingCreateReviewCheckpoint(ref, {
        workflow: 'publishingEntity',
        waitingStep: 'entity',
        completedStages: [],
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      await sleep('1 hour');
    }
    const current = saved?.checkpointId ?? checkpointId;
    const next: PublishingEntityContinuation = {
      reviewOnly: true,
      ...(current ? { createReviewCheckpointId: current } : {}),
      ...(version > consumedReviewResume ? { resumeRequested: true } : {}),
    };
    return workflowInfo().targetWorkerDeploymentVersionChanged
      ? makeContinueAsNewFunc<typeof publishingEntityWorkflow>({ initialVersioningBehavior: 'AUTO_UPGRADE' })(ref, next)
      : continueAsNew<typeof publishingEntityWorkflow>(ref, next);
  };
  const evidenceVersion = receivePublishingEvidence(ref);
  let criticalCertificateId = continuation.criticalRepairCertificateId;
  const desiredScope = new CancellationScope();
  setHandler(publishingCriticalRepair, ({ certificateId }) => {
    if (/^[a-f0-9]{64}$/.test(certificateId)) {
      criticalCertificateId = certificateId;
      version++;
      desiredScope.cancel();
    }
  });
  setHandler(publishingResume, () => {
    version += 1;
  });
  return withDurableLifecycle(
    ref,
    async () => {
      try {
        if (continuation.reviewOnly && !criticalCertificateId) {
          await desiredScope.run(async () => {
            for (;;) {
              await awaitPublishingReview(ref, {
                resumed: () => Boolean(criticalCertificateId) || version > consumedReviewResume,
                evidenceVersion,
                rotate: reviewRotate,
              });
              if (criticalCertificateId) throw new CancelledFailure('Begin certified repair');
              if (!checkpointId) {
                try {
                  checkpointId = (
                    await createReview.savePublishingCreateReviewCheckpoint(ref, {
                      workflow: 'publishingEntity',
                      waitingStep: 'entity',
                      completedStages: [],
                    })
                  )?.checkpointId;
                } catch (error) {
                  if (isCancellation(error)) throw error;
                  await sleep('1 hour');
                  await reviewRotate();
                }
              }
              if (!checkpointId) {
                consumedReviewResume = version;
                continue;
              }
              let approved;
              try {
                approved = await createReview.loadPublishingCreateReviewContinuation(ref, checkpointId);
              } catch (error) {
                if (isCancellation(error)) throw error;
                await sleep('1 hour');
                await reviewRotate();
              }
              consumedReviewResume = version;
              if (approved?.workflow !== 'publishingEntity' || approved.waitingStep !== 'entity') continue;
              reviewedDesired = true;
              return;
            }
          });
        }
        if (continuation.cleanupOnly || criticalCertificateId)
          throw new CancelledFailure('Continue cancellation cleanup');
        return await desiredScope.run(async () => {
          const attempt = { audio: 0, allocation: 0, settlement: 0, transient: 0 };
          for (;;) {
            const before = version;
            let outcome;
            try {
              outcome =
                reviewedDesired && checkpointId
                  ? await activities.executeReviewedPublishingEntityCreate(ref, checkpointId)
                  : await activities.executePublishingEntityActivity(ref);
            } catch (error) {
              if (isCancellation(error)) throw error;
              outcome = await recovery.recoverPublishingEntityFailure(ref);
            }
            if (outcome.state === 'completed') return outcome.result ?? {};
            await waitForEntityRetry(ref, outcome, attempt, () => version > before, evidenceVersion, reviewRotate);
          }
        });
      } catch (error) {
        if (!isCancellation(error)) throw error;
        if (criticalCertificateId && !continuation.cleanupOnly) {
          const preservedStop = await waitForEntityCriticalRepair(
            ref,
            () => criticalCertificateId,
            () => version,
            () =>
              workflowInfo().targetWorkerDeploymentVersionChanged
                ? makeContinueAsNewFunc<typeof publishingEntityWorkflow>({ initialVersioningBehavior: 'AUTO_UPGRADE' })(
                    ref,
                    { criticalRepairCertificateId: criticalCertificateId }
                  )
                : continueAsNew<typeof publishingEntityWorkflow>(ref, {
                    criticalRepairCertificateId: criticalCertificateId,
                  })
          );
          if (preservedStop) throw error;
        }
        await waitForEntityCancellation(
          ref,
          () => version,
          () =>
            workflowInfo().targetWorkerDeploymentVersionChanged
              ? makeContinueAsNewFunc<typeof publishingEntityWorkflow>({ initialVersioningBehavior: 'AUTO_UPGRADE' })(
                  ref,
                  {
                    cleanupOnly: true,
                    ...(criticalCertificateId ? { criticalRepairCertificateId: criticalCertificateId } : {}),
                  }
                )
              : continueAsNew<typeof publishingEntityWorkflow>(ref, {
                  cleanupOnly: true,
                  ...(criticalCertificateId ? { criticalRepairCertificateId: criticalCertificateId } : {}),
                })
        );
        throw error;
      }
    },
    {
      reviewOnly: continuation.reviewOnly,
      reviewedDesiredResume: () => reviewedDesired,
      cleanupOnly: continuation.cleanupOnly,
      ...(criticalCertificateId ? { criticalRepairCertificateId: criticalCertificateId } : {}),
    }
  );
}
export async function maintenanceWorkflow(
  ref: DurableJobRef,
  cursor?: string,
  continuation: PublishingEntityContinuation = {}
): Promise<{ state: 'completed' }> {
  let version = 0;
  const evidenceVersion = receivePublishingEvidence(ref);
  let criticalCertificateId = continuation.criticalRepairCertificateId;
  const desiredScope = new CancellationScope();
  setHandler(publishingCriticalRepair, ({ certificateId }) => {
    if (/^[a-f0-9]{64}$/.test(certificateId)) {
      criticalCertificateId = certificateId;
      version++;
      desiredScope.cancel();
    }
  });
  setHandler(publishingResume, () => {
    version += 1;
  });
  return withDurableLifecycle(
    ref,
    async () => {
      try {
        if (continuation.reviewOnly && !criticalCertificateId) {
          await desiredScope.run(() =>
            awaitPublishingReview(ref, {
              resumed: () => Boolean(criticalCertificateId),
              evidenceVersion,
              rotate: () =>
                workflowInfo().targetWorkerDeploymentVersionChanged
                  ? makeContinueAsNewFunc<typeof maintenanceWorkflow>({ initialVersioningBehavior: 'AUTO_UPGRADE' })(
                      ref,
                      cursor,
                      { reviewOnly: true }
                    )
                  : continueAsNew<typeof maintenanceWorkflow>(ref, cursor, { reviewOnly: true }),
            })
          );
          throw new CancelledFailure('Begin certified repair');
        }
        if (continuation.cleanupOnly || criticalCertificateId)
          throw new CancelledFailure('Continue cancellation cleanup');
        return await desiredScope.run(async () => {
          let pages = 0;
          const attempt = { audio: 0, allocation: 0, settlement: 0, transient: 0 };
          for (;;) {
            const before = version;
            let outcome: Awaited<ReturnType<typeof activities.executePublishingMaintenancePage>>;
            try {
              outcome = await activities.executePublishingMaintenancePage(ref, cursor);
            } catch (error) {
              if (isCancellation(error)) throw error;
              outcome = await recovery.recoverPublishingEntityFailure(ref);
            }
            if (outcome.state !== 'completed' || !outcome.page) {
              await waitForEntityRetry(
                ref,
                outcome,
                attempt,
                () => version > before,
                evidenceVersion,
                () =>
                  workflowInfo().targetWorkerDeploymentVersionChanged
                    ? makeContinueAsNewFunc<typeof maintenanceWorkflow>({ initialVersioningBehavior: 'AUTO_UPGRADE' })(
                        ref,
                        cursor,
                        { reviewOnly: true }
                      )
                    : continueAsNew<typeof maintenanceWorkflow>(ref, cursor, { reviewOnly: true })
              );
              continue;
            }
            attempt.settlement = 0;
            attempt.audio = 0;
            attempt.allocation = 0;
            attempt.transient = 0;
            if (outcome.page.done) return { state: 'completed' };
            cursor = outcome.page.nextCursor;
            pages += 1;
            if (!cursor) throw new Error('Maintenance cursor did not advance.');
            if (pages >= 50 || workflowInfo().continueAsNewSuggested)
              return continueAsNew<typeof maintenanceWorkflow>(ref, cursor);
          }
        });
      } catch (error) {
        if (!isCancellation(error)) throw error;
        if (criticalCertificateId && !continuation.cleanupOnly) {
          const preservedStop = await waitForEntityCriticalRepair(
            ref,
            () => criticalCertificateId,
            () => version,
            () =>
              workflowInfo().targetWorkerDeploymentVersionChanged
                ? makeContinueAsNewFunc<typeof maintenanceWorkflow>({ initialVersioningBehavior: 'AUTO_UPGRADE' })(
                    ref,
                    cursor,
                    { criticalRepairCertificateId: criticalCertificateId }
                  )
                : continueAsNew<typeof maintenanceWorkflow>(ref, cursor, {
                    criticalRepairCertificateId: criticalCertificateId,
                  })
          );
          if (preservedStop) throw error;
        }
        await waitForEntityCancellation(
          ref,
          () => version,
          () =>
            workflowInfo().targetWorkerDeploymentVersionChanged
              ? makeContinueAsNewFunc<typeof maintenanceWorkflow>({ initialVersioningBehavior: 'AUTO_UPGRADE' })(
                  ref,
                  cursor,
                  {
                    cleanupOnly: true,
                    ...(criticalCertificateId ? { criticalRepairCertificateId: criticalCertificateId } : {}),
                  }
                )
              : continueAsNew<typeof maintenanceWorkflow>(ref, cursor, {
                  cleanupOnly: true,
                  ...(criticalCertificateId ? { criticalRepairCertificateId: criticalCertificateId } : {}),
                })
        );
        throw error;
      }
    },
    {
      reviewOnly: continuation.reviewOnly,
      cleanupOnly: continuation.cleanupOnly,
      ...(criticalCertificateId ? { criticalRepairCertificateId: criticalCertificateId } : {}),
    }
  );
}
