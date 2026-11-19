import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { Firestore, Transaction, DocumentSnapshot } from 'firebase-admin/firestore';
import { ApplicationFailure } from '@temporalio/common';
import { readAcquisitionExecution } from './hetzner-acquisition-episode';
import { YOUTUBE_ACQUISITIONS, assertStagingAcquisitionDatabase } from './hetzner-acquisition-store';
import { youtubeAcquisitionId } from './hetzner-acquisition';
import { readYouTubeRenderSlot, retainedYouTubeRenderSlot, youtubeRenderSlot } from './hetzner-render-slot';
import type { YouTubeNativeClose } from './hetzner-acquisition-process';
import type { MediaJobRef } from './types';

const immutable = (s: DocumentSnapshot) => s.exists && s.createTime?.isEqual(s.updateTime!);
const failure = () =>
  ApplicationFailure.create({
    message: 'The original Hetzner process has not been confirmed closed.',
    type: 'YOUTUBE_RENDER_DRAIN_PENDING',
  });

function closesOriginalProcess(claim: DocumentSnapshot, receipt: DocumentSnapshot): boolean {
  const owner = claim.get('owner');
  const close = receipt.get('close') as Partial<YouTubeNativeClose> | undefined;
  const startedAt = claim.get('startedAt');
  return Boolean(
    immutable(claim) &&
      immutable(receipt) &&
      Number.isSafeInteger(owner?.processId) &&
      owner.processId > 0 &&
      isDeepStrictEqual(receipt.get('owner'), owner) &&
      close &&
      close.processId === owner.processId &&
      Number.isSafeInteger(startedAt) &&
      startedAt > 0 &&
      typeof close.closedAt === 'number' &&
      Number.isSafeInteger(close.closedAt) &&
      close.closedAt >= startedAt &&
      (close.exitCode === null || (Number.isInteger(close.exitCode) && close.exitCode! >= 0)) &&
      (close.exitSignal === null ||
        (typeof close.exitSignal === 'string' && /^SIG[A-Z0-9]+$/.test(close.exitSignal))) &&
      (close.outcome === 'failed' ||
        close.outcome === 'cancelled' ||
        (close.outcome === 'completed' && close.exitCode === 0 && close.exitSignal === null))
  );
}

async function isDrained(tx: Transaction, db: Firestore, ref: MediaJobRef, stop: boolean) {
  const root = await tx.get(db.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(ref)));
  if (!root.exists || root.get('renderProtocol') !== 1) return true;
  if (!isDeepStrictEqual(root.get('ref'), ref)) throw failure();
  const execution = await readAcquisitionExecution(tx, root);
  const render = execution.ref.collection('render');
  const [claim, close, dispatch, auth] = await Promise.all(
    ['claim', 'close', 'dispatch', 'authentication'].map((name) => tx.get(render.doc(name)))
  );
  let authDrained = true;
  let unclaimedAuth: string | undefined;
  if (auth.exists) {
    const id = auth.get('id');
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw failure();
    const facts = auth.ref.collection('attempts').doc(id).collection('facts');
    const [authClaim, authDrain, authDispatch] = await Promise.all(
      ['claim', 'drain', 'dispatch'].map((name) => tx.get(facts.doc(name)))
    );
    if (!authClaim.exists && authDispatch.exists) unclaimedAuth = id;
    authDrained = authClaim.exists
      ? authClaim.get('id') === id &&
        authClaim.get('episodeId') === execution.get('preparedEpisode') &&
        authDrain.get('id') === id &&
        closesOriginalProcess(authClaim, authDrain)
      : !authDispatch.exists || stop || root.get('renderStopped') === true;
  }
  const drained = claim.exists
    ? claim.get('episodeId') === execution.get('preparedEpisode') &&
      close.get('episodeId') === claim.get('episodeId') &&
      isDeepStrictEqual(claim.get('ref'), ref) &&
      isDeepStrictEqual(close.get('ref'), ref) &&
      closesOriginalProcess(claim, close)
    : !dispatch.exists || stop || root.get('renderStopped') === true;
  // Claims and IPC grants read this same root in their transactions. Once the
  // fence commits, an unclaimed dispatch cannot later begin native effects.
  if (stop) {
    const episodeId = execution.get('preparedEpisode');
    const slot = await readYouTubeRenderSlot(tx, db);
    if (slot.get('phase') === 'authenticated' && slot.get('operationId') === youtubeAcquisitionId(ref)) {
      const sourceId = slot.get('episodeId');
      const generation = slot.get('authenticationId');
      if (
        ![sourceId, generation].every((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)) ||
        !isDeepStrictEqual(slot.data(), retainedYouTubeRenderSlot(ref, sourceId, generation))
      )
        throw failure();
      if (sourceId !== episodeId) {
        const head = await tx.get(root.ref.collection('episodes').doc(episodeId));
        if (
          !immutable(head) ||
          !isDeepStrictEqual(head.get('ref'), ref) ||
          head.get('predecessor.id') !== sourceId ||
          head.get('predecessor.authenticationGeneration') !== generation
        )
          throw failure();
      }
      const source =
        sourceId === root.get('preparedEpisode')
          ? root.ref
          : root.ref.collection('episodes').doc(sourceId).collection('runtime').doc('current');
      const facts = source
        .collection('render')
        .doc('authentication')
        .collection('attempts')
        .doc(generation)
        .collection('facts');
      const [authClaim, completion, drain] = await Promise.all(
        ['claim', 'completion', 'drain'].map((name) => tx.get(facts.doc(name)))
      );
      if (
        !immutable(completion) ||
        !immutable(drain) ||
        !completion.createTime!.isEqual(drain.createTime!) ||
        completion.get('id') !== generation ||
        completion.get('status') !== 'ready' ||
        completion.get('retainedSlot') !== true ||
        authClaim.get('id') !== generation ||
        authClaim.get('episodeId') !== sourceId ||
        !closesOriginalProcess(authClaim, drain) ||
        drain.get('close.outcome') !== 'completed' ||
        !isDeepStrictEqual(drain.data(), {
          id: generation,
          owner: completion.get('owner'),
          close: completion.get('close'),
        })
      )
        throw failure();
      tx.delete(slot.ref);
    } else if (
      root.get('renderStopped') !== true &&
      typeof episodeId === 'string' &&
      (unclaimedAuth || (!claim.exists && dispatch.exists)) &&
      isDeepStrictEqual(slot.data(), youtubeRenderSlot(ref, episodeId, unclaimedAuth))
    ) {
      tx.delete(slot.ref);
    }
    if (root.get('renderStopped') !== true) tx.update(root.ref, { renderStopped: true });
  }
  return drained && authDrained;
}

export async function awaitYouTubeRenderDrain(o: {
  firestore: Firestore;
  ref: MediaJobRef;
  stop: boolean;
  heartbeat?: () => void;
  polls?: number;
}) {
  assertStagingAcquisitionDatabase(o.firestore);
  const polls = o.polls ?? 50;
  for (let i = 0; i < polls; i++) {
    o.heartbeat?.();
    if (await o.firestore.runTransaction((tx) => isDrained(tx, o.firestore, o.ref, o.stop), { maxAttempts: 1 })) return;
    if (i + 1 < polls) await delay(1000);
  }
  throw failure();
}
