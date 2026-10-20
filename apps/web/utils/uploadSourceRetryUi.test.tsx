import { renderToStaticMarkup } from 'react-dom/server';
import type { DurableJob } from '@upperroom/contracts/temporal';
import UploadProgressComponent from '../components/uploaderComponents/UploadProgressComponent';

let mockJob: DurableJob;
let mockStale = false;
let mockError: string | null = null;
jest.mock('../hooks/useDurableJobs', () => ({
  useDurableJob: () => ({ job: mockJob, loading: false, stale: mockStale, error: mockError }),
}));
jest.mock('../context/user/UserContext', () => ({
  __esModule: true,
  default: () => ({ user: { uid: 'uploader-1', isAdmin: () => false } }),
}));
jest.mock('../utils/durableJobs', () => ({ submitDurableCommand: jest.fn() }));
jest.mock('../components/AvatarWithDefaultImage', () => ({ __esModule: true, default: () => null }));
jest.mock('@mui/material/Dialog', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <section role="dialog">{children}</section> : null,
}));

const retainedSource = { type: 'YoutubeUrl' as const, source: 'https://www.youtube.com/watch?v=original' };
const render = (options: { retained?: boolean; uploading?: boolean; uid?: string } = {}) =>
  renderToStaticMarkup(
    <UploadProgressComponent
      audioSource={options.retained === false ? undefined : retainedSource}
      isUploading={options.uploading ?? false}
      uploadProgress={{ error: true, percent: 0, message: 'Source attempt failed; input retained.' }}
      receipt={{
        jobId: mockJob.jobId,
        projectId: mockJob.projectId,
        requestId: mockJob.requestId,
        generation: 1,
        revision: 4,
        admissionState: 'accepted',
      }}
      requesterUid={options.uid ?? 'uploader-1'}
      onRetrySource={() => undefined}
    />
  );
beforeEach(() => {
  mockStale = false;
  mockError = null;
  mockJob = {
    jobId: 'source-original',
    projectId: 'test',
    requestId: 'request-original',
    schemaVersion: 1,
    kind: 'upload.create',
    entity: { type: 'sermon', id: 'same-canonical-sermon' },
    workflowId: 'source-workflow',
    generation: 1,
    revision: 4,
    requestedBy: 'uploader-1',
    state: 'failed',
    createdAt: 1,
    updatedAt: 2,
    steps: [],
    actions: [],
  };
});

it.each(['failed', 'cancelled', 'superseded'] as const)(
  'offers an explicit new source attempt for the requester with retained input after %s',
  (state) => {
    mockJob.state = state;
    const html = render();
    expect(html).toContain('Try upload again');
    expect(html).toContain('same audio and saved settings');
    expect(html).toContain('This audio attempt stopped. You can start a new attempt with the same saved source.');
  }
);

it('does not offer new source work from stale or disconnected status', () => {
  mockStale = true;
  expect(render()).not.toContain('Try upload again');
  mockStale = false;
  mockError = 'Disconnected';
  expect(render()).not.toContain('Try upload again');
});

it('does not offer new source work without retained input, for another requester, or during transfer', () => {
  expect(render({ retained: false })).not.toContain('Try upload again');
  expect(render({ uid: 'other-user' })).not.toContain('Try upload again');
  expect(render({ uploading: true })).not.toContain('Try upload again');
});

it('routes source-complete jobs and jobs with an admitted audio child to processing review', () => {
  mockJob.state = 'succeeded';
  expect(render()).not.toContain('Try upload again');
  mockJob.state = 'failed';
  mockJob.result = { mediaJobId: 'processing-child' };
  expect(render()).not.toContain('Try upload again');
  mockJob.result = undefined;
  mockJob.kind = 'audio.process';
  expect(render()).not.toContain('Try upload again');
});

it('does not replace active or cancellation-requested source work', () => {
  mockJob.state = 'cancel_requested';
  expect(render()).not.toContain('Try upload again');
  mockJob.state = 'awaiting_source';
  expect(render()).not.toContain('Try upload again');
});
