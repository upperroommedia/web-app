import { networkFailureInjector, subsplashSeriesMock } from './mocks';
import { getSeriesItems } from '../../helpers/seriesHelpers';

describe('seriesHelpers getSeriesItems pagination', () => {
  beforeEach(() => {
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('reads every page when a series has more than 200 items', async () => {
    const series = subsplashSeriesMock.createSeries('Long Series');
    for (let position = 1; position <= 205; position += 1) {
      subsplashSeriesMock.createMediaItem(`Part ${position}`, {
        seriesId: series.id,
        position,
      });
    }

    const items = await getSeriesItems(series.id, 'fake-token', { pageSize: 200 });

    expect(items).toHaveLength(205);
    expect(new Set(items.map((item) => item.id)).size).toBe(205);
  });
});
