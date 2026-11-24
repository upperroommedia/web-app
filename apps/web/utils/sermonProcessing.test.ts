import type { DurableJob } from '@upperroom/contracts/temporal';
import { sermonStatusType } from '../types/SermonTypes';
import { getSermonProcessing } from './sermonProcessing';

const buildDurableJob = (overrides: Partial<DurableJob>): DurableJob => ({
  schemaVersion: 1,
  kind: 'upload.create',
  jobId: 'job-1',
  generation: 1,
  projectId: 'test',
  entity: { type: 'sermon', id: 'sermon-1' },
  workflowId: 'workflow-1',
  requestId: 'request-1',
  requestedBy: 'uploader-1',
  state: 'awaiting_source',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  steps: [],
  actions: [],
  ...overrides,
});

describe('sermon processing presentation', () => {
  const media = buildDurableJob({
    kind: 'audio.process',
    state: 'running',
    steps: [
      {
        id: 'transcoding',
        label: 'Process audio',
        state: 'running',
        attempt: 1,
        progress: { completed: 20, total: 80, unit: 'seconds' },
      },
    ],
  });

  it('shows measured audio progress even alongside an unrelated publishing job', () => {
    const publishing = buildDurableJob({ kind: 'sermon.publish', state: 'running' });
    expect(getSermonProcessing([publishing, media], sermonStatusType.PROCESSING, false)).toEqual({
      pending: false,
      processing: true,
      label: 'Process audio',
      percent: 25,
      showBar: true,
    });
  });

  it('shows a stage without a percentage while queued, and discards stale measurements', () => {
    expect(getSermonProcessing([{ ...media, state: 'queued' }], sermonStatusType.PENDING, false)).toMatchObject({
      label: 'Queued',
      percent: undefined,
      showBar: true,
    });
    expect(getSermonProcessing([media], sermonStatusType.PROCESSING, true)).toMatchObject({
      label: 'Reconnecting',
      percent: undefined,
      showBar: false,
    });
  });
});
