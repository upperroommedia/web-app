import { SUBSPLASH_MEDIA_ITEM_NOT_FOUND_CODE } from '@upperroom/contracts/addToList';

type CallableErrorDetails = {
  code?: unknown;
};

export const isSubsplashMediaItemNotFoundClientError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const callableError = error as { code?: unknown; details?: unknown };
  if (callableError.code !== 'functions/not-found') {
    return false;
  }

  const details = callableError.details;
  return (
    typeof details === 'object' &&
    details !== null &&
    !Array.isArray(details) &&
    (details as CallableErrorDetails).code === SUBSPLASH_MEDIA_ITEM_NOT_FOUND_CODE
  );
};

export async function runWithMissingSubsplashMediaRecovery<T>({
  mediaItemId,
  run,
  recreateMediaItem,
}: {
  mediaItemId: string;
  run: (activeMediaItemId: string) => Promise<T>;
  recreateMediaItem: () => Promise<{ mediaItemId: string }>;
}): Promise<{ result: T; mediaItemId: string; recovered: boolean }> {
  try {
    return {
      result: await run(mediaItemId),
      mediaItemId,
      recovered: false,
    };
  } catch (error) {
    if (!isSubsplashMediaItemNotFoundClientError(error)) {
      throw error;
    }

    const replacement = await recreateMediaItem();
    return {
      result: await run(replacement.mediaItemId),
      mediaItemId: replacement.mediaItemId,
      recovered: true,
    };
  }
}
