import { deriveSeriesMetadata } from '../../helpers/seriesHelpers';

describe('deriveSeriesMetadata', () => {
  it('returns 0 part series when there are no items', () => {
    expect(deriveSeriesMetadata([])).toEqual({
      itemCount: 0,
      publishedItemCount: 0,
      subtitle: '0 part series',
    });
  });

  it('recalculates when publish state changes from false to true', () => {
    const beforePublish = deriveSeriesMetadata([
      { publishedToSubsplash: false },
      { publishedToSubsplash: false },
    ]);
    const afterPublish = deriveSeriesMetadata([
      { publishedToSubsplash: true },
      { publishedToSubsplash: false },
    ]);

    expect(beforePublish).toEqual({
      itemCount: 2,
      publishedItemCount: 0,
      subtitle: '0 part series',
    });
    expect(afterPublish).toEqual({
      itemCount: 2,
      publishedItemCount: 1,
      subtitle: '1 part series',
    });
  });

  it('recalculates when publish state changes from true to false', () => {
    const beforeUnpublish = deriveSeriesMetadata([
      { publishedToSubsplash: true },
      { publishedToSubsplash: true },
    ]);
    const afterUnpublish = deriveSeriesMetadata([
      { publishedToSubsplash: true },
      { publishedToSubsplash: false },
    ]);

    expect(beforeUnpublish).toEqual({
      itemCount: 2,
      publishedItemCount: 2,
      subtitle: '2 part series',
    });
    expect(afterUnpublish).toEqual({
      itemCount: 2,
      publishedItemCount: 1,
      subtitle: '1 part series',
    });
  });

  it('recalculates when a published item is deleted', () => {
    const beforeDelete = deriveSeriesMetadata([
      { publishedToSubsplash: true },
      { publishedToSubsplash: true },
      { publishedToSubsplash: false },
    ]);
    const afterDelete = deriveSeriesMetadata([
      { publishedToSubsplash: true },
      { publishedToSubsplash: false },
    ]);

    expect(beforeDelete).toEqual({
      itemCount: 3,
      publishedItemCount: 2,
      subtitle: '2 part series',
    });
    expect(afterDelete).toEqual({
      itemCount: 2,
      publishedItemCount: 1,
      subtitle: '1 part series',
    });
  });

  it('uses only published item count for subtitle when total is 10 and published is 5', () => {
    const metadata = deriveSeriesMetadata([
      { publishedToSubsplash: true },
      { publishedToSubsplash: true },
      { publishedToSubsplash: true },
      { publishedToSubsplash: true },
      { publishedToSubsplash: true },
      { publishedToSubsplash: false },
      { publishedToSubsplash: false },
      { publishedToSubsplash: false },
      { publishedToSubsplash: false },
      { publishedToSubsplash: false },
    ]);

    expect(metadata).toEqual({
      itemCount: 10,
      publishedItemCount: 5,
      subtitle: '5 part series',
    });
  });
});
