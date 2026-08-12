import {
  isRetryableStorageUploadError,
  retryStorageUpload,
} from '../../utils/retryStorageUpload';

describe('retryStorageUpload', () => {
  it('starts a fresh upload session after transient Storage failures', async () => {
    const transientError = { code: 'storage/unknown' };
    const upload = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce();
    const onRetry = jest.fn();

    await retryStorageUpload({
      upload,
      onRetry,
      retryDelaysMs: [1],
      wait: async () => undefined,
    });

    expect(upload).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(2, 2);
  });

  it('does not retry permission or validation failures', async () => {
    const permissionError = { code: 'storage/unauthorized' };
    const upload = jest.fn<Promise<void>, []>().mockRejectedValue(permissionError);

    await expect(
      retryStorageUpload({ upload, wait: async () => undefined })
    ).rejects.toBe(permissionError);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('recognizes retry exhaustion as a resumable transport failure', () => {
    expect(isRetryableStorageUploadError({ code: 'storage/retry-limit-exceeded' })).toBe(true);
    expect(isRetryableStorageUploadError({ code: 'storage/canceled' })).toBe(false);
  });
});
