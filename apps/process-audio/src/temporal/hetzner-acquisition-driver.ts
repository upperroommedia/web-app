import { join } from 'node:path';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { MediaJobRef } from './types';
import { youtubeAcquisitionId } from './hetzner-acquisition';
import { runYouTubeAcquisitionProcess } from './hetzner-acquisition-process';
import { createNativeYouTubeAuthorization } from './hetzner-acquisition-authorization';

interface SharedHostReservation {
  directory: string;
  signal: AbortSignal;
  releaseUnused(): Promise<void>;
  releaseAfterNativeDrain(): Promise<void>;
}
/** Fixed source-owned gate. A directory marker or caller boolean cannot stand in
 * for physical backing, both legacy containers/canaries, cgroups and headroom.
 * No resource mutation or helper fork is reachable until that implementation exists. */
async function reserveSharedHostResources(_ref: MediaJobRef, _buildId: string): Promise<SharedHostReservation> {
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
}): Promise<void> {
  const ref = Object.freeze({ ...o.ref });
  youtubeAcquisitionId(ref);
  o.startSignal.throwIfAborted();
  if (o.auth.app.options.projectId !== ref.projectId) throw new Error('YOUTUBE_HOST_PROJECT_UNCONFIRMED');
  const buildId = acquisitionHostBuildId();
  const reservation = await reserveSharedHostResources(ref, buildId);
  // A late resource ACK must not fork after the HTTP birth budget has expired.
  try {
    o.startSignal.throwIfAborted();
  } catch (error) {
    await reservation.releaseUnused(); // No child was created; no fabricated drain fact.
    throw error;
  }
  const authorize = createNativeYouTubeAuthorization({ ...o, ref, buildId });
  // The returned result is possible only after the ORIGINAL child CLOSE and
  // positive owned group absence. Rejected/unknown drain never releases resources.
  await runYouTubeAcquisitionProcess({
    helperPath: join(__dirname, 'hetzner-acquisition-helper.js'),
    directory: reservation.directory,
    ref,
    signal: reservation.signal,
    authorize: async (pid, signal) => {
      o.startSignal.throwIfAborted();
      const allowed = await authorize(pid, AbortSignal.any([signal, o.startSignal]));
      o.startSignal.throwIfAborted();
      return allowed;
    },
  });
  await reservation.releaseAfterNativeDrain();
}
