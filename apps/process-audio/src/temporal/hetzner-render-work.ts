import { isMosesYouTubeRenderHost } from './youtube-render-target';
import { isDeepStrictEqual } from 'node:util';
import type { Auth } from 'firebase-admin/auth';
import type { Database } from 'firebase-admin/database';
import type { Firestore } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import { CancelToken } from '../CancelToken';
import { createContext } from '../context';
import { renderProcessAudio } from '../processAudio';
import { sermonStatusType, uploadStatus } from '../types';
import { getAudioSource, getDurationSeconds, unlinkSafeTempFile } from '../utils';
import { boundedNativeEligibility } from './hetzner-acquisition-authorization';
import { drainNativeYouTubeSession } from './hetzner-acquisition-producer';
import { readOwnedYouTubeRender, recordOwnedYouTubeRenderCandidate } from './hetzner-render-claim';
import {
  readYouTubeRenderArtifact,
  uploadYouTubeRenderSource,
  type YouTubeRenderArtifact,
} from './hetzner-render-output';
import { renderProviderOutcome, type RenderProviderOutcome } from './hetzner-render-provider';
import { withRenderProfileSnapshot } from './hetzner-render-profile';
import { assertRetainedMediaWorkspaceAvailable } from './resources';
import type { MediaJobRef } from './types';

const denied = () => new Error('YOUTUBE_RENDER_WORK_UNCONFIRMED');

/** Called only by the original claimed child in its private workspace. A
 * candidate is private until the original parent proves CLOSE and group drain. */
export async function runOwnedYouTubeRender(o: {
  firestore: Firestore;
  auth: Auth;
  realtimeDB: Database;
  bucket: Bucket;
  ref: MediaJobRef;
  verifiedCallerEmail: string;
  buildId: string;
  episodeId: string;
  directory: string;
  ytdlpPath: string;
  cancellation: CancelToken;
}) {
  if (o.bucket.name !== 'urm-app-staging.firebasestorage.app') throw denied();
  const { cancellation, ref, bucket } = o;
  const signal = cancellation.signal;
  const observe = (observationSignal = signal, checkAuthentication?: 'starting' | 'downloading') =>
    boundedNativeEligibility(() => readOwnedYouTubeRender({ ...o, signal: observationSignal, checkAuthentication }));
  const original = await observe(signal, 'starting');
  if (isMosesYouTubeRenderHost() && original.authenticationSeal) throw denied();
  const sameAuthority = (current: typeof original) =>
    isDeepStrictEqual(current.claim, original.claim) &&
    isDeepStrictEqual(current.pinnedMergeSources, original.pinnedMergeSources);
  let downloading = true;
  let providerOutcome: RenderProviderOutcome | undefined = original.authenticationCurrent ? undefined : 'waiting_auth';
  const { payload, output } = original;
  const tempFiles = new Set<string>();
  let checking: Promise<void> | undefined;
  const watchdog = setInterval(() => {
    checking ??= Promise.all([
      observe(signal, downloading ? 'downloading' : undefined),
      boundedNativeEligibility(() => assertRetainedMediaWorkspaceAvailable(o.directory)),
    ])
      .then(([current]) => {
        if (signal.aborted) return;
        if (!sameAuthority(current)) {
          cancellation.cancel();
        } else if (downloading && !current.authenticationCurrent) {
          providerOutcome = 'waiting_auth';
          cancellation.cancel();
        }
      }, cancellation.cancel)
      .finally(() => {
        checking = undefined;
      });
  }, 1000);
  watchdog.unref();
  let source: YouTubeRenderArtifact | undefined;
  const result = await (async () => {
    try {
      if (!original.authenticationCurrent) return undefined;
      await boundedNativeEligibility(() => assertRetainedMediaWorkspaceAvailable(o.directory));
      signal.throwIfAborted();
      const render = () =>
        renderProcessAudio({
          ytdlpPath: o.ytdlpPath,
          cancelToken: cancellation,
          bucket,
          sourceBucket: bucket,
          audioSource: getAudioSource(payload),
          realtimeDB: o.realtimeDB,
          // Temporal owns public status. The host render only produces artifacts.
          progressRef: { set: async () => undefined },
          updateSermon: async () => undefined,
          sermonStatus: {
            audioStatus: sermonStatusType.PROCESSING,
            soundCloud: uploadStatus.NOT_UPLOADED,
            subsplash: uploadStatus.NOT_UPLOADED,
          },
          contextWithSermonId: createContext(ref.sermonId, 'temporal-youtube-render'),
          processedStoragePath: output.processed,
          outputFilePath: output.merged,
          outputIdentity: output.metadata,
          retainYouTubeSource: async (localPath) => {
            signal.throwIfAborted();
            const duration = await getDurationSeconds(localPath, cancellation);
            if (
              !Number.isFinite(duration) ||
              duration <= 0 ||
              duration > 86400 ||
              payload.startTime >= duration ||
              payload.startTime + payload.duration > duration + 1
            )
              throw denied();
            const current = await observe(signal, 'downloading');
            signal.throwIfAborted();
            if (!sameAuthority(current)) throw denied();
            if (!current.authenticationCurrent) {
              providerOutcome = 'waiting_auth';
              throw denied();
            }
            downloading = false;
            source = await uploadYouTubeRenderSource({ ...o, attemptId: o.episodeId, localPath, duration, signal });
          },
          authorizeOutputUpload: async () => {
            if (!source || !sameAuthority(await observe(signal))) throw denied();
            signal.throwIfAborted();
          },
          onYouTubeProviderFailure: (error) => {
            providerOutcome ??= renderProviderOutcome(error);
          },
          pinnedMergeSources: original.pinnedMergeSources,
          title: undefined,
          startTime: payload.startTime,
          duration: payload.duration,
          introUrl: payload.introUrl,
          outroUrl: payload.outroUrl,
          tempFiles,
        });
      return original.authenticationSeal
        ? await withRenderProfileSnapshot(o.directory, original.authenticationSeal, signal, async () => {
            try {
              return await render();
            } catch (error) {
              cancellation.cancel();
              throw error;
            } finally {
              await cancellation.waitForProcesses();
            }
          })
        : await render();
    } catch (error) {
      if (error instanceof Error && error.message === 'YOUTUBE_RENDER_PROFILE_UNCONFIRMED' && !signal.aborted) {
        providerOutcome = 'waiting_auth';
      }
      cancellation.cancel();
      if (!providerOutcome) throw error;
      return undefined;
    } finally {
      clearInterval(watchdog);
      await checking;
      await cancellation.waitForProcesses();
      if (await drainNativeYouTubeSession(o.directory)) throw denied();
      const cleanup = await Promise.allSettled(
        [...tempFiles].map(async (path) => {
          try {
            await unlinkSafeTempFile(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        })
      );
      if (cleanup.some((entry) => entry.status === 'rejected')) throw denied();
    }
  })();
  // Extraction failure is captured at the download call, before any output
  // stream can open. The original cancellation token has been used to drain.
  const receiptSignal = result ? signal : AbortSignal.timeout(5000);
  let candidate;
  if (result) {
    receiptSignal.throwIfAborted();
    if (!result.generations?.processed || (result.path !== output.processed && !result.generations.merged))
      throw denied();
    const processed = await readYouTubeRenderArtifact({
      ...o,
      stage: 'processed',
      generation: result.generations.processed,
      duration: result.processedDuration,
      attemptId: o.episodeId,
      signal,
    });
    if (result.path !== (original.claim.mergedPath ?? original.claim.processedPath)) throw denied();
    const final =
      result.path === output.processed
        ? processed
        : await readYouTubeRenderArtifact({
            ...o,
            stage: 'merged',
            generation: result.generations.merged,
            duration: result.durationSeconds,
            attemptId: o.episodeId,
            signal,
          });
    if (!source) throw denied();
    candidate = { source, processed, final };
  } else {
    if (!providerOutcome) throw denied();
    candidate = { providerOutcome };
  }
  const verified = await observe(receiptSignal);
  if (!sameAuthority(verified)) throw denied();
  await recordOwnedYouTubeRenderCandidate({ ...o, claim: original.claim, candidate, signal: receiptSignal });
}
