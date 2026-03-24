import { defineSecret } from 'firebase-functions/params';
import { runtimeAlertRecipientsSecret } from './notifications/notificationSecrets';

export const algoliaSearchApiKeySecret = defineSecret('ALGOLIA_SEARCH_API_KEY');
export const algoliaAppIdSecret = defineSecret('ALGOLIA_APP_ID');
export const algoliaSecretsWithRuntimeAlerts = [
  algoliaAppIdSecret,
  algoliaSearchApiKeySecret,
  runtimeAlertRecipientsSecret,
];
