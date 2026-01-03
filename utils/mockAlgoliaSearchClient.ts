import { SearchClient, MultipleQueriesQuery, SearchResponse, SearchForFacetValuesResponse } from 'algoliasearch';
import firestore, { collection, query, getDocs, where, orderBy, limit, QueryConstraint } from '../firebase/firestore';
import { sermonConverter, Sermon } from '../types/Sermon';
import { uploadStatus } from '../types/SermonTypes';

/**
 * Creates a mock Algolia SearchClient that queries Firestore instead of Algolia.
 * This is used in development mode when the emulator is running.
 */
export function createMockAlgoliaSearchClient(): SearchClient {
  return {
    search: async <T = Record<string, any>>(
      queries: readonly MultipleQueriesQuery[]
    ): Promise<{ results: Array<SearchResponse<T>> }> => {
      const results = await Promise.all(
        queries.map(async (queryRequest) => {
          if (queryRequest.indexName !== 'sermons') {
            // For non-sermons indices, return empty results
            return {
              hits: [],
              nbHits: 0,
              page: 0,
              nbPages: 0,
              hitsPerPage: queryRequest.params?.hitsPerPage || 20,
              processingTimeMS: 0,
              query: queryRequest.params?.query || '',
              params: '',
            } as SearchResponse<T>;
          }

          try {
            const searchQuery = queryRequest.params?.query || '';
            const hitsPerPage = queryRequest.params?.hitsPerPage || 20;
            const page = queryRequest.params?.page || 0;
            const filters = queryRequest.params?.filters || '';
            const facetFilters = queryRequest.params?.facetFilters || [];

            // Build Firestore query constraints
            const constraints: QueryConstraint[] = [];

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
              hitsPerPage: queryRequest.params?.hitsPerPage || 20,
              processingTimeMS: 0,
              query: queryRequest.params?.query || '',
              params: '',
            } as SearchResponse<T>;
          }
        })
      );

      return { results };
    },
    searchForFacetValues: async (
      requests: Array<{
        indexName: string;
        params: {
          facetName: string;
          facetQuery?: string;
          maxFacetHits?: number;
        };
      }>
    ): Promise<Array<SearchForFacetValuesResponse>> => {
      return Promise.all(
        requests.map(async (request) => {
          if (request.indexName !== 'sermons') {
            return {
              facetHits: [],
            } as SearchForFacetValuesResponse;
          }

          try {
            const { facetName, facetQuery = '', maxFacetHits = 10 } = request.params;

            // Get all sermons to calculate facets
            const sermonsRef = collection(firestore, 'sermons');
            const sermonsQuery = query(sermonsRef.withConverter(sermonConverter), orderBy('createdAtMillis', 'desc'));
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
            } as SearchForFacetValuesResponse;
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error('Mock Algolia searchForFacetValues error:', error);
            return {
              facetHits: [],
            } as SearchForFacetValuesResponse;
          }
        })
      );
    },
  } as SearchClient;
}

