import {
  ActivityCancellationType,
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
  setHandler,
  continueAsNew,
  proxyActivities,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import type { DurableJobRef } from '../../../../../packages/contracts/temporal';
import type { SearchActivities, SearchControlActivities } from '../../activities/search';
const activities = proxyActivities<Pick<SearchActivities, 'syncSearchDocument' | 'searchBackfillPage'>>({
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  taskQueue: 'urm-search',
  startToCloseTimeout: '4 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { initialInterval: '10 seconds', maximumInterval: '5 minutes', maximumAttempts: 20 },
});
const controls = proxyActivities<SearchControlActivities>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '2 minutes',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});
export const searchResume = defineSignal('search.resume');
export async function SearchDocument(ref: DurableJobRef): Promise<void> {
  let resumed = false;
  setHandler(searchResume, () => {
    resumed = true;
  });
  while (true) {
    try {
      await activities.syncSearchDocument(ref);
      return;
    } catch (error) {
      if (isCancellation(error)) {
        await CancellationScope.nonCancellable(() => controls.finishSearch(ref, 'cancelled'));
        throw error;
      }
      await controls.finishSearch(ref, 'needs_attention');
      await condition(() => resumed);
      resumed = false;
    }
  }
}
export async function SearchBackfill(input: { ref: DurableJobRef; cursor?: string; count?: number }): Promise<void> {
  let resumed = false;
  setHandler(searchResume, () => {
    resumed = true;
  });
  let cursor = input.cursor;
  let count = input.count ?? 0;
  let pages = 0;
  while (true) {
    try {
      const page = await activities.searchBackfillPage(input.ref, cursor);
      while (page.jobs.length && !(await controls.confirmSearchPage(page.jobs))) await sleep('5 seconds');
      count += page.jobs.length;
      cursor = page.cursor;
      if (page.complete) {
        await controls.finishSearchBackfill(input.ref, count);
        return;
      }
      pages++;
    } catch (error) {
      if ((error as { cause?: { type?: string } })?.cause?.type === 'STALE_GENERATION') {
        await controls.finishSearch(input.ref, 'superseded');
        return;
      }
      if (isCancellation(error)) {
        await CancellationScope.nonCancellable(() => controls.finishSearch(input.ref, 'cancelled'));
        throw error;
      }
      await controls.finishSearch(input.ref, 'needs_attention');
      await condition(() => resumed);
      resumed = false;
    }
    if (pages >= 100 || workflowInfo().continueAsNewSuggested)
      await continueAsNew<typeof SearchBackfill>({ ref: input.ref, cursor, count });
  }
}
