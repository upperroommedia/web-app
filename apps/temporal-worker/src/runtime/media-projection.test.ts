import { createMediaProjection } from './media-projection';
const job: any = {
  state: 'running',
  steps: [
    { id: 'preparing', label: 'Prepare', state: 'succeeded', attempt: 1 },
    { id: 'downloading', label: 'Download', state: 'running', attempt: 2 },
  ],
};
test('a completed audio job cannot leave a step appearing to run forever', () => {
  const projection = createMediaProjection(job, { state: 'succeeded' }, 2, 1000)!;
  expect(projection.steps?.every((step) => step.state === 'succeeded')).toBe(true);
  expect(projection.finishedAt).toBe(1000);
  expect(projection.actions).toEqual([]);
});
test('new confirmed stages preserve earlier progress and finish the previous stage', () => {
  const projection = createMediaProjection(job, { state: 'running', stage: 'merging' }, 1, 1000)!;
  expect(projection.steps?.find((step) => step.id === 'downloading')?.state).toBe('succeeded');
  expect(projection.steps?.find((step) => step.id === 'merging')?.state).toBe('running');
  expect(projection.steps?.find((step) => step.id === 'preparing')?.state).toBe('succeeded');
});
test('auth waits and delayed retries are visible without invented percentages', () => {
  const waiting = createMediaProjection(job, { state: 'waiting', reason: 'authentication' }, 2, 1000)!;
  expect(waiting.state).toBe('waiting_for_auth');
  expect(waiting.steps?.find((step) => step.id === 'downloading')?.state).toBe('waiting');
  expect(JSON.stringify(waiting)).not.toContain('percent');
});
test('old callbacks never regress a completed or superseded job', () => {
  expect(
    createMediaProjection({ ...job, state: 'superseded' }, { state: 'running', stage: 'preparing' }, 3, 1000)
  ).toBeNull();
});
test('publishes measured seconds only for the exact running stage and attempt', () => {
  const report = {
    state: 'running' as const,
    stage: 'downloading' as const,
    measuredSeconds: { completed: 31, total: 60 },
  };
  const running = { ...job, revision: 14 };
  const projection = createMediaProjection(running, report, 2, 1000);
  expect(projection?.expectedRevision).toBe(14);
  expect(projection?.steps?.[1].progress).toEqual({ completed: 31, total: 60, unit: 'seconds' });
  expect(createMediaProjection(running, report, 1, 1000)).toBeNull();
  expect(createMediaProjection({ ...running, state: 'cancel_requested' }, report, 2, 1000)).toBeNull();
  expect(createMediaProjection({ ...running, steps: projection?.steps }, report, 2, 1000)).toBeNull();
});

test('a remote YouTube render describes acquisition and processing without a synthetic percentage', () => {
  const projection = createMediaProjection(
    job,
    {
      state: 'running',
      stage: 'downloading',
      remoteYouTubeRender: true,
    },
    3,
    1000
  );
  const step = projection?.steps?.find(({ id }) => id === 'downloading');
  expect(step?.label).toBe('Download and process YouTube audio');
  expect(step?.progress).toBeUndefined();
});
