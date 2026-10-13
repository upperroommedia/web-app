import { algoliasearch, type SearchClient } from 'algoliasearch';

// NEXT_PUBLIC values are compiled into the browser bundle. Staging deliberately
// keeps search off until its own Algolia application is restored.
export const externalSearchDisabled = process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_ENABLED === 'false';
export const browserAlgoliaAppId = externalSearchDisabled ? null : process.env.NEXT_PUBLIC_ALGOLIA_APP_ID || null;
export const browserAlgoliaApiKey = externalSearchDisabled ? null : process.env.NEXT_PUBLIC_ALGOLIA_API_KEY || null;
export const browserSearchUnavailableMessage = externalSearchDisabled
  ? 'Search is temporarily unavailable in staging. You can still browse and upload content.'
  : 'Search is not configured. You can still browse and upload content.';

export function createBrowserSearchClient(): SearchClient | undefined {
  return browserAlgoliaAppId && browserAlgoliaApiKey
    ? algoliasearch(browserAlgoliaAppId, browserAlgoliaApiKey)
    : undefined;
}
