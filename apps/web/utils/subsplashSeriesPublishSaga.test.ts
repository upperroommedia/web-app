import { runSubsplashSeriesPublishSaga } from './subsplashSeriesPublishSaga';

describe('runSubsplashSeriesPublishSaga', () => {
  it('publishes successfully when add, reorder, and local persist all succeed', async () => {
    const ensureSeriesSubsplashId = jest.fn().mockResolvedValue('series-remote-1');
    const addToSeries = jest.fn().mockResolvedValue({
      status: 'success',
      mediaItemId: 'media-1',
      confirmedSeriesId: 'series-remote-1',
    });
    const reorderSeries = jest.fn().mockResolvedValue(undefined);
    const rollbackSeriesMembership = jest.fn().mockResolvedValue(undefined);
    const persistLocalPublished = jest.fn().mockResolvedValue(undefined);
    const persistLocalUnpublished = jest.fn().mockResolvedValue(undefined);

    const result = await runSubsplashSeriesPublishSaga({
      ensureSeriesSubsplashId,
      addToSeries,
      reorderSeries,
      rollbackSeriesMembership,
      persistLocalPublished,
      persistLocalUnpublished,
    });

    expect(result).toEqual({
      status: 'success',
      mediaItemId: 'media-1',
      seriesSubsplashId: 'series-remote-1',
      remotePublished: true,
      localPublished: true,
    });
    expect(persistLocalPublished).toHaveBeenCalledWith('media-1');
    expect(rollbackSeriesMembership).not.toHaveBeenCalled();
    expect(persistLocalUnpublished).not.toHaveBeenCalled();
  });

  it('rolls back remote publish and keeps local state unpublished when reorder fails but rollback succeeds', async () => {
    const rollbackSeriesMembership = jest.fn().mockResolvedValue(undefined);
    const persistLocalUnpublished = jest.fn().mockResolvedValue(undefined);

    const result = await runSubsplashSeriesPublishSaga({
      ensureSeriesSubsplashId: jest.fn().mockResolvedValue('series-remote-1'),
      addToSeries: jest.fn().mockResolvedValue({
        status: 'success',
        mediaItemId: 'media-1',
        confirmedSeriesId: 'series-remote-1',
      }),
      reorderSeries: jest.fn().mockRejectedValue(new Error('reorder failed')),
      rollbackSeriesMembership,
      persistLocalPublished: jest.fn().mockResolvedValue(undefined),
      persistLocalUnpublished,
    });

    expect(result).toEqual({
      status: 'error',
      mediaItemId: 'media-1',
      seriesSubsplashId: 'series-remote-1',
      remotePublished: false,
      localPublished: false,
      error: 'reorder failed',
    });
    expect(rollbackSeriesMembership).toHaveBeenCalledWith('media-1');
    expect(persistLocalUnpublished).toHaveBeenCalled();
  });

  it('keeps local state published when rollback also fails so Firebase matches Subsplash', async () => {
    const persistLocalPublished = jest.fn().mockResolvedValue(undefined);

    const result = await runSubsplashSeriesPublishSaga({
      ensureSeriesSubsplashId: jest.fn().mockResolvedValue('series-remote-1'),
      addToSeries: jest.fn().mockResolvedValue({
        status: 'success',
        mediaItemId: 'media-1',
        confirmedSeriesId: 'series-remote-1',
      }),
      reorderSeries: jest.fn().mockRejectedValue(new Error('reorder failed')),
      rollbackSeriesMembership: jest.fn().mockRejectedValue(new Error('rollback failed')),
      persistLocalPublished,
      persistLocalUnpublished: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.status).toBe('error');
    expect(result.remotePublished).toBe(true);
    expect(result.localPublished).toBe(true);
    expect(result.error).toContain('reorder failed');
    expect(result.error).toContain('rollback failed');
    expect(persistLocalPublished).toHaveBeenCalledWith('media-1');
  });

  it('fails safely when Subsplash does not confirm the expected series assignment', async () => {
    const result = await runSubsplashSeriesPublishSaga({
      ensureSeriesSubsplashId: jest.fn().mockResolvedValue('series-remote-1'),
      addToSeries: jest.fn().mockResolvedValue({
        status: 'success',
        mediaItemId: 'media-1',
        confirmedSeriesId: 'series-remote-2',
      }),
      reorderSeries: jest.fn().mockResolvedValue(undefined),
      rollbackSeriesMembership: jest.fn().mockResolvedValue(undefined),
      persistLocalPublished: jest.fn().mockResolvedValue(undefined),
      persistLocalUnpublished: jest.fn().mockResolvedValue(undefined),
    });

    expect(result).toEqual({
      status: 'error',
      mediaItemId: 'media-1',
      seriesSubsplashId: 'series-remote-1',
      remotePublished: false,
      localPublished: false,
      error: 'Subsplash did not confirm series assignment. Expected series-remote-1, got series-remote-2.',
    });
  });
});
