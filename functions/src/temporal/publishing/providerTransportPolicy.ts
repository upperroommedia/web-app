import { isFactualPublishingCleanup } from './durableOperationContext';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { HttpsError } from 'firebase-functions/v2/https';
/** Simulation may exercise private journals, but never authorizes a live vendor write.
 * Staging currently shares production provider identities; isolation requires an
 * authoritative account migration before this transport policy can be widened. */
export function assertProviderMutationTransportAllowed(provider: 'subsplash' | 'soundcloud'): void {
  if (isFactualPublishingCleanup())
    throw new HttpsError('permission-denied', 'Factual cleanup cannot mutate provider resources.', {
      reason: 'PUBLISHING_FACTUAL_CLEANUP_NEW_EFFECT_FORBIDDEN',
    });
  const projectId =
    typeof firebaseAdmin.app === 'function'
      ? firebaseAdmin.app().options.projectId
      : process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId === 'urm-app-staging')
    throw new HttpsError(
      'failed-precondition',
      `Staging ${provider} writes require a verified isolated provider account.`,
      { reason: 'PROVIDER_ACCOUNT_ISOLATION_REQUIRED' }
    );
}
