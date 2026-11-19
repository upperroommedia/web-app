import { ApplicationFailure, proxyActivities, sleep, workflowInfo } from '@temporalio/workflow';
import { validWorkerWakeProbe, type WorkerWakeProbeInput } from './worker-wake-input';

/** Staging diagnostic only, with no business handlers or data-plane writes. */
export async function WorkerWakeProbe(input: WorkerWakeProbeInput): Promise<string> {
  const info = workflowInfo();
  if (
    info.namespace !== 'urm-app-staging.qwejt' ||
    info.taskQueue !== 'urm-orchestration' ||
    !validWorkerWakeProbe(input, info.workflowId)
  )
    throw ApplicationFailure.nonRetryable('Invalid worker wake probe', 'INVALID_WORKER_WAKE_PROBE');

  await sleep(input.delayMs);
  const activity = proxyActivities<{ probeWorkerWake(input: WorkerWakeProbeInput): Promise<string> }>({
    taskQueue: `urm-${input.role}`,
    startToCloseTimeout: '10 seconds',
    scheduleToCloseTimeout: input.delayMs + 5 * 60 * 1000,
    retry: { initialInterval: input.delayMs, maximumAttempts: 2 },
  });
  return activity.probeWorkerWake(input);
}
