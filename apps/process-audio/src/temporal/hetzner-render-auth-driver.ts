import { assertYouTubeRenderRuntime } from './youtube-render-target';
import { removeRenderProfileSnapshot } from './hetzner-render-profile';
import { mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { acquisitionHostBuildId } from './hetzner-acquisition-driver';
import { requireYouTubeRenderSlot, youtubeRenderSlot } from './hetzner-render-slot';
import { readEligibleYouTubeAcquisition } from './hetzner-acquisition-policy';
import { runYouTubeAcquisitionProcess } from './hetzner-acquisition-process';
import {
  claimRenderAuthentication,
  closeRenderAuthentication,
  readPreparedRenderAuthentication,
} from './hetzner-render-authentication';
import type { MediaJobRef } from './types';

const denied = () => new Error('YOUTUBE_RENDER_AUTHENTICATION_UNCONFIRMED');

export async function executeRenderAuthentication(o: {
  firestore: Firestore;
  auth: Auth;
  ref: MediaJobRef;
  verifiedCallerEmail: string;
  id: string;
  runtimeId?: string;
  startSignal: AbortSignal;
  assertStartFresh: () => void;
  onStarted: () => void;
}) {
  if (
    process.platform !== 'linux' ||
    process.env.PROCESS_AUDIO_RUNTIME_PROFILE !== 'hetzner' ||
    o.auth.app.options.projectId !== 'urm-app-staging'
  )
    throw denied();
  const fresh = (signal?: AbortSignal) => {
    o.startSignal.throwIfAborted();
    signal?.throwIfAborted();
    o.assertStartFresh();
  };
  fresh();
  const ref = Object.freeze({ ...o.ref });
  const episode = await o.firestore.runTransaction(
    async (tx) => {
      const { original, completion, intent } = await readPreparedRenderAuthentication(tx, { ...o, ref });
      if (completion.exists || (await tx.get(intent.ref.collection('facts').doc('claim'))).exists) return undefined;
      await requireYouTubeRenderSlot(tx, o.firestore, youtubeRenderSlot(ref, original.episode.id, o.id));
      return original.episode;
    },
    { maxAttempts: 1 }
  );
  if (!episode) return 'already-claimed' as const;
  const episodeId = episode.id;
  const buildId = acquisitionHostBuildId();
  assertYouTubeRenderRuntime(episode.renderRuntime, o.runtimeId, buildId);
  const existingTmp = await realpath(tmpdir());
  fresh();
  const directory = await mkdtemp(join(existingTmp, 'youtube-render-'));
  try {
    fresh();
  } catch (error) {
    await rmdir(directory);
    throw error;
  }
  let attempted: Awaited<ReturnType<typeof claimRenderAuthentication>>;
  return runYouTubeAcquisitionProcess({
    helperPath: join(__dirname, 'hetzner-acquisition-helper.js'),
    directory,
    ref,
    episodeId,
    renderCallerEmail: o.verifiedCallerEmail,
    authenticationId: o.id,
    signal: AbortSignal.timeout(120000),
    assertStartFresh: fresh,
    onStarted: o.onStarted,
    authorize: async (processId, signal) => {
      fresh(signal);
      const claim = await claimRenderAuthentication({
        ...o,
        ref,
        processId,
        buildId,
        assertFresh: () => fresh(signal),
        onClaimAttempt: (claim) => {
          attempted = claim;
        },
        assertCurrent: async (transaction, bound) => {
          const eligible = await readEligibleYouTubeAcquisition({ ...o, transaction, ref: bound });
          if (eligible.kind !== 'ready') throw denied();
        },
      });
      fresh(signal);
      return claim !== undefined;
    },
    onNativeClose: async (close, boundary) => {
      await removeRenderProfileSnapshot(directory);
      await rmdir(directory);
      const original = attempted;
      if (!original) return;
      if (close.processId !== original.owner.processId || close.closedAt < original.startedAt) throw denied();
      await closeRenderAuthentication({ ...o, ref, close, claim: original, ipcAttempted: boundary.ipcAttempted });
    },
  });
}
