import { defineSecret } from 'firebase-functions/params';
import { runtimeAlertRecipientsSecret } from './notifications/notificationSecrets';

export const algoliaSearchApiKeySecret = defineSecret('ALGOLIA_SEARCH_API_KEY');
export const algoliaSecretsWithRuntimeAlerts = [algoliaSearchApiKeySecret, runtimeAlertRecipientsSecret];
