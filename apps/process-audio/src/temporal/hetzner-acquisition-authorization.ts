import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { MediaJobRef } from './types';
import { inspectNativeYouTubeProcess } from './hetzner-acquisition-identity';
import { createYouTubeAcquisitionHostStore, type AcquisitionHostProcess } from './hetzner-acquisition-store';
import { readEligibleYouTubeAcquisition } from './hetzner-acquisition-policy';

/** Concrete durable authorization for the inert helper's native PID. The caller
 * must already have reserved shared-host resources before forking, and must bind
 * verifiedCallerEmail to independently verified OIDC, never request JSON.
 * Unknown claim acknowledgement remains fenced; this does not retry/reset it.
 */
export function createNativeYouTubeAuthorization(options: {
  firestore: Firestore;
  auth: Auth;
  ref: MediaJobRef;
  buildId: string;
  verifiedCallerEmail: string;
}): (processId: number, signal: AbortSignal) => Promise<boolean> {
  const ref = Object.freeze({ ...options.ref });
  return async (processId, signal) => {
    signal.throwIfAborted();
    const owner = await inspectNativeYouTubeProcess(processId, options.buildId);
    signal.throwIfAborted();
    const store = createCanonicalYouTubeHostStore({ firestore: options.firestore, auth: options.auth, owner, signal });
    const result = await store.claim(ref, options.verifiedCallerEmail);
    signal.throwIfAborted();
    return result.launch;
  };
}

/** Actual canonical/readiness guard shared by parent authorization and the
 * isolated helper. A source-available receipt is checked separately from
 * permission to acquire new bytes; it never grants another upload attempt.
 */
export function createCanonicalYouTubeHostStore(options: {
  firestore: Firestore;
  auth: Auth;
  owner: AcquisitionHostProcess;
  signal?: AbortSignal;
}): ReturnType<typeof createYouTubeAcquisitionHostStore> {
  const owner = Object.freeze({ ...options.owner });
  return createYouTubeAcquisitionHostStore({
    firestore: options.firestore,
    projectId: 'urm-app-staging',
    owner,
    assertEligible: async (transaction, ref, purpose) => {
      options.signal?.throwIfAborted();
      const actual = await inspectNativeYouTubeProcess(owner.processId, owner.buildId);
      if (Object.keys(owner).some((key) => owner[key as keyof typeof owner] !== actual[key as keyof typeof actual]))
        throw new Error('YOUTUBE_NATIVE_IDENTITY_UNCONFIRMED');
      const result = await readEligibleYouTubeAcquisition({
        firestore: options.firestore,
        auth: options.auth,
        transaction,
        ref,
      });
      options.signal?.throwIfAborted();
      if (result.kind !== (purpose === 'source_available' ? 'source_available' : 'ready'))
        throw new Error('YOUTUBE_ACQUISITION_INELIGIBLE');
    },
  });
}
