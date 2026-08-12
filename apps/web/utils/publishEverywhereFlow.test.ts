import { runPublishEverywhereFlow } from './publishEverywhereFlow';

type Result = {
  status: 'success' | 'error';
  error?: string;
};

const createDeferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
};

describe('runPublishEverywhereFlow', () => {
  it('starts SoundCloud immediately and runs lists before series after media item prep', async () => {
    const events: string[] = [];
    const ensureDeferred = createDeferred<{ mediaItemId: string }>();
    const listsDeferred = createDeferred<Result>();
    const seriesDeferred = createDeferred<Result>();
    const soundCloudDeferred = createDeferred<Result>();

    const flowPromise = runPublishEverywhereFlow<Result, Result, Result>({
      shouldPublishLists: true,
      shouldPublishSeries: true,
      shouldPublishSoundCloud: true,
      ensureMediaItem: jest.fn(async () => {
        events.push('ensure:start');
        const result = await ensureDeferred.promise;
        events.push(`ensure:done:${result.mediaItemId}`);
        return result;
      }),
      publishLists: jest.fn(async (mediaItemId: string) => {
        events.push(`lists:start:${mediaItemId}`);
        const result = await listsDeferred.promise;
        events.push(`lists:done:${result.status}`);
        return result;
      }),
      publishSeries: jest.fn(async (mediaItemId: string) => {
        events.push(`series:start:${mediaItemId}`);
        const result = await seriesDeferred.promise;
        events.push(`series:done:${result.status}`);
        return result;
      }),
      publishSoundCloud: jest.fn(async () => {
        events.push('soundcloud:start');
        const result = await soundCloudDeferred.promise;
        events.push(`soundcloud:done:${result.status}`);
        return result;
      }),
      createPrepErrorResult: (error: string) => ({ status: 'error', error }),
    });

    await Promise.resolve();
    expect(events).toEqual(['soundcloud:start', 'ensure:start']);

    ensureDeferred.resolve({ mediaItemId: 'media-1' });
    await new Promise(process.nextTick);
    await new Promise(process.nextTick);
    expect(events.slice(0, 4)).toEqual([
      'soundcloud:start',
      'ensure:start',
      'ensure:done:media-1',
      'lists:start:media-1',
    ]);

    soundCloudDeferred.resolve({ status: 'success' });
    listsDeferred.resolve({ status: 'success' });
    await new Promise(process.nextTick);
    await new Promise(process.nextTick);
    expect(events).toContain('series:start:media-1');
    seriesDeferred.resolve({ status: 'success' });

    await expect(flowPromise).resolves.toEqual({
      listResult: { status: 'success' },
      seriesResult: { status: 'success' },
      soundCloudResult: { status: 'success' },
      mediaItemId: 'media-1',
    });
  });

  it('reuses the existing media item id and skips prep', async () => {
    const ensureMediaItem = jest.fn();
    const publishLists = jest.fn().mockResolvedValue({ status: 'success' });
    const publishSeries = jest.fn().mockResolvedValue({ status: 'success' });

    const result = await runPublishEverywhereFlow<Result, Result, Result>({
      shouldPublishLists: true,
      shouldPublishSeries: true,
      shouldPublishSoundCloud: false,
      initialMediaItemId: 'existing-media',
      ensureMediaItem,
      publishLists,
      publishSeries,
      publishSoundCloud: jest.fn().mockResolvedValue({ status: 'success' }),
      createPrepErrorResult: (error: string) => ({ status: 'error', error }),
    });

    expect(ensureMediaItem).not.toHaveBeenCalled();
    expect(publishLists).toHaveBeenCalledWith('existing-media');
    expect(publishSeries).toHaveBeenCalledWith('existing-media');
    expect(result).toEqual({
      listResult: { status: 'success' },
      seriesResult: { status: 'success' },
      soundCloudResult: null,
      mediaItemId: 'existing-media',
    });
  });

  it('returns prep errors to both lists and series while still allowing SoundCloud to succeed', async () => {
    const publishSoundCloud = jest.fn().mockResolvedValue({ status: 'success' });
    const publishLists = jest.fn();
    const publishSeries = jest.fn();

    const result = await runPublishEverywhereFlow<Result, Result, Result>({
      shouldPublishLists: true,
      shouldPublishSeries: true,
      shouldPublishSoundCloud: true,
      ensureMediaItem: jest.fn().mockRejectedValue(new Error('prep failed')),
      publishLists,
      publishSeries,
      publishSoundCloud,
      createPrepErrorResult: (error: string) => ({ status: 'error', error }),
    });

    expect(publishLists).not.toHaveBeenCalled();
    expect(publishSeries).not.toHaveBeenCalled();
    expect(publishSoundCloud).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      listResult: { status: 'error', error: 'prep failed' },
      seriesResult: { status: 'error', error: 'prep failed' },
      soundCloudResult: { status: 'success' },
    });
  });

  it('does not prepare a media item when only SoundCloud is selected', async () => {
    const ensureMediaItem = jest.fn();
    const result = await runPublishEverywhereFlow<Result, Result, Result>({
      shouldPublishLists: false,
      shouldPublishSeries: false,
      shouldPublishSoundCloud: true,
      ensureMediaItem,
      publishLists: jest.fn().mockResolvedValue({ status: 'success' }),
      publishSeries: jest.fn().mockResolvedValue({ status: 'success' }),
      publishSoundCloud: jest.fn().mockResolvedValue({ status: 'success' }),
      createPrepErrorResult: (error: string) => ({ status: 'error', error }),
    });

    expect(ensureMediaItem).not.toHaveBeenCalled();
    expect(result).toEqual({
      listResult: null,
      seriesResult: null,
      soundCloudResult: { status: 'success' },
    });
  });

  it('supports list-only publish after preparing the media item', async () => {
    const publishLists = jest.fn().mockResolvedValue({ status: 'success' });
    const publishSeries = jest.fn();

    const result = await runPublishEverywhereFlow<Result, Result, Result>({
      shouldPublishLists: true,
      shouldPublishSeries: false,
      shouldPublishSoundCloud: false,
      ensureMediaItem: jest.fn().mockResolvedValue({ mediaItemId: 'media-2' }),
      publishLists,
      publishSeries,
      publishSoundCloud: jest.fn().mockResolvedValue({ status: 'success' }),
      createPrepErrorResult: (error: string) => ({ status: 'error', error }),
    });

    expect(publishLists).toHaveBeenCalledWith('media-2');
    expect(publishSeries).not.toHaveBeenCalled();
    expect(result).toEqual({
      listResult: { status: 'success' },
      seriesResult: null,
      soundCloudResult: null,
      mediaItemId: 'media-2',
    });
  });

  it('supports series-only publish after preparing the media item', async () => {
    const publishSeries = jest.fn().mockResolvedValue({ status: 'success' });
    const publishLists = jest.fn();

    const result = await runPublishEverywhereFlow<Result, Result, Result>({
      shouldPublishLists: false,
      shouldPublishSeries: true,
      shouldPublishSoundCloud: false,
      ensureMediaItem: jest.fn().mockResolvedValue({ mediaItemId: 'media-3' }),
      publishLists,
      publishSeries,
      publishSoundCloud: jest.fn().mockResolvedValue({ status: 'success' }),
      createPrepErrorResult: (error: string) => ({ status: 'error', error }),
    });

    expect(publishSeries).toHaveBeenCalledWith('media-3');
    expect(publishLists).not.toHaveBeenCalled();
    expect(result).toEqual({
      listResult: null,
      seriesResult: { status: 'success' },
      soundCloudResult: null,
      mediaItemId: 'media-3',
    });
  });

  it('waits for list publish to finish before starting series publish when both are selected', async () => {
    const events: string[] = [];
    const listsDeferred = createDeferred<Result>();
    const seriesDeferred = createDeferred<Result>();

    const flowPromise = runPublishEverywhereFlow<Result, Result, Result>({
      shouldPublishLists: true,
      shouldPublishSeries: true,
      shouldPublishSoundCloud: false,
      ensureMediaItem: jest.fn().mockResolvedValue({ mediaItemId: 'media-4' }),
      publishLists: jest.fn(async (mediaItemId: string) => {
        events.push(`lists:start:${mediaItemId}`);
        const result = await listsDeferred.promise;
        events.push(`lists:done:${result.status}`);
        return result;
      }),
      publishSeries: jest.fn(async (mediaItemId: string) => {
        events.push(`series:start:${mediaItemId}`);
        const result = await seriesDeferred.promise;
        events.push(`series:done:${result.status}`);
        return result;
      }),
      publishSoundCloud: jest.fn().mockResolvedValue({ status: 'success' }),
      createPrepErrorResult: (error: string) => ({ status: 'error', error }),
    });

    await new Promise(process.nextTick);
    expect(events).toEqual(['lists:start:media-4']);

    listsDeferred.resolve({ status: 'success' });
    await new Promise(process.nextTick);
    await new Promise(process.nextTick);
    expect(events).toEqual(['lists:start:media-4', 'lists:done:success', 'series:start:media-4']);

    seriesDeferred.resolve({ status: 'success' });

    await expect(flowPromise).resolves.toEqual({
      listResult: { status: 'success' },
      seriesResult: { status: 'success' },
      soundCloudResult: null,
      mediaItemId: 'media-4',
    });
  });

  it('passes a list-recovered media item id to the following series publish', async () => {
    const publishSeries = jest.fn().mockResolvedValue({ status: 'success' });

    const result = await runPublishEverywhereFlow<Result & { mediaItemId?: string }, Result, Result>({
      shouldPublishLists: true,
      shouldPublishSeries: true,
      shouldPublishSoundCloud: false,
      initialMediaItemId: 'stale-media',
      ensureMediaItem: jest.fn(),
      publishLists: jest.fn().mockResolvedValue({ status: 'success', mediaItemId: 'replacement-media' }),
      publishSeries,
      publishSoundCloud: jest.fn(),
      createPrepErrorResult: (error: string) => ({ status: 'error', error }),
    });

    expect(publishSeries).toHaveBeenCalledWith('replacement-media');
    expect(result.mediaItemId).toBe('replacement-media');
  });
});
