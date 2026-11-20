import * as mediaUtils from '../../../process-audio/src/utils';
import { uploadYouTubeRenderSource } from '../../../process-audio/src/temporal/hetzner-render-output';
import { CancelToken } from '../../../process-audio/src/CancelToken';
import { renderProcessAudio } from '../../../process-audio/src/processAudio';
import { drainNativeYouTubeSession } from '../../../process-audio/src/temporal/hetzner-acquisition-producer';
import {
  readOwnedYouTubeRender,
  recordOwnedYouTubeRenderCandidate,
} from '../../../process-audio/src/temporal/hetzner-render-claim';
import { runOwnedYouTubeRender } from '../../../process-audio/src/temporal/hetzner-render-work';
import { assertRetainedMediaWorkspaceAvailable } from '../../../process-audio/src/temporal/resources';

jest.mock('../../../process-audio/src/temporal/hetzner-render-output', () => ({
  uploadYouTubeRenderSource: jest.fn(),
  readYouTubeRenderArtifact: jest.fn(),
}));
jest.mock('../../../process-audio/src/processAudio', () => ({ renderProcessAudio: jest.fn() }));
jest.mock('../../../process-audio/src/temporal/resources', () => ({
  assertRetainedMediaWorkspaceAvailable: jest.fn(),
}));
jest.mock('../../../process-audio/src/temporal/hetzner-acquisition-producer', () => ({
  drainNativeYouTubeSession: jest.fn(),
}));
jest.mock('../../../process-audio/src/temporal/hetzner-render-claim', () => ({
  readOwnedYouTubeRender: jest.fn(),
  recordOwnedYouTubeRenderCandidate: jest.fn(),
}));

const ref = {
  projectId: 'urm-app-staging',
  jobId: 'job',
  sermonId: 'sermon',
  revision: 1,
  requestVersion: '0123456789abcdef',
};
const directory = '/tmp/fixture-render';
const original = {
  authenticationCurrent: true,
  payload: { youtubeUrl: 'https://www.youtube.com/watch?v=fixture', startTime: 0, duration: 1 },
  output: { processed: 'processed', merged: 'merged', metadata: {} },
  pinnedMergeSources: {},
  claim: { episodeId: 'episode' },
} as Awaited<ReturnType<typeof readOwnedYouTubeRender>>;

function runFixture(cancellation: CancelToken) {
  return runOwnedYouTubeRender({
    ref,
    directory,
    bucket: { name: 'urm-app-staging.firebasestorage.app' },
    cancellation,
  } as Parameters<typeof runOwnedYouTubeRender>[0]);
}

afterEach(() => {
  jest.useRealTimers();
  jest.resetAllMocks();
});

test('one stalled authority read cancels running render work and late readback cannot publish', async () => {
  jest.useFakeTimers();
  const cancellation = new CancelToken();
  let completeRead!: (value: typeof original) => void;
  const pendingRead = new Promise<typeof original>((resolve) => {
    completeRead = resolve;
  });
  jest.mocked(readOwnedYouTubeRender).mockResolvedValueOnce(original).mockReturnValueOnce(pendingRead);
  jest.mocked(drainNativeYouTubeSession).mockResolvedValue(false);
  jest.mocked(renderProcessAudio).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        const signal = cancellation.signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
  );

  const result = runFixture(cancellation);
  const rejected = expect(result).rejects.toThrow('Media operation cancelled');
  await jest.advanceTimersByTimeAsync(5999);
  expect(cancellation.signal.aborted).toBe(false);
  expect(readOwnedYouTubeRender).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(1);
  await rejected;
  expect(cancellation.signal.aborted).toBe(true);
  expect(drainNativeYouTubeSession).toHaveBeenCalledWith(directory);

  completeRead(original);
  await jest.advanceTimersByTimeAsync(1000);
  expect(readOwnedYouTubeRender).toHaveBeenCalledTimes(2);
  expect(recordOwnedYouTubeRenderCandidate).not.toHaveBeenCalled();
});

test('a stalled initial claim observation never opens the renderer', async () => {
  jest.useFakeTimers();
  jest.mocked(readOwnedYouTubeRender).mockReturnValueOnce(new Promise(() => {}));

  const rejected = expect(runFixture(new CancelToken())).rejects.toThrow('YOUTUBE_ACQUISITION_AUTHORITY_UNAVAILABLE');
  await jest.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(renderProcessAudio).not.toHaveBeenCalled();
  expect(recordOwnedYouTubeRenderCandidate).not.toHaveBeenCalled();
});

test('the retained workspace is checked before the renderer or any candidate can open', async () => {
  jest.mocked(readOwnedYouTubeRender).mockResolvedValue(original);
  jest.mocked(drainNativeYouTubeSession).mockResolvedValue(false);
  jest.mocked(assertRetainedMediaWorkspaceAvailable).mockRejectedValue(new Error('No available workspace'));

  await expect(runFixture(new CancelToken())).rejects.toThrow('No available workspace');
  expect(assertRetainedMediaWorkspaceAvailable).toHaveBeenCalledWith(directory);
  expect(renderProcessAudio).not.toHaveBeenCalled();
  expect(recordOwnedYouTubeRenderCandidate).not.toHaveBeenCalled();
  expect(drainNativeYouTubeSession).toHaveBeenCalledWith(directory);
});

test('workspace exhaustion during a render cancels and drains the original work', async () => {
  jest.useFakeTimers();
  const cancellation = new CancelToken();
  jest.mocked(readOwnedYouTubeRender).mockResolvedValue(original);
  jest.mocked(drainNativeYouTubeSession).mockResolvedValue(false);
  jest
    .mocked(assertRetainedMediaWorkspaceAvailable)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('No available workspace'));
  jest
    .mocked(renderProcessAudio)
    .mockImplementation(
      () =>
        new Promise((_resolve, reject) =>
          cancellation.signal.addEventListener('abort', () => reject(cancellation.signal.reason), { once: true })
        )
    );

  const result = expect(runFixture(cancellation)).rejects.toThrow('Media operation cancelled');
  await jest.advanceTimersByTimeAsync(1000);
  await result;
  expect(assertRetainedMediaWorkspaceAvailable).toHaveBeenCalledTimes(2);
  expect(drainNativeYouTubeSession).toHaveBeenCalledWith(directory);
  expect(recordOwnedYouTubeRenderCandidate).not.toHaveBeenCalled();
});

test('a changed generation profile during download drains the render and publishes only an authentication wait', async () => {
  jest.useFakeTimers();
  const cancellation = new CancelToken();
  jest
    .mocked(readOwnedYouTubeRender)
    .mockImplementation(async ({ checkAuthentication }) =>
      checkAuthentication === 'downloading' ? { ...original, authenticationCurrent: false } : original
    );
  jest.mocked(drainNativeYouTubeSession).mockResolvedValue(false);
  jest
    .mocked(renderProcessAudio)
    .mockImplementation(
      () =>
        new Promise((_resolve, reject) =>
          cancellation.signal.addEventListener('abort', () => reject(cancellation.signal.reason), { once: true })
        )
    );

  const result = runFixture(cancellation);
  await jest.advanceTimersByTimeAsync(1000);
  await result;
  expect(cancellation.signal.aborted).toBe(true);
  expect(drainNativeYouTubeSession).toHaveBeenCalledWith(directory);
  expect(recordOwnedYouTubeRenderCandidate).toHaveBeenCalledTimes(1);
  expect(recordOwnedYouTubeRenderCandidate).toHaveBeenCalledWith(
    expect.objectContaining({ candidate: { providerOutcome: 'waiting_auth' } })
  );
});

test.each([
  { stage: 'source', position: 1 },
  { stage: 'processed', position: 2 },
  { stage: 'merged', position: 3 },
])('changed generations stop the $stage object before it opens', async ({ position }) => {
  const cancellation = new CancelToken();
  const duration = jest.spyOn(mediaUtils, 'getDurationSeconds').mockResolvedValue(2);
  let reads = 0;
  let derivedUploads = 0;
  jest.mocked(readOwnedYouTubeRender).mockImplementation(async () => {
    if (reads++ !== position) return original;
    return { ...original, pinnedMergeSources: { INTRO: { path: 'different-intro', generation: '2' } } };
  });
  jest.mocked(drainNativeYouTubeSession).mockResolvedValue(false);
  jest.mocked(uploadYouTubeRenderSource).mockResolvedValue({
    path: 'private-source',
    bytes: 128,
    generation: '1',
    crc32c: 'AAAAAA==',
    duration: 2,
  });
  jest.mocked(renderProcessAudio).mockImplementation(async (options) => {
    await options.retainYouTubeSource!('/tmp/fixture-source');
    await options.authorizeOutputUpload!();
    derivedUploads++;
    await options.authorizeOutputUpload!();
    derivedUploads++;
    throw new Error('Changed authority should stop before this point');
  });
  try {
    await expect(runFixture(cancellation)).rejects.toThrow('YOUTUBE_RENDER_WORK_UNCONFIRMED');
    expect(uploadYouTubeRenderSource).toHaveBeenCalledTimes(position === 1 ? 0 : 1);
    expect(derivedUploads).toBe(position === 3 ? 1 : 0);
    expect(cancellation.signal.aborted).toBe(true);
    expect(drainNativeYouTubeSession).toHaveBeenCalledWith(directory);
    expect(recordOwnedYouTubeRenderCandidate).not.toHaveBeenCalled();
  } finally {
    duration.mockRestore();
  }
});
