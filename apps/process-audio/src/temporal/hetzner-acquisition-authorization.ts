import type { HostResourceReply } from '../host/resources';
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
  episodeId?: string;
  assertFresh?: () => void;
  /** Private parent observer; inspection alone grants no execution authority. */
  onInspected?: (owner: Readonly<AcquisitionHostProcess>, startedAt: number) => void;
}): (processId: number, signal: AbortSignal) => Promise<boolean> {
  const ref = Object.freeze({ ...options.ref });
  return async (processId, signal) => {
    signal.throwIfAborted();
    options.assertFresh?.();
    const owner = await inspectNativeYouTubeProcess(processId, options.buildId);
    const startedAt = Date.now();
    options.onInspected?.(Object.freeze({ ...owner }), startedAt);
    signal.throwIfAborted();
    options.assertFresh?.();
    const store = createCanonicalYouTubeHostStore({
      firestore: options.firestore,
      auth: options.auth,
      owner,
      signal,
      episodeId: options.episodeId,
      assertFresh: options.assertFresh,
    });
    const result = await store.claim(ref, options.verifiedCallerEmail, startedAt);
    signal.throwIfAborted();
    options.assertFresh?.();
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
  episodeId?: string;
  assertFresh?: () => void;
  nativeEnrollment?: HostResourceReply;
}): ReturnType<typeof createYouTubeAcquisitionHostStore> {
  const owner = Object.freeze({ ...options.owner });
  return createYouTubeAcquisitionHostStore({
    firestore: options.firestore,
    projectId: 'urm-app-staging',
    owner,
    episodeId: options.episodeId,
    nativeEnrollment: options.nativeEnrollment,
    assertEligible: async (transaction, ref, purpose) => {
      await boundedNativeEligibility(async () => {
        options.signal?.throwIfAborted();
        options.assertFresh?.();
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
        options.assertFresh?.();
        if (result.kind !== (purpose === 'source_available' ? 'source_available' : 'ready'))
          throw new Error('YOUTUBE_ACQUISITION_INELIGIBLE');
      });
    },
  });
}

/** Read-only native/actor observation. Late settlement cannot grant bytes or a
 * durable claim, even if the event loop delays the timeout callback. */
async function boundedNativeEligibility(run: () => Promise<void>): Promise<void> {
  const wall = Date.now(),
    mono = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deny = () => new Error('YOUTUBE_ACQUISITION_AUTHORITY_UNAVAILABLE');
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(deny()), 5000);
      }),
    ]);
    if (Date.now() < wall || Date.now() - wall >= 5000 || performance.now() - mono >= 5000) throw deny();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
