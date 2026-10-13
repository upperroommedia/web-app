import type { DurableJob } from '@upperroom/contracts/temporal';
export const ACTIVITY_PAGE_SIZE = 100;
export interface JobPageCursor {
  createdAt: number;
  jobId: string;
}
export function compareJobCreationDescending(
  a: Pick<DurableJob, 'createdAt' | 'jobId'>,
  b: Pick<DurableJob, 'createdAt' | 'jobId'>
): number {
  return b.createdAt - a.createdAt || (a.jobId < b.jobId ? 1 : a.jobId > b.jobId ? -1 : 0);
}
/** Merge bounded actor/subject pages without duplicates; one sentinel proves older results exist. */
export function buildJobPage(windows: readonly (readonly DurableJob[])[], pageSize = ACTIVITY_PAGE_SIZE) {
  const byId = new Map<string, DurableJob>();
  for (const window of windows)
    for (const job of window) {
      const prior = byId.get(job.jobId);
      if (!prior || prior.revision < job.revision) byId.set(job.jobId, job);
    }
  const ordered = [...byId.values()].sort(compareJobCreationDescending);
  const jobs = ordered.slice(0, pageSize);
  const last = jobs[jobs.length - 1];
  return {
    jobs,
    hasOlder: ordered.length > pageSize,
    olderCursor: last ? { createdAt: last.createdAt, jobId: last.jobId } : undefined,
  };
}
