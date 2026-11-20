import { proxyActivities } from '@temporalio/workflow';
/** Safe representative of an already-scheduled Activity in retry backoff.
 * No signals, reset, rescheduling or business/provider effects are used.
 */
export async function pendingActivityHandoffProbe(activityQueue: string): Promise<string> {
  return proxyActivities<{ retryHandoffMarker(): Promise<string> }>({
    taskQueue: activityQueue,
    startToCloseTimeout: '10 seconds',
    scheduleToCloseTimeout: '60 seconds',
    retry: { initialInterval: '25 seconds', backoffCoefficient: 1, maximumAttempts: 2 },
  }).retryHandoffMarker();
}
