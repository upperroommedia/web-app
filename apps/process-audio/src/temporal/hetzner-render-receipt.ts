import { isRenderProviderOutcome } from './hetzner-render-provider';
import { isDeepStrictEqual as same } from 'node:util';
import type { Firestore, Transaction, DocumentSnapshot } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import { MEDIA_ARTIFACTS, mediaArtifactId } from '@upperroom/orchestration/media-artifacts';
import { assertStagingAcquisitionDatabase } from './hetzner-acquisition-store';
import { readPreparedYouTubeEpisodeInTransaction, type AcquisitionEpisode } from './hetzner-acquisition-episode';
import { readYouTubeRenderArtifact, youtubeRenderOutput, type YouTubeRenderArtifact } from './hetzner-render-output';
import type { MediaJobRef } from './types';

const unconfirmed = () => new Error('YOUTUBE_RENDER_RECEIPT_UNCONFIRMED');
const immutable = (s: DocumentSnapshot) => s.exists && s.createTime?.isEqual(s.updateTime!);

interface RenderRead {
  firestore: Firestore;
  ref: MediaJobRef;
  episodeId: string;
  verifiedCallerEmail: string;
}

function artifact(value: unknown, path: string): YouTubeRenderArtifact {
  const a = value as YouTubeRenderArtifact;
  if (
    !a ||
    Object.keys(a).sort().join(',') !== 'bytes,crc32c,duration,generation,path' ||
    a.path !== path ||
    typeof a.generation !== 'string' ||
    !/^[1-9][0-9]{0,29}$/.test(a.generation) ||
    typeof a.crc32c !== 'string' ||
    !/^[A-Za-z0-9+/]{6}==$/.test(a.crc32c) ||
    !Number.isSafeInteger(a.bytes) ||
    a.bytes <= 0 ||
    a.bytes > 20 * 1024 ** 3 ||
    !Number.isFinite(a.duration) ||
    a.duration <= 0 ||
    a.duration > 86400
  )
    throw unconfirmed();
  return a;
}

/** A candidate alone is pending, even after a successful HTTP response.
 * Read the exact immutable versions joined by the original parent's close. */
export async function readYouTubeRenderReceipt(tx: Transaction, o: RenderRead, requireActive = false) {
  const { episode, execution, root } = await readPreparedYouTubeEpisodeInTransaction(tx, { ...o, render: true });
  if (episode.id !== o.episodeId || (requireActive && root.get('renderStopped') === true)) throw unconfirmed();
  return readBoundYouTubeRenderReceipt(tx, o.ref, episode, execution);
}

export async function readBoundYouTubeRenderReceipt(
  tx: Transaction,
  ref: MediaJobRef,
  episode: AcquisitionEpisode,
  execution: DocumentSnapshot
) {
  const claimedEpisode = execution.get('renderClaim');
  const render = execution.ref.collection('render');
  if (claimedEpisode === undefined) {
    const close = await tx.get(render.doc('close'));
    if (!close.exists) return { kind: 'missing' } as const;
    const [claim, candidate] = await Promise.all(['claim', 'candidate'].map((name) => tx.get(render.doc(name))));
    if (
      claim.exists ||
      candidate.exists ||
      !immutable(close) ||
      close.get('schemaVersion') !== 1 ||
      close.get('episodeId') !== episode.id ||
      !same(close.get('ref'), ref) ||
      close.get('neverClaimed') !== true ||
      close.get('ipcAttempted') !== false ||
      close.get('candidateVersion') !== null ||
      !Number.isSafeInteger(close.get('owner.processId')) ||
      close.get('owner.processId') !== close.get('close.processId') ||
      !Number.isSafeInteger(close.get('startedAt')) ||
      close.get('startedAt') < episode.createdAt ||
      !Number.isSafeInteger(close.get('close.closedAt')) ||
      close.get('close.closedAt') < close.get('startedAt') ||
      !['failed', 'cancelled'].includes(close.get('close.outcome'))
    )
      throw unconfirmed();
    return { kind: 'failed' } as const;
  }
  if (claimedEpisode !== episode.id) throw unconfirmed();
  const [claim, candidate, close] = await Promise.all(
    ['claim', 'candidate', 'close'].map((name) => tx.get(render.doc(name)))
  );
  if (
    !immutable(claim) ||
    claim.get('schemaVersion') !== 1 ||
    claim.get('operationId') !== episode.operationId ||
    claim.get('episodeId') !== episode.id ||
    !same(claim.get('ref'), ref)
  )
    throw unconfirmed();
  if (!close.exists) return { kind: 'running' } as const;
  const owner = claim.get('owner'),
    startedAt = claim.get('startedAt'),
    fact = close.get('close');
  if (
    !immutable(close) ||
    close.get('neverClaimed') !== undefined ||
    close.get('schemaVersion') !== 1 ||
    close.get('episodeId') !== episode.id ||
    !same(close.get('ref'), ref) ||
    !owner ||
    !same(close.get('owner'), owner) ||
    close.get('startedAt') !== startedAt ||
    !Number.isSafeInteger(startedAt) ||
    startedAt < episode.createdAt ||
    !fact ||
    fact.processId !== owner.processId ||
    !Number.isSafeInteger(fact.closedAt) ||
    fact.closedAt < startedAt ||
    !['failed', 'cancelled', 'completed'].includes(fact.outcome)
  )
    throw unconfirmed();
  if (fact.outcome === 'cancelled') return { kind: 'cancelled' } as const;
  if (fact.outcome === 'failed') return { kind: 'failed' } as const;
  if (
    fact.exitCode !== 0 ||
    fact.exitSignal !== null ||
    close.get('ipcAttempted') !== true ||
    !immutable(candidate) ||
    !candidate.updateTime!.isEqual(close.get('candidateVersion')) ||
    candidate.get('schemaVersion') !== 1 ||
    candidate.get('episodeId') !== episode.id ||
    candidate.get('startedAt') !== startedAt ||
    !same(candidate.get('owner'), owner) ||
    !same(candidate.get('ref'), ref)
  )
    throw unconfirmed();
  const providerOutcome: unknown = candidate.get('providerOutcome');
  if (providerOutcome !== undefined) {
    if (
      !isRenderProviderOutcome(providerOutcome) ||
      candidate.get('source') !== undefined ||
      candidate.get('processed') !== undefined ||
      candidate.get('final') !== undefined
    )
      throw unconfirmed();
    return { kind: providerOutcome, episodeId: episode.id } as const;
  }
  const paths = youtubeRenderOutput(ref, episode.id);
  const merged = claim.get('mergedPath');
  if (
    claim.get('sourcePath') !== paths.source ||
    claim.get('processedPath') !== paths.processed ||
    (merged !== null && merged !== paths.merged)
  )
    throw unconfirmed();
  const source = artifact(candidate.get('source'), paths.source);
  const processed = artifact(candidate.get('processed'), paths.processed);
  const final = artifact(candidate.get('final'), merged ?? paths.processed);
  if (!merged && !same(final, processed)) throw unconfirmed();
  return { kind: 'rendered', episodeId: episode.id, merged: merged !== null, source, processed, final } as const;
}

/** Activity-side adoption. Validate actual Storage metadata and rejoin the
 * immutable receipt under the current actor before updating canonical inputs. */
export async function adoptYouTubeRender(
  o: RenderRead & {
    bucket: Bucket;
    signal: AbortSignal;
    assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<unknown>;
  }
) {
  assertStagingAcquisitionDatabase(o.firestore);
  o.signal.throwIfAborted();
  const result = await o.firestore.runTransaction((tx) => readYouTubeRenderReceipt(tx, o, true), { maxAttempts: 1 });
  if (result.kind !== 'rendered') return result;
  const artifacts = [
    { stage: 'source', expected: result.source },
    { stage: 'processed', expected: result.processed },
    ...(result.merged ? [{ stage: 'merged', expected: result.final } as const] : []),
  ] as const;
  for (const { stage, expected } of artifacts) {
    const actual = await readYouTubeRenderArtifact({
      ...o,
      attemptId: result.episodeId,
      stage,
      generation: expected.generation,
      duration: expected.duration,
    });
    if (!same(actual, expected)) throw unconfirmed();
  }
  const assets = artifacts.map(({ expected }) => expected);
  const canonical = ({ path, generation, duration }: YouTubeRenderArtifact) => ({ path, generation, duration });
  const source = canonical(result.source),
    processed = canonical(result.processed),
    final = canonical(result.final);
  let attempted = false;
  const join = async (tx: Transaction, readOnly: boolean) => {
    const current = await readYouTubeRenderReceipt(tx, o, true);
    const requestRef = o.firestore.collection('temporalMediaRequests').doc(o.ref.jobId);
    const request = await tx.get(requestRef);
    const registry = await Promise.all(
      assets.map((a) => tx.get(o.firestore.collection(MEDIA_ARTIFACTS).doc(mediaArtifactId(o.ref.projectId, a.path))))
    );
    await o.assertCurrent(tx, o.ref);
    o.signal.throwIfAborted();
    if (
      !same(result, current) ||
      !same(request.get('ref'), o.ref) ||
      typeof request.get('payload.youtubeUrl') !== 'string'
    )
      throw unconfirmed();
    for (const [index, saved] of registry.entries()) {
      const expected = assets[index];
      if (
        !saved.exists ||
        saved.get('path') !== expected.path ||
        saved.get('ownerJobId') !== o.ref.jobId ||
        saved.get('projectId') !== o.ref.projectId ||
        saved.get('sermonId') !== o.ref.sermonId ||
        !['uploading', 'retained'].includes(saved.get('status')) ||
        ![null, expected.generation].includes(saved.get('generation'))
      )
        throw unconfirmed();
    }
    const marker = request.get('youtubeRenderEpisode');
    if (marker !== undefined) {
      if (
        marker !== result.episodeId ||
        !same(request.get('artifacts.source'), source) ||
        !same(request.get('artifacts.processed'), processed) ||
        !same(request.get('artifacts.final'), final) ||
        registry.some(
          (entry, index) => entry.get('generation') !== assets[index].generation || entry.get('status') !== 'retained'
        )
      )
        throw unconfirmed();
      return;
    }
    if (
      readOnly ||
      request.get('artifacts.source') !== undefined ||
      request.get('artifacts.processed') !== undefined ||
      request.get('artifacts.final') !== undefined
    )
      throw unconfirmed();
    for (const [index, saved] of registry.entries())
      tx.update(saved.ref, { generation: assets[index].generation, status: 'retained' });
    attempted = true;
    tx.update(requestRef, {
      'artifacts.source': source,
      'artifacts.processed': processed,
      'artifacts.final': final,
      youtubeRenderEpisode: result.episodeId,
    });
  };
  try {
    await o.firestore.runTransaction((tx) => join(tx, false), { maxAttempts: 1 });
  } catch (error) {
    // An unknown commit can only accept the exact already-adopted result.
    // Recheck current actor, the stop fence and all pinned generations together.
    if (!attempted) throw error;
    await o.firestore.runTransaction((tx) => join(tx, true), { readOnly: true });
  }
  return result;
}
