import { isFactualPublishingCleanup } from './durableOperationContext';
import { getProviderExecutionProfile } from '../../providerSandbox/profile';
import { HttpsError } from 'firebase-functions/v2/https';
/** Factual cleanup never authorizes a write. Staging mutations require the
 * authoritative sandbox profile and are sent only through its isolated facade. */
export function assertProviderMutationTransportAllowed(provider: 'subsplash' | 'soundcloud'): void {
  if (isFactualPublishingCleanup())
    throw new HttpsError('permission-denied', 'Factual cleanup cannot mutate provider resources.', {
      reason: 'PUBLISHING_FACTUAL_CLEANUP_NEW_EFFECT_FORBIDDEN',
    });
  // This validates the real Admin project and exact server-only profile.
  // Sandbox writes are sent exclusively through the fail-closed provider facade.
  getProviderExecutionProfile();
}
