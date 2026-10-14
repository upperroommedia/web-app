import { algoliasearch } from 'algoliasearch';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { canUserRoleUpload } from '@upperroom/shared/types/User';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { algoliaSecretsWithRuntimeAlerts } from './algoliaSecrets';
import handleError from './handleError';
import {
  STAGING_SEARCH_PROJECT_ID,
  STAGING_SEARCH_APPLICATION_ID,
  STAGING_SEARCH_READINESS_PATH,
  validateStagingSearchReadiness,
} from '@upperroom/contracts/stagingSearchReadiness';

import type {
  GenerateSecuredApiKeyInputType,
  GenerateSecuredApiKeyOutputType,
} from '@upperroom/contracts/generateAlgoliaSecureApiKey';
export type {
  GenerateSecuredApiKeyInputType,
  GenerateSecuredApiKeyOutputType,
} from '@upperroom/contracts/generateAlgoliaSecureApiKey';

export const SHARED_SEARCH_INDICES = [
  'speakers',
  'speakers_sort_name_asc',
  'speakers_sort_name_desc',
  'speakers_sort_sermonCount_asc',
  'speakers_sort_sermonCount_desc',
  'lists',
  'lists_sort_name_asc',
  'lists_sort_name_desc',
  'images',
];

const generateSecuredApiKey = onCall(
  { secrets: algoliaSecretsWithRuntimeAlerts },
  async (request: CallableRequest<GenerateSecuredApiKeyInputType>): Promise<GenerateSecuredApiKeyOutputType> => {
    try {
      const authenticatedUid = request.auth?.uid;
      if (!authenticatedUid) {
        throw new HttpsError('permission-denied', 'You are not allowed to generate a restricted Algolia key.');
      }

      // Claims in an otherwise valid ID token can outlive a role change. Read
      // the current account before issuing new credentials, and honor revocation.
      const account = await firebaseAdmin.auth().getUser(authenticatedUid);
      const currentRole = account.customClaims?.role;
      if (account.disabled || !canUserRoleUpload(currentRole)) {
        throw new HttpsError('permission-denied', 'You are not allowed to generate a restricted Algolia key.');
      }
      const authenticatedAt = request.auth?.token.auth_time;
      const validAfter = account.tokensValidAfterTime ? Date.parse(account.tokensValidAfterTime) / 1000 : 0;
      if (
        typeof authenticatedAt !== 'number' ||
        !Number.isFinite(authenticatedAt) ||
        !Number.isFinite(validAfter) ||
        authenticatedAt < validAfter
      ) {
        throw new HttpsError('unauthenticated', 'Your session has been revoked. Please sign in again.');
      }

      const isStaging = firebaseAdmin.app().options.projectId === STAGING_SEARCH_PROJECT_ID;
      if (isStaging) {
        try {
          const firestore = firebaseAdmin.firestore();
          await firestore.runTransaction(
            async (transaction) => {
              const [control, marker] = await transaction.getAll(
                firestore.doc('_control/temporalRelease'),
                firestore.doc(STAGING_SEARCH_READINESS_PATH)
              );
              validateStagingSearchReadiness(control.data(), marker.data());
            },
            { readOnly: true }
          );
        } catch {
          throw new HttpsError('unavailable', 'Search is not ready in staging. Please try again later.');
        }
      }

      // Algolia secure API keys are derived from the parent key + restrictions.
      // App ID is not part of the signature, so we fall back to a placeholder when
      // runtime env does not provide one.
      const appId = isStaging
        ? STAGING_SEARCH_APPLICATION_ID
        : process.env.NEXT_PUBLIC_ALGOLIA_APP_ID?.trim() || process.env.ALGOLIA_APP_ID?.trim() || 'ALGOLIA';
      const apiKey = process.env.ALGOLIA_SEARCH_API_KEY?.trim();
      if (!apiKey) {
        throw new Error('Missing Algolia Search API Key');
      }

      const client = algoliasearch(appId, apiKey);

      const validUntil = Math.floor(Date.now() / 1000) + 5 * 60;
      const sermonIndices = ['sermons'];
      const apiKeyForSermons = client.generateSecuredApiKey({
        parentApiKey: apiKey,
        restrictions: {
          ...(currentRole === 'admin' ? {} : { filters: `uploaderId:${JSON.stringify(authenticatedUid)}` }),
          restrictIndices: sermonIndices,
          userToken: authenticatedUid,
          validUntil,
        },
      });
      const sharedApiKey = client.generateSecuredApiKey({
        parentApiKey: apiKey,
        restrictions: { restrictIndices: SHARED_SEARCH_INDICES, userToken: authenticatedUid, validUntil },
      });
      return {
        apiKey: apiKeyForSermons,
        sharedApiKey,
        expiresAt: validUntil * 1000,
        sermonIndices,
        sharedIndices: [...SHARED_SEARCH_INDICES],
      };
    } catch (error) {
      throw handleError(error, {
        alertCode: 'GENERATE_ALGOLIA_SECURED_KEY_FAILURE',
        summary: 'generateAlgoliaSecureApiKey failed while generating a restricted API key.',
        request,
        context: {
          functionName: 'generateSecuredApiKey',
          userId: request.auth?.uid,
          hasAlgoliaAppId: Boolean(
            process.env.NEXT_PUBLIC_ALGOLIA_APP_ID?.trim() || process.env.ALGOLIA_APP_ID?.trim()
          ),
          hasAlgoliaSearchApiKey: Boolean(process.env.ALGOLIA_SEARCH_API_KEY?.trim()),
        },
      });
    }
  }
);

export default generateSecuredApiKey;
