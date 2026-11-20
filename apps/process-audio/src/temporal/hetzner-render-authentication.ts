import { awaitTrackedBrowserRefreshResult, isTrackedBrowserRefreshId } from './hetzner-render-refresh-result';
import {
  readYouTubeRenderSlot,
  reserveYouTubeRenderDispatch,
  requireYouTubeRenderSlot,
  retainedYouTubeRenderSlot,
  youtubeRenderSlot,
} from './hetzner-render-slot';
import { readRenderProfileSeal, withRenderProfileSnapshot } from './hetzner-render-profile';
import type { YouTubeNativeClose } from './hetzner-acquisition-process';
import { inspectNativeYouTubeProcess } from './hetzner-acquisition-identity';
import { validateYouTubeMediaByteCanaryReport, type YouTubeMediaByteCanaryReport } from '../youtubeReadiness';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import type { DocumentReference, DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
import { readRenderAuthenticationPredecessor, type AcquisitionInvocation } from './hetzner-acquisition-episode';
import {
  assertStagingAcquisitionDatabase,
  YOUTUBE_ACQUISITIONS,
  validateAcquisitionPreparer,
  type AcquisitionPreparer,
} from './hetzner-acquisition-store';
import type { MediaJobRef } from './types';

const denied = () => new Error('YOUTUBE_RENDER_AUTHENTICATION_UNCONFIRMED');
const immutable = (s: DocumentSnapshot) => s.exists && s.createTime?.isEqual(s.updateTime!);
const uuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s);

interface ReadAuthentication {
  firestore: Firestore;
  ref: MediaJobRef;
  verifiedCallerEmail: string;
}

function validInvocation(i: AcquisitionInvocation) {
  return (
    i &&
    Object.keys(i).sort().join(',') === 'activityId,attempt,runId,workflowId' &&
    [i.activityId, i.runId, i.workflowId].every(
      (value) => typeof value === 'string' && value.length > 0 && value.length <= 256
    ) &&
    Number.isSafeInteger(i.attempt) &&
    i.attempt > 0
  );
}

function completedProbe(id: string, claim: DocumentSnapshot, probe: DocumentSnapshot, close: YouTubeNativeClose) {
  const bytes = probe.get('bytes');
  const checkedAt = probe.get('checkedAt');
  const profileSeal = probe.get('profileSeal');
  return close.outcome === 'completed' &&
    close.exitCode === 0 &&
    close.exitSignal === null &&
    immutable(probe) &&
    probe.get('id') === id &&
    claim.updateTime!.isEqual(probe.get('claimVersion')) &&
    Number.isSafeInteger(bytes) &&
    bytes >= 0 &&
    Number.isSafeInteger(checkedAt) &&
    checkedAt >= claim.get('startedAt') &&
    checkedAt <= close.closedAt &&
    (bytes > 0 ? typeof profileSeal === 'string' && /^[a-f0-9]{64}$/.test(profileSeal) : profileSeal === null)
    ? { bytes: bytes as number, profileSeal: profileSeal as string | null, version: probe.updateTime! }
    : undefined;
}

async function readHead(
  tx: Transaction,
  o: ReadAuthentication,
  original?: Awaited<ReturnType<typeof readRenderAuthenticationPredecessor>>,
  allowUnarmed = false
) {
  original ??= await readRenderAuthenticationPredecessor(tx, o);
  const pointer = original.execution.ref.collection('render').doc('authentication');
  const state = await tx.get(pointer);
  if (!state.exists) return { original, pointer, head: undefined };
  const { id, ordinal } = state.data()!;
  if (!uuid(id) || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 72) throw denied();
  const doc = pointer.collection('attempts').doc(id);
  const [intent, authorized, completion] = await Promise.all([
    tx.get(doc),
    tx.get(doc.collection('facts').doc('authorized')),
    tx.get(doc.collection('facts').doc('completion')),
  ]);
  if (
    !immutable(intent) ||
    intent.get('schemaVersion') !== 1 ||
    intent.get('id') !== id ||
    intent.get('ordinal') !== ordinal ||
    !same(intent.get('ref'), o.ref) ||
    intent.get('episodeId') !== original.episode.id ||
    intent.get('candidateHash') !== original.candidateHash ||
    intent.get('closeHash') !== original.closeHash ||
    !validInvocation(intent.get('invocation')) ||
    intent.get('invocation.workflowId') !== original.episode.invocation.workflowId ||
    intent.get('invocation.runId') !== original.episode.invocation.runId ||
    intent.get('invocation.activityId') === original.episode.invocation.activityId ||
    intent.get('caller.serviceAccount') !== o.verifiedCallerEmail ||
    intent.get('caller.buildId') !== original.episode.preparedBy.buildId
  )
    throw denied();
  if (!authorized.exists) {
    if (!allowUnarmed || completion.exists) throw denied();
    const facts = doc.collection('facts');
    const [slot, ...activity] = await Promise.all([
      readYouTubeRenderSlot(tx, o.firestore),
      ...[
        'dispatch',
        'dispatchSubmission',
        'claim',
        'probe',
        'drain',
        'refreshAttempted',
        'refreshSettled',
        'abandoned',
      ].map((name) => tx.get(facts.doc(name))),
    ]);
    if (slot.get('authenticationId') === id || activity.some((fact) => fact.exists)) throw denied();
    return { original, pointer, head: { id, ordinal, intent, completion, armed: false } };
  }
  if (!immutable(authorized) || !authorized.get('intentVersion')?.isEqual(intent.updateTime!)) throw denied();
  if (completion.exists) {
    const facts = intent.ref.collection('facts');
    const [claim, probe, drain] = await Promise.all(['claim', 'probe', 'drain'].map((name) => tx.get(facts.doc(name))));
    const close = completion.get('close') as YouTubeNativeClose;
    const owner = completion.get('owner');
    if (
      !immutable(completion) ||
      !immutable(drain) ||
      !completion.createTime!.isEqual(drain.createTime!) ||
      completion.get('id') !== id ||
      !intent.updateTime!.isEqual(completion.get('intentVersion')) ||
      !close ||
      !Number.isSafeInteger(owner?.processId) ||
      owner.processId !== close.processId ||
      !Number.isSafeInteger(close.closedAt) ||
      !same(drain.data(), { id, owner, close })
    )
      throw denied();
    if (completion.get('neverClaimed') === true) {
      if (
        claim.exists ||
        probe.exists ||
        !['failed', 'cancelled'].includes(close.outcome) ||
        completion.get('probeVersion') !== null ||
        completion.get('profileSeal') !== null ||
        completion.get('status') !== 'failed'
      )
        throw denied();
    } else {
      if (
        !immutable(claim) ||
        claim.get('id') !== id ||
        claim.get('episodeId') !== original.episode.id ||
        !intent.updateTime!.isEqual(claim.get('intentVersion')) ||
        !same(owner, claim.get('owner')) ||
        close.closedAt < claim.get('startedAt')
      )
        throw denied();
      const verified = completedProbe(id, claim, probe, close);
      if (
        !same(completion.get('probeVersion'), verified?.version ?? null) ||
        completion.get('profileSeal') !== (verified?.profileSeal ?? null) ||
        completion.get('status') !== (verified?.bytes ? 'ready' : 'failed')
      )
        throw denied();
    }
  }
  return { original, pointer, head: { id, ordinal, intent, completion, armed: true } };
}

/** A known native Temporal commit authorizes exactly one recovery intent.
 * Retries observe it. A distinct recovery Activity can replace a settled
 * failed probe. A later invocation may replace an unarmed intent only while its authorization,
 * host slot and activity facts are absent. The original is never authorized. */
export async function prepareRenderAuthentication(o: {
  firestore: Firestore;
  ref: MediaJobRef;
  caller: AcquisitionPreparer;
  invocation: AcquisitionInvocation;
  assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<unknown>;
  signal: AbortSignal;
}) {
  assertStagingAcquisitionDatabase(o.firestore);
  const caller = validateAcquisitionPreparer(o.caller),
    invocation = o.invocation;
  if (!validInvocation(invocation)) throw denied();
  const ref = Object.freeze({ ...o.ref }),
    id = randomUUID();
  const read = { firestore: o.firestore, ref, verifiedCallerEmail: caller.serviceAccount };
  const wall = Date.now(),
    mono = performance.now();
  const fresh = () => {
    o.signal.throwIfAborted();
    if (Date.now() < wall || Date.now() - wall >= 5000 || performance.now() - mono >= 5000) throw denied();
  };
  const result = await o.firestore.runTransaction(
    async (tx) => {
      const { original, pointer, head } = await readHead(tx, read, undefined, true);
      if (
        invocation.workflowId !== original.episode.invocation.workflowId ||
        invocation.runId !== original.episode.invocation.runId ||
        invocation.activityId === original.episode.invocation.activityId ||
        caller.buildId !== original.episode.preparedBy.buildId
      )
        throw denied();
      await o.assertCurrent(tx, ref);
      fresh();
      const replaceable = head?.completion.get('status') === 'failed';
      const sameActivity = head?.intent.get('invocation.activityId') === invocation.activityId;
      if (head?.armed && (sameActivity || !replaceable)) return { id: head.id, created: false } as const;
      if (head && !head.armed && sameActivity && invocation.attempt <= head.intent.get('invocation.attempt'))
        throw denied();
      const ordinal = (head?.ordinal ?? 0) + 1;
      if (ordinal > 72) throw denied();
      const doc = pointer.collection('attempts').doc(id);
      const intent = {
        schemaVersion: 1,
        id,
        ordinal,
        ref,
        caller,
        invocation,
        episodeId: original.episode.id,
        candidateHash: original.candidateHash,
        closeHash: original.closeHash,
        predecessor: head
          ? head.armed
            ? { id: head.id, completionVersion: head.completion.updateTime! }
            : { id: head.id, unarmedIntentVersion: head.intent.updateTime! }
          : null,
        createdAt: wall,
      };
      if (head && !head.armed)
        tx.create(head.intent.ref.collection('facts').doc('abandoned'), {
          id: head.id,
          intentVersion: head.intent.updateTime!,
          successorId: id,
        });
      tx.create(doc, intent);
      tx.set(pointer, { id, ordinal });
      return { id, created: true, doc, pointer, intent } as const;
    },
    { maxAttempts: 1 }
  );
  if (!result.created) return result.id;
  await o.firestore.runTransaction(
    async (tx) => {
      const [pointer, intent] = await Promise.all([tx.get(result.pointer), tx.get(result.doc)]);
      const original = await readRenderAuthenticationPredecessor(tx, read);
      if (
        pointer.get('id') !== id ||
        !immutable(intent) ||
        !same(intent.data(), result.intent) ||
        original.episode.id !== result.intent.episodeId ||
        original.candidateHash !== result.intent.candidateHash ||
        original.closeHash !== result.intent.closeHash
      )
        throw denied();
      await o.assertCurrent(tx, ref);
      fresh();
      tx.create(result.doc.collection('facts').doc('authorized'), { intentVersion: intent.updateTime! });
    },
    { maxAttempts: 1 }
  );
  fresh();
  return id;
}

export async function readPreparedRenderAuthentication(tx: Transaction, o: ReadAuthentication & { id: string }) {
  const { original, head } = await readHead(tx, o);
  if (!head || head.id !== o.id) throw denied();
  return { original, ...head };
}

type RenderAuthenticationClaim = {
  id: string;
  episodeId: string;
  intentVersion: FirebaseFirestore.Timestamp;
  owner: Awaited<ReturnType<typeof inspectNativeYouTubeProcess>>;
  startedAt: number;
};

export async function claimRenderAuthentication(
  o: ReadAuthentication & {
    id: string;
    processId: number;
    buildId: string;
    assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<unknown>;
    assertFresh: () => void;
    onClaimAttempt?: (claim: RenderAuthenticationClaim) => void;
  }
) {
  assertStagingAcquisitionDatabase(o.firestore);
  if (o.processId === process.pid) throw denied();
  const owner = await inspectNativeYouTubeProcess(o.processId, o.buildId);
  return o.firestore.runTransaction(
    async (tx) => {
      const { intent, completion, original } = await readPreparedRenderAuthentication(tx, o);
      const root = await tx.get(o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(original.episode.operationId));
      if (root.get('renderStopped') === true) throw denied();
      const claim = intent.ref.collection('facts').doc('claim');
      const previous = await tx.get(claim);
      if (previous.exists || completion.exists) return undefined;
      const dispatch = await tx.get(intent.ref.collection('facts').doc('dispatch'));
      if (!immutable(dispatch) || !intent.updateTime!.isEqual(dispatch.get('intentVersion'))) throw denied();
      await requireYouTubeRenderSlot(tx, o.firestore, youtubeRenderSlot(o.ref, original.episode.id, o.id));
      await o.assertCurrent(tx, o.ref);
      if (!same(owner, await inspectNativeYouTubeProcess(o.processId, o.buildId))) throw denied();
      o.assertFresh();
      const startedAt = Date.now();
      if (startedAt < intent.get('createdAt')) throw denied();
      const saved: RenderAuthenticationClaim = {
        id: o.id,
        episodeId: original.episode.id,
        intentVersion: intent.updateTime!,
        owner,
        startedAt,
      };
      o.onClaimAttempt?.(saved);
      tx.create(claim, saved);
      return saved;
    },
    { maxAttempts: 1 }
  );
}

export async function recordRenderAuthenticationProbe(
  o: ReadAuthentication & {
    id: string;
    buildId: string;
    signal: AbortSignal;
    assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<unknown>;
    probe: () => Promise<YouTubeMediaByteCanaryReport>;
    directory: string;
    refresh: (watcherRequestId: string) => Promise<boolean>;
  }
) {
  assertStagingAcquisitionDatabase(o.firestore);
  o.signal.throwIfAborted();
  const owner = await inspectNativeYouTubeProcess(process.pid, o.buildId);
  const verify = async (tx: Transaction) => {
    const { intent, completion, original } = await readPreparedRenderAuthentication(tx, o);
    const root = await tx.get(o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(original.episode.operationId));
    if (root.get('renderStopped') === true) throw denied();
    await requireYouTubeRenderSlot(tx, o.firestore, youtubeRenderSlot(o.ref, original.episode.id, o.id));
    const claim = await tx.get(intent.ref.collection('facts').doc('claim'));
    await o.assertCurrent(tx, o.ref);
    o.signal.throwIfAborted();
    if (
      !immutable(claim) ||
      completion.exists ||
      claim.get('id') !== o.id ||
      claim.get('episodeId') !== original.episode.id ||
      !intent.updateTime!.isEqual(claim.get('intentVersion')) ||
      !same(claim.get('owner'), owner) ||
      !Number.isSafeInteger(claim.get('startedAt')) ||
      claim.get('startedAt') < intent.get('createdAt')
    )
      throw denied();
    return claim;
  };
  const original = await o.firestore.runTransaction(verify, { maxAttempts: 1 });
  let before = await readRenderProfileSeal(o.signal).catch(() => undefined);
  const unavailable = (): YouTubeMediaByteCanaryReport => ({
    scope: 'authenticated',
    checkedAt: new Date().toISOString(),
    succeeded: false,
    bytesDownloaded: 0,
    failureClass: 'cookie_session_unavailable',
  });
  const runProbe = async (seal: string | undefined) =>
    validateYouTubeMediaByteCanaryReport(
      seal
        ? await withRenderProfileSnapshot(o.directory, seal, o.signal, o.probe).catch((error) => {
            if (!(error instanceof Error) || error.message !== 'YOUTUBE_RENDER_PROFILE_UNCONFIRMED') throw error;
            o.signal.throwIfAborted();
            return unavailable();
          })
        : unavailable()
    );
  const verifyOriginal = async (tx: Transaction) => {
    const current = await verify(tx);
    if (!original.updateTime!.isEqual(current.updateTime!) || !same(original.data(), current.data())) throw denied();
    return current;
  };
  let report = await runProbe(before);
  if (
    report.failureClass === 'cookie_session_stale_or_challenged' ||
    report.failureClass === 'cookie_session_unavailable'
  ) {
    const facts = original.ref.parent;
    const attempted = facts.doc('refreshAttempted'),
      settled = facts.doc('refreshSettled');
    const refreshScope = { id: o.id, claimVersion: original.updateTime!, watcherRequestId: randomUUID() };
    await o.firestore.runTransaction(
      async (tx) => {
        await verifyOriginal(tx);
        tx.create(attempted, refreshScope);
      },
      { maxAttempts: 1 }
    );
    const refreshed = await o.refresh(refreshScope.watcherRequestId);
    // Once the exact external response is known, record it even if the
    // Activity has been cancelled. Settlement grants no further refresh.
    await o.firestore.runTransaction(
      async (tx) => {
        const [claim, prior] = await Promise.all([tx.get(original.ref), tx.get(attempted)]);
        if (
          !immutable(claim) ||
          !original.updateTime!.isEqual(claim.updateTime!) ||
          !same(claim.data(), original.data()) ||
          !immutable(prior) ||
          !same(prior.data(), refreshScope)
        )
          throw denied();
        tx.create(settled, { ...refreshScope, refreshed });
      },
      { maxAttempts: 1 }
    );
    o.signal.throwIfAborted();
    if (refreshed) {
      const next = await readRenderProfileSeal(o.signal).catch(() => undefined);
      if (next && next !== before) {
        await o.firestore.runTransaction(verifyOriginal, { maxAttempts: 1 });
        before = next;
        report = await runProbe(next);
      }
    }
  }
  const after = report.succeeded ? await readRenderProfileSeal(o.signal).catch(() => undefined) : undefined;
  const profileSeal = before && before === after ? before : null;
  const checkedAt = Date.parse(report.checkedAt);
  if (report.scope !== 'authenticated' || checkedAt < original.get('startedAt') || checkedAt > Date.now())
    throw denied();
  await o.firestore.runTransaction(
    async (tx) => {
      const claim = await verifyOriginal(tx);
      tx.create(claim.ref.parent.doc('probe'), {
        id: o.id,
        claimVersion: claim.updateTime!,
        checkedAt,
        bytes: report.succeeded && profileSeal ? report.bytesDownloaded : 0,
        profileSeal,
      });
    },
    { maxAttempts: 1 }
  );
}

class PendingBrowserRefresh extends Error {
  constructor(readonly watcherRequestId: string) {
    super('YOUTUBE_RENDER_AUTHENTICATION_UNCONFIRMED');
  }
}

export async function closeRenderAuthentication(
  o: ReadAuthentication & {
    id: string;
    claim: NonNullable<Awaited<ReturnType<typeof claimRenderAuthentication>>>;
    close: YouTubeNativeClose;
    ipcAttempted: boolean;
  }
) {
  assertStagingAcquisitionDatabase(o.firestore);
  if (o.close.processId !== o.claim.owner.processId || o.close.closedAt < o.claim.startedAt) throw denied();
  let proposal:
    | { drain: DocumentReference; completion: DocumentReference; drainData: object; completionData: object }
    | undefined;
  const persistClose = (watcherResult?: { requestId: string; refreshed: boolean }) => {
    proposal = undefined;
    return o.firestore.runTransaction(
      async (tx) => {
        const { original, intent, completion } = await readPreparedRenderAuthentication(tx, o);
        const facts = intent.ref.collection('facts');
        const [claim, probe, refreshAttempted, refreshSettled] = await Promise.all(
          ['claim', 'probe', 'refreshAttempted', 'refreshSettled'].map((name) => tx.get(facts.doc(name)))
        );
        if (claim.exists && !same(claim.data(), o.claim) && !o.ipcAttempted) return;
        if (completion.exists || (claim.exists && (!immutable(claim) || !same(claim.data(), o.claim)))) throw denied();
        let recoveredRefresh: object | undefined;
        if (refreshAttempted.exists || refreshSettled.exists || watcherResult) {
          if (!immutable(claim) || !immutable(refreshAttempted)) throw denied();
          const watcherRequestId = refreshAttempted.get('watcherRequestId');
          if (!isTrackedBrowserRefreshId(watcherRequestId)) throw denied();
          const expected = { id: o.id, claimVersion: claim.updateTime!, watcherRequestId };
          if (
            !same(refreshAttempted.data(), expected) ||
            (watcherResult && watcherResult.requestId !== watcherRequestId)
          )
            throw denied();
          if (refreshSettled.exists) {
            const refreshed = refreshSettled.get('refreshed');
            if (
              !immutable(refreshSettled) ||
              typeof refreshed !== 'boolean' ||
              !same(refreshSettled.data(), { ...expected, refreshed }) ||
              (watcherResult && watcherResult.refreshed !== refreshed)
            )
              throw denied();
          } else {
            if (!watcherResult) throw new PendingBrowserRefresh(watcherRequestId);
            recoveredRefresh = { ...expected, refreshed: watcherResult.refreshed };
          }
        }
        const neverClaimed = !claim.exists;
        if (neverClaimed) {
          const dispatch = await tx.get(facts.doc('dispatch'));
          if (
            o.ipcAttempted ||
            !['failed', 'cancelled'].includes(o.close.outcome) ||
            probe.exists ||
            !immutable(dispatch) ||
            !intent.updateTime!.isEqual(dispatch.get('intentVersion')) ||
            !intent.updateTime!.isEqual(o.claim.intentVersion) ||
            o.claim.id !== o.id ||
            o.claim.episodeId !== original.episode.id
          )
            throw denied();
        }
        // A late Firestore claim has read this same slot and completion record.
        // Releasing the slot and recording closure conflict with that claim.
        const slot = await requireYouTubeRenderSlot(
          tx,
          o.firestore,
          youtubeRenderSlot(o.ref, original.episode.id, o.id)
        );
        const verified = neverClaimed ? undefined : completedProbe(o.id, claim, probe, o.close);
        if (verified && !o.ipcAttempted) throw denied();
        const root = await tx.get(o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(original.episode.operationId));
        const retainedSlot = Boolean(verified?.bytes) && root.get('renderStopped') !== true;
        if (retainedSlot) tx.set(slot, retainedYouTubeRenderSlot(o.ref, original.episode.id, o.id));
        else tx.delete(slot);
        const drain = facts.doc('drain');
        const drainData = { id: o.id, owner: o.claim.owner, close: o.close };
        const completionData = {
          id: o.id,
          intentVersion: intent.updateTime!,
          probeVersion: verified?.version ?? null,
          owner: o.claim.owner,
          close: o.close,
          status: verified?.bytes ? 'ready' : 'failed',
          profileSeal: verified?.profileSeal ?? null,
          ...(retainedSlot ? { retainedSlot: true } : {}),
          ...(neverClaimed ? { neverClaimed: true } : {}),
        };
        proposal = { drain, completion: completion.ref, drainData, completionData };
        if (recoveredRefresh) tx.create(refreshSettled.ref, recoveredRefresh);
        tx.create(drain, drainData);
        tx.create(completion.ref, completionData);
      },
      { maxAttempts: 1 }
    );
  };
  let watcherResult: { requestId: string; refreshed: boolean } | undefined;
  const closeWithWatcherResult = async () => {
    try {
      await persistClose(watcherResult);
    } catch (error) {
      if (!(error instanceof PendingBrowserRefresh)) throw error;
      const controlDir = process.env.PROCESS_AUDIO_BROWSER_REFRESH_CONTROL_DIR?.trim();
      if (!controlDir) throw error;
      const refreshed = await awaitTrackedBrowserRefreshResult(controlDir, error.watcherRequestId);
      if (refreshed === undefined) throw error;
      watcherResult = { requestId: error.watcherRequestId, refreshed };
      await persistClose(watcherResult);
    }
  };
  try {
    try {
      await closeWithWatcherResult();
    } catch (error) {
      // A definite Firestore ABORTED can retry the same original close once.
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 10)) throw error;
      await closeWithWatcherResult();
    }
  } catch (error) {
    // Observe only the exact pair proposed by this invocation. A successor may
    // already own the slot, so a lost ACK never changes reservation custody.
    if (!proposal) throw error;
    const expected = proposal;
    const [drain, completion] = await o.firestore.runTransaction(
      (tx) => Promise.all([tx.get(expected.drain), tx.get(expected.completion)]),
      { readOnly: true }
    );
    if (
      !immutable(drain) ||
      !immutable(completion) ||
      !drain.createTime!.isEqual(completion.createTime!) ||
      !same(drain.data(), expected.drainData) ||
      !same(completion.data(), expected.completionData)
    )
      throw error;
  }
}

export async function authorizeRenderAuthenticationDispatch(
  o: ReadAuthentication & {
    id: string;
    signal: AbortSignal;
    assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<unknown>;
  }
) {
  assertStagingAcquisitionDatabase(o.firestore);
  o.signal.throwIfAborted();
  return reserveYouTubeRenderDispatch({
    firestore: o.firestore,
    signal: o.signal,
    assertCurrent: (tx) => o.assertCurrent(tx, o.ref),
    read: async (tx) => {
      const { intent, completion, original } = await readPreparedRenderAuthentication(tx, o);
      const root = await tx.get(o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(original.episode.operationId));
      const facts = intent.ref.collection('facts');
      const [dispatch, claim] = await Promise.all([tx.get(facts.doc('dispatch')), tx.get(facts.doc('claim'))]);
      return {
        dispatch,
        body: { intentVersion: intent.updateTime! },
        slot: youtubeRenderSlot(o.ref, original.episode.id, o.id),
        active: root.get('renderStopped') !== true && !claim.exists && !completion.exists,
      };
    },
  });
}

export async function readReadyRenderAuthentication(
  tx: Transaction,
  o: ReadAuthentication,
  original?: Awaited<ReturnType<typeof readRenderAuthenticationPredecessor>>
) {
  const { head } = await readHead(tx, o, original);
  if (!head || head.completion.get('status') !== 'ready') return undefined;
  const stamp = head.completion.updateTime!;
  const proofHash = createHash('sha256')
    .update(
      JSON.stringify({
        id: head.id,
        completion: head.completion.data(),
        seconds: stamp.seconds,
        nanoseconds: stamp.nanoseconds,
      })
    )
    .digest('hex');
  return {
    generation: head.id,
    retainedSlot: head.completion.get('retainedSlot') === true,
    proofHash,
    closedAt: head.completion.get('close.closedAt') as number,
    profileSeal: head.completion.get('profileSeal') as string,
    owner: head.completion.get('owner') as Awaited<ReturnType<typeof inspectNativeYouTubeProcess>>,
    invocation: head.intent.get('invocation') as AcquisitionInvocation,
  };
}
