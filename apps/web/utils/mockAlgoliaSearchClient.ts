import type {
  SearchClient,
  SearchQuery,
  SearchResponse,
  SearchForFacetValuesResponse,
  SearchMethodParams,
  LegacySearchMethodProps,
  SearchForFacetValuesProps,
  SearchResponses,
} from 'algoliasearch';
import firestore, { collection, query, getDocs, where, orderBy, QueryConstraint } from '../firebase/firestore';
import { listConverter } from '../types/List';
import { sermonConverter } from '../types/Sermon';
import { speakerConverter } from '../types/Speaker';
import { resolveListSortFromIndexName } from './algolia/listSorting';
import { resolveSpeakerSortFromIndexName } from './algolia/speakerSorting';

interface MockAlgoliaClientOptions {
  userId: string;
  canSearchAllSermons: boolean;
}

type QueryRequestParamContainer = Record<string, unknown> & {
  params?: Record<string, unknown> | string;
};

/**
 * Creates a mock Algolia SearchClient that queries Firestore instead of Algolia.
 * This is used in development mode when the emulator is running.
 * @param options.userId - The current user's ID
 * @param options.canSearchAllSermons - Whether the current user can search across all sermons
 */
export function createMockAlgoliaSearchClient(options: MockAlgoliaClientOptions): SearchClient {
  const { userId, canSearchAllSermons } = options;
  return {
    search: async <T = Record<string, unknown>>(
      searchMethodParams: SearchMethodParams | LegacySearchMethodProps
    ): Promise<SearchResponses<T>> => {
      // Handle both SearchMethodParams (has requests array) and LegacySearchMethodProps (is array of queries)
      const queries: readonly SearchQuery[] = Array.isArray(searchMethodParams)
        ? searchMethodParams
        : searchMethodParams.requests;

      const results = await Promise.all(
        queries.map(async (queryRequest) => {
          // In algoliasearch v5, SearchQuery properties are directly on the object
          // Handle both SearchParamsObject (direct properties) and SearchParamsString (params string) formats
          const queryObj = queryRequest as unknown as QueryRequestParamContainer;
          const getParam = (key: string): unknown => {
            // Try direct property first (SearchParamsObject format)
            if (queryObj[key] !== undefined) return queryObj[key];
            // Fall back to params object if it exists (legacy format)
            if (
              queryObj.params &&
              typeof queryObj.params === 'object' &&
              !Array.isArray(queryObj.params) &&
              queryObj.params[key] !== undefined
            ) {
              return queryObj.params[key];
            }
            return undefined;
          };
          const getStringParam = (key: string, fallback = ''): string => {
            const value = getParam(key);
            if (typeof value === 'string') return value;
            if (value === undefined || value === null) return fallback;
            return String(value);
          };
          const getNumberParam = (key: string, fallback: number): number => {
            const value = getParam(key);
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (typeof value === 'string' && value.trim() !== '') {
              const parsed = Number(value);
              if (Number.isFinite(parsed)) return parsed;
            }
            return fallback;
          };

          try {
            if (queryRequest.indexName?.startsWith('speakers')) {
              const searchQuery = getStringParam('query');
              const hitsPerPage = getNumberParam('hitsPerPage', 20);
              const page = getNumberParam('page', 0);
              const { sortProperty, sortOrder } = resolveSpeakerSortFromIndexName(queryRequest.indexName);

              const speakersRef = collection(firestore, 'speakers');
              const speakersQuery = query(
                speakersRef.withConverter(speakerConverter),
                orderBy(sortProperty, sortOrder)
              );
              const speakersSnapshot = await getDocs(speakersQuery);
              let allSpeakers = speakersSnapshot.docs.map((doc) => doc.data());

              if (searchQuery) {
                const queryLower = searchQuery.toLowerCase();
                allSpeakers = allSpeakers.filter((speaker) => speaker.name?.toLowerCase().includes(queryLower));
              }

              const totalHits = allSpeakers.length;
              const totalPages = Math.ceil(totalHits / hitsPerPage);
              const startIndex = page * hitsPerPage;
              const endIndex = startIndex + hitsPerPage;
              const paginatedSpeakers = allSpeakers.slice(startIndex, endIndex);
              const hits = paginatedSpeakers.map((speaker) => ({
                ...speaker,
                objectID: speaker.id,
              })) as T[];

              return {
                hits,
                nbHits: totalHits,
                page,
                nbPages: totalPages,
                hitsPerPage,
                processingTimeMS: 0,
                query: searchQuery,
                params: '',
                exhaustiveNbHits: true,
              } as SearchResponse<T>;
            }

            if (queryRequest.indexName?.startsWith('lists')) {
              const searchQuery = getStringParam('query');
              const hitsPerPage = getNumberParam('hitsPerPage', 20);
              const page = getNumberParam('page', 0);
              const facetFiltersRaw = getParam('facetFilters');
              const facetFilters = Array.isArray(facetFiltersRaw) ? facetFiltersRaw.flat() : [];
              const listTypeFilter =
                facetFilters
                  .find((filter): filter is string => typeof filter === 'string' && filter.startsWith('type:'))
                  ?.split(':')[1] ?? '';
              const { sortProperty, sortOrder } = resolveListSortFromIndexName(queryRequest.indexName);

              const listsRef = collection(firestore, 'lists');
              const listsQuery = query(listsRef.withConverter(listConverter), orderBy('name'));
              const listsSnapshot = await getDocs(listsQuery);
              let allLists = listsSnapshot.docs
                .map((doc) => doc.data())
                .filter((list) => list.isMoreSermonsList !== true);

              if (listTypeFilter) {
                allLists = allLists.filter((list) => list.type === listTypeFilter);
              }

              if (searchQuery) {
                const queryLower = searchQuery.toLowerCase();
                allLists = allLists.filter((list) => list.name?.toLowerCase().includes(queryLower));
              }

              allLists = [...allLists].sort((leftList, rightList) => {
                const leftValue = leftList[sortProperty];
                const rightValue = rightList[sortProperty];

                if (typeof leftValue === 'number' && typeof rightValue === 'number') {
                  return sortOrder === 'asc' ? leftValue - rightValue : rightValue - leftValue;
                }

                const normalizedLeft = String(leftValue ?? '').toLowerCase();
                const normalizedRight = String(rightValue ?? '').toLowerCase();
                const comparison = normalizedLeft.localeCompare(normalizedRight);
                return sortOrder === 'asc' ? comparison : -comparison;
              });

              const totalHits = allLists.length;
              const totalPages = Math.ceil(totalHits / hitsPerPage);
              const startIndex = page * hitsPerPage;
              const endIndex = startIndex + hitsPerPage;
              const paginatedLists = allLists.slice(startIndex, endIndex);
              const hits = paginatedLists.map((list) => ({
                ...list,
                objectID: list.id,
              })) as T[];

              return {
                hits,
                nbHits: totalHits,
                page,
                nbPages: totalPages,
                hitsPerPage,
                processingTimeMS: 0,
                query: searchQuery,
                params: '',
                exhaustiveNbHits: true,
              } as SearchResponse<T>;
            }

            if (queryRequest.indexName !== 'sermons') {
              return {
                hits: [],
                nbHits: 0,
                page: 0,
                nbPages: 0,
                hitsPerPage: getNumberParam('hitsPerPage', 20),
                processingTimeMS: 0,
                query: getStringParam('query'),
                params: '',
              } as SearchResponse<T>;
            }

            const searchQuery = getStringParam('query');
            const hitsPerPage = getNumberParam('hitsPerPage', 20);
            const page = getNumberParam('page', 0);
            const filters = getStringParam('filters');
            const facetFiltersRaw = getParam('facetFilters');
            const facetFilters = Array.isArray(facetFiltersRaw) ? facetFiltersRaw : [];

            // Build Firestore query constraints
            const constraints: QueryConstraint[] = [];

            // Uploaders are restricted to their own sermons. Admins and publishers can search all sermons.
            if (!canSearchAllSermons) {
              constraints.push(where('uploaderId', '==', userId));
            }

            // Apply filters
            if (filters) {
              // Parse filters like "status.subsplash:UPLOADED" or "status.soundCloud:NOT_UPLOADED"
              const filterParts = filters.split(' AND ');
              for (const filterPart of filterParts) {
                const [field, value] = filterPart.split(':');
                if (field === 'status.subsplash') {
                  constraints.push(where('status.subsplash', '==', value));
                } else if (field === 'status.soundCloud') {
                  constraints.push(where('status.soundCloud', '==', value));
                }
              }
            }

            // Track speaker filters to apply in memory (Firestore can't query nested object arrays easily)
            const speakerFilters: string[] = [];

            // Apply facet filters (array of arrays)
            if (Array.isArray(facetFilters) && facetFilters.length > 0) {
              for (const facetFilterGroup of facetFilters) {
                if (Array.isArray(facetFilterGroup)) {
                  for (const filter of facetFilterGroup) {
                    if (typeof filter !== 'string') continue;
                    const [field, value] = filter.split(':');
                    if (field === 'status.subsplash') {
                      constraints.push(where('status.subsplash', '==', value));
                    } else if (field === 'status.soundCloud') {
                      constraints.push(where('status.soundCloud', '==', value));
                    } else if (field === 'speakers.name') {
                      // Speaker name filtering will be done in memory
                      speakerFilters.push(value);
                    }
                  }
                } else if (typeof facetFilterGroup === 'string') {
                  const [field, value] = facetFilterGroup.split(':');
                  if (field === 'status.subsplash') {
                    constraints.push(where('status.subsplash', '==', value));
                  } else if (field === 'status.soundCloud') {
                    constraints.push(where('status.soundCloud', '==', value));
                  }
                }
              }
            }

            // Order by creation date (most recent first)
            constraints.push(orderBy('createdAtMillis', 'desc'));

            // Get all sermons first (we'll filter and paginate in memory)
            const sermonsRef = collection(firestore, 'sermons');
            const baseQuery = query(sermonsRef.withConverter(sermonConverter), ...constraints);
            const allSermonsSnapshot = await getDocs(baseQuery);
            let allSermons = allSermonsSnapshot.docs.map((doc) => doc.data());

            // Apply text search if query is provided
            if (searchQuery) {
              const queryLower = searchQuery.toLowerCase();
              allSermons = allSermons.filter((sermon) => {
                return (
                  sermon.title?.toLowerCase().includes(queryLower) ||
                  sermon.subtitle?.toLowerCase().includes(queryLower) ||
                  sermon.description?.toLowerCase().includes(queryLower) ||
                  sermon.speakers?.some((speaker) => speaker.name?.toLowerCase().includes(queryLower)) ||
                  sermon.topics?.some((topic) => topic?.toLowerCase().includes(queryLower))
                );
              });
            }

            // Apply speaker name filters (done in memory since Firestore can't easily query nested arrays)
            if (speakerFilters.length > 0) {
              allSermons = allSermons.filter((sermon) =>
                sermon.speakers?.some((speaker) => speakerFilters.includes(speaker.name))
              );
            }

            // Calculate facet stats from filtered results
            const facetStats: Record<string, Record<string, number>> = {
              'status.subsplash': {},
              'status.soundCloud': {},
              'speakers.name': {},
            };

            allSermons.forEach((sermon) => {
              // Count status.subsplash
              const subsplashStatus = sermon.status?.subsplash || 'NOT_UPLOADED';
              facetStats['status.subsplash'][subsplashStatus] =
                (facetStats['status.subsplash'][subsplashStatus] || 0) + 1;

              // Count status.soundCloud
              const soundCloudStatus = sermon.status?.soundCloud || 'NOT_UPLOADED';
              facetStats['status.soundCloud'][soundCloudStatus] =
                (facetStats['status.soundCloud'][soundCloudStatus] || 0) + 1;

              // Count speakers.name
              sermon.speakers?.forEach((speaker) => {
                if (speaker.name) {
                  facetStats['speakers.name'][speaker.name] = (facetStats['speakers.name'][speaker.name] || 0) + 1;
                }
              });
            });

            // Calculate pagination
            const totalHits = allSermons.length;
            const totalPages = Math.ceil(totalHits / hitsPerPage);
            const startIndex = page * hitsPerPage;
            const endIndex = startIndex + hitsPerPage;
            const paginatedSermons = allSermons.slice(startIndex, endIndex);

            // Convert sermons to Algolia hit format (with objectID)
            const hits = paginatedSermons.map((sermon) => ({
              ...sermon,
              objectID: sermon.id,
            })) as T[];

            return {
              hits,
              nbHits: totalHits,
              page,
              nbPages: totalPages,
              hitsPerPage,
              processingTimeMS: 0,
              query: searchQuery,
              params: '',
              exhaustiveNbHits: true,
              facets: facetStats,
            } as SearchResponse<T>;
          } catch (error) {
            console.error('Mock Algolia search error:', error);
            return {
              hits: [],
              nbHits: 0,
              page: 0,
              nbPages: 0,
              hitsPerPage: getNumberParam('hitsPerPage', 20),
              processingTimeMS: 0,
              query: getStringParam('query'),
              params: '',
            } as SearchResponse<T>;
          }
        })
      );

      return { results };
    },
    searchForFacetValues: async ({
      indexName,
      facetName,
      searchForFacetValuesRequest,
    }: SearchForFacetValuesProps): Promise<SearchForFacetValuesResponse> => {
      if (indexName !== 'sermons') {
        return {
          facetHits: [],
          exhaustiveFacetsCount: true,
        } as SearchForFacetValuesResponse;
      }

      try {
        const facetQuery = searchForFacetValuesRequest?.facetQuery || '';
        const maxFacetHits = searchForFacetValuesRequest?.maxFacetHits || 10;

        // Build query constraints for facet values
        const facetConstraints: QueryConstraint[] = [];

        // Uploaders are restricted to their own sermons. Admins and publishers can search all sermons.
        if (!canSearchAllSermons) {
          facetConstraints.push(where('uploaderId', '==', userId));
        }
        facetConstraints.push(orderBy('createdAtMillis', 'desc'));

        // Get sermons to calculate facets
        const sermonsRef = collection(firestore, 'sermons');
        const sermonsQuery = query(sermonsRef.withConverter(sermonConverter), ...facetConstraints);
        const sermonsSnapshot = await getDocs(sermonsQuery);
        const allSermons = sermonsSnapshot.docs.map((doc) => doc.data());

        // Calculate facet values based on attribute
        const facetMap = new Map<string, number>();

        if (facetName === 'status.subsplash') {
          allSermons.forEach((sermon) => {
            const value = sermon.status?.subsplash || 'NOT_UPLOADED';
            facetMap.set(value, (facetMap.get(value) || 0) + 1);
          });
        } else if (facetName === 'status.soundCloud') {
          allSermons.forEach((sermon) => {
            const value = sermon.status?.soundCloud || 'NOT_UPLOADED';
            facetMap.set(value, (facetMap.get(value) || 0) + 1);
          });
        } else if (facetName === 'speakers.name') {
          // For speakers, we need to extract all unique speaker names
          allSermons.forEach((sermon) => {
            sermon.speakers?.forEach((speaker) => {
              if (speaker.name) {
                facetMap.set(speaker.name, (facetMap.get(speaker.name) || 0) + 1);
              }
            });
          });
        }

        // Filter by facetQuery if provided
        const facetHits = Array.from(facetMap.entries())
          .map(([value, count]) => ({
            value,
            highlighted: value,
            count,
          }))
          .filter((hit) => {
            if (!facetQuery) return true;
            return hit.value.toLowerCase().includes(facetQuery.toLowerCase());
          })
          .sort((a, b) => b.count - a.count) // Sort by count descending
          .slice(0, maxFacetHits);

        return {
          facetHits,
          exhaustiveFacetsCount: true,
        } as SearchForFacetValuesResponse;
      } catch (error) {
        console.error('Mock Algolia searchForFacetValues error:', error);
        return {
          facetHits: [],
          exhaustiveFacetsCount: true,
        } as SearchForFacetValuesResponse;
      }
    },
  } as SearchClient;
}
