import { algoliasearch } from 'algoliasearch';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import { algoliaSearchApiKeySecret } from './algoliaSecrets';

export interface GenerateSecuredApiKeyInputType {
  userId: string;
}
export type GenerateSecuredApiKeyOutputType = string;

const generateSecuredApiKey = onCall(
  { secrets: [algoliaSearchApiKeySecret] },
  (request: CallableRequest<GenerateSecuredApiKeyInputType>): GenerateSecuredApiKeyOutputType => {
    const appId = process.env.NEXT_PUBLIC_ALGOLIA_APP_ID?.trim();
    const apiKey = process.env.ALGOLIA_SEARCH_API_KEY?.trim() || process.env.NEXT_PUBLIC_ALGOLIA_API_KEY?.trim();
    if (!appId || !apiKey) {
      throw new Error('Missing Algolia Credentials');
    }

    const client = algoliasearch(appId, apiKey);

    const securedApiKey = client.generateSecuredApiKey({
      parentApiKey: apiKey,
      restrictions: {
        filters: `uploaderId:${request.data.userId}`,
      },
    });

    console.log(securedApiKey);

    return securedApiKey;
  }
);

export default generateSecuredApiKey;
