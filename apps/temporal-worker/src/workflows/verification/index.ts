import { condition, defineQuery, defineSignal, setHandler, workflowInfo } from '@temporalio/workflow';
export const workerRestartProbeStatus = defineQuery<{ state: 'waiting' | 'completed'; runId: string }>(
  'workerRestartProbe.status'
);
export const workerRestartProbeRelease = defineSignal('workerRestartProbe.release');
/** Deployment verification only: no activities, external calls or application data. */
export async function WorkerRestartProbe(): Promise<{ completed: true }> {
  let released = false;
  setHandler(workerRestartProbeStatus, () => ({
    state: released ? 'completed' : 'waiting',
    runId: workflowInfo().runId,
  }));
  setHandler(workerRestartProbeRelease, () => {
    released = true;
  });
  await condition(() => released);
  return { completed: true };
}
