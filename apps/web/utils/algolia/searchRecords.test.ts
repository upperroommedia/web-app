import type { SearchClient } from 'algoliasearch';
import { ListType, OverflowBehavior } from '../../types/List';
import {
  getListDiscoveryCount,
  isDiscoverableRootList,
  normalizeAlgoliaListHit,
  searchListsIndex,
} from './searchRecords';

describe('searchRecords list discovery', () => {
  it('prefers explicit root metadata over legacy overflow flags', () => {
    expect(
      isDiscoverableRootList({
        objectID: 'root-wins',
        isRootList: true,
        isMoreSermonsList: true,
      })
    ).toBe(true);

    expect(
      isDiscoverableRootList({
        objectID: 'overflow-wins',
        isRootList: false,
        isMoreSermonsList: false,
      })
    ).toBe(false);
  });

  it('falls back to legacy overflow filtering when explicit root metadata is absent', () => {
    expect(
      isDiscoverableRootList({
        objectID: 'legacy-root',
      })
    ).toBe(true);

    expect(
      isDiscoverableRootList({
        objectID: 'legacy-visible-root',
        isMoreSermonsList: false,
      })
    ).toBe(true);

    expect(
      isDiscoverableRootList({
        objectID: 'legacy-overflow',
        isMoreSermonsList: true,
      })
    ).toBe(false);
  });

  it('uses logicalCount ahead of physical count for discovery totals', () => {
    expect(
      getListDiscoveryCount({
        objectID: 'logical-count',
        count: 3,
        logicalCount: 11,
      })
    ).toBe(11);

    expect(
      normalizeAlgoliaListHit({
        objectID: 'normalized-logical-count',
        id: 'normalized-logical-count',
        name: 'Overflow-aware list',
        count: 4,
        logicalCount: 12,
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
        type: ListType.SERIES,
        createdAtMillis: 10,
      }).logicalCount
    ).toBe(12);
  });

  it('keeps the legacy overflow exclusion in Algolia filters during migration', async () => {
    const search = jest.fn().mockResolvedValue({
      results: [
        {
          hits: [],
          nbHits: 0,
          page: 0,
          nbPages: 0,
          hitsPerPage: 5,
          processingTimeMS: 0,
          query: '',
          params: '',
        },
      ],
    });

    await searchListsIndex(
      {
        search,
      } as unknown as SearchClient,
      {
        query: 'series',
        hitsPerPage: 5,
        page: 0,
        sortProperty: 'name',
        sortOrder: 'asc',
        listType: '',
      }
    );

    expect(search).toHaveBeenCalledWith({
      requests: [
        expect.objectContaining({
          filters: 'NOT isMoreSermonsList:true',
        }),
      ],
    });
  });
});
