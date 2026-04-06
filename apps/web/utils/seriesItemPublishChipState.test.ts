import { getSeriesItemPublishChipState } from './seriesItemPublishChipState';

describe('getSeriesItemPublishChipState', () => {
  it('shows a loading state while publishing', () => {
    expect(
      getSeriesItemPublishChipState({
        publishedToSubsplash: false,
        isPublishing: true,
        isUnpublishing: false,
      })
    ).toEqual({
      isBusy: true,
      label: 'Publishing',
      tooltip: 'Publishing to Subsplash series…',
      color: 'info',
      variant: 'filled',
    });
  });

  it('shows a loading state while unpublishing', () => {
    expect(
      getSeriesItemPublishChipState({
        publishedToSubsplash: true,
        isPublishing: false,
        isUnpublishing: true,
      })
    ).toEqual({
      isBusy: true,
      label: 'Unpublishing',
      tooltip: 'Unpublishing from Subsplash series…',
      color: 'info',
      variant: 'filled',
    });
  });

  it('shows the published state when idle and synced', () => {
    expect(
      getSeriesItemPublishChipState({
        publishedToSubsplash: true,
        isPublishing: false,
        isUnpublishing: false,
      })
    ).toEqual({
      isBusy: false,
      label: 'Published',
      tooltip: 'Published to Subsplash series',
      color: 'success',
      variant: 'filled',
    });
  });
});
