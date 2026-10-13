import {
  ActivityCancellationType,
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';
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
export async function ImageIngest(ref: DurableJobRef): Promise<void> {
  let resumed = false;
  setHandler(imageResume, () => {
    resumed = true;
  });
  while (true) {
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
      await condition(() => resumed);
      resumed = false;
    }
  }
}
export async function ImageDelete(ref: DurableJobRef): Promise<void> {
  let resumed = false;
  setHandler(imageResume, () => {
    resumed = true;
  });
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
      await condition(() => resumed);
      resumed = false;
    }
  }
}

export async function ImageReceiptReconciliation(ref: DurableJobRef): Promise<void> {
  let resumed = false;
  setHandler(imageResume, () => {
    resumed = true;
  });
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
    await condition(() => resumed);
    resumed = false;
  }
}
