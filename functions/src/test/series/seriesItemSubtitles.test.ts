import { formatSeriesItemSubtitle, planSeriesItemSubtitleUpdates } from '../../helpers/seriesItemSubtitles';

describe('series item subtitles', () => {
  it('formats a one-indexed series position as a public Subsplash subtitle', () => {
    expect(formatSeriesItemSubtitle('Sowing Seeds', 4)).toBe('Part 4 of Sowing Seeds');
  });

  it('trims the series title and rejects positions that cannot identify a part', () => {
    expect(formatSeriesItemSubtitle('  Sowing Seeds  ', 1)).toBe('Part 1 of Sowing Seeds');
    expect(() => formatSeriesItemSubtitle('', 1)).toThrow('series title');
    expect(() => formatSeriesItemSubtitle('Sowing Seeds', 0)).toThrow('positive integer');
    expect(() => formatSeriesItemSubtitle('Sowing Seeds', 1.5)).toThrow('positive integer');
  });

  it('plans only mismatched items and is idempotent once subtitles match', () => {
    expect(
      planSeriesItemSubtitleUpdates('Sowing Seeds', [
        { id: 'part-3', position: 3, subtitle: 'Part 3 of Sowing Seeds' },
        { id: 'part-2', position: 2, subtitle: null },
        { id: 'part-1', position: 1, subtitle: 'Spiritual Reflections' },
      ])
    ).toEqual([
      { id: 'part-2', position: 2, subtitle: 'Part 2 of Sowing Seeds' },
      { id: 'part-1', position: 1, subtitle: 'Part 1 of Sowing Seeds' },
    ]);

    expect(
      planSeriesItemSubtitleUpdates('Sowing Seeds', [
        { id: 'part-2', position: 2, subtitle: 'Part 2 of Sowing Seeds' },
        { id: 'part-1', position: 1, subtitle: 'Part 1 of Sowing Seeds' },
      ])
    ).toEqual([]);
  });

  it('defers unpositioned items while still planning updates for positioned items', () => {
    expect(
      planSeriesItemSubtitleUpdates('Sowing Seeds', [
        { id: 'draft-item', position: null, subtitle: null },
        { id: 'invalid-item', position: 0, subtitle: null },
        { id: 'published-item', position: 2, subtitle: null },
      ])
    ).toEqual([
      { id: 'published-item', position: 2, subtitle: 'Part 2 of Sowing Seeds' },
    ]);
  });
});
