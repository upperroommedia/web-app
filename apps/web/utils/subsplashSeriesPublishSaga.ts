import { AddToSeriesOutputType } from '@upperroom/contracts/addToSeries';

export interface SeriesPublishSagaDependencies {
  ensureSeriesSubsplashId: () => Promise<string>;
  addToSeries: (seriesSubsplashId: string) => Promise<AddToSeriesOutputType>;
  reorderSeries: (resolvedMediaItemId: string) => Promise<void>;
  rollbackSeriesMembership: (resolvedMediaItemId: string) => Promise<void>;
  persistLocalPublished: (resolvedMediaItemId: string) => Promise<void>;
  persistLocalUnpublished: () => Promise<void>;
}

export interface SeriesPublishSagaResult {
  status: 'success' | 'error';
  mediaItemId?: string;
  seriesSubsplashId?: string;
  remotePublished: boolean;
  localPublished: boolean;
  error?: string;
}

export const runSubsplashSeriesPublishSaga = async (
  dependencies: SeriesPublishSagaDependencies
): Promise<SeriesPublishSagaResult> => {
  const seriesSubsplashId = await dependencies.ensureSeriesSubsplashId();
  const addResult = await dependencies.addToSeries(seriesSubsplashId);

  if (!addResult || addResult.status !== 'success') {
    return {
      status: 'error',
      remotePublished: false,
      localPublished: false,
      seriesSubsplashId,
      error: addResult?.error || 'Failed to add sermon to series.',
    };
  }

  if (addResult.confirmedSeriesId !== seriesSubsplashId) {
    return {
      status: 'error',
      remotePublished: false,
      localPublished: false,
      seriesSubsplashId,
      mediaItemId: addResult.mediaItemId,
      error: `Subsplash did not confirm series assignment. Expected ${seriesSubsplashId}, got ${addResult.confirmedSeriesId || 'null'}.`,
    };
  }

  const resolvedMediaItemId = addResult.mediaItemId;
  if (!resolvedMediaItemId) {
    return {
      status: 'error',
      remotePublished: false,
      localPublished: false,
      seriesSubsplashId,
      error: 'Series publish succeeded remotely but did not return a media item id.',
    };
  }

  try {
    await dependencies.reorderSeries(resolvedMediaItemId);
    await dependencies.persistLocalPublished(resolvedMediaItemId);

    return {
      status: 'success',
      mediaItemId: resolvedMediaItemId,
      seriesSubsplashId,
      remotePublished: true,
      localPublished: true,
    };
  } catch (reorderError: unknown) {
    const reorderMessage = reorderError instanceof Error ? reorderError.message : 'Unknown reorder error';

    try {
      await dependencies.rollbackSeriesMembership(resolvedMediaItemId);
      await dependencies.persistLocalUnpublished();

      return {
        status: 'error',
        mediaItemId: resolvedMediaItemId,
        seriesSubsplashId,
        remotePublished: false,
        localPublished: false,
        error: reorderMessage,
      };
    } catch (rollbackError: unknown) {
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : 'Unknown rollback error';
      await dependencies.persistLocalPublished(resolvedMediaItemId);

      return {
        status: 'error',
        mediaItemId: resolvedMediaItemId,
        seriesSubsplashId,
        remotePublished: true,
        localPublished: true,
        error: `Series reorder failed and rollback failed. Sermon remains published in Subsplash. Reorder error: ${reorderMessage}; rollback error: ${rollbackMessage}.`,
      };
    }
  }
};
