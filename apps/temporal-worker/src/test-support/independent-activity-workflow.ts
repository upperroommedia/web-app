import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
export const releaseIndependentProbe = defineSignal('releaseIndependentProbe');
export const independentProbeReady = defineQuery<boolean>('independentProbeReady');
/** Test-only native routing probe. No credentials or media data enter history. */
export async function independentActivityProbe(activityQueue: string, waitForRelease = false): Promise<string> {
  let released = !waitForRelease;
  setHandler(releaseIndependentProbe, () => {
    released = true;
  });
  setHandler(independentProbeReady, () => true);
  await condition(() => released);
  return proxyActivities<{ independentActivityMarker(): Promise<string> }>({
    taskQueue: activityQueue,
    startToCloseTimeout: '10 seconds',
    scheduleToCloseTimeout: '30 seconds',
  }).independentActivityMarker();
}
