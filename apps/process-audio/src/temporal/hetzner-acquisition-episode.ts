import type { YouTubeNativeClose } from './hetzner-acquisition-process';
import { createHash, randomUUID } from 'node:crypto';
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
  ordinal: number;
  predecessor: null | { id: string; closeHash: string; releaseHash: string; providerHash: string };
  invocation: AcquisitionInvocation;
  ref: MediaJobRef;
  preparedBy: AcquisitionPreparer;
  createdAt: number;
}
export interface AcquisitionInvocation {
  workflowId: string;
  runId: string;
  activityId: string;
  attempt: number;
}
function invocation(value: AcquisitionInvocation): AcquisitionInvocation {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'activityId,attempt,runId,workflowId' ||
    ![value.workflowId, value.runId, value.activityId].every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 256
    ) ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1
  )
    return fail();
  return { ...value };
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function nativeHash(snapshot: DocumentSnapshot) {
  immutable(snapshot);
  return digest({
    data: snapshot.data(),
    createTime: { seconds: snapshot.createTime!.seconds, nanoseconds: snapshot.createTime!.nanoseconds },
    updateTime: { seconds: snapshot.updateTime!.seconds, nanoseconds: snapshot.updateTime!.nanoseconds },
  });
}
function providerOutcome(snapshot: DocumentSnapshot, id: string): void {
  immutable(snapshot);
  const value = snapshot.data();
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'action,attemptedModes,episodeId,kind,schemaVersion' ||
    value.schemaVersion !== 1 ||
    value.episodeId !== id ||
    value.kind !== 'retryable' ||
    value.action !== 'task_retry' ||
    !Array.isArray(value.attemptedModes) ||
    value.attemptedModes.length < 1 ||
    value.attemptedModes.length > 3 ||
    !value.attemptedModes.every(
      (mode: unknown) =>
        typeof mode === 'string' && ['public_provider', 'cookie_provider', 'browser_fallback'].includes(mode)
    )
  )
    return fail();
}

/** Actual snapshots only. Original episode execution stays on the original
 * delegation; each successor owns its distinct native runtime document. */
export function acquisitionDelegationRef(execution: DocumentSnapshot) {
  return execution.ref.parent.id === 'runtime' ? execution.ref.parent.parent!.parent.parent! : execution.ref;
}
export async function readAcquisitionExecution(
  tx: Transaction,
  root: DocumentSnapshot,
  id?: string
): Promise<DocumentSnapshot> {
  const selected = id ?? root.get('headEpisode') ?? root.get('preparedEpisode');
  if (selected === undefined || selected === root.get('preparedEpisode')) return root;
  if (!uuid(selected) || root.get('headEpisode') !== selected) return fail();
  const execution = await tx.get(root.ref.collection('episodes').doc(selected).collection('runtime').doc('current'));
  if (
    !execution.exists ||
    execution.get('preparedEpisode') !== selected ||
    execution.get('operationId') !== root.id ||
    !isDeepStrictEqual(execution.get('ref'), root.get('ref'))
  )
    return fail();
  return execution;
}
async function episodeOriginal(
  tx: Transaction,
  execution: DocumentSnapshot,
  original: DocumentSnapshot,
  parsed: AcquisitionEpisode
) {
  immutable(original);
  const rootRef = acquisitionDelegationRef(execution);
  if (parsed.ordinal === 1) {
    const root = rootRef.path === execution.ref.path ? execution : await tx.get(rootRef);
    if (root.get('preparedEpisode') !== parsed.id || !original.createTime?.isEqual(root.createTime!)) return fail();
  } else {
    if (
      !parsed.predecessor ||
      execution.ref.path !== original.ref.collection('runtime').doc('current').path ||
      !original.createTime?.isEqual(execution.createTime!)
    )
      return fail();
    const link = await tx.get(
      rootRef.collection('episodes').doc(parsed.predecessor.id).collection('facts').doc('successor')
    );
    immutable(link);
    if (
      !link.createTime?.isEqual(original.createTime!) ||
      !isDeepStrictEqual(link.data(), { schemaVersion: 1, episode: parsed })
    )
      return fail();
    const previousIntent = await tx.get(rootRef.collection('episodes').doc(parsed.predecessor.id));
    const previous = intent(previousIntent.data(), parsed.ref);
    if (
      previous.ordinal + 1 !== parsed.ordinal ||
      previous.invocation.workflowId !== parsed.invocation.workflowId ||
      previous.invocation.runId !== parsed.invocation.runId ||
      previous.invocation.activityId !== parsed.invocation.activityId ||
      parsed.invocation.attempt <= previous.invocation.attempt
    )
      return fail();
    const predecessorExecution =
      previous.ordinal === 1
        ? await tx.get(rootRef)
        : await tx.get(previousIntent.ref.collection('runtime').doc('current'));
    await episodeOriginal(tx, predecessorExecution, previousIntent, previous);
    const [close, released, uploads, provider] = await Promise.all([
      tx.get(predecessorExecution.ref.collection('nativeClose').doc('original')),
      tx.get(previousIntent.ref.collection('facts').doc('released')),
      tx.get(predecessorExecution.ref.collection('uploads').limit(1)),
      tx.get(previousIntent.ref.collection('facts').doc('providerOutcome')),
    ]);
    immutable(close);
    immutable(released);
    providerOutcome(provider, previous.id);
    validateEpisodeDrain(released.get('proof'), previous.id, 'closed');
    if (
      nativeHash(provider) !== parsed.predecessor.providerHash ||
      provider.get('kind') !== 'retryable' ||
      provider.get('action') !== 'task_retry' ||
      provider.get('episodeId') !== previous.id ||
      nativeHash(close) !== parsed.predecessor.closeHash ||
      nativeHash(released) !== parsed.predecessor.releaseHash ||
      close.get('outcome') !== 'completed' ||
      released.get('proof.descendantsStopped') === true ||
      !isDeepStrictEqual(close.data(), predecessorExecution.get('nativeClose')) ||
      predecessorExecution.get('status') !== 'retryable' ||
      predecessorExecution.get('result.kind') !== 'retryable' ||
      predecessorExecution.get('activeUpload') !== undefined ||
      !uploads.empty
    )
      return fail();
  }
}
function immutable(snapshot: DocumentSnapshot): void {
  if (!snapshot.exists || !snapshot.createTime?.isEqual(snapshot.updateTime!)) fail();
}
function intent(raw: unknown, ref: MediaJobRef): AcquisitionEpisode {
  const value = raw as AcquisitionEpisode;
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      'createdAt,id,invocation,operationId,ordinal,predecessor,preparedBy,ref,schemaVersion' ||
    value.schemaVersion !== 1 ||
    !uuid(value.id) ||
    value.operationId !== youtubeAcquisitionId(ref) ||
    youtubeAcquisitionId(value.ref) !== value.operationId ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal < 1 ||
    value.ordinal > 64 ||
    (value.ordinal === 1
      ? value.predecessor !== null
      : !value.predecessor ||
        Object.keys(value.predecessor).sort().join(',') !== 'closeHash,id,providerHash,releaseHash' ||
        !uuid(value.predecessor.id) ||
        !/^[a-f0-9]{64}$/.test(value.predecessor.closeHash) ||
        !/^[a-f0-9]{64}$/.test(value.predecessor.releaseHash) ||
        !/^[a-f0-9]{64}$/.test(value.predecessor.providerHash)) ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  )
    return fail();
  validateAcquisitionPreparer(value.preparedBy);
  invocation(value.invocation);
  return value;
}
/** Native Activity producer only. HTTP never chooses an episode or authorizes
 * retries. Historical single-owner delegations are not silently backfilled. */
export async function prepareNativeYouTubeEpisode(o: {
  firestore: Firestore;
  ref: MediaJobRef;
  caller: AcquisitionPreparer;
  invocation: AcquisitionInvocation;
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
    invocation: invocation(o.invocation),
    operationId: parent.id,
    ref,
    preparedBy: caller,
    createdAt: Date.now(),
  };
  const doc = parent.collection('episodes').doc(episode.id);
  let executionRef = parent;
  let created = false;
  // An unknown first intent ACK never becomes a new birth. Only the source
  // producer after a KNOWN commit may create the separate permission receipt.
  await o.firestore.runTransaction(
    async (tx) => {
      const existing = await tx.get(parent);
      if (existing.exists) {
        const execution = await readAcquisitionExecution(tx, existing);
        const current = readYouTubeAcquisitionOperation(execution.data(), ref);
        const saved = execution.get('preparedEpisode');
        if (
          !uuid(saved) ||
          current.preparedBy.buildId !== caller.buildId ||
          current.preparedBy.serviceAccount !== caller.serviceAccount
        )
          return fail();
        const original = await tx.get(parent.collection('episodes').doc(saved));
        const allowed = await tx.get(original.ref.collection('facts').doc('authorized'));
        immutable(allowed);
        const parsed = intent(original.data(), ref);
        await episodeOriginal(tx, execution, original, parsed);
        if (parsed.id !== saved || !isDeepStrictEqual(allowed.data(), { schemaVersion: 1, episode: parsed }))
          return fail();
        await o.assertCurrent(tx, ref);
        if (execution.get('unclaimedClose') !== undefined) return fail();
        if (isDeepStrictEqual(parsed.invocation, episode.invocation)) return;
        // An ordinary retry cannot reinterpret unknown ownership, upload ACKs,
        // or an auth/archive wait as permission for a new producer.
        if (
          current.status !== 'retryable' ||
          current.result?.kind !== 'retryable' ||
          current.nativeClose?.outcome !== 'completed' ||
          parsed.ordinal >= 64 ||
          parsed.invocation.workflowId !== episode.invocation.workflowId ||
          parsed.invocation.runId !== episode.invocation.runId ||
          parsed.invocation.activityId !== episode.invocation.activityId ||
          episode.invocation.attempt <= parsed.invocation.attempt
        )
          return fail();
        await assertReleasedYouTubeEpisode(tx, execution);
        const provider = await tx.get(original.ref.collection('facts').doc('providerOutcome'));
        providerOutcome(provider, parsed.id);
        if (
          provider.get('schemaVersion') !== 1 ||
          provider.get('episodeId') !== parsed.id ||
          provider.get('kind') !== 'retryable' ||
          provider.get('action') !== 'task_retry'
        )
          return fail();
        const uploads = await tx.get(execution.ref.collection('uploads').limit(1));
        if (!uploads.empty || execution.get('activeUpload') !== undefined) return fail();
        const closed = await tx.get(execution.ref.collection('nativeClose').doc('original'));
        const released = await tx.get(original.ref.collection('facts').doc('released'));
        immutable(closed);
        immutable(released);
        episode.ordinal = parsed.ordinal + 1;
        episode.predecessor = {
          id: parsed.id,
          closeHash: nativeHash(closed),
          releaseHash: nativeHash(released),
          providerHash: nativeHash(provider),
        };
        executionRef = doc.collection('runtime').doc('current');
        tx.create(original.ref.collection('facts').doc('successor'), { schemaVersion: 1, episode });
        tx.create(doc, episode);
        tx.create(executionRef, {
          schemaVersion: 1,
          operationId: parent.id,
          ref,
          preparedBy: caller,
          status: 'prepared',
          createdAt: episode.createdAt,
          preparedEpisode: episode.id,
        });
        tx.update(parent, { headEpisode: episode.id });
        created = true;
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
      const [current, original] = await Promise.all([tx.get(executionRef), tx.get(doc)]);
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
      const root = await tx.get(parent);
      const snapshot = await readAcquisitionExecution(tx, root),
        current = readYouTubeAcquisitionOperation(snapshot.data(), o.ref);
      if (snapshot.get('unclaimedClose') !== undefined) return fail();
      const id = snapshot.get('preparedEpisode');
      if (!uuid(id) || current.status !== 'prepared' || current.preparedBy.serviceAccount !== o.verifiedCallerEmail)
        return fail();
      const original = await tx.get(parent.collection('episodes').doc(id));
      const allowed = await tx.get(original.ref.collection('facts').doc('authorized'));
      immutable(original);
      immutable(allowed);
      const value = intent(original.data(), o.ref);
      await episodeOriginal(tx, snapshot, original, value);
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
      const [delegation, saved, authorized] = await Promise.all([
        tx.get(parent),
        tx.get(doc),
        tx.get(doc.collection('facts').doc('authorized')),
      ]);
      immutable(saved);
      immutable(authorized);
      const root = await readAcquisitionExecution(tx, delegation, episode.id);
      await episodeOriginal(tx, root, saved, episode);
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
  if (!uuid(id) || parent.get('preparedEpisode') !== id || parent.get('unclaimedClose') !== undefined) return fail();
  const doc = acquisitionDelegationRef(parent).collection('episodes').doc(id);
  const [original, authorized, reserved, enrolled, birth] = await Promise.all([
    tx.get(doc),
    tx.get(doc.collection('facts').doc('authorized')),
    tx.get(doc.collection('facts').doc('reserved')),
    tx.get(doc.collection('facts').doc('enrolled')),
    tx.get(doc.collection('facts').doc('birth')),
  ]);
  for (const saved of [original, authorized, reserved, enrolled]) immutable(saved);
  const episode = intent(original.data(), ref);
  await episodeOriginal(tx, parent, original, episode);
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
  const rootRef = acquisitionDelegationRef(parent);
  const root = rootRef.path === parent.ref.path ? parent : await tx.get(rootRef);
  if ((root.get('headEpisode') ?? root.get('preparedEpisode')) !== id) return fail();
  const doc = rootRef.collection('episodes').doc(id),
    facts = doc.collection('facts');
  const [original, authorized, reserved, enrolled, born] = await Promise.all([
    tx.get(doc),
    tx.get(facts.doc('authorized')),
    tx.get(facts.doc('reserved')),
    tx.get(facts.doc('enrolled')),
    tx.get(facts.doc('birth')),
  ]);
  for (const saved of [original, authorized, reserved, enrolled, born]) immutable(saved);
  const value = intent(original.data(), parent.get('ref'));
  await episodeOriginal(tx, parent, original, value);
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
function validateUnclaimedFact(fact: Readonly<YouTubeNativeClose>): void {
  if (
    !fact ||
    Object.keys(fact).sort().join(',') !== 'closedAt,exitCode,exitSignal,outcome,processId' ||
    !Number.isSafeInteger(fact.processId) ||
    fact.processId < 1 ||
    !Number.isSafeInteger(fact.closedAt) ||
    fact.closedAt < 0 ||
    !['failed', 'cancelled'].includes(fact.outcome) ||
    (fact.exitCode !== null && (!Number.isInteger(fact.exitCode) || fact.exitCode < 0 || fact.exitCode > 255)) ||
    (fact.exitSignal !== null && !/^SIG[A-Z0-9]+$/.test(fact.exitSignal))
  )
    return fail();
}
interface UnclaimedEpisodeClose {
  schemaVersion: 1;
  kind: 'unclaimed';
  episodeId: string;
  ipcAttempted: false;
  fact: Readonly<YouTubeNativeClose>;
  reservationReceiptHash: string;
  enrollmentReceiptHash: string;
}
async function unclaimedInputs(tx: Transaction, execution: DocumentSnapshot, episode: AcquisitionEpisode) {
  const rootRef = acquisitionDelegationRef(execution);
  const root = rootRef.path === execution.ref.path ? execution : await tx.get(rootRef);
  if (
    (root.get('headEpisode') ?? root.get('preparedEpisode')) !== episode.id ||
    execution.get('preparedEpisode') !== episode.id ||
    execution.get('status') !== 'prepared' ||
    ['owner', 'startedAt', 'result', 'drainedAt', 'activeUpload', 'nativeClose'].some(
      (key) => execution.get(key) !== undefined
    )
  )
    return fail();
  const doc = rootRef.collection('episodes').doc(episode.id),
    facts = doc.collection('facts');
  const [original, authorized, reserved, enrolled, born, uploads] = await Promise.all([
    tx.get(doc),
    tx.get(facts.doc('authorized')),
    tx.get(facts.doc('reserved')),
    tx.get(facts.doc('enrolled')),
    tx.get(facts.doc('birth')),
    tx.get(execution.ref.collection('uploads').limit(1)),
  ]);
  for (const saved of [original, authorized, reserved, enrolled]) immutable(saved);
  await episodeOriginal(tx, execution, original, episode);
  resource(reserved.get('proof'), episode.id, 'reserved');
  resource(enrolled.get('proof'), episode.id, 'enrolled');
  if (
    !isDeepStrictEqual(original.data(), episode) ||
    !isDeepStrictEqual(authorized.data(), { schemaVersion: 1, episode }) ||
    born.exists ||
    !uploads.empty
  )
    return fail();
  return { facts, reserved, enrolled };
}
async function assertUnclaimedClose(
  tx: Transaction,
  execution: DocumentSnapshot,
  episode: AcquisitionEpisode,
  proof: HostResourceReply
) {
  const inputs = await unclaimedInputs(tx, execution, episode);
  const [closed, sealed] = await Promise.all([
    tx.get(execution.ref.collection('unclaimedClose').doc('original')),
    tx.get(inputs.facts.doc('sealed')),
  ]);
  immutable(closed);
  immutable(sealed);
  const value = closed.data() as UnclaimedEpisodeClose;
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      'enrollmentReceiptHash,episodeId,fact,ipcAttempted,kind,reservationReceiptHash,schemaVersion' ||
    value.schemaVersion !== 1 ||
    value.kind !== 'unclaimed' ||
    value.episodeId !== episode.id ||
    value.ipcAttempted !== false ||
    value.reservationReceiptHash !== inputs.reserved.get('proof.receiptHash') ||
    value.enrollmentReceiptHash !== inputs.enrolled.get('proof.receiptHash') ||
    !isDeepStrictEqual(execution.get('unclaimedClose'), value) ||
    !execution.updateTime?.isEqual(closed.createTime!) ||
    !closed.createTime?.isEqual(sealed.createTime!) ||
    !isDeepStrictEqual(sealed.get('proof'), proof)
  )
    return fail();
  validateUnclaimedFact(value.fact);
  return closed;
}
/** Parent cleanup only, from ORIGINAL live CLOSE with positively never-attempted
 * execution IPC and original held-scope drain. Atomic execution fence conflicts
 * with an in-flight claim; an unknown claim which committed is NOT unclaimed.
 * Unknown closure ACK reconciles exact immutable GETs and is never resent. */
export async function closeUnclaimedYouTubeEpisode(o: {
  firestore: Firestore;
  episode: AcquisitionEpisode;
  proof: HostResourceReply;
  fact: Readonly<YouTubeNativeClose>;
  boundary: Readonly<{ ipcAttempted: boolean }>;
}): Promise<void> {
  assertStagingAcquisitionDatabase(o.firestore);
  const episode = intent(o.episode, o.episode.ref),
    fact = Object.freeze({ ...o.fact });
  validateEpisodeDrain(o.proof, episode.id, 'drained');
  if (o.boundary.ipcAttempted !== false) return fail();
  validateUnclaimedFact(fact);
  const rootRef = o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(episode.operationId);
  let expected: UnclaimedEpisodeClose | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wall = Date.now(),
    mono = performance.now();
  const fresh = () => {
    if (Date.now() < wall || Date.now() - wall >= 5000 || performance.now() - mono >= 5000) return fail();
  };
  const work = async () => {
    try {
      await o.firestore.runTransaction(
        async (tx) => {
          const root = await tx.get(rootRef),
            execution = await readAcquisitionExecution(tx, root, episode.id);
          const inputs = await unclaimedInputs(tx, execution, episode);
          const closeRef = execution.ref.collection('unclaimedClose').doc('original');
          const [closed, sealed] = await Promise.all([tx.get(closeRef), tx.get(inputs.facts.doc('sealed'))]);
          fresh();
          if (execution.get('unclaimedClose') !== undefined || closed.exists || sealed.exists) return fail();
          expected = {
            schemaVersion: 1,
            kind: 'unclaimed',
            episodeId: episode.id,
            ipcAttempted: false,
            fact,
            reservationReceiptHash: inputs.reserved.get('proof.receiptHash'),
            enrollmentReceiptHash: inputs.enrolled.get('proof.receiptHash'),
          };
          tx.create(closeRef, expected);
          tx.create(inputs.facts.doc('sealed'), { schemaVersion: 1, episodeId: episode.id, proof: { ...o.proof } });
          tx.update(execution.ref, { unclaimedClose: expected });
        },
        { maxAttempts: 1 }
      );
      fresh();
    } catch {
      fresh();
      if (!expected) return fail();
      await o.firestore.runTransaction(
        async (tx) => {
          const root = await tx.get(rootRef),
            execution = await readAcquisitionExecution(tx, root, episode.id);
          const closed = await assertUnclaimedClose(tx, execution, episode, o.proof);
          fresh();
          if (!isDeepStrictEqual(closed.data(), expected)) return fail();
        },
        { maxAttempts: 1 }
      );
      fresh();
    }
  };
  try {
    await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('YOUTUBE_UNCLAIMED_CLOSE_UNCONFIRMED')), 5000);
      }),
    ]);
    fresh();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function assertPersistedYouTubeEpisodeClose(o: {
  firestore: Firestore;
  episode: AcquisitionEpisode;
  proof: HostResourceReply;
}): Promise<void> {
  validateEpisodeDrain(o.proof, o.episode.id, 'drained');
  await o.firestore.runTransaction(
    async (tx) => {
      const root = await tx.get(o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(o.episode.operationId));
      const parent = await readAcquisitionExecution(tx, root, o.episode.id);
      if (parent.get('unclaimedClose') !== undefined) {
        await assertUnclaimedClose(tx, parent, o.episode, o.proof);
        return;
      }
      await assertOwnedYouTubeEpisode(tx, parent, o.episode.id, parent.get('owner'));
      const [sealed, closed] = await Promise.all([
        tx.get(
          acquisitionDelegationRef(parent).collection('episodes').doc(o.episode.id).collection('facts').doc('sealed')
        ),
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
        const delegation = await tx.get(parent);
        const root = await readAcquisitionExecution(tx, delegation, o.episode.id);
        if (root.get('unclaimedClose') !== undefined) {
          const sealed = await tx.get(doc.parent.doc('sealed'));
          immutable(sealed);
          validateEpisodeDrain(sealed.get('proof'), o.episode.id, 'drained');
          await assertUnclaimedClose(tx, root, o.episode, sealed.get('proof'));
          if (sealed.get('proof.receiptHash') !== o.proof.receiptHash) return fail();
          tx.create(doc, expected);
          return;
        }
        await assertOwnedYouTubeEpisode(tx, root, o.episode.id, root.get('owner'));
        const closed = await tx.get(root.ref.collection('nativeClose').doc('original'));
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
  const facts = acquisitionDelegationRef(parent).collection('episodes').doc(id).collection('facts');
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
