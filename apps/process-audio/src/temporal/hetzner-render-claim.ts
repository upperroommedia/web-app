import { assertYouTubeRenderRuntime } from './youtube-render-target';
import { isDeepStrictEqual } from 'node:util';
import type { Auth } from 'firebase-admin/auth';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { writeMediaUploadIntent } from '@upperroom/orchestration/media-artifacts';
import {
  readCurrentRenderAuthenticationSeal,
  readPreparedYouTubeEpisodeInTransaction,
} from './hetzner-acquisition-episode';
import { assertStagingAcquisitionDatabase } from './hetzner-acquisition-store';
import { inspectNativeYouTubeProcess } from './hetzner-acquisition-identity';
import { readEligibleYouTubeAcquisition } from './hetzner-acquisition-policy';
import { requireYouTubeRenderSlot, youtubeRenderSlot } from './hetzner-render-slot';
import { youtubeRenderOutput, type YouTubeRenderArtifact } from './hetzner-render-output';
import type { RenderProviderOutcome } from './hetzner-render-provider';
import type { MediaJobRef } from './types';

const unavailable = () => new Error('YOUTUBE_RENDER_CLAIM_UNCONFIRMED');

type RenderClaim = {
  schemaVersion: number;
  operationId: string;
  episodeId: string;
  ref: MediaJobRef;
  owner: Awaited<ReturnType<typeof inspectNativeYouTubeProcess>>;
  startedAt: number;
  sourcePath: string;
  processedPath: string;
  mergedPath: string | null;
};

/** Only the live parent of the inert child calls this after OIDC validation.
 * A known commit authorizes IPC for that child. Existing or uncertain claims
 * are observations only. The execution document also fences source acquisition. */
export async function claimNativeYouTubeRender(o: {
  firestore: Firestore;
  auth: Auth;
  ref: MediaJobRef;
  verifiedCallerEmail: string;
  processId: number;
  buildId: string;
  runtimeId?: string;
  episodeId: string;
  assertFresh: () => void;
  onClaimAttempt?: (claim: RenderClaim) => void;
}) {
  assertStagingAcquisitionDatabase(o.firestore);
  if (o.processId === process.pid) throw unavailable();
  const ref = Object.freeze({ ...o.ref });
  const owner = await inspectNativeYouTubeProcess(o.processId, o.buildId);
  o.assertFresh();
  const startedAt = Date.now();
  return o.firestore.runTransaction(
    async (tx) => {
      const { episode, execution, root } = await readPreparedYouTubeEpisodeInTransaction(tx, {
        ...o,
        ref,
        render: true,
      });
      if (root.get('renderStopped') === true) throw unavailable();
      if (episode.id !== o.episodeId || startedAt < episode.createdAt) throw unavailable();
      if (execution.get('renderClaim') !== undefined) return { launch: false } as const;
      assertYouTubeRenderRuntime(episode.renderRuntime, o.runtimeId, o.buildId);
      const dispatch = await tx.get(execution.ref.collection('render').doc('dispatch'));
      if (
        !dispatch.exists ||
        !dispatch.createTime?.isEqual(dispatch.updateTime!) ||
        !isDeepStrictEqual(dispatch.data(), { schemaVersion: 1, ref, episodeId: episode.id })
      )
        throw unavailable();
      await requireYouTubeRenderSlot(tx, o.firestore, youtubeRenderSlot(ref, episode.id));
      const eligible = await readEligibleYouTubeAcquisition({ ...o, transaction: tx, ref });
      if (eligible.kind !== 'ready') throw unavailable();
      const output = youtubeRenderOutput(ref, episode.id);
      const claim: RenderClaim = {
        schemaVersion: 1,
        operationId: episode.operationId,
        episodeId: episode.id,
        ref,
        owner,
        startedAt,
        sourcePath: output.source,
        processedPath: output.processed,
        mergedPath: eligible.payload.introUrl || eligible.payload.outroUrl ? output.merged : null,
      };
      if (!isDeepStrictEqual(owner, await inspectNativeYouTubeProcess(o.processId, o.buildId))) throw unavailable();
      o.assertFresh();
      o.onClaimAttempt?.(claim);
      const fact = execution.ref.collection('render').doc('claim');
      tx.create(fact, claim);
      tx.update(execution.ref, { renderClaim: episode.id });
      for (const path of [claim.sourcePath, claim.processedPath, claim.mergedPath]) {
        if (path === null) continue;
        writeMediaUploadIntent(tx, o.firestore, { ...ref, path, createdAt: startedAt });
      }
      return { launch: true, claim } as const;
    },
    { maxAttempts: 1 }
  );
}

/** The child checks its own native identity and the current actor before
 * rendering or accepting any inputs. The same check can supervise the render. */
export async function readOwnedYouTubeRender(o: {
  firestore: Firestore;
  auth: Auth;
  ref: MediaJobRef;
  verifiedCallerEmail: string;
  buildId: string;
  episodeId: string;
  signal: AbortSignal;
  checkAuthentication?: 'starting' | 'downloading';
}) {
  assertStagingAcquisitionDatabase(o.firestore);
  o.signal.throwIfAborted();
  const ref = Object.freeze({ ...o.ref });
  const owner = await inspectNativeYouTubeProcess(process.pid, o.buildId);
  return o.firestore.runTransaction(
    async (tx) => {
      const { episode, execution, root } = await readPreparedYouTubeEpisodeInTransaction(tx, {
        ...o,
        ref,
        render: true,
      });
      if (root.get('renderStopped') === true) throw unavailable();
      if (episode.id !== o.episodeId || execution.get('renderClaim') !== episode.id) throw unavailable();
      await requireYouTubeRenderSlot(tx, o.firestore, youtubeRenderSlot(ref, episode.id));
      const authenticationSeal = o.checkAuthentication
        ? await readCurrentRenderAuthenticationSeal(tx, execution, episode, owner, o.signal)
        : undefined;
      const receipt = await tx.get(execution.ref.collection('render').doc('claim'));
      const eligible = await readEligibleYouTubeAcquisition({ ...o, transaction: tx, ref });
      if (eligible.kind !== 'ready') throw unavailable();
      const output = youtubeRenderOutput(ref, episode.id);
      const startedAt: unknown = receipt.get('startedAt');
      if (
        !receipt.exists ||
        !receipt.createTime?.isEqual(receipt.updateTime!) ||
        typeof startedAt !== 'number' ||
        !Number.isSafeInteger(startedAt) ||
        startedAt < episode.createdAt ||
        !isDeepStrictEqual(receipt.data(), {
          schemaVersion: 1,
          operationId: episode.operationId,
          episodeId: episode.id,
          ref,
          owner,
          startedAt,
          sourcePath: output.source,
          processedPath: output.processed,
          mergedPath: eligible.payload.introUrl || eligible.payload.outroUrl ? output.merged : null,
        })
      )
        throw unavailable();
      o.signal.throwIfAborted();
      const request = await tx.get(o.firestore.collection('temporalMediaRequests').doc(ref.jobId));
      const mergeSource = (stage: 'intro' | 'outro', required: boolean) => {
        const source = request.get(`sources.${stage}`);
        if (!required) {
          if (source !== undefined) throw unavailable();
          return undefined;
        }
        if (
          !source ||
          typeof source.path !== 'string' ||
          !source.path ||
          source.path.startsWith('/') ||
          source.path.split('/').includes('..') ||
          typeof source.generation !== 'string' ||
          !/^[1-9][0-9]{0,29}$/.test(source.generation)
        )
          throw unavailable();
        return { path: source.path as string, generation: source.generation as string };
      };
      const pinnedMergeSources = {
        INTRO: mergeSource('intro', Boolean(eligible.payload.introUrl)),
        OUTRO: mergeSource('outro', Boolean(eligible.payload.outroUrl)),
      };
      o.signal.throwIfAborted();
      return {
        authenticationCurrent: authenticationSeal !== null,
        authenticationSeal,
        payload: eligible.payload,
        output,
        owner,
        startedAt,
        pinnedMergeSources,
        claim: receipt.data()!,
      };
    },
    { maxAttempts: 1 }
  );
}

type RenderCandidate =
  | { source: YouTubeRenderArtifact; processed: YouTubeRenderArtifact; final: YouTubeRenderArtifact }
  | { providerOutcome: RenderProviderOutcome };

/** Record the original child's result under the same fence used by stop and
 * claim. A preflight observation cannot authorize a later candidate write. */
export async function recordOwnedYouTubeRenderCandidate(o: {
  firestore: Firestore;
  auth: Auth;
  ref: MediaJobRef;
  verifiedCallerEmail: string;
  episodeId: string;
  claim: DocumentData;
  candidate: RenderCandidate;
  signal: AbortSignal;
}) {
  assertStagingAcquisitionDatabase(o.firestore);
  o.signal.throwIfAborted();
  await o.firestore.runTransaction(
    async (tx) => {
      const { root, execution, episode } = await readPreparedYouTubeEpisodeInTransaction(tx, { ...o, render: true });
      if (
        root.get('renderStopped') === true ||
        episode.id !== o.episodeId ||
        execution.get('renderClaim') !== episode.id
      )
        throw unavailable();
      await requireYouTubeRenderSlot(tx, o.firestore, youtubeRenderSlot(o.ref, episode.id));
      const render = execution.ref.collection('render');
      const claim = await tx.get(render.doc('claim'));
      if (!claim.exists || !claim.createTime?.isEqual(claim.updateTime!) || !isDeepStrictEqual(claim.data(), o.claim))
        throw unavailable();
      const eligible = await readEligibleYouTubeAcquisition({ ...o, transaction: tx });
      if (eligible.kind !== 'ready') throw unavailable();
      o.signal.throwIfAborted();
      tx.create(render.doc('candidate'), {
        schemaVersion: 1,
        ref: o.ref,
        episodeId: episode.id,
        owner: o.claim.owner,
        startedAt: o.claim.startedAt,
        ...o.candidate,
      });
    },
    { maxAttempts: 1 }
  );
}
