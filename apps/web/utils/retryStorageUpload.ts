type StorageErrorLike = {
  code?: unknown;
};

export const isRetryableStorageUploadError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const code = (error as StorageErrorLike).code;
  return code === 'storage/unknown' || code === 'storage/retry-limit-exceeded';
};

type RetryStorageUploadOptions = {
  upload: () => Promise<void>;
  onRetry?: (attempt: number, maxAttempts: number) => void;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
};

const defaultWait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

/** Starts a fresh resumable session after Firebase Storage exhausts the one it
 * was using. This is deliberately limited to transport/session failures: auth,
 * validation, quota, and permission failures remain immediately actionable. */
export const retryStorageUpload = async ({
  upload,
  onRetry,
  retryDelaysMs = [1_000, 4_000],
  wait = defaultWait,
}: RetryStorageUploadOptions): Promise<void> => {
  const maxAttempts = retryDelaysMs.length + 1;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await upload();
      return;
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt - 1];
      if (retryDelayMs === undefined || !isRetryableStorageUploadError(error)) {
        throw error;
      }

      onRetry?.(attempt + 1, maxAttempts);
      await wait(retryDelayMs);
    }
  }
};
