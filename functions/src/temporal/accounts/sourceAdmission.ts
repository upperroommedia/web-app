import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { isDomainTemporalEnabled } from '../ownership';

/** Old browsers cannot start grants without the new facade's stable intent ID. */
export async function assertLegacyAccountSourceAllowed(firestore: Firestore): Promise<void> {
  if (isDomainTemporalEnabled('accounts')) {
    throw new HttpsError(
      'failed-precondition',
      'This operation moved to the durable task service. Refresh the application before starting new work.'
    );
  }
  // The release control is authoritative even when an older backend revision
  // still has a legacy environment flag. Missing control preserves old installs.
  await (await import('../releaseControl')).assertLegacyAdmissionAllowed(firestore, 'accounts');
}

import type { LegacyAdmissionLease } from '../legacyAdmissionLease';
import { getFirebaseProjectId } from '@upperroom/shared/shared/firebaseProjectConfig';

class LegacyAccountResultError extends Error {
  readonly code = 'LEGACY_ACCOUNT_EFFECT_REQUIRES_REVIEW';
}
/** Registered legacy invocations remain visible until confirmed completion. */
export async function withLegacyAccountSource<T>(
  firestore: Firestore,
  actorUid: string,
  operation: string,
  callback: (lease: LegacyAdmissionLease) => Promise<T>
): Promise<T> {
  if (isDomainTemporalEnabled('accounts')) await assertLegacyAccountSourceAllowed(firestore);
  const { withLegacyAdmissionLease } = await import('../legacyAdmissionLease');
  let failedResult: T | undefined;
  try {
    return await withLegacyAdmissionLease(
      firestore,
      { domain: 'accounts', actorUid, operation, projectId: getFirebaseProjectId() },
      async (lease) => {
        const result = await callback(lease);
        // Legacy handlers sometimes return an error after an external effect instead
        // of throwing. Retain the uncertain lease while preserving their API shape.
        if (result && typeof result === 'object' && 'status' in result && result.status === 'error') {
          failedResult = result;
          throw new LegacyAccountResultError('Legacy account operation needs review.');
        }
        return result;
      }
    );
  } catch (error) {
    if (error instanceof LegacyAccountResultError && failedResult) return failedResult;
    throw error;
  }
}
