import { assertYouTubeRenderRuntime } from './youtube-render-target';
import { removeRenderProfileSnapshot } from './hetzner-render-profile';
import { mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Auth } from 'firebase-admin/auth';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { acquisitionHostBuildId } from './hetzner-acquisition-driver';
import { readPreparedYouTubeEpisodeInTransaction } from './hetzner-acquisition-episode';
import { runYouTubeAcquisitionProcess, type YouTubeNativeClose } from './hetzner-acquisition-process';
import { requireYouTubeRenderSlot, youtubeRenderSlot } from './hetzner-render-slot';
import { assertStagingAcquisitionDatabase } from './hetzner-acquisition-store';
import { claimNativeYouTubeRender } from './hetzner-render-claim';
import type { MediaJobRef } from './types';

const unavailable = () => new Error('YOUTUBE_RENDER_EXECUTION_UNCONFIRMED');
type Claim = Extract<Awaited<ReturnType<typeof claimNativeYouTubeRender>>, { launch: true }>['claim'];

/** Internal staging driver for the authenticated render route.
 * The birth request's cancellation ends at IPC. Thereafter the child watches
 * the canonical job, and this original parent observes process and scratch drain. */
export async function executeCanonicalYouTubeRender(o: {
  firestore: Firestore;
  auth: Auth;
  ref: MediaJobRef;
  episodeId: string;
  verifiedCallerEmail: string;
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
    throw unavailable();
  const fresh = (signal?: AbortSignal) => {
    o.startSignal.throwIfAborted();
    signal?.throwIfAborted();
    o.assertStartFresh();
  };
  fresh();
  const ref = Object.freeze({ ...o.ref });
  const episode = await o.firestore.runTransaction(
    async (tx) => {
      const { episode, execution } = await readPreparedYouTubeEpisodeInTransaction(tx, { ...o, ref, render: true });
      if (episode.id !== o.episodeId) throw unavailable();
      if (execution.get('renderClaim') !== undefined) return undefined;
      await requireYouTubeRenderSlot(tx, o.firestore, youtubeRenderSlot(ref, episode.id));
      return episode;
    },
    { maxAttempts: 1 }
  );
  if (!episode) return 'already-claimed' as const;
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
  let attempted: Claim | undefined;
  return runYouTubeAcquisitionProcess({
    helperPath: join(__dirname, 'hetzner-acquisition-helper.js'),
    directory,
    ref,
    episodeId: episode.id,
    renderCallerEmail: o.verifiedCallerEmail,
    signal: new AbortController().signal,
    assertStartFresh: fresh,
    onStarted: o.onStarted,
    authorize: async (processId, signal) => {
      fresh(signal);
      const result = await claimNativeYouTubeRender({
        ...o,
        ref,
        buildId,
        processId,
        episodeId: episode.id,
        assertFresh: () => fresh(signal),
        onClaimAttempt: (claim) => {
          attempted = claim;
        },
      });
      fresh(signal);
      return result.launch;
    },
    onNativeClose: async (close, boundary) => {
      await removeRenderProfileSnapshot(directory);
      // rmdir only removes the original empty operation directory. Any residue
      // leaves this claim without a publishable close or a replacement attempt.
      await rmdir(directory);
      // The attempt was captured from live PID inspection before the transaction
      // could commit. After CLOSE it can reconcile a lost ACK, never authorize IPC.
      const claim = attempted;
      if (!claim) return;
      await recordCanonicalYouTubeRenderClose({
        firestore: o.firestore,
        ref,
        episodeId: episode.id,
        verifiedCallerEmail: o.verifiedCallerEmail,
        claim,
        close,
        ipcAttempted: boundary.ipcAttempted,
      });
    },
  });
}

/** Records only the original child's observed close after local workspace drain. */
export async function recordCanonicalYouTubeRenderClose(o: {
  firestore: Firestore;
  ref: MediaJobRef;
  episodeId: string;
  verifiedCallerEmail: string;
  claim: Claim;
  close: Readonly<YouTubeNativeClose>;
  ipcAttempted: boolean;
}) {
  assertStagingAcquisitionDatabase(o.firestore);
  const { close, claim, ref, episodeId, ipcAttempted } = o;
  if (
    claim.episodeId !== episodeId ||
    !isDeepStrictEqual(claim.ref, ref) ||
    close.processId !== claim.owner.processId ||
    close.closedAt < claim.startedAt
  )
    throw unavailable();
  let proposal: { ref: DocumentReference; data: object } | undefined;
  const persist = () => {
    proposal = undefined;
    return o.firestore.runTransaction(
      async (tx) => {
        const { episode, execution } = await readPreparedYouTubeEpisodeInTransaction(tx, { ...o, render: true });
        if (episode.id !== episodeId) throw unavailable();
        const render = execution.ref.collection('render');
        const [savedClaim, candidate] = await Promise.all([
          tx.get(render.doc('claim')),
          tx.get(render.doc('candidate')),
        ]);
        const neverClaimed = !savedClaim.exists;
        if (neverClaimed) {
          const dispatch = await tx.get(render.doc('dispatch'));
          if (
            ipcAttempted ||
            close.outcome === 'completed' ||
            execution.get('renderClaim') !== undefined ||
            candidate.exists ||
            !dispatch.createTime?.isEqual(dispatch.updateTime!) ||
            !isDeepStrictEqual(dispatch.data(), { schemaVersion: 1, ref, episodeId })
          )
            throw unavailable();
        } else {
          // A different original child already won this dispatch.
          if (!ipcAttempted && !isDeepStrictEqual(savedClaim.data(), claim)) return;
          if (
            execution.get('renderClaim') !== episodeId ||
            !savedClaim.createTime?.isEqual(savedClaim.updateTime!) ||
            !isDeepStrictEqual(savedClaim.data(), claim)
          )
            throw unavailable();
        }
        if (
          close.outcome === 'completed' &&
          (!ipcAttempted ||
            !candidate.createTime?.isEqual(candidate.updateTime!) ||
            candidate.get('episodeId') !== episodeId ||
            candidate.get('startedAt') !== claim.startedAt ||
            !isDeepStrictEqual(candidate.get('owner'), claim.owner) ||
            !isDeepStrictEqual(candidate.get('ref'), ref))
        )
          throw unavailable();
        // The exact original close and slot release commit together.
        const slot = await requireYouTubeRenderSlot(tx, o.firestore, youtubeRenderSlot(ref, episodeId));
        proposal = {
          ref: render.doc('close'),
          data: {
            schemaVersion: 1,
            ref,
            episodeId,
            owner: claim.owner,
            startedAt: claim.startedAt,
            close,
            ipcAttempted,
            ...(neverClaimed ? { neverClaimed: true } : {}),
            candidateVersion: close.outcome === 'completed' ? candidate.updateTime! : null,
          },
        };
        tx.delete(slot);
        tx.create(proposal.ref, proposal.data);
      },
      { maxAttempts: 1 }
    );
  };
  try {
    try {
      await persist();
    } catch (error) {
      // Firestore ABORTED is a definite non-commit. Retry the same close once.
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 10)) throw error;
      await persist();
    }
  } catch (error) {
    // A lost response may only observe the exact immutable receipt proposed
    // by this invocation. It cannot retry the transaction or change custody.
    if (!proposal) throw error;
    const observed = await proposal.ref.get();
    if (!observed.createTime?.isEqual(observed.updateTime!) || !isDeepStrictEqual(observed.data(), proposal.data))
      throw error;
  }
}
