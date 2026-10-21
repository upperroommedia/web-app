import { join } from 'node:path';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { MediaJobRef } from './types';
import { youtubeAcquisitionId } from './hetzner-acquisition';
import { runYouTubeAcquisitionProcess } from './hetzner-acquisition-process';
import { closeYouTubeAcquisitionNativeProcess, type AcquisitionHostProcess } from './hetzner-acquisition-store';
import { readPreparedYouTubeEpisode } from './hetzner-acquisition-episode';
import { reserveYouTubeEpisodeResources } from './hetzner-acquisition-resources';
import { readEligibleYouTubeAcquisition } from './hetzner-acquisition-policy';
import { createNativeYouTubeAuthorization } from './hetzner-acquisition-authorization';

/** Native installed enforcement and complete retry/auth/archive resumption
 * acceptance are still missing. No environment flag can enable this producer. */
function assertAcquisitionActivationSupported(): void {
  throw new Error('YOUTUBE_SHARED_HOST_RESOURCES_UNAVAILABLE');
}
export function acquisitionHostBuildId(): string {
  const build = /^process-audio-hetzner@staging-([a-f0-9]{40})$/.exec(process.env.SENTRY_RELEASE ?? '')?.[1];
  if (!build) throw new Error('YOUTUBE_HOST_BUILD_UNCONFIRMED');
  return build;
}
/** Actual host POST driver. The native helper is a fixed compiled sibling; HTTP
 * contributes only the already validated ref and independently verified email.
 * HTTP deadlines fence birth/grant, never create a second acquisition authority. */
export async function executeCanonicalYouTubeAcquisition(o: {
  firestore: Firestore;
  auth: Auth;
  ref: MediaJobRef;
  verifiedCallerEmail: string;
  startSignal: AbortSignal;
  birthDeadline?: { wall: number; monotonic: number };
}): Promise<void> {
  const deadline = o.birthDeadline
    ? Object.freeze({ ...o.birthDeadline })
    : { wall: Date.now(), monotonic: performance.now() };
  const fresh = () => {
    o.startSignal.throwIfAborted();
    if (
      !Number.isFinite(deadline.wall) ||
      !Number.isFinite(deadline.monotonic) ||
      Date.now() < deadline.wall ||
      performance.now() < deadline.monotonic ||
      Date.now() - deadline.wall >= 5000 ||
      performance.now() - deadline.monotonic >= 5000
    )
      throw new Error('YOUTUBE_BIRTH_DEADLINE');
  };
  const ref = Object.freeze({ ...o.ref });
  youtubeAcquisitionId(ref);
  fresh();
  if (o.auth.app.options.projectId !== ref.projectId) throw new Error('YOUTUBE_HOST_PROJECT_UNCONFIRMED');
  const buildId = acquisitionHostBuildId();
  assertAcquisitionActivationSupported();
  const episode = await readPreparedYouTubeEpisode({ ...o, ref });
  fresh();
  const reservation = await reserveYouTubeEpisodeResources({
    ...o,
    episode,
    assertStartFresh: fresh,
    assertCurrent: async (transaction, bound) => {
      fresh();
      const current = await readEligibleYouTubeAcquisition({ ...o, transaction, ref: bound });
      fresh();
      if (current.kind !== 'ready') throw new Error('YOUTUBE_ACQUISITION_INELIGIBLE');
    },
  });
  // A late resource ACK must not fork after the HTTP birth budget has expired.
  try {
    fresh();
  } catch (error) {
    await reservation.releaseUnused(); // No child was created; no fabricated drain fact.
    throw error;
  }
  let originalStartedAt: number | undefined;
  let originalOwner: Readonly<AcquisitionHostProcess> | undefined;
  const authorize = createNativeYouTubeAuthorization({
    ...o,
    ref,
    buildId,
    episodeId: episode.id,
    assertFresh: fresh,
    onInspected: (owner, startedAt) => {
      if (originalOwner) throw new Error('YOUTUBE_SECOND_NATIVE_OWNER');
      originalOwner = owner;
      originalStartedAt = startedAt;
    },
  });
  // The returned result is possible only after the ORIGINAL child CLOSE and
  // positive owned group absence. Rejected/unknown drain never releases resources.
  await runYouTubeAcquisitionProcess({
    helperPath: join(__dirname, 'hetzner-acquisition-helper.js'),
    directory: reservation.directory,
    ref,
    signal: reservation.signal,
    episodeId: episode.id,
    assertStartFresh: fresh,
    onNativeClose: async (fact) => {
      if (!originalOwner || originalStartedAt === undefined) throw new Error('YOUTUBE_NATIVE_OWNER_UNCONFIRMED');
      const sealed = await reservation.sealAfterNativeClose();
      await closeYouTubeAcquisitionNativeProcess({
        firestore: o.firestore,
        ref,
        owner: originalOwner,
        startedAt: originalStartedAt,
        fact: sealed.descendantsStopped === true ? { ...fact, outcome: 'failed' } : fact,
        episode: { id: episode.id, proof: sealed },
      });
    },
    authorize: async (pid, signal) => {
      fresh();
      await reservation.enroll(pid, signal);
      const allowed = await authorize(pid, AbortSignal.any([signal, o.startSignal]));
      fresh();
      return allowed;
    },
  });
  await reservation.releaseAfterNativeDrain();
}
