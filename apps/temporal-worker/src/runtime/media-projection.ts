import type { DurableJob } from '@upperroom/contracts/temporal';
import type { DurableJobPatch } from '@upperroom/orchestration/job-store';
import type { MediaJobProjection } from '../../../process-audio/src/temporal/types';
const order = ['preparing', 'downloading', 'transcoding', 'merging', 'publishing'];
const labels: Record<string, string> = {
  preparing: 'Prepare audio source',
  downloading: 'Download audio',
  transcoding: 'Process audio',
  merging: 'Add intro and outro',
  publishing: 'Save final audio',
};
export function createMediaProjection(
  job: DurableJob,
  value: MediaJobProjection,
  attempt: number,
  now: number
): DurableJobPatch | null {
  if (['succeeded', 'failed', 'cancelled', 'superseded'].includes(job.state)) return null;
  const state =
    value.state === 'waiting' ? (value.reason === 'authentication' ? 'waiting_for_auth' : 'retrying') : value.state;
  const terminal = ['succeeded', 'failed', 'cancelled', 'superseded'].includes(state);
  const steps = job.steps.map((step) => {
    if (!['running', 'retrying', 'waiting'].includes(step.state)) return step;
    if (terminal)
      return {
        ...step,
        state:
          state === 'succeeded'
            ? ('succeeded' as const)
            : state === 'failed'
            ? ('failed' as const)
            : ('cancelled' as const),
        finishedAt: now,
      };
    if (value.stage && order.includes(step.id) && order.indexOf(step.id) < order.indexOf(value.stage))
      return { ...step, state: 'succeeded' as const, finishedAt: now };
    if (value.state === 'waiting')
      return { ...step, state: state === 'waiting_for_auth' ? ('waiting' as const) : ('retrying' as const) };
    return step;
  });
  if (value.stage && !terminal) {
    const step = { id: value.stage, label: labels[value.stage], state: 'running' as const, attempt };
    const index = steps.findIndex((existing) => existing.id === step.id);
    if (index >= 0) steps[index] = step;
    else steps.push(step);
  }
  return {
    state,
    steps,
    actions: state === 'waiting_for_auth' ? ['resume', 'cancel'] : terminal ? [] : ['cancel'],
    ...(terminal ? { finishedAt: now } : {}),
  };
}
