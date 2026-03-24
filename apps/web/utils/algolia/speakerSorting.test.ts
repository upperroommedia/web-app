import { getDefaultSpeakerSortOrder, resolveSpeakerIndexName, resolveSpeakerSortFromIndexName } from './speakerSorting';

describe('speakerSorting', () => {
  it('maps the speaker sort selections to the expected Algolia index names', () => {
    expect(resolveSpeakerIndexName('sermonCount', 'desc')).toBe('speakers_sort_sermonCount_desc');
    expect(resolveSpeakerIndexName('sermonCount', 'asc')).toBe('speakers_sort_sermonCount_asc');
    expect(resolveSpeakerIndexName('name', 'asc')).toBe('speakers_sort_name_asc');
    expect(resolveSpeakerIndexName('name', 'desc')).toBe('speakers_sort_name_desc');
  });

  it('derives the expected sort state from replica index names', () => {
    expect(resolveSpeakerSortFromIndexName('speakers_sort_sermonCount_desc')).toEqual({
      sortProperty: 'sermonCount',
      sortOrder: 'desc',
    });
    expect(resolveSpeakerSortFromIndexName('speakers_sort_name_asc')).toEqual({
      sortProperty: 'name',
      sortOrder: 'asc',
    });
  });

  it('keeps the current default sort directions stable', () => {
    expect(getDefaultSpeakerSortOrder('sermonCount')).toBe('desc');
    expect(getDefaultSpeakerSortOrder('name')).toBe('asc');
  });
});
