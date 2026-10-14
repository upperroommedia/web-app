// Public configuration contains only the application ID. Search credentials
// are short-lived, scoped keys obtained from the authenticated callable.
export const externalSearchDisabled = process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_ENABLED === 'false';
export const browserAlgoliaAppId = externalSearchDisabled ? null : process.env.NEXT_PUBLIC_ALGOLIA_APP_ID || null;
export const browserSearchUnavailableMessage = externalSearchDisabled
  ? 'Search is temporarily unavailable in staging. You can still browse and upload content.'
  : 'Search is not configured. You can still browse and upload content.';
