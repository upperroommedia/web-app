import type { SearchClient, SearchQuery, SearchResponse, SearchForFacetValuesResponse, SearchMethodParams, LegacySearchMethodProps, SearchForFacetValuesProps, SearchResponses } from 'algoliasearch';
import firestore, { collection, query, getDocs, where, orderBy, QueryConstraint } from '../firebase/firestore';
import { sermonConverter } from '../types/Sermon';

interface MockAlgoliaClientOptions {
  userId: string;
  isAdmin: boolean;
}

/**
 * Creates a mock Algolia SearchClient that queries Firestore instead of Algolia.
 * This is used in development mode when the emulator is running.
 * @param options.userId - The current user's ID
 * @param options.isAdmin - Whether the current user is an admin
 */
export function createMockAlgoliaSearchClient(options: MockAlgoliaClientOptions): SearchClient {
  const { userId, isAdmin } = options;
  return {
    search: async <T = Record<string, any>>(
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
          const queryObj = queryRequest as any;
          const getParam = (key: string) => {
            // Try direct property first (SearchParamsObject format)
            if (queryObj[key] !== undefined) return queryObj[key];
            // Fall back to params object if it exists (legacy format)
            if (queryObj.params && typeof queryObj.params === 'object' && queryObj.params[key] !== undefined) {
              return queryObj.params[key];
            }
            return undefined;
          };

          if (queryRequest.indexName !== 'sermons') {
            // For non-sermons indices, return empty results
            return {
              hits: [],
              nbHits: 0,
              page: 0,
              nbPages: 0,
              hitsPerPage: getParam('hitsPerPage') || 20,
              processingTimeMS: 0,
              query: getParam('query') || '',
              params: '',
            } as SearchResponse<T>;
          }

          try {
            const searchQuery = getParam('query') || '';
            const hitsPerPage = getParam('hitsPerPage') || 20;
            const page = getParam('page') || 0;
            const filters = getParam('filters') || '';
            const facetFilters = getParam('facetFilters') || [];

            // Build Firestore query constraints
            const constraints: QueryConstraint[] = [];

            // For non-admin users, filter by uploaderId to show only their own sermons
            if (!isAdmin) {
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
                } else {
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
              facetStats['status.subsplash'][subsplashStatus] = (facetStats['status.subsplash'][subsplashStatus] || 0) + 1;

              // Count status.soundCloud
              const soundCloudStatus = sermon.status?.soundCloud || 'NOT_UPLOADED';
              facetStats['status.soundCloud'][soundCloudStatus] = (facetStats['status.soundCloud'][soundCloudStatus] || 0) + 1;

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
            // eslint-disable-next-line no-console
            console.error('Mock Algolia search error:', error);
            return {
              hits: [],
              nbHits: 0,
              page: 0,
              nbPages: 0,
              hitsPerPage: getParam('hitsPerPage') || 20,
              processingTimeMS: 0,
              query: getParam('query') || '',
              params: '',
            } as SearchResponse<T>;
          }
        })
      );

      return { results };
    },
    searchForFacetValues: async (
      { indexName, facetName, searchForFacetValuesRequest }: SearchForFacetValuesProps
    ): Promise<SearchForFacetValuesResponse> => {
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
        
        // For non-admin users, filter by uploaderId to show only their own sermons
        if (!isAdmin) {
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
        let facetHits = Array.from(facetMap.entries())
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
        // eslint-disable-next-line no-console
        console.error('Mock Algolia searchForFacetValues error:', error);
        return {
          facetHits: [],
          exhaustiveFacetsCount: true,
        } as SearchForFacetValuesResponse;
      }
    },
  } as SearchClient;
}

