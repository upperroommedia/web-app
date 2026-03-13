import { algoliasearch } from 'algoliasearch';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import { algoliaSearchApiKeySecret } from './algoliaSecrets';
import handleError from './handleError';

export interface GenerateSecuredApiKeyInputType {
  userId: string;
}
export type GenerateSecuredApiKeyOutputType = string;

const generateSecuredApiKey = onCall(
  { secrets: [algoliaSearchApiKeySecret] },
  (request: CallableRequest<GenerateSecuredApiKeyInputType>): GenerateSecuredApiKeyOutputType => {
    try {
      // Algolia secure API keys are derived from the parent key + restrictions.
      // App ID is not part of the signature, so we fall back to a placeholder when
      // runtime env does not provide one.
      const appId = process.env.NEXT_PUBLIC_ALGOLIA_APP_ID?.trim() || process.env.ALGOLIA_APP_ID?.trim() || 'ALGOLIA';
      const apiKey = process.env.ALGOLIA_SEARCH_API_KEY?.trim() || process.env.NEXT_PUBLIC_ALGOLIA_API_KEY?.trim();
      if (!apiKey) {
        throw new Error('Missing Algolia Search API Key');
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
    } catch (error) {
      throw handleError(error, {
        alertCode: 'GENERATE_ALGOLIA_SECURED_KEY_FAILURE',
        summary: 'generateAlgoliaSecureApiKey failed while generating a restricted API key.',
        context: {
          functionName: 'generateSecuredApiKey',
          userId: request.data.userId,
        },
      });
    }
  }
);

export default generateSecuredApiKey;
