import { buildPublishedSeriesOrder, getNextSeriesPosition } from './seriesPublishOrder';

describe('seriesPublishOrder', () => {
  it('computes the next position from the highest existing series item position', () => {
    expect(
      getNextSeriesPosition([
        { sermonId: 'a', position: 1 },
        { sermonId: 'b', position: 7 },
        { sermonId: 'c', position: 4 },
      ])
    ).toBe(8);
  });

  it('injects the newly published sermon into reorder payloads when its Firestore row is missing', () => {
    expect(
      buildPublishedSeriesOrder(
        [
          { sermonId: 'existing-1', publishedToSubsplash: true, sermonSubsplashId: 'media-1', position: 5 },
          { sermonId: 'existing-2', publishedToSubsplash: true, sermonSubsplashId: 'media-2', position: 3 },
        ],
        'new-sermon',
        'new-media',
        6
      )
    ).toEqual([
      { sermonId: 'new-sermon', mediaItemId: 'new-media', position: 6 },
      { sermonId: 'existing-1', mediaItemId: 'media-1', position: 5 },
      { sermonId: 'existing-2', mediaItemId: 'media-2', position: 3 },
    ]);
  });

  it('throws when the newly published sermon is missing and there is no pending position fallback', () => {
    expect(() =>
      buildPublishedSeriesOrder(
        [{ sermonId: 'existing-1', publishedToSubsplash: true, sermonSubsplashId: 'media-1', position: 2 }],
        'missing-sermon',
        'missing-media'
      )
    ).toThrow('Series item is missing from Firestore order. Refresh and try again.');
  });

  it('throws when any published sermon is missing its Subsplash media item id', () => {
    expect(() =>
      buildPublishedSeriesOrder(
        [
          { sermonId: 'existing-1', publishedToSubsplash: true, sermonSubsplashId: '', position: 2 },
          { sermonId: 'new-sermon', publishedToSubsplash: false, position: 1 },
        ],
        'new-sermon',
        'new-media',
        1
      )
    ).toThrow('Published series item existing-1 is missing a Subsplash media ID.');
  });
});
