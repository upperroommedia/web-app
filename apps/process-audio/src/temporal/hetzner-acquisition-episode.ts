import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Firestore, Transaction, DocumentSnapshot } from 'firebase-admin/firestore';
import type { HostResourceReply } from '../host/resources';
import type { AcquisitionHostProcess } from './hetzner-acquisition-store';
import type { MediaJobRef } from './types';
import { youtubeAcquisitionId } from './hetzner-acquisition';
import {
  assertStagingAcquisitionDatabase,
  validateAcquisitionPreparer,
  readYouTubeAcquisitionOperation,
  YOUTUBE_ACQUISITIONS,
  type AcquisitionPreparer,
} from './hetzner-acquisition-store';
const fail = (): never => {
  throw new Error('YOUTUBE_EPISODE_UNCONFIRMED');
};
const uuid = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
export interface AcquisitionEpisode {
  schemaVersion: 1;
  id: string;
  operationId: string;
  ordinal: 1;
  predecessor: null;
  ref: MediaJobRef;
  preparedBy: AcquisitionPreparer;
  createdAt: number;
}
function immutable(snapshot: DocumentSnapshot): void {
  if (!snapshot.exists || !snapshot.createTime?.isEqual(snapshot.updateTime!)) fail();
}
function intent(raw: unknown, ref: MediaJobRef): AcquisitionEpisode {
  const value = raw as AcquisitionEpisode;
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      'createdAt,id,operationId,ordinal,predecessor,preparedBy,ref,schemaVersion' ||
    value.schemaVersion !== 1 ||
    !uuid(value.id) ||
    value.operationId !== youtubeAcquisitionId(ref) ||
    youtubeAcquisitionId(value.ref) !== value.operationId ||
    value.ordinal !== 1 ||
    value.predecessor !== null ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  )
    return fail();
  validateAcquisitionPreparer(value.preparedBy);
  return value;
}
/** Native Activity producer only. HTTP never chooses an episode or authorizes
 * retries. Historical single-owner delegations are not silently backfilled. */
export async function prepareNativeYouTubeEpisode(o: {
  firestore: Firestore;
  ref: MediaJobRef;
  caller: AcquisitionPreparer;
  assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<void>;
}): Promise<void> {
  assertStagingAcquisitionDatabase(o.firestore);
  const ref = Object.freeze({ ...o.ref }),
    caller = validateAcquisitionPreparer(o.caller);
  const parent = o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(ref));
  const episode: AcquisitionEpisode = {
    schemaVersion: 1,
    id: randomUUID(),
    ordinal: 1,
    predecessor: null,
    operationId: parent.id,
    ref,
    preparedBy: caller,
    createdAt: Date.now(),
  };
  const doc = parent.collection('episodes').doc(episode.id);
  let created = false;
  // An unknown first intent ACK never becomes a new birth. Only the source
  // producer after a KNOWN commit may create the separate permission receipt.
  await o.firestore.runTransaction(
    async (tx) => {
      const existing = await tx.get(parent);
      if (existing.exists) {
        const current = readYouTubeAcquisitionOperation(existing.data(), ref);
        const saved = existing.get('preparedEpisode');
        if (
          !uuid(saved) ||
          current.preparedBy.buildId !== caller.buildId ||
          current.preparedBy.serviceAccount !== caller.serviceAccount
        )
          return fail();
        const original = await tx.get(parent.collection('episodes').doc(saved));
        const allowed = await tx.get(original.ref.collection('facts').doc('authorized'));
        immutable(original);
        immutable(allowed);
        if (!original.createTime?.isEqual(existing.createTime!)) return fail();
        const parsed = intent(original.data(), ref);
        if (parsed.id !== saved || !isDeepStrictEqual(allowed.data(), { schemaVersion: 1, episode: parsed }))
          return fail();
        await o.assertCurrent(tx, ref);
        return;
      }
      await o.assertCurrent(tx, ref);
      tx.create(parent, {
        schemaVersion: 1,
        operationId: parent.id,
        ref,
        preparedBy: caller,
        status: 'prepared',
        createdAt: episode.createdAt,
        preparedEpisode: episode.id,
      });
      tx.create(doc, episode);
      created = true;
    },
    { maxAttempts: 1 }
  );
  if (!created) return;
  await o.firestore.runTransaction(
    async (tx) => {
      const [current, original] = await Promise.all([tx.get(parent), tx.get(doc)]);
      immutable(original);
      if (
        !isDeepStrictEqual(original.data(), episode) ||
        current.get('preparedEpisode') !== episode.id ||
        current.get('status') !== 'prepared'
      )
        return fail();
      await o.assertCurrent(tx, ref);
      tx.create(doc.collection('facts').doc('authorized'), { schemaVersion: 1, episode });
    },
    { maxAttempts: 1 }
  );
}
/** GET-only input for the actual fixed host driver. No transaction/ACK repair,
 * episode creation, retry decision, or authority renewal is available here. */
export async function readPreparedYouTubeEpisode(o: {
  firestore: Firestore;
  ref: MediaJobRef;
  verifiedCallerEmail: string;
}): Promise<AcquisitionEpisode> {
  assertStagingAcquisitionDatabase(o.firestore);
  return o.firestore.runTransaction(
    async (tx) => {
      const parent = o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(o.ref));
      const snapshot = await tx.get(parent),
        current = readYouTubeAcquisitionOperation(snapshot.data(), o.ref);
      const id = snapshot.get('preparedEpisode');
      if (!uuid(id) || current.status !== 'prepared' || current.preparedBy.serviceAccount !== o.verifiedCallerEmail)
        return fail();
      const original = await tx.get(parent.collection('episodes').doc(id));
      const allowed = await tx.get(original.ref.collection('facts').doc('authorized'));
      immutable(original);
      immutable(allowed);
      if (!original.createTime?.isEqual(snapshot.createTime!)) return fail();
      const value = intent(original.data(), o.ref);
      if (
        value.id !== id ||
        !isDeepStrictEqual(value.preparedBy, current.preparedBy) ||
        !isDeepStrictEqual(allowed.data(), { schemaVersion: 1, episode: value })
      )
        return fail();
      return value;
    },
    { maxAttempts: 1 }
  );
}

function resource(proof: HostResourceReply, id: string, state: 'reserved' | 'enrolled'): void {
  if (
    proof.v !== 1 ||
    proof.id !== id ||
    proof.state !== state ||
    proof.peerBound !== true ||
    proof.directory !== `/workspace/yt-acquisition-scratch/${id}` ||
    !proof.receiptHash ||
    !/^[a-f0-9]{64}$/.test(proof.receiptHash)
  )
    fail();
}
/** Known root ACKs only. The driver must never call this with GET-recovered
 * reservation/enrollment as launch permission. Unknown writes are not resent. */
export async function recordYouTubeEpisodeResource(o: {
  firestore: Firestore;
  episode: AcquisitionEpisode;
  proof: HostResourceReply;
  phase: 'reserved' | 'enrolled';
  assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<void>;
}): Promise<void> {
  const episode = intent(o.episode, o.episode.ref);
  resource(o.proof, episode.id, o.phase);
  const parent = o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(episode.operationId),
    doc = parent.collection('episodes').doc(episode.id);
  const proof = Object.freeze({ ...o.proof });
  await o.firestore.runTransaction(
    async (tx) => {
      const [root, saved, authorized] = await Promise.all([
        tx.get(parent),
        tx.get(doc),
        tx.get(doc.collection('facts').doc('authorized')),
      ]);
      immutable(saved);
      immutable(authorized);
      if (!saved.createTime?.isEqual(root.createTime!)) return fail();
      if (
        root.get('preparedEpisode') !== episode.id ||
        root.get('status') !== 'prepared' ||
        !isDeepStrictEqual(saved.data(), episode) ||
        !isDeepStrictEqual(authorized.data(), { schemaVersion: 1, episode })
      )
        return fail();
      if (o.phase === 'enrolled') {
        const reserved = await tx.get(doc.collection('facts').doc('reserved'));
        immutable(reserved);
        resource(reserved.get('proof'), episode.id, 'reserved');
      }
      await o.assertCurrent(tx, episode.ref);
      tx.create(doc.collection('facts').doc(o.phase), { schemaVersion: 1, episodeId: episode.id, proof });
    },
    { maxAttempts: 1 }
  );
}
export async function claimYouTubeEpisode(
  tx: Transaction,
  parent: DocumentSnapshot,
  ref: MediaJobRef,
  id: string | undefined,
  owner: AcquisitionHostProcess,
  startedAt: number
): Promise<void> {
  if (!uuid(id) || parent.get('preparedEpisode') !== id) return fail();
  const doc = parent.ref.collection('episodes').doc(id);
  const [original, authorized, reserved, enrolled, birth] = await Promise.all([
    tx.get(doc),
    tx.get(doc.collection('facts').doc('authorized')),
    tx.get(doc.collection('facts').doc('reserved')),
    tx.get(doc.collection('facts').doc('enrolled')),
    tx.get(doc.collection('facts').doc('birth')),
  ]);
  for (const saved of [original, authorized, reserved, enrolled]) immutable(saved);
  if (!original.createTime?.isEqual(parent.createTime!)) return fail();
  const episode = intent(original.data(), ref);
  if (
    episode.id !== id ||
    !isDeepStrictEqual(episode.preparedBy, parent.get('preparedBy')) ||
    !isDeepStrictEqual(authorized.data(), { schemaVersion: 1, episode }) ||
    birth.exists
  )
    return fail();
  resource(reserved.get('proof'), id, 'reserved');
  resource(enrolled.get('proof'), id, 'enrolled');
  tx.create(doc.collection('facts').doc('birth'), {
    schemaVersion: 1,
    episodeId: id,
    owner,
    startedAt,
    reservationReceiptHash: reserved.get('proof.receiptHash'),
    enrollmentReceiptHash: enrolled.get('proof.receiptHash'),
  });
}
export async function assertOwnedYouTubeEpisode(
  tx: Transaction,
  parent: DocumentSnapshot,
  id: string | undefined,
  owner: AcquisitionHostProcess,
  nativeEnrollment?: HostResourceReply
): Promise<void> {
  const bound = parent.get('preparedEpisode');
  if (bound === undefined) {
    if (id !== undefined || nativeEnrollment !== undefined) fail();
    return;
  }
  if (!uuid(id) || bound !== id) return fail();
  const doc = parent.ref.collection('episodes').doc(id),
    facts = doc.collection('facts');
  const [original, authorized, reserved, enrolled, born] = await Promise.all([
    tx.get(doc),
    tx.get(facts.doc('authorized')),
    tx.get(facts.doc('reserved')),
    tx.get(facts.doc('enrolled')),
    tx.get(facts.doc('birth')),
  ]);
  for (const saved of [original, authorized, reserved, enrolled, born]) immutable(saved);
  if (!original.createTime?.isEqual(parent.createTime!)) return fail();
  const value = intent(original.data(), parent.get('ref'));
  resource(reserved.get('proof'), id, 'reserved');
  resource(enrolled.get('proof'), id, 'enrolled');
  if (
    value.id !== id ||
    !isDeepStrictEqual(authorized.data(), { schemaVersion: 1, episode: value }) ||
    born.get('episodeId') !== id ||
    !isDeepStrictEqual(born.get('owner'), owner) ||
    born.get('startedAt') !== parent.get('startedAt') ||
    born.get('reservationReceiptHash') !== reserved.get('proof.receiptHash') ||
    born.get('enrollmentReceiptHash') !== enrolled.get('proof.receiptHash')
  )
    return fail();
  if (nativeEnrollment !== undefined) {
    resource(nativeEnrollment, id, 'enrolled');
    if (!isDeepStrictEqual(nativeEnrollment, enrolled.get('proof'))) return fail();
  }
}
export function validateEpisodeDrain(proof: HostResourceReply, id: string, state: 'drained' | 'closed'): void {
  if (
    !uuid(id) ||
    proof.id !== id ||
    proof.v !== 1 ||
    proof.peerBound !== true ||
    proof.state !== state ||
    proof.groupAbsent !== true ||
    !proof.receiptHash ||
    !/^[a-f0-9]{64}$/.test(proof.receiptHash)
  )
    fail();
}
export async function assertPersistedYouTubeEpisodeClose(o: {
  firestore: Firestore;
  episode: AcquisitionEpisode;
  proof: HostResourceReply;
}): Promise<void> {
  validateEpisodeDrain(o.proof, o.episode.id, 'drained');
  await o.firestore.runTransaction(
    async (tx) => {
      const parent = await tx.get(o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(o.episode.operationId));
      await assertOwnedYouTubeEpisode(tx, parent, o.episode.id, parent.get('owner'));
      const [sealed, closed] = await Promise.all([
        tx.get(parent.ref.collection('episodes').doc(o.episode.id).collection('facts').doc('sealed')),
        tx.get(parent.ref.collection('nativeClose').doc('original')),
      ]);
      immutable(sealed);
      immutable(closed);
      if (
        !isDeepStrictEqual(sealed.get('proof'), o.proof) ||
        !isDeepStrictEqual(closed.data(), parent.get('nativeClose')) ||
        !sealed.createTime?.isEqual(closed.createTime!)
      )
        return fail();
    },
    { maxAttempts: 1 }
  );
}
export async function recordReleasedYouTubeEpisode(o: {
  firestore: Firestore;
  episode: AcquisitionEpisode;
  proof: HostResourceReply;
}): Promise<void> {
  validateEpisodeDrain(o.proof, o.episode.id, 'closed');
  const parent = o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(o.episode.operationId),
    doc = parent.collection('episodes').doc(o.episode.id).collection('facts').doc('released');
  const expected = { schemaVersion: 1, episodeId: o.episode.id, proof: { ...o.proof } };
  try {
    await o.firestore.runTransaction(
      async (tx) => {
        const root = await tx.get(parent);
        await assertOwnedYouTubeEpisode(tx, root, o.episode.id, root.get('owner'));
        const closed = await tx.get(parent.collection('nativeClose').doc('original'));
        const sealed = await tx.get(doc.parent.doc('sealed'));
        immutable(closed);
        immutable(sealed);
        validateEpisodeDrain(sealed.get('proof'), o.episode.id, 'drained');
        if (
          sealed.get('proof.receiptHash') !== o.proof.receiptHash ||
          !isDeepStrictEqual(closed.data(), root.get('nativeClose')) ||
          !closed.createTime?.isEqual(sealed.createTime!)
        )
          return fail();
        tx.create(doc, expected);
      },
      { maxAttempts: 1 }
    );
  } catch {
    // Exact original immutable receipt only; no transaction retry or retiming.
    const saved = await doc.get();
    immutable(saved);
    if (!isDeepStrictEqual(saved.data(), expected)) return fail();
  }
}
/** Required by BOTH host readback and the actual source-adoption transaction.
 * A helper result or DB parent-close alone cannot hide an unreleased scope. */
export async function assertReleasedYouTubeEpisode(tx: Transaction, parent: DocumentSnapshot): Promise<void> {
  const id = parent.get('preparedEpisode');
  if (id === undefined) return; // Historical single-owner path is not relabelled.
  if (!uuid(id)) return fail();
  await assertOwnedYouTubeEpisode(tx, parent, id, parent.get('owner'));
  const facts = parent.ref.collection('episodes').doc(id).collection('facts');
  const [sealed, released, closed] = await Promise.all([
    tx.get(facts.doc('sealed')),
    tx.get(facts.doc('released')),
    tx.get(parent.ref.collection('nativeClose').doc('original')),
  ]);
  for (const saved of [sealed, released, closed]) immutable(saved);
  validateEpisodeDrain(sealed.get('proof'), id, 'drained');
  validateEpisodeDrain(released.get('proof'), id, 'closed');
  if (
    sealed.get('proof.receiptHash') !== released.get('proof.receiptHash') ||
    !closed.createTime?.isEqual(sealed.createTime!) ||
    !isDeepStrictEqual(closed.data(), parent.get('nativeClose')) ||
    parent.get('nativeClose.outcome') !== 'completed' ||
    sealed.get('proof.descendantsStopped') === true ||
    released.get('proof.descendantsStopped') === true
  )
    return fail();
}
