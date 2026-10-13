import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
export const requestProbe = defineSignal('requestProbe');
export const probeState = defineQuery<{ requested: boolean; completed: boolean }>('probeState');
export async function capacityWorkflow(input: { providerQueue: string; controlQueue: string }): Promise<void> {
  const providers = proxyActivities<{ occupied(): Promise<void> }>({
    taskQueue: input.providerQueue,
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 1 },
  });
  const controls = proxyActivities<{ probe(): Promise<void> }>({
    taskQueue: input.controlQueue,
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 1 },
  });
  let requested = false,
    completed = false;
  setHandler(probeState, () => ({ requested, completed }));
  setHandler(requestProbe, async () => {
    requested = true;
    await controls.probe();
    completed = true;
  });
  await Promise.all(Array.from({ length: 10 }, () => providers.occupied()));
  await condition(() => completed);
}
export async function shutdownRetryWorkflow(queue: string): Promise<string> {
  const activity = proxyActivities<{ restartable(): Promise<string> }>({
    taskQueue: queue,
    startToCloseTimeout: '1 minute',
    heartbeatTimeout: '5 seconds',
    retry: { initialInterval: '1 second', maximumAttempts: 2 },
  });
  return activity.restartable();
}
