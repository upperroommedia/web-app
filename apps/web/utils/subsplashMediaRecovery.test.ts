import {
  isSubsplashMediaItemNotFoundClientError,
  runWithMissingSubsplashMediaRecovery,
} from './subsplashMediaRecovery';

const missingMediaItemError = () =>
  Object.assign(new Error('Media item no longer exists.'), {
    code: 'functions/not-found',
    details: {
      code: 'SUBSPLASH_MEDIA_ITEM_NOT_FOUND',
      media_item_id: 'stale-media',
    },
  });

describe('Subsplash missing media recovery', () => {
  it('recognizes only the structured missing-media callable error', () => {
    expect(isSubsplashMediaItemNotFoundClientError(missingMediaItemError())).toBe(true);
    expect(
      isSubsplashMediaItemNotFoundClientError(
        Object.assign(new Error('not found'), {
          code: 'functions/not-found',
          details: { code: 'A_DIFFERENT_NOT_FOUND' },
        })
      )
    ).toBe(false);
    expect(
      isSubsplashMediaItemNotFoundClientError(
        Object.assign(new Error('unavailable'), {
          code: 'functions/unavailable',
        })
      )
    ).toBe(false);
  });

  it('recreates the media item and retries exactly once with the replacement id', async () => {
    const run = jest.fn().mockRejectedValueOnce(missingMediaItemError()).mockResolvedValueOnce('published');
    const recreateMediaItem = jest.fn().mockResolvedValue({ mediaItemId: 'replacement-media' });

    await expect(
      runWithMissingSubsplashMediaRecovery({
        mediaItemId: 'stale-media',
        run,
        recreateMediaItem,
      })
    ).resolves.toEqual({
      result: 'published',
      mediaItemId: 'replacement-media',
      recovered: true,
    });
    expect(run).toHaveBeenNthCalledWith(1, 'stale-media');
    expect(run).toHaveBeenNthCalledWith(2, 'replacement-media');
    expect(recreateMediaItem).toHaveBeenCalledTimes(1);
  });

  it('does not recreate for transient failures and does not loop after a failed retry', async () => {
    const transientError = Object.assign(new Error('upstream unavailable'), { code: 'functions/unavailable' });
    const recreateForTransient = jest.fn();
    await expect(
      runWithMissingSubsplashMediaRecovery({
        mediaItemId: 'media',
        run: jest.fn().mockRejectedValue(transientError),
        recreateMediaItem: recreateForTransient,
      })
    ).rejects.toBe(transientError);
    expect(recreateForTransient).not.toHaveBeenCalled();

    const secondMissingError = missingMediaItemError();
    const run = jest.fn().mockRejectedValueOnce(missingMediaItemError()).mockRejectedValueOnce(secondMissingError);
    const recreateMediaItem = jest.fn().mockResolvedValue({ mediaItemId: 'replacement-media' });
    await expect(
      runWithMissingSubsplashMediaRecovery({
        mediaItemId: 'stale-media',
        run,
        recreateMediaItem,
      })
    ).rejects.toBe(secondMissingError);
    expect(run).toHaveBeenCalledTimes(2);
    expect(recreateMediaItem).toHaveBeenCalledTimes(1);
  });
});
