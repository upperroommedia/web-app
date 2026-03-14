import { getDefaultListSortOrder, resolveListIndexName, resolveListSortFromIndexName } from './listSorting';

describe('listSorting', () => {
  it('maps the list sort selections to the expected Algolia index names', () => {
    expect(resolveListIndexName('name', 'asc')).toBe('lists_sort_name_asc');
    expect(resolveListIndexName('name', 'desc')).toBe('lists_sort_name_desc');
    expect(resolveListIndexName('count', 'asc')).toBe('lists');
  });

  it('derives the expected sort state from replica index names', () => {
    expect(resolveListSortFromIndexName('lists_sort_name_asc')).toEqual({
      sortProperty: 'name',
      sortOrder: 'asc',
    });
    expect(resolveListSortFromIndexName('lists_sort_count_desc')).toEqual({
      sortProperty: 'name',
      sortOrder: 'asc',
    });
  });

  it('keeps the default sort directions stable', () => {
    expect(getDefaultListSortOrder('name')).toBe('asc');
  });
});
