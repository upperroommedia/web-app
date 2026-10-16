import {
  CancellationScope,
  condition,
  continueAsNew,
  makeContinueAsNewFunc,
  patched,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { DurableJobRef } from '../../../../../packages/contracts/temporal';
import type { ProviderOrphanReviewActivities } from '../../../../../functions/src/temporal/publishing/orphanReview';
const controls = proxyActivities<ProviderOrphanReviewActivities>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '2 minutes',
});
export const providerOrphanReviewResume = defineSignal('providerOrphanReviewResume');
/** Only reads and safe status projection. Cancellation cannot silently discard an acknowledged resource. */
interface OrphanReviewContinuation {
  schemaVersion: 1;
  resumeRequested: boolean;
  nextReviewAt: number;
}
export async function ProviderOrphanReview(ref: DurableJobRef, continuation?: OrphanReviewContinuation): Promise<void> {
  if (
    continuation &&
    (continuation.schemaVersion !== 1 ||
      typeof continuation.resumeRequested !== 'boolean' ||
      !Number.isSafeInteger(continuation.nextReviewAt) ||
      continuation.nextReviewAt < 0)
  )
    throw new Error('Invalid orphan review continuation');
  await CancellationScope.nonCancellable(async () => {
    let resumed = continuation?.resumeRequested ?? false;
    setHandler(providerOrphanReviewResume, () => {
      resumed = true;
    });
    if (!patched('provider-review-version-migration-v1')) {
      // Preserve the original daily timer and activity sequence for old histories.
      for (;;) {
        if ((await controls.reviewProviderOrphanAcknowledgement(ref)) === 'complete') return;
        await condition(() => resumed, '1 day');
        resumed = false;
        if (workflowInfo().continueAsNewSuggested) await continueAsNew<typeof ProviderOrphanReview>(ref);
      }
    }
    let nextReviewAt = continuation?.nextReviewAt;
    for (;;) {
      // A new deployment never accelerates daily receipt reconciliation. A genuine
      // review signal still does, and remains distinct from the metadata wake-up.
      if (nextReviewAt === undefined || resumed || Date.now() >= nextReviewAt) {
        resumed = false;
        if ((await controls.reviewProviderOrphanAcknowledgement(ref)) === 'complete') return;
        nextReviewAt = Date.now() + 24 * 60 * 60 * 1000;
      }
      if (workflowInfo().targetWorkerDeploymentVersionChanged || workflowInfo().continueAsNewSuggested)
        await makeContinueAsNewFunc<typeof ProviderOrphanReview>({ initialVersioningBehavior: 'AUTO_UPGRADE' })(ref, {
          schemaVersion: 1,
          resumeRequested: resumed,
          nextReviewAt,
        });
      await condition(
        () => resumed || workflowInfo().targetWorkerDeploymentVersionChanged,
        Math.min(5 * 60 * 1000, Math.max(1, nextReviewAt - Date.now()))
      );
    }
  });
}
