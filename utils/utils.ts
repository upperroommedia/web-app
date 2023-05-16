import { createInMemoryCache } from '@algolia/cache-in-memory';
import algoliasearch from 'algoliasearch';
import { Sermon } from '../types/SermonTypes';
import { AlgoliaSpeaker } from '../types/Speaker';

export function getSquareImageStoragePath(sermon: Sermon) {
  const encodedPath = sermon.images
    .find((image) => image.type === 'square')
    ?.downloadLink.split('/')
    .pop();
  const imageStoragePath = encodedPath ? decodeURIComponent(encodedPath) : undefined;
  return imageStoragePath;
}

const client =
  process.env.NEXT_PUBLIC_ALGOLIA_APP_ID && process.env.NEXT_PUBLIC_ALGOLIA_API_KEY
    ? algoliasearch(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID, process.env.NEXT_PUBLIC_ALGOLIA_API_KEY, {
        responsesCache: createInMemoryCache(),
        requestsCache: createInMemoryCache({ serializable: false }),
      })
    : undefined;

const speakersIndex = client?.initIndex('speakers');

export async function fetchSpeakerResults(query: string, hitsPerPage: number, page: number) {
  const speakers: AlgoliaSpeaker[] = [];
  if (speakersIndex) {
    const response = await speakersIndex.search<AlgoliaSpeaker>(query, {
      hitsPerPage,
      page,
    });
    response.hits.forEach((hit) => {
      speakers.push(hit);
    });
  }
  return speakers;
}
