import { makeContinueAsNewFunc, proxyActivities, sleep, workflowInfo } from '@temporalio/workflow';

/** Same timer/target-change rotation used by publishingWorkflow; no operator signal or override. */
export async function naturalContinuationHandoffProbe(activityQueue: string, continued = false): Promise<string> {
  if (!continued) {
    for (let check = 0; check < 15; check++) {
      await sleep('1 second');
      if (workflowInfo().targetWorkerDeploymentVersionChanged) {
        return makeContinueAsNewFunc<typeof naturalContinuationHandoffProbe>({
          initialVersioningBehavior: 'AUTO_UPGRADE',
        })(activityQueue, true);
      }
    }
    throw new Error('Native target change was not observed');
  }
  return proxyActivities<{ retryHandoffMarker(): Promise<string> }>({
    taskQueue: activityQueue,
    startToCloseTimeout: '10 seconds',
    retry: { maximumAttempts: 1 },
  }).retryHandoffMarker();
}
