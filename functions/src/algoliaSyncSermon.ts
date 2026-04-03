import { algoliasearch } from 'algoliasearch';
import { logger } from 'firebase-functions/v2';

type SermonAlgoliaRecord = {
  objectID: string;
  editedAtMillis?: number;
};

const ALGOLIA_SERMON_INDEX = 'sermons';
const ALGOLIA_SYNC_ATTEMPTS = 8;
const ALGOLIA_SYNC_DELAY_MS = 1500;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isNotFoundError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const status = 'status' in error ? error.status : undefined;
  return status === 404;
};

const getAlgoliaClient = () => {
  const appId = process.env.ALGOLIA_APP_ID?.trim() || process.env.NEXT_PUBLIC_ALGOLIA_APP_ID?.trim();
  const apiKey = process.env.ALGOLIA_SEARCH_API_KEY?.trim() || process.env.NEXT_PUBLIC_ALGOLIA_API_KEY?.trim();

  if (!appId || !apiKey) {
    return null;
  }

  return algoliasearch(appId, apiKey);
};

export const waitForSermonToReachAlgolia = async ({
  sermonId,
  editedAtMillis,
}: {
  sermonId: string;
  editedAtMillis: number;
}): Promise<boolean> => {
  const client = getAlgoliaClient();

  if (!client) {
    logger.warn('Skipping Algolia sermon sync acknowledgement because Algolia credentials are unavailable.', {
      sermonId,
    });
    return false;
  }

  for (let attempt = 1; attempt <= ALGOLIA_SYNC_ATTEMPTS; attempt += 1) {
    try {
      const record = (await client.getObject({
        indexName: ALGOLIA_SERMON_INDEX,
        objectID: sermonId,
      })) as SermonAlgoliaRecord;

      if (record.editedAtMillis === editedAtMillis) {
        return true;
      }

      logger.info('Algolia sermon record is still stale.', {
        sermonId,
        attempt,
        expectedEditedAtMillis: editedAtMillis,
        indexedEditedAtMillis: record.editedAtMillis ?? null,
      });
    } catch (error) {
      if (!isNotFoundError(error)) {
        logger.warn('Failed to read sermon record from Algolia while waiting for index sync.', {
          sermonId,
          attempt,
          error,
        });
      }
    }

    if (attempt < ALGOLIA_SYNC_ATTEMPTS) {
      await sleep(ALGOLIA_SYNC_DELAY_MS);
    }
  }

  return false;
};
