import {
  ActivityCancellationType,
  CancellationScope,
  ContinueAsNew,
  continueAsNew,
  isCancellation,
  proxyActivities,
  workflowInfo,
} from '@temporalio/workflow';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { createMediaArtifactCleanupActivities } from '../../../../../functions-media/src/temporal/artifactCleanup';
import type { LifecycleActivities } from '../../activities/lifecycle';

export interface MediaArtifactCleanupInput {
  ref: DurableJobRef;
  cursor?: string;
  completedPages?: number;
}
/** Explicit administrator operation; no automatic production deletion schedule. */
export async function MediaArtifactCleanup(input: MediaArtifactCleanupInput): Promise<void> {
  const lifecycle = proxyActivities<LifecycleActivities>({
    taskQueue: 'urm-controls',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 10 },
  });
  const control = proxyActivities<
    Pick<ReturnType<typeof createMediaArtifactCleanupActivities>, 'loadMediaCleanupPlan'>
  >({
    taskQueue: 'urm-controls',
    startToCloseTimeout: '1 minute',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 10 },
  });
  const activity = proxyActivities<ReturnType<typeof createMediaArtifactCleanupActivities>>({
    startToCloseTimeout: '15 minutes',
    heartbeatTimeout: '1 minute',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 3 },
  });
  try {
    await lifecycle.beginDurableJob(input.ref);
    const plan = await control.loadMediaCleanupPlan(input.ref);
    let cursor = input.cursor;
    let completed = input.completedPages ?? 0;
    while (completed < plan.maxPages) {
      const page = await activity.cleanupMediaArtifactPage(input.ref, cursor);
      completed++;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (workflowInfo().continueAsNewSuggested && completed < plan.maxPages)
        await continueAsNew<typeof MediaArtifactCleanup>({ ref: input.ref, cursor, completedPages: completed });
    }
    await lifecycle.finishDurableJob(input.ref, 'succeeded');
  } catch (error) {
    if (error instanceof ContinueAsNew) throw error;
    await CancellationScope.nonCancellable(() =>
      lifecycle.finishDurableJob(input.ref, isCancellation(error) ? 'cancelled' : 'failed')
    );
    throw error;
  }
}
