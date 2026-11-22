import { createHash, randomBytes } from 'node:crypto';
import type { DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
import { ApplicationFailure } from '@temporalio/common';
import {
  readYouTubeRenderTarget,
  stagingYouTubeRenderOrigins,
  type YouTubeRenderTarget,
} from '../../../process-audio/src/temporal/youtube-render-target';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

interface ExpectedRenderer {
  runtimeId: string;
  sentryRelease: string;
}

type RendererIdentity = { runtimeId: string; commit: string };
type RendererPair = Record<YouTubeRenderTarget, RendererIdentity>;
export type YouTubeRenderChoice = RendererIdentity & { target: YouTubeRenderTarget };

const unavailable = () =>
  ApplicationFailure.retryable('No verified YouTube renderer is reachable.', 'YOUTUBE_RENDER_TARGET_UNAVAILABLE');

function rendererIdentity(snapshot: DocumentSnapshot, proof: unknown, releaseId: string, commit: string) {
  type Stamp = { seconds?: number; nanoseconds?: number };
  const pin = proof as { createTime?: Stamp; updateTime?: Stamp; dataDigest?: unknown } | undefined;
  const received = snapshot.data();
  function matchesTime(actual: Stamp | undefined, expected: Stamp | undefined) {
    return actual && expected && actual.seconds === expected.seconds && actual.nanoseconds === expected.nanoseconds;
  }
  if (
    !received ||
    !pin ||
    !snapshot.createTime ||
    !snapshot.updateTime?.isEqual(snapshot.createTime) ||
    !matchesTime(snapshot.createTime, pin.createTime) ||
    !matchesTime(snapshot.updateTime, pin.updateTime) ||
    received.releaseId !== releaseId ||
    received.commit !== commit ||
    received.mode !== 'enabled' ||
    typeof received.runtimeId !== 'string' ||
    !uuid.test(received.runtimeId)
  )
    throw unavailable();

  // Activation receipts contain only scalars. This is the same ordered JSON
  // representation that the release operator hashes at backend-ready.
  const fields = Object.entries(received).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (
    fields.some(([, value]) => value === null || typeof value === 'object' || value === undefined) ||
    createHash('sha256')
      .update(JSON.stringify(Object.fromEntries(fields)))
      .digest('hex') !== pin.dataDigest
  )
    throw unavailable();
  return { runtimeId: received.runtimeId, commit };
}

/** A renderer becomes selectable only after the staging release operator checkpoints both activations. */
export function createStagingYouTubeRenderAuthority(env: NodeJS.ProcessEnv, firestore: Firestore) {
  if (readYouTubeRenderTarget(env.TEMPORAL_MEDIA_YOUTUBE_RENDER_TARGET) === 'hetzner') return undefined;
  const releaseId = env.TEMPORAL_MEDIA_YOUTUBE_RENDER_RELEASE_ID;
  const build = env.TEMPORAL_BUILD_ID;
  if (!releaseId || !uuid.test(releaseId) || !build || !/^[a-f0-9]{40}$/.test(build)) throw unavailable();
  const read = async (tx: Transaction) => {
    const [control, state, moses, hetzner] = await tx.getAll(
      firestore.doc('_control/temporalRelease'),
      firestore.doc('_control/temporalReleaseState'),
      firestore.doc(`_control/temporalMosesYouTubeActivation-${releaseId}`),
      firestore.doc(`_control/temporalHetznerYouTubeActivation-${releaseId}`)
    );
    const current = control.data();
    const checkpoint = state.data();
    const binding = checkpoint?.mediaRenderBinding;
    if (
      !current ||
      current.admission !== 'open' ||
      current.domains?.media?.admission !== 'open' ||
      current.domains.media.owner !== 'temporal' ||
      !checkpoint ||
      checkpoint.releaseId !== current.releaseId ||
      checkpoint.controlRevision !== current.revision ||
      !['open', 'complete'].includes(checkpoint.phase) ||
      !binding ||
      binding.releaseId !== releaseId ||
      binding.workerBuildId !== build ||
      !/^[a-f0-9]{40}$/.test(binding.compatibilityCommit ?? '')
    )
      throw unavailable();
    const commit: string = binding.compatibilityCommit;
    const primary = rendererIdentity(moses, binding.mosesActivation, releaseId, commit);
    const backup = rendererIdentity(hetzner, binding.hetznerActivation, releaseId, commit);
    if (moses.get('target') !== 'moses' || moses.get('guestOnly') !== true) throw unavailable();
    return { moses: primary, hetzner: backup };
  };
  return { load: () => firestore.runTransaction(read, { readOnly: true }), read };
}

/** Probe before a first reservation or an expressly authorized guest handoff. */
export function createStagingYouTubeRenderSelector(load: () => Promise<RendererPair>, request = fetch) {
  function expected({ runtimeId, commit }: RendererIdentity): ExpectedRenderer {
    if (!uuid.test(runtimeId) || !/^[a-f0-9]{40}$/.test(commit)) throw unavailable();
    return { runtimeId, sentryRelease: `process-audio-hetzner@staging-${commit}` };
  }

  async function ready(target: YouTubeRenderTarget, renderer: ExpectedRenderer, signal: AbortSignal) {
    signal.throwIfAborted();
    const releaseChallenge = randomBytes(32).toString('hex');
    const url = new URL('/healthz', stagingYouTubeRenderOrigins[target]);
    url.searchParams.set('releaseChallenge', releaseChallenge);
    try {
      const response = await request(url, {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      const health = await response.json();
      return (
        health?.ok === true &&
        health.service === 'process-audio' &&
        health.releaseChallenge === releaseChallenge &&
        health.temporalYouTubeRenderMode === 'enabled' &&
        health.temporalYouTubeRenderTarget === target &&
        health.temporalYouTubeRenderPinProtocol === 1 &&
        (target !== 'moses' || health.temporalYouTubeGuestOnly === true) &&
        health.temporalYouTubeRuntimeId === renderer.runtimeId &&
        health.sentryEnabled === true &&
        health.sentryEnvironment === 'staging' &&
        health.sentryRelease === renderer.sentryRelease
      );
    } catch {
      return false;
    } finally {
      signal.throwIfAborted();
    }
  }

  return async (signal: AbortSignal, backupOnly = false): Promise<YouTubeRenderChoice> => {
    signal.throwIfAborted();
    const pair = await load();
    const moses = expected(pair.moses);
    const hetzner = expected(pair.hetzner);
    if (!backupOnly && (await ready('moses', moses, signal))) return { target: 'moses', ...pair.moses };
    if (await ready('hetzner', hetzner, signal)) return { target: 'hetzner', ...pair.hetzner };
    throw unavailable();
  };
}
