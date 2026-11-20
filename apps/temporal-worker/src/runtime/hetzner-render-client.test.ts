import { youtubeAcquisitionId } from '../../../process-audio/src/temporal/hetzner-acquisition';
import { waitForYouTubeRender } from '../../../process-audio/src/temporal/hetzner-render-client';

const ref = {
  projectId: 'urm-app-staging',
  jobId: 'job',
  sermonId: 'sermon',
  requestVersion: 'a'.repeat(16),
  revision: 1,
};
const operationId = youtubeAcquisitionId(ref);
const status = (value: string) => ({ operationId, status: value });
const signal = new AbortController().signal;
const wait = async () => undefined;

test('a lost render POST ACK is followed only by reads, including after a missing observation', async () => {
  const request = jest
    .fn()
    .mockResolvedValueOnce(status('missing'))
    .mockRejectedValueOnce(new Error('fixture lost response'))
    .mockResolvedValueOnce(status('missing'))
    .mockResolvedValueOnce(status('running'))
    .mockResolvedValueOnce(status('rendered'));
  const authorizeDispatch = jest.fn().mockResolvedValue(true);
  await expect(
    waitForYouTubeRender({ ref, signal, request, authorizeDispatch, heartbeat: jest.fn(), wait, maxPolls: 4 })
  ).resolves.toBe('rendered');
  expect(authorizeDispatch).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.map(([method]) => method)).toEqual(['GET', 'POST', 'GET', 'GET', 'GET']);
  for (const [, body] of request.mock.calls) expect(body).toEqual({ ref, operationId });
});

test('a previous dispatch marker prevents a retry from issuing another POST', async () => {
  const request = jest.fn().mockResolvedValueOnce(status('missing')).mockResolvedValueOnce(status('rendered'));
  await expect(
    waitForYouTubeRender({
      ref,
      signal,
      request,
      authorizeDispatch: async () => false,
      heartbeat: jest.fn(),
      wait,
      maxPolls: 2,
    })
  ).resolves.toBe('rendered');
  expect(request.mock.calls.map(([method]) => method)).toEqual(['GET', 'GET']);
});

test('auth check treats a lost POST as observation-only and accepts a known failed probe', async () => {
  const request = jest
    .fn()
    .mockResolvedValueOnce(status('missing'))
    .mockRejectedValueOnce(new Error('fixture lost response'))
    .mockResolvedValueOnce(status('running'))
    .mockResolvedValueOnce(status('failed'));
  await expect(
    waitForYouTubeRender({
      ref,
      signal,
      request,
      authorizeDispatch: async () => true,
      authentication: true,
      heartbeat: jest.fn(),
      wait,
      maxPolls: 3,
    })
  ).resolves.toBe('failed');
  expect(request.mock.calls.map(([method]) => method)).toEqual(['GET', 'POST', 'GET', 'GET']);
});

test('auth contention returns to the durable wait without posting or exhausting the probe budget', async () => {
  const request = jest.fn().mockResolvedValue(status('missing'));
  const authorizeDispatch = jest.fn().mockResolvedValue('busy');
  await expect(
    waitForYouTubeRender({
      ref,
      signal,
      request,
      authorizeDispatch,
      authentication: true,
      heartbeat: jest.fn(),
      wait,
    })
  ).resolves.toBe('busy');
  expect(authorizeDispatch).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.map(([method]) => method)).toEqual(['GET']);
});

test('host contention is retried before dispatch, and a lost POST does not reopen dispatch', async () => {
  const request = jest
    .fn()
    .mockResolvedValueOnce(status('missing'))
    .mockResolvedValueOnce(status('missing'))
    .mockRejectedValueOnce(new Error('fixture lost response'))
    .mockResolvedValueOnce(status('missing'))
    .mockResolvedValueOnce(status('rendered'));
  const authorizeDispatch = jest.fn().mockResolvedValueOnce('busy').mockResolvedValueOnce(true);
  await expect(
    waitForYouTubeRender({ ref, signal, request, authorizeDispatch, heartbeat: jest.fn(), wait, maxPolls: 4 })
  ).resolves.toBe('rendered');
  expect(authorizeDispatch).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.map(([method]) => method)).toEqual(['GET', 'GET', 'POST', 'GET', 'GET']);
});
