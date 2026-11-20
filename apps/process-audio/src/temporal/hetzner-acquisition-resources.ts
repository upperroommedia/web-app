import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { MediaJobRef } from './types';
import { hostResourceRequest, type HostResourceReply } from '../host/resources';
import {
  recordYouTubeEpisodeResource,
  recordReleasedYouTubeEpisode,
  assertPersistedYouTubeEpisodeClose,
  validateEpisodeDrain,
  type AcquisitionEpisode,
} from './hetzner-acquisition-episode';
const fail = () => new Error('YOUTUBE_EPISODE_RESOURCES_UNCONFIRMED');
async function getOnly(id: string): Promise<void> {
  await hostResourceRequest(id, 'get').catch(() => undefined);
}
/** Source-fixed bridge to the SAME legacy/canary host coordinator. This is
 * physical custody only; it cannot manufacture a native Activity episode. */
export interface YouTubeEpisodeResources {
  directory: string;
  signal: AbortSignal;
  releaseUnused(): Promise<void>;
  enroll(pid: number, signal: AbortSignal): Promise<void>;
  sealAfterNativeClose(): Promise<HostResourceReply>;
  releaseAfterNativeDrain(): Promise<void>;
}
export async function reserveYouTubeEpisodeResources(o: {
  firestore: Firestore;
  episode: AcquisitionEpisode;
  startSignal: AbortSignal;
  assertStartFresh?: () => void;
  assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<void>;
}): Promise<YouTubeEpisodeResources> {
  const id = o.episode.id;
  o.startSignal.throwIfAborted();
  o.assertStartFresh?.();
  let reserved: HostResourceReply;
  try {
    reserved = await hostResourceRequest(id, 'reserve', { kind: 'acquisition' }, o.assertStartFresh);
  } catch {
    await getOnly(id);
    throw fail();
  } // GET never becomes birth permission.
  const directory = `/workspace/yt-acquisition-scratch/${id}`;
  if (reserved.state !== 'reserved' || reserved.directory !== directory || !reserved.receiptHash) throw fail();
  let attempted = false,
    sealed: HostResourceReply | undefined;
  const cleanupSignal = new AbortController(); // independent of HTTP birth lifetime
  const releaseUnused = async () => {
    if (attempted) throw fail();
    try {
      await hostResourceRequest(id, 'unstarted');
    } catch {
      await getOnly(id);
      throw fail();
    }
  };
  try {
    o.startSignal.throwIfAborted();
    o.assertStartFresh?.();
    await recordYouTubeEpisodeResource({ ...o, proof: reserved, phase: 'reserved' });
    o.startSignal.throwIfAborted();
    o.assertStartFresh?.();
  } catch (error) {
    await releaseUnused();
    throw error;
  }
  return {
    directory,
    signal: cleanupSignal.signal,
    releaseUnused,
    async enroll(pid: number, signal: AbortSignal): Promise<void> {
      attempted = true;
      signal.throwIfAborted();
      o.startSignal.throwIfAborted();
      o.assertStartFresh?.();
      let proof: HostResourceReply;
      try {
        proof = await hostResourceRequest(id, 'enroll', { childPid: pid }, o.assertStartFresh);
      } catch {
        await getOnly(id);
        throw fail();
      } // no second enrollment or IPC
      await recordYouTubeEpisodeResource({ ...o, proof, phase: 'enrolled' });
      signal.throwIfAborted();
      o.startSignal.throwIfAborted();
      o.assertStartFresh?.();
    },
    async sealAfterNativeClose(): Promise<HostResourceReply> {
      // The live process boundary has already ended numeric-PID signalling.
      // Root stops only its held original cgroup, including escaped descendants.
      try {
        await hostResourceRequest(id, 'stop');
      } catch {
        await getOnly(id);
      }
      try {
        sealed = await hostResourceRequest(id, 'seal');
        validateEpisodeDrain(sealed, id, 'drained');
      } catch {
        // Original parent authority stays pending until native drain is known.
        for (;;) {
          try {
            sealed = await hostResourceRequest(id, 'get');
            validateEpisodeDrain(sealed, id, 'drained');
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }
      return sealed!;
    },
    async releaseAfterNativeDrain(): Promise<void> {
      if (!sealed) throw fail();
      await assertPersistedYouTubeEpisodeClose({ ...o, proof: sealed });
      let released: HostResourceReply;
      try {
        released = await hostResourceRequest(id, 'release');
        validateEpisodeDrain(released, id, 'closed');
      } catch {
        for (;;) {
          try {
            released = await hostResourceRequest(id, 'get');
            validateEpisodeDrain(released, id, 'closed');
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }
      if (released!.receiptHash !== sealed.receiptHash) throw fail();
      // Called only after the original DB CLOSE transaction has returned a
      // verified immutable ACK. Neither source receipt nor seal frees capacity.
      await recordReleasedYouTubeEpisode({ ...o, proof: released! });
    },
  };
}
