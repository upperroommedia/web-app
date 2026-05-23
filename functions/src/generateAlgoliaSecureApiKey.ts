import { algoliasearch } from 'algoliasearch';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { canUserRoleUpload } from '@upperroom/shared/types/User';
import { algoliaSecretsWithRuntimeAlerts } from './algoliaSecrets';
import handleError from './handleError';

export interface GenerateSecuredApiKeyInputType {
  userId: string;
}
export type GenerateSecuredApiKeyOutputType = string;

const generateSecuredApiKey = onCall(
  { secrets: algoliaSecretsWithRuntimeAlerts },
  (request: CallableRequest<GenerateSecuredApiKeyInputType>): GenerateSecuredApiKeyOutputType => {
    try {
      const authenticatedUid = request.auth?.uid;
      if (!authenticatedUid || !canUserRoleUpload(request.auth?.token.role)) {
        throw new HttpsError('permission-denied', 'You are not allowed to generate a restricted Algolia key.');
      }

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
          filters: `uploaderId:${authenticatedUid}`,
          restrictIndices: ['sermons'],
          userToken: authenticatedUid,
        },
      });

      return securedApiKey;
    } catch (error) {
      throw handleError(error, {
        alertCode: 'GENERATE_ALGOLIA_SECURED_KEY_FAILURE',
        summary: 'generateAlgoliaSecureApiKey failed while generating a restricted API key.',
        request,
        context: {
          functionName: 'generateSecuredApiKey',
          userId: request.data.userId,
          hasAlgoliaAppId: Boolean(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID?.trim() || process.env.ALGOLIA_APP_ID?.trim()),
          hasAlgoliaSearchApiKey: Boolean(
            process.env.ALGOLIA_SEARCH_API_KEY?.trim() || process.env.NEXT_PUBLIC_ALGOLIA_API_KEY?.trim()
          ),
        },
      });
    }
  }
);

export default generateSecuredApiKey;
