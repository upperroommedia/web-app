import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DurableJob } from '@upperroom/contracts/temporal';
let child: DurableJob | undefined;
let childStale = false;
let actor = 'owner';
jest.mock('../context/user/UserContext', () => ({
  __esModule: true,
  default: () => ({ user: { uid: actor, isAdmin: () => false } }),
}));
jest.mock('../hooks/useDurableJobs', () => ({
  useDurableJob: () => ({ job: child, loading: false, error: null, stale: childStale }),
}));
jest.mock('../utils/durableJobs', () => ({ submitDurableCommand: jest.fn() }));
import PlainJobStatus from '../components/jobs/PlainJobStatus';
const job = (extra: Partial<DurableJob> = {}): DurableJob => ({
  schemaVersion: 1,
  jobId: 'internal-job',
  projectId: 'demo-test',
  workflowId: 'internal-workflow',
  requestId: 'internal-request',
  requestedBy: 'owner',
  generation: 1,
  revision: 1,
  kind: 'sermon.publish',
  entity: { type: 'sermon', id: 'sermon' },
  state: 'running',
  createdAt: 1,
  updatedAt: 1,
  steps: [],
  actions: ['cancel'],
  ...extra,
});
beforeEach(() => {
  child = undefined;
  childStale = false;
  actor = 'owner';
});
it('shows an actual attention outcome without operational identifiers or an in-progress claim', () => {
  const html = renderToStaticMarkup(
    <PlainJobStatus
      job={job({
        state: 'needs_attention',
        attention: { kind: 'external_result_unknown', message: 'The destination could not be confirmed.' },
      })}
    />
  );
  expect(html).toContain('Needs attention');
  expect(html).toContain('The destination could not be confirmed.');
  expect(html).not.toContain('internal-job');
  expect(html).not.toContain('internal-workflow');
  expect(html).not.toContain('/admin/activity');
  expect(html).not.toContain('already in progress');
});
it('keeps authorized cancellation beside ordinary inline status', () => {
  expect(renderToStaticMarkup(<PlainJobStatus job={job()} />)).toContain('Request cancellation');
  actor = 'another-user';
  expect(renderToStaticMarkup(<PlainJobStatus job={job()} />)).not.toContain('Request cancellation');
  actor = 'owner';
  expect(renderToStaticMarkup(<PlainJobStatus job={job({ actions: [] })} />)).not.toContain('Request cancellation');
});
it('does not offer commands or completion from stale observations', () => {
  const html = renderToStaticMarkup(<PlainJobStatus job={job({ state: 'succeeded' })} stale />);
  expect(html).toContain('Reconnecting');
  expect(html).not.toContain('Complete');
  expect(html).not.toContain('Request cancellation');
});
it('separates source receipt from queued child processing', () => {
  child = job({ jobId: 'audio', kind: 'audio.process', state: 'queued' });
  const html = renderToStaticMarkup(
    <PlainJobStatus job={job({ kind: 'upload.create', state: 'succeeded', result: { mediaJobId: 'audio' } })} />
  );
  expect(html).toContain('Source received');
  expect(html).toContain('Queued');
  expect(html).not.toContain('Complete');
  expect(html).toContain('Request cancellation');
});
it('does not claim completion from a stale or unrelated child', () => {
  const source = job({ kind: 'upload.create', state: 'succeeded', result: { mediaJobId: 'audio' } });
  child = job({ jobId: 'audio', kind: 'audio.process', state: 'succeeded' });
  childStale = true;
  expect(renderToStaticMarkup(<PlainJobStatus job={source} />)).not.toContain('Complete');
  childStale = false;
  child = { ...child, entity: { type: 'sermon', id: 'another-sermon' } };
  expect(renderToStaticMarkup(<PlainJobStatus job={source} />)).not.toContain('Complete');
});
