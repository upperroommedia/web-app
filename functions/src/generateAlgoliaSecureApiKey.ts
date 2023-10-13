import algoliasearch from 'algoliasearch';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
export interface GenerateSecuredApiKeyInputType {
  userId: string;
}
export type GenerateSecuredApiKeyOutputType = string;

const generateSecuredApiKey = onCall(
  (request: CallableRequest<GenerateSecuredApiKeyInputType>): GenerateSecuredApiKeyOutputType => {
    if (!process.env.NEXT_PUBLIC_ALGOLIA_APP_ID || !process.env.NEXT_PUBLIC_ALGOLIA_API_KEY) {
      throw new Error('Missing Algolia Credentials');
    }
    const client = algoliasearch(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID, process.env.NEXT_PUBLIC_ALGOLIA_API_KEY);
    const securedApiKey = client.generateSecuredApiKey(process.env.NEXT_PUBLIC_ALGOLIA_API_KEY, {
      filters: `uploaderId:${request.data.userId}`,
    });

    console.log(securedApiKey);

    return securedApiKey;
  }
);

export default generateSecuredApiKey;
