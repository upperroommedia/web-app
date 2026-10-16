import {
  ActivityCancellationType,
  CancellationScope,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
  continueAsNew,
  makeContinueAsNewFunc,
  patched,
  workflowInfo,
} from '@temporalio/workflow';
import { assertAttentionContinuation, waitForAttentionResume } from '../attention';
import type { DurableJobRef } from '../../../../../packages/contracts/temporal';
import type { ImageActivities } from '../../../../../functions/src/temporal/images/types';

const activities = proxyActivities<Omit<ImageActivities, 'finishImage' | 'getImageDisposition'>>({
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { initialInterval: '5 seconds', maximumInterval: '5 minutes', maximumAttempts: 8 },
});
const controls = proxyActivities<Pick<ImageActivities, 'finishImage' | 'getImageDisposition'>>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '2 minutes',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});
export const imageResume = defineSignal('image.resume');
interface ImageAttentionContinuation {
  schemaVersion: 1;
  waiting: true;
  resumeRequested: boolean;
}
export async function ImageIngest(ref: DurableJobRef, attention?: ImageAttentionContinuation): Promise<void> {
  assertAttentionContinuation(attention);
  let resumed = attention?.resumeRequested ?? false;
  setHandler(imageResume, () => {
    resumed = true;
  });
  const wait = async (): Promise<boolean> => {
    try {
      await waitForAttentionResume(
        () => resumed,
        () =>
          makeContinueAsNewFunc<typeof ImageIngest>({ initialVersioningBehavior: 'AUTO_UPGRADE' })(ref, {
            schemaVersion: 1,
            waiting: true,
            resumeRequested: resumed,
          })
      );
    } catch (error) {
      if (isCancellation(error)) {
        await CancellationScope.nonCancellable(() => activities.cancelImage(ref));
        throw error;
      }
      throw error;
    }
    return true;
  };
  if (attention?.waiting) {
    if (!(await wait())) return;
    resumed = false;
  }
  while (true) {
    // The additional-allocation review loop already wakes every minute and only
    // reads durable disposition here; it needs no artificial resume signal.
    if (patched('image-review-target-upgrade-v1') && workflowInfo().targetWorkerDeploymentVersionChanged)
      await makeContinueAsNewFunc<typeof ImageIngest>({ initialVersioningBehavior: 'AUTO_UPGRADE' })(ref);
    if (workflowInfo().continueAsNewSuggested) await continueAsNew<typeof ImageIngest>(ref);
    try {
      const disposition = await controls.getImageDisposition(ref);
      if (disposition === 'additional_review') {
        await controls.finishImage(ref, 'needs_attention', 'ImageAdditionalAllocationReview');
        await sleep('1 minute');
        continue;
      }
      if (disposition === 'retained') {
        await controls.finishImage(ref, 'cancelled');
        return;
      }
      await activities.prepareImage(ref);
      await activities.allocateImage(ref);
      await activities.uploadImageBytes(ref);
      await activities.commitImage(ref);
      await controls.finishImage(ref, 'succeeded');
      return;
    } catch (error) {
      if ((error as { cause?: { type?: string } })?.cause?.type === 'STALE_GENERATION') {
        await activities.supersedeImage(ref);
        return;
      }
      if (isCancellation(error)) {
        await CancellationScope.nonCancellable(() => activities.cancelImage(ref));
        throw error;
      }
      await controls.finishImage(ref, 'needs_attention', (error as { cause?: { type?: string } })?.cause?.type);
      if (!(await wait())) return;
      resumed = false;
    }
  }
}
export async function ImageDelete(ref: DurableJobRef, attention?: ImageAttentionContinuation): Promise<void> {
  assertAttentionContinuation(attention);
  let resumed = attention?.resumeRequested ?? false;
  setHandler(imageResume, () => {
    resumed = true;
  });
  const wait = async (): Promise<boolean> => {
    try {
      await waitForAttentionResume(
        () => resumed,
        () =>
          makeContinueAsNewFunc<typeof ImageDelete>({ initialVersioningBehavior: 'AUTO_UPGRADE' })(ref, {
            schemaVersion: 1,
            waiting: true,
            resumeRequested: resumed,
          })
      );
    } catch (error) {
      if (isCancellation(error)) {
        await CancellationScope.nonCancellable(async () => {
          await activities.deleteImageProviders(ref);
          await controls.finishImage(ref, 'succeeded');
        });
        return false;
      }
      throw error;
    }
    return true;
  };
  if (attention?.waiting) {
    if (!(await wait())) return;
    resumed = false;
  }
  while (true) {
    try {
      await activities.deleteImageProviders(ref);
      await controls.finishImage(ref, 'succeeded');
      return;
    } catch (error) {
      if ((error as { cause?: { type?: string } })?.cause?.type === 'STALE_GENERATION') {
        await activities.supersedeImage(ref);
        return;
      }
      if (isCancellation(error)) {
        // Deletion cannot roll back removed destinations: drain idempotent cleanup.
        await CancellationScope.nonCancellable(async () => {
          await activities.deleteImageProviders(ref);
          await controls.finishImage(ref, 'succeeded');
        });
        return;
      }
      await controls.finishImage(ref, 'needs_attention', (error as { cause?: { type?: string } })?.cause?.type);
      if (!(await wait())) return;
      resumed = false;
    }
  }
}

export async function ImageReceiptReconciliation(
  ref: DurableJobRef,
  attention?: ImageAttentionContinuation
): Promise<void> {
  assertAttentionContinuation(attention);
  let resumed = attention?.resumeRequested ?? false;
  setHandler(imageResume, () => {
    resumed = true;
  });
  const wait = async (): Promise<boolean> => {
    try {
      await waitForAttentionResume(
        () => resumed,
        () =>
          makeContinueAsNewFunc<typeof ImageReceiptReconciliation>({ initialVersioningBehavior: 'AUTO_UPGRADE' })(ref, {
            schemaVersion: 1,
            waiting: true,
            resumeRequested: resumed,
          })
      );
    } catch (error) {
      if (isCancellation(error)) {
        await CancellationScope.nonCancellable(async () => {
          if ((await activities.reconcileImageReceipt(ref)) !== 'complete')
            await controls.finishImage(ref, 'needs_attention', (error as { cause?: { type?: string } })?.cause?.type);
        });
        return false;
      }
      throw error;
    }
    return true;
  };
  if (attention?.waiting) {
    if (!(await wait())) return;
    resumed = false;
  }
  while (true) {
    try {
      if ((await activities.reconcileImageReceipt(ref)) === 'complete') return;
    } catch (error) {
      if (isCancellation(error)) {
        await CancellationScope.nonCancellable(async () => {
          if ((await activities.reconcileImageReceipt(ref)) !== 'complete')
            await controls.finishImage(ref, 'needs_attention', (error as { cause?: { type?: string } })?.cause?.type);
        });
        return;
      }
      await controls.finishImage(ref, 'needs_attention', (error as { cause?: { type?: string } })?.cause?.type);
    }
    if (!(await wait())) return;
    resumed = false;
  }
}
