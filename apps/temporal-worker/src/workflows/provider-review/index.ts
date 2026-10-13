import {
  CancellationScope,
  condition,
  continueAsNew,
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
export async function ProviderOrphanReview(ref: DurableJobRef): Promise<void> {
  await CancellationScope.nonCancellable(async () => {
    let resumed = false;
    setHandler(providerOrphanReviewResume, () => {
      resumed = true;
    });
    for (;;) {
      if ((await controls.reviewProviderOrphanAcknowledgement(ref)) === 'complete') return;
      await condition(() => resumed, '1 day');
      resumed = false;
      if (workflowInfo().continueAsNewSuggested) await continueAsNew<typeof ProviderOrphanReview>(ref);
    }
  });
}
