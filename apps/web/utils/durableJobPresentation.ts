import type { DurableEntityRef, DurableJob, DurableJobState, DurableJobStep } from '@upperroom/contracts/temporal';

export const JOB_STATE_LABELS: Record<DurableJobState, string> = {
  awaiting_source: 'Waiting for source upload',
  queued: 'Queued',
  running: 'In progress',
  retrying: 'Retrying automatically',
  waiting_for_auth: 'Reconnect required',
  cancel_requested: 'Cancellation requested',
  reconciling: 'Checking the destination',
  needs_attention: 'Needs attention',
  succeeded: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
  superseded: 'Replaced by a newer task',
};
export function jobTitle(job: DurableJob): string {
  const names: Record<string, string> = {
    'provider.orphan_review': 'Review additional provider item',
    'upload.create': 'Upload sermon',
    'audio.process': 'Process audio',
    'sermon.publish': 'Publish sermon',
    'sermon.unpublish': 'Unpublish sermon',
    'sermon.update': 'Update sermon',
    'sermon.delete': 'Delete sermon',
    'series.sync_metadata': 'Update series details at the destination',
  };
  return (
    names[job.kind] ??
    job.kind
      .split(/[._]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  );
}
export function entityHref(entity: DurableEntityRef): string | undefined {
  const directories: Partial<Record<DurableEntityRef['type'], string>> = {
    sermon: 'sermons',
    series: 'series',
    list: 'lists',
    speaker: 'speakers',
  };
  const directory = directories[entity.type];
  return directory ? `/admin/${directory}/${encodeURIComponent(entity.id)}` : undefined;
}
export function measuredStepPercent(step: DurableJobStep): number | undefined {
  const progress = step.progress;
  if (!progress || !Number.isFinite(progress.total) || progress.total <= 0 || !Number.isFinite(progress.completed))
    return undefined;
  return Math.min(100, Math.max(0, Math.round((100 * progress.completed) / progress.total)));
}

const providerMutationCodes = (job: DurableJob) => [
  job.error?.code,
  ...job.steps.map((step) => step.error?.code),
  typeof job.result?.code === 'string' ? job.result.code : undefined,
];
/** A quarantined provider mutation remains a barrier even when cancellation was requested. */
export function hasUnresolvedProviderMutation(job: DurableJob): boolean {
  const codes = new Set([
    'PROVIDER_MUTATION_UNRESOLVED',
    'PUBLISHING_CANCEL_MUTATION_REVIEW_REQUIRED',
    'PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED',
  ]);
  return providerMutationCodes(job).some((code) => code !== undefined && codes.has(code));
}
export function providerMutationReviewMessage(job: DurableJob): string {
  return providerMutationCodes(job).includes('PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED')
    ? 'A destination response could not be safely recorded. This task remains paused, and cancellation cannot finish until its result is safely reviewed.'
    : 'Changes at a publishing destination could not be confirmed. The original request may still arrive. This task remains paused, and cancellation cannot finish until that request is safely reviewed.';
}

/** The immutable attempt was stopped before sending; a refreshed intent must get a new job. */
export function hasUnsentProviderGraphChange(job: DurableJob): boolean {
  return providerMutationCodes(job).includes('PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT');
}

/** Only the certified public stop result can claim content was preserved. */
export function stoppedRepairMessage(job: DurableJob): string | undefined {
  const result = job.result;
  if (result?.mode !== 'partial_stop' || result.contentPreserved !== true) return undefined;
  if (result.providerEffects === 'not_started')
    return 'Stopped before destination changes. Content was kept. Review the destination before starting a new task.';
  if (result.providerEffects === 'partial')
    return 'Stopped after some destination changes. Remaining content was kept. Review the destination before starting a new task.';
  return undefined;
}
export function jobStateLabel(job: DurableJob): string {
  if (stoppedRepairMessage(job)) return job.state === 'cancel_requested' ? 'Stopping' : 'Stopped';
  return job.kind === 'upload.create' && job.state === 'succeeded' ? 'Source received' : JOB_STATE_LABELS[job.state];
}
