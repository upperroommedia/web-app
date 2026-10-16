import {
  ActivityCancellationType,
  CancellationScope,
  ContinueAsNew,
  isCancellation,
  proxyActivities,
  sleep,
} from '@temporalio/workflow';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { LifecycleActivities } from '../activities/lifecycle';
const lifecycle = proxyActivities<LifecycleActivities>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { initialInterval: '1 second', maximumInterval: '30 seconds', maximumAttempts: 12 },
});
export async function withDurableLifecycle<T>(
  ref: DurableJobRef,
  operation: () => Promise<T>,
  options: {
    /** Only a validated, workflow-internal attention checkpoint may skip the
     * initial running projection. Cancellation/finish handling still applies. */
    continuingAttention?: boolean;
    reviewedDesiredResume?: () => boolean;
    reviewOnly?: boolean;
    cleanupOnly?: boolean;
    criticalRepairCertificateId?: string;
  } = {}
): Promise<T> {
  const reportRepairFailure = async () => {
    for (;;) {
      try {
        await lifecycle.reportDurableCriticalRepairFailure(ref);
        return;
      } catch {
        await sleep('30 seconds');
      }
    }
  };
  try {
    if (options.criticalRepairCertificateId) {
      try {
        await lifecycle.beginDurableCriticalRepair(ref, options.criticalRepairCertificateId);
      } catch {
        await CancellationScope.nonCancellable(reportRepairFailure);
        // The dedicated repair branch validates every effect again and waits for
        // renewed approval. A rejected begin cannot close an unresolved job.
      }
    } else if (options.reviewOnly) {
      try {
        await lifecycle.beginDurableReview(ref);
      } catch {
        await CancellationScope.nonCancellable(reportRepairFailure);
      }
    } else if (options.cleanupOnly) await lifecycle.beginDurableCleanup(ref);
    else if (!options.continuingAttention) await lifecycle.beginDurableJob(ref);
    const result = await operation();
    await lifecycle.finishDurableJob(
      ref,
      (options.reviewOnly && !options.reviewedDesiredResume?.()) ||
        options.cleanupOnly ||
        options.criticalRepairCertificateId
        ? 'cancelled'
        : 'succeeded'
    );
    return result;
  } catch (error) {
    if (error instanceof ContinueAsNew) throw error;
    if ((options.criticalRepairCertificateId || options.reviewOnly) && !isCancellation(error)) {
      await CancellationScope.nonCancellable(reportRepairFailure);
      throw error;
    }
    await CancellationScope.nonCancellable(() =>
      lifecycle.finishDurableJob(ref, isCancellation(error) ? 'cancelled' : 'failed')
    );
    throw error;
  }
}
