import type { DocumentData, DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { youtubeAcquisitionId } from './hetzner-acquisition';
import type { MediaJobRef } from './types';

export type YouTubeRenderSlot = {
  operationId: string;
  episodeId: string;
  authenticationId: string | null;
};

export function youtubeRenderSlot(ref: MediaJobRef, episodeId: string, authenticationId: string | null = null) {
  return { operationId: youtubeAcquisitionId(ref), episodeId, authenticationId } satisfies YouTubeRenderSlot;
}

export function retainedYouTubeRenderSlot(ref: MediaJobRef, episodeId: string, authenticationId: string) {
  return { ...youtubeRenderSlot(ref, episodeId, authenticationId), phase: 'authenticated' as const };
}

/** One retained staging host executes native renders and probes. A reservation
 * has no lease expiry: only confirmed original close or a fenced unclaimed
 * dispatch can release it. The reservation and dispatch are committed together. */
export async function readYouTubeRenderSlot(tx: Transaction, firestore: Firestore) {
  return tx.get(firestore.collection('temporalYouTubeRenderHosts').doc('staging'));
}

export async function requireYouTubeRenderSlot(tx: Transaction, firestore: Firestore, expected: YouTubeRenderSlot) {
  const slot = await readYouTubeRenderSlot(tx, firestore);
  if (!isDeepStrictEqual(slot.data(), expected)) throw new Error('YOUTUBE_RENDER_HOST_RESERVATION_UNCONFIRMED');
  return slot.ref;
}

/** Reserve the host and record which live call did so in one commit. Only that
 * call can recover the first-send grant after a lost Firestore acknowledgement.
 * A later invocation observing this dispatch is always observation-only. */
export async function reserveYouTubeRenderDispatch(o: {
  firestore: Firestore;
  signal: AbortSignal;
  read: (tx: Transaction) => Promise<{
    dispatch: DocumentSnapshot;
    body: DocumentData;
    slot: YouTubeRenderSlot;
    transferFrom?: ReturnType<typeof retainedYouTubeRenderSlot>;
    active: boolean;
  }>;
  assertCurrent: (tx: Transaction) => Promise<unknown>;
}): Promise<boolean | 'busy'> {
  const { firestore, signal } = o;
  const submission = Object.freeze({ schemaVersion: 1, id: randomUUID() });
  let attempted = false;
  signal.throwIfAborted();
  try {
    return await firestore.runTransaction(
      async (tx) => {
        const authorized = await o.read(tx);
        if (!authorized.active || authorized.dispatch.exists) return false;
        await o.assertCurrent(tx);
        const slot = await readYouTubeRenderSlot(tx, firestore);
        signal.throwIfAborted();
        if (authorized.transferFrom) {
          if (!isDeepStrictEqual(slot.data(), authorized.transferFrom)) return 'busy' as const;
          tx.set(slot.ref, authorized.slot);
        } else {
          if (slot.exists) return 'busy' as const;
          tx.create(slot.ref, authorized.slot);
        }
        tx.create(authorized.dispatch.ref, authorized.body);
        tx.create(authorized.dispatch.ref.parent.doc('dispatchSubmission'), submission);
        attempted = true;
        return true;
      },
      { maxAttempts: 1 }
    );
  } catch (error) {
    signal.throwIfAborted();
    if (!attempted) throw error;
    // No HTTP request has been made. Re-read only, and only while this exact
    // invocation still holds its unspent, non-serialized submission identity.
    const recovered = await firestore.runTransaction(
      async (tx) => {
        const authorized = await o.read(tx);
        if (!authorized.active || !authorized.dispatch.exists) return false;
        const [savedSubmission, slot] = await Promise.all([
          tx.get(authorized.dispatch.ref.parent.doc('dispatchSubmission')),
          readYouTubeRenderSlot(tx, firestore),
        ]);
        if (
          !authorized.dispatch.createTime?.isEqual(authorized.dispatch.updateTime!) ||
          !isDeepStrictEqual(authorized.dispatch.data(), authorized.body) ||
          !savedSubmission.exists ||
          !savedSubmission.createTime?.isEqual(savedSubmission.updateTime!) ||
          !authorized.dispatch.createTime.isEqual(savedSubmission.createTime!) ||
          !isDeepStrictEqual(savedSubmission.data(), submission) ||
          !slot.exists ||
          (!authorized.transferFrom && !slot.createTime?.isEqual(slot.updateTime!)) ||
          !authorized.dispatch.createTime.isEqual(slot.updateTime!) ||
          !isDeepStrictEqual(slot.data(), authorized.slot)
        )
          return false;
        await o.assertCurrent(tx);
        signal.throwIfAborted();
        return true;
      },
      { readOnly: true }
    );
    if (!recovered) throw error;
    return true;
  }
}
