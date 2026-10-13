import type { DurableJob } from '@upperroom/contracts/temporal';
import { buildJobPage, compareJobCreationDescending } from './jobPaging';
const job = (index: number): DurableJob => ({
  schemaVersion: 1,
  jobId: `job-${String(index).padStart(3, '0')}`,
  projectId: 'test',
  kind: 'provider.orphan_review',
  entity: { type: 'maintenance', id: 'review' },
  workflowId: 'workflow',
  generation: 1,
  revision: 1,
  requestedBy: 'actor',
  requestId: 'request',
  state: 'needs_attention',
  createdAt: 1000,
  updatedAt: 1000,
  steps: [],
  actions: ['resolve'],
});
it('reaches every task across tied timestamp boundaries without duplicates or gaps', () => {
  const records = Array.from({ length: 105 }, (_, index) => job(index)).sort(compareJobCreationDescending);
  const first = buildJobPage([records.slice(0, 101)]);
  expect(first.jobs).toHaveLength(100);
  expect(first.hasOlder).toBe(true);
  expect(first.olderCursor).toEqual({ createdAt: 1000, jobId: 'job-005' });
  const remaining = records.filter((candidate) => compareJobCreationDescending(candidate, first.olderCursor!) > 0);
  const second = buildJobPage([remaining.slice(0, 101)]);
  expect(second.jobs).toHaveLength(5);
  expect(second.hasOlder).toBe(false);
  expect(new Set([...first.jobs, ...second.jobs].map((candidate) => candidate.jobId)).size).toBe(105);
});
it('merges bounded requester and subject pages using the latest revision', () => {
  const records = Array.from({ length: 160 }, (_, index) => job(index)).sort(compareJobCreationDescending);
  const first = buildJobPage([
    records.slice(0, 101),
    records.slice(59, 160).map((candidate) => ({ ...candidate, revision: 2 })),
  ]);
  expect(first.jobs).toHaveLength(100);
  expect(first.hasOlder).toBe(true);
  expect(first.jobs.find((candidate) => candidate.jobId === 'job-100')?.revision).toBe(2);
  const remaining = records.filter((candidate) => compareJobCreationDescending(candidate, first.olderCursor!) > 0);
  const second = buildJobPage([remaining, remaining]);
  expect(new Set([...first.jobs, ...second.jobs].map((candidate) => candidate.jobId)).size).toBe(160);
});
it('does not claim older work exists when exactly one full page was confirmed', () => {
  expect(buildJobPage([Array.from({ length: 100 }, (_, index) => job(index))]).hasOlder).toBe(false);
  expect(buildJobPage([[]])).toEqual({ jobs: [], hasOlder: false, olderCursor: undefined });
});
