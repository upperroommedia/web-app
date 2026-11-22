import {
  readYouTubeRenderHeadTarget,
  readYouTubeRenderTarget,
  readYouTubeRenderRuntime,
  type YouTubeRenderTarget,
  type YouTubeRenderRuntime,
} from './youtube-render-target';
import { readRenderProfileSeal } from './hetzner-render-profile';
import { readReadyRenderAuthentication } from './hetzner-render-authentication';
import { readYouTubeRenderSlot } from './hetzner-render-slot';
import { readBoundYouTubeRenderReceipt } from './hetzner-render-receipt';
import { mediaWallTime } from './system-time';
import type { YouTubeNativeClose } from './hetzner-acquisition-process';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Firestore, Transaction, DocumentSnapshot } from 'firebase-admin/firestore';
import type { HostResourceReply } from '../host/resources';
import type { AcquisitionHostProcess } from './hetzner-acquisition-store';
import { MEDIA_ARCHIVE_RETRY_DELAYS, type MediaArchiveWait, type MediaJobRef } from './types';
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
  archiveAttempt: number;
  predecessor: null | {
    id: string;
    closeHash: string;
    releaseHash: string;
    providerHash: string;
    authenticationGeneration?: string;
    guestFailover?: true;
    authenticationHash?: string;
    archiveWaitHash?: string;
    archiveAuthorizationHash?: string;
  };
  invocation: AcquisitionInvocation;
  ref: MediaJobRef;
  preparedBy: AcquisitionPreparer;
  createdAt: number;
  renderTarget?: YouTubeRenderTarget;
  renderRuntime?: YouTubeRenderRuntime;
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
    !(
      (value.kind === 'retryable' && value.action === 'task_retry') ||
      (value.kind === 'waiting_archive' && value.action === 'post_live_retry') ||
      (value.kind === 'waiting_auth' && value.action === 'defer')
    ) ||
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
    const guestFailover = parsed.predecessor.guestFailover === true;
    if (
      (!guestFailover &&
        (!isDeepStrictEqual(previous.renderRuntime, parsed.renderRuntime) ||
          readYouTubeRenderTarget(previous.renderTarget) !== readYouTubeRenderTarget(parsed.renderTarget))) ||
      previous.ordinal + 1 !== parsed.ordinal ||
      previous.invocation.workflowId !== parsed.invocation.workflowId ||
      previous.invocation.runId !== parsed.invocation.runId ||
      (guestFailover
        ? previous.invocation.activityId !== parsed.invocation.activityId ||
          previous.invocation.attempt > parsed.invocation.attempt ||
          parsed.archiveAttempt !== previous.archiveAttempt
        : parsed.predecessor.authenticationGeneration !== undefined
        ? previous.invocation.activityId === parsed.invocation.activityId ||
          parsed.archiveAttempt !== previous.archiveAttempt
        : parsed.predecessor.archiveWaitHash === undefined
        ? previous.invocation.activityId !== parsed.invocation.activityId ||
          parsed.invocation.attempt <= previous.invocation.attempt ||
          parsed.archiveAttempt !== previous.archiveAttempt
        : previous.invocation.activityId === parsed.invocation.activityId ||
          parsed.archiveAttempt !== previous.archiveAttempt + 1)
    )
      return fail();
    const predecessorExecution =
      previous.ordinal === 1
        ? await tx.get(rootRef)
        : await tx.get(previousIntent.ref.collection('runtime').doc('current'));
    await episodeOriginal(tx, predecessorExecution, previousIntent, previous);
    const root = await tx.get(rootRef);
    if (guestFailover) {
      if (
        root.get('renderProtocol') !== 1 ||
        root.get('renderHeadTarget') !== 'hetzner' ||
        previous.renderTarget !== 'moses' ||
        parsed.renderTarget !== 'hetzner' ||
        !previous.renderRuntime ||
        !parsed.renderRuntime ||
        previous.renderRuntime.commit !== parsed.renderRuntime.commit
      )
        return fail();
      const proof = await readBoundRenderAuthenticationPredecessor(tx, predecessorExecution, previous);
      if (
        parsed.predecessor.closeHash !== proof.closeHash ||
        parsed.predecessor.releaseHash !== proof.closeHash ||
        parsed.predecessor.providerHash !== proof.candidateHash
      )
        return fail();
      return;
    }
    if (root.get('renderProtocol') === 1) {
      if (parsed.predecessor.authenticationGeneration !== undefined) {
        const proof = await readBoundRenderAuthentication(tx, predecessorExecution, previous);
        if (
          proof.ready.generation !== parsed.predecessor.authenticationGeneration ||
          proof.ready.proofHash !== parsed.predecessor.authenticationHash ||
          parsed.predecessor.providerHash !== proof.candidateHash ||
          parsed.predecessor.closeHash !== proof.closeHash ||
          parsed.predecessor.releaseHash !== proof.closeHash ||
          proof.ready.closedAt > parsed.createdAt ||
          proof.ready.invocation.activityId === parsed.invocation.activityId
        )
          return fail();
        return;
      }
      const proof = await readRenderArchiveProof(tx, predecessorExecution, previous);
      if (
        parsed.predecessor.archiveWaitHash !== nativeHash(proof.wait) ||
        parsed.predecessor.archiveAuthorizationHash !== nativeHash(proof.authorized) ||
        parsed.predecessor.providerHash !== proof.providerHash ||
        parsed.predecessor.closeHash !== proof.closeHash ||
        parsed.predecessor.releaseHash !== proof.closeHash
      )
        return fail();
      return;
    }
    const [close, released, uploads, provider] = await Promise.all([
      tx.get(predecessorExecution.ref.collection('nativeClose').doc('original')),
      tx.get(previousIntent.ref.collection('facts').doc('released')),
      tx.get(predecessorExecution.ref.collection('uploads').limit(1)),
      tx.get(previousIntent.ref.collection('facts').doc('providerOutcome')),
    ]);
    immutable(close);
    immutable(released);
    providerOutcome(provider, previous.id);
    if (parsed.predecessor.archiveWaitHash !== undefined) {
      const waitProof = await readArchiveWait(tx, previousIntent.ref, previous, provider, close, released);
      if (
        nativeHash(waitProof.wait) !== parsed.predecessor.archiveWaitHash ||
        nativeHash(waitProof.authorized) !== parsed.predecessor.archiveAuthorizationHash
      )
        return fail();
    }
    validateEpisodeDrain(released.get('proof'), previous.id, 'closed');
    if (
      nativeHash(provider) !== parsed.predecessor.providerHash ||
      provider.get('kind') !== (parsed.predecessor.archiveWaitHash === undefined ? 'retryable' : 'waiting_archive') ||
      provider.get('action') !==
        (parsed.predecessor.archiveWaitHash === undefined ? 'task_retry' : 'post_live_retry') ||
      provider.get('episodeId') !== previous.id ||
      nativeHash(close) !== parsed.predecessor.closeHash ||
      nativeHash(released) !== parsed.predecessor.releaseHash ||
      close.get('outcome') !== 'completed' ||
      released.get('proof.descendantsStopped') === true ||
      !isDeepStrictEqual(close.data(), predecessorExecution.get('nativeClose')) ||
      predecessorExecution.get('status') !== provider.get('kind') ||
      predecessorExecution.get('result.kind') !== provider.get('kind') ||
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
    ![
      'archiveAttempt,createdAt,id,invocation,operationId,ordinal,predecessor,preparedBy,ref,schemaVersion',
      'archiveAttempt,createdAt,id,invocation,operationId,ordinal,predecessor,preparedBy,ref,renderTarget,schemaVersion',
      'archiveAttempt,createdAt,id,invocation,operationId,ordinal,predecessor,preparedBy,ref,renderRuntime,renderTarget,schemaVersion',
    ].includes(Object.keys(value).sort().join(',')) ||
    value.schemaVersion !== 1 ||
    !uuid(value.id) ||
    value.operationId !== youtubeAcquisitionId(ref) ||
    youtubeAcquisitionId(value.ref) !== value.operationId ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal < 1 ||
    value.ordinal > 64 ||
    !Number.isSafeInteger(value.archiveAttempt) ||
    value.archiveAttempt < 0 ||
    value.archiveAttempt > 12 ||
    (value.ordinal === 1 && value.archiveAttempt !== 0) ||
    (value.ordinal === 1
      ? value.predecessor !== null
      : !value.predecessor ||
        ![
          'closeHash,id,providerHash,releaseHash',
          'authenticationGeneration,authenticationHash,closeHash,id,providerHash,releaseHash',
          'closeHash,guestFailover,id,providerHash,releaseHash',
          'archiveAuthorizationHash,archiveWaitHash,closeHash,id,providerHash,releaseHash',
        ].includes(Object.keys(value.predecessor).sort().join(',')) ||
        !uuid(value.predecessor.id) ||
        (value.predecessor.guestFailover !== undefined && value.predecessor.guestFailover !== true) ||
        !/^[a-f0-9]{64}$/.test(value.predecessor.closeHash) ||
        !/^[a-f0-9]{64}$/.test(value.predecessor.releaseHash) ||
        !/^[a-f0-9]{64}$/.test(value.predecessor.providerHash) ||
        (value.predecessor.authenticationGeneration !== undefined &&
          (!uuid(value.predecessor.authenticationGeneration) ||
            !/^[a-f0-9]{64}$/.test(value.predecessor.authenticationHash ?? ''))) ||
        (value.predecessor.archiveWaitHash !== undefined &&
          (!/^[a-f0-9]{64}$/.test(value.predecessor.archiveWaitHash) ||
            !/^[a-f0-9]{64}$/.test(value.predecessor.archiveAuthorizationHash ?? '')))) ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  )
    return fail();
  readYouTubeRenderTarget(value.renderTarget);
  readYouTubeRenderRuntime(value.renderRuntime);
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
  archiveResume?: MediaArchiveWait;
  render?: true;
  renderTarget?: YouTubeRenderTarget;
  renderRuntime?: YouTubeRenderRuntime;
  requireExistingRender?: boolean;
  authenticationGeneration?: string;
  guestFailoverFrom?: string;
  assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<void>;
}): Promise<string> {
  assertStagingAcquisitionDatabase(o.firestore);
  const renderTarget = readYouTubeRenderTarget(o.renderTarget);
  const renderRuntime = readYouTubeRenderRuntime(o.renderRuntime);
  if (!o.render && (o.renderTarget !== undefined || renderRuntime || o.requireExistingRender)) return fail();
  if (o.authenticationGeneration !== undefined && (!o.render || o.archiveResume || !uuid(o.authenticationGeneration)))
    return fail();
  if (
    o.guestFailoverFrom !== undefined &&
    (!uuid(o.guestFailoverFrom) ||
      !o.render ||
      renderTarget !== 'hetzner' ||
      !renderRuntime ||
      o.archiveResume !== undefined ||
      o.authenticationGeneration !== undefined)
  )
    return fail();
  const ref = Object.freeze({ ...o.ref }),
    caller = validateAcquisitionPreparer(o.caller);
  const parent = o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(ref));
  const episode: AcquisitionEpisode = {
    schemaVersion: 1,
    id: randomUUID(),
    ordinal: 1,
    archiveAttempt: 0,
    predecessor: null,
    invocation: invocation(o.invocation),
    operationId: parent.id,
    ref,
    preparedBy: caller,
    createdAt: mediaWallTime(),
    ...(renderTarget === 'moses' || renderRuntime ? { renderTarget } : {}),
    ...(renderRuntime && { renderRuntime }),
  };
  const doc = parent.collection('episodes').doc(episode.id);
  let executionRef = parent;
  let created = false;
  let selectedEpisodeId = episode.id;
  // An unacknowledged render proposal is never published. Publishing writes
  // the head and its authorization together, only after the proposal's known
  // commit. Any later Activity can proceed from the last authorized head.
  const proposal = parent.collection('renderProposals').doc(episode.id);
  const prepare = async (tx: Transaction, publishRender = false) => {
    const proposed = publishRender ? await tx.get(proposal) : undefined;
    const admitRender = () => {
      if (!proposed) {
        tx.create(proposal, episode);
        created = true;
        return false;
      }
      immutable(proposed);
      if (!isDeepStrictEqual(proposed.data(), episode)) return fail();
      tx.create(doc.collection('facts').doc('authorized'), { schemaVersion: 1, episode });
      return true;
    };
    const existing = await tx.get(parent);
    if (existing.exists) {
      const execution = await readAcquisitionExecution(tx, existing);
      const current = readYouTubeAcquisitionOperation(execution.data(), ref);
      const originalTarget = readYouTubeRenderHeadTarget(existing);
      const transferring = o.guestFailoverFrom !== undefined;
      if (
        (existing.get('renderProtocol') === 1) !== (o.render === true) ||
        originalTarget !== (transferring ? 'moses' : renderTarget) ||
        existing.get('renderStopped') === true
      )
        return fail();
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
      if (
        parsed.id !== saved ||
        readYouTubeRenderTarget(parsed.renderTarget) !== originalTarget ||
        (!transferring && renderRuntime !== undefined && !isDeepStrictEqual(parsed.renderRuntime, renderRuntime)) ||
        !isDeepStrictEqual(allowed.data(), { schemaVersion: 1, episode: parsed })
      )
        return fail();
      await o.assertCurrent(tx, ref);
      if (execution.get('unclaimedClose') !== undefined) return fail();
      if (transferring) {
        if (
          parsed.id !== o.guestFailoverFrom ||
          parsed.ordinal >= 64 ||
          !parsed.renderRuntime ||
          parsed.renderRuntime.commit !== renderRuntime?.commit ||
          parsed.invocation.workflowId !== episode.invocation.workflowId ||
          parsed.invocation.runId !== episode.invocation.runId ||
          parsed.invocation.activityId !== episode.invocation.activityId ||
          parsed.invocation.attempt > episode.invocation.attempt
        )
          return fail();
        // A successful guest provider outcome excludes artifact candidates. The
        // original parent commits positive process/descendant closure together
        // with reservation release. A missing or uncertain response proves none of this.
        const proof = await readBoundRenderAuthenticationPredecessor(tx, execution, parsed);
        if ((await readYouTubeRenderSlot(tx, o.firestore)).get('operationId') === parent.id) return fail();
        episode.ordinal = parsed.ordinal + 1;
        episode.archiveAttempt = parsed.archiveAttempt;
        episode.predecessor = {
          id: parsed.id,
          closeHash: proof.closeHash,
          releaseHash: proof.closeHash,
          providerHash: proof.candidateHash,
          guestFailover: true,
        };
        if (!admitRender()) return;
        tx.create(original.ref.collection('facts').doc('successor'), { schemaVersion: 1, episode });
        tx.create(doc, episode);
        tx.create(doc.collection('runtime').doc('current'), {
          schemaVersion: 1,
          operationId: parent.id,
          ref,
          preparedBy: caller,
          status: 'prepared',
          createdAt: episode.createdAt,
          preparedEpisode: episode.id,
        });
        tx.update(parent, { headEpisode: episode.id, renderHeadTarget: 'hetzner' });
        return;
      }
      if (isDeepStrictEqual(parsed.invocation, episode.invocation)) {
        selectedEpisodeId = parsed.id;
        return;
      }
      const sameScheduled =
        parsed.invocation.workflowId === episode.invocation.workflowId &&
        parsed.invocation.runId === episode.invocation.runId &&
        parsed.invocation.activityId === episode.invocation.activityId;
      // Later SDK attempts may observe an already running/settled original
      // operation. Monotonic states never become a new HTTP start permission.
      if (
        sameScheduled &&
        episode.invocation.attempt > parsed.invocation.attempt &&
        (o.render === true || !['prepared', 'retryable'].includes(current.status))
      ) {
        // An unresolved upload still fences later acquisition invocations.
        // The running episode may be observed again once its upload is settled.
        if (!o.render && execution.get('activeUpload') !== undefined) return fail();
        selectedEpisodeId = parsed.id;
        return;
      }
      if (o.render) {
        if (
          (!o.archiveResume && !o.authenticationGeneration) ||
          sameScheduled ||
          parsed.ordinal >= 64 ||
          parsed.invocation.workflowId !== episode.invocation.workflowId ||
          parsed.invocation.runId !== episode.invocation.runId ||
          parsed.invocation.activityId === episode.invocation.activityId
        )
          return fail();
        if (parsed.renderRuntime) {
          episode.renderRuntime = parsed.renderRuntime;
          episode.renderTarget = renderTarget;
        }
        episode.ordinal = parsed.ordinal + 1;
        if (o.authenticationGeneration) {
          const proof = await readBoundRenderAuthentication(tx, execution, parsed);
          if (
            !proof.ready.retainedSlot ||
            proof.ready.generation !== o.authenticationGeneration ||
            proof.ready.invocation.activityId === episode.invocation.activityId ||
            episode.createdAt < proof.ready.closedAt
          )
            return fail();
          episode.archiveAttempt = parsed.archiveAttempt;
          episode.predecessor = {
            id: parsed.id,
            closeHash: proof.closeHash,
            releaseHash: proof.closeHash,
            providerHash: proof.candidateHash,
            authenticationGeneration: proof.ready.generation,
            authenticationHash: proof.ready.proofHash,
          };
        } else {
          validateArchiveWait(o.archiveResume!);
          const proof = await readRenderArchiveProof(tx, execution, parsed);
          if (
            !isDeepStrictEqual(proof.wait.get('wait'), o.archiveResume!) ||
            mediaWallTime() < o.archiveResume!.dueAt ||
            o.archiveResume!.attempt !== parsed.archiveAttempt + 1
          )
            return fail();
          episode.ordinal = parsed.ordinal + 1;
          episode.archiveAttempt = o.archiveResume!.attempt;
          episode.predecessor = {
            id: parsed.id,
            closeHash: proof.closeHash,
            releaseHash: proof.closeHash,
            providerHash: proof.providerHash,
            archiveWaitHash: nativeHash(proof.wait),
            archiveAuthorizationHash: nativeHash(proof.authorized),
          };
        }
        if (!admitRender()) return;
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
      const archive = !sameScheduled && o.archiveResume !== undefined;
      if (
        current.status !== (archive ? 'waiting_archive' : 'retryable') ||
        current.result?.kind !== current.status ||
        current.nativeClose?.outcome !== 'completed' ||
        parsed.ordinal >= 64 ||
        parsed.invocation.workflowId !== episode.invocation.workflowId ||
        parsed.invocation.runId !== episode.invocation.runId ||
        (archive
          ? parsed.invocation.activityId === episode.invocation.activityId
          : parsed.invocation.activityId !== episode.invocation.activityId ||
            episode.invocation.attempt <= parsed.invocation.attempt)
      )
        return fail();
      await assertReleasedYouTubeEpisode(tx, execution);
      const provider = await tx.get(original.ref.collection('facts').doc('providerOutcome'));
      providerOutcome(provider, parsed.id);
      if (
        provider.get('kind') !== (archive ? 'waiting_archive' : 'retryable') ||
        provider.get('action') !== (archive ? 'post_live_retry' : 'task_retry')
      )
        return fail();
      const uploads = await tx.get(execution.ref.collection('uploads').limit(1));
      if (!uploads.empty || execution.get('activeUpload') !== undefined) return fail();
      const closed = await tx.get(execution.ref.collection('nativeClose').doc('original'));
      const released = await tx.get(original.ref.collection('facts').doc('released'));
      immutable(closed);
      immutable(released);
      episode.ordinal = parsed.ordinal + 1;
      episode.archiveAttempt = parsed.archiveAttempt;
      episode.predecessor = {
        id: parsed.id,
        closeHash: nativeHash(closed),
        releaseHash: nativeHash(released),
        providerHash: nativeHash(provider),
      };
      if (archive) {
        validateArchiveWait(o.archiveResume!);
        const saved = await readArchiveWait(tx, original.ref, parsed, provider, closed, released);
        if (
          !isDeepStrictEqual(saved.wait.get('wait'), o.archiveResume) ||
          mediaWallTime() < o.archiveResume!.dueAt ||
          o.archiveResume!.attempt !== parsed.archiveAttempt + 1
        )
          return fail();
        episode.archiveAttempt = o.archiveResume!.attempt;
        episode.predecessor.archiveWaitHash = nativeHash(saved.wait);
        episode.predecessor.archiveAuthorizationHash = nativeHash(saved.authorized);
      }

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
    if (o.requireExistingRender || o.archiveResume !== undefined || o.authenticationGeneration !== undefined)
      return fail();
    await o.assertCurrent(tx, ref);
    if (o.render && !admitRender()) return;
    tx.create(parent, {
      schemaVersion: 1,
      operationId: parent.id,
      ref,
      preparedBy: caller,
      status: 'prepared',
      createdAt: episode.createdAt,
      preparedEpisode: episode.id,
      ...(o.render ? { renderProtocol: 1 } : {}),
      ...(renderTarget === 'moses' ? { renderTarget } : {}),
    });
    tx.create(doc, episode);
    created = true;
  };
  await o.firestore.runTransaction((tx) => prepare(tx), { maxAttempts: 1 });
  if (!created) return selectedEpisodeId;
  if (o.render) {
    await o.firestore.runTransaction((tx) => prepare(tx, true), { maxAttempts: 1 });
    return selectedEpisodeId;
  }
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
  return selectedEpisodeId;
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
      const { episode } = await readPreparedYouTubeEpisodeInTransaction(tx, o);
      return episode;
    },
    { maxAttempts: 1 }
  );
}

/** A host claim and its durable delegation must be checked in the same transaction. */
export async function readPreparedYouTubeEpisodeInTransaction(
  tx: Transaction,
  o: { firestore: Firestore; ref: MediaJobRef; verifiedCallerEmail: string; render?: true }
) {
  const parent = o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(o.ref));
  const root = await tx.get(parent);
  if ((root.get('renderProtocol') === 1) !== (o.render === true)) return fail();
  const execution = await readAcquisitionExecution(tx, root);
  const current = readYouTubeAcquisitionOperation(execution.data(), o.ref);
  if (execution.get('unclaimedClose') !== undefined) return fail();
  const id = execution.get('preparedEpisode');
  if (!uuid(id) || current.status !== 'prepared' || current.preparedBy.serviceAccount !== o.verifiedCallerEmail)
    return fail();
  const original = await tx.get(parent.collection('episodes').doc(id));
  const allowed = await tx.get(original.ref.collection('facts').doc('authorized'));
  immutable(original);
  immutable(allowed);
  const episode = intent(original.data(), o.ref);
  await episodeOriginal(tx, execution, original, episode);
  if (
    episode.id !== id ||
    readYouTubeRenderTarget(episode.renderTarget) !== readYouTubeRenderHeadTarget(root) ||
    !isDeepStrictEqual(episode.preparedBy, current.preparedBy) ||
    !isDeepStrictEqual(allowed.data(), { schemaVersion: 1, episode })
  )
    return fail();
  return { episode, execution, root };
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
function validateArchiveWait(value: MediaArchiveWait): void {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'attempt,dueAt,scheduledAt' ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    value.attempt > 12 ||
    !Number.isSafeInteger(value.scheduledAt) ||
    value.scheduledAt < 0 ||
    !Number.isSafeInteger(value.dueAt) ||
    value.dueAt !==
      value.scheduledAt + MEDIA_ARCHIVE_RETRY_DELAYS[Math.min(value.attempt - 1, MEDIA_ARCHIVE_RETRY_DELAYS.length - 1)]
  )
    return fail();
}
async function readArchiveWait(
  tx: Transaction,
  doc: DocumentSnapshot['ref'],
  episode: AcquisitionEpisode,
  provider: DocumentSnapshot,
  closed: DocumentSnapshot,
  released: DocumentSnapshot
) {
  const [wait, authorized] = await Promise.all([
    tx.get(doc.collection('facts').doc('archiveWait')),
    tx.get(doc.collection('facts').doc('archiveWaitAuthorized')),
  ]);
  immutable(wait);
  immutable(authorized);
  const body = wait.data()!;
  if (
    Object.keys(body).sort().join(',') !==
    'acquisition,closeHash,episodeId,kind,operationId,projection,providerHash,ref,releaseHash,schemaVersion,sourceBuildId,wait'
  )
    return fail();
  validateArchiveWait(body.wait);
  invocation(body.projection);
  if (
    body.schemaVersion !== 1 ||
    body.kind !== 'archive' ||
    body.operationId !== episode.operationId ||
    body.episodeId !== episode.id ||
    body.sourceBuildId !== episode.preparedBy.buildId ||
    !isDeepStrictEqual(body.ref, episode.ref) ||
    !isDeepStrictEqual(body.acquisition, episode.invocation) ||
    body.wait.attempt !== episode.archiveAttempt + 1 ||
    body.projection.workflowId !== episode.invocation.workflowId ||
    body.projection.runId !== episode.invocation.runId ||
    body.projection.activityId === episode.invocation.activityId ||
    provider.get('kind') !== 'waiting_archive' ||
    body.providerHash !== nativeHash(provider) ||
    body.closeHash !== nativeHash(closed) ||
    body.releaseHash !== nativeHash(released) ||
    !isDeepStrictEqual(authorized.data(), { schemaVersion: 1, waitHash: nativeHash(wait) })
  )
    return fail();
  return { wait, authorized };
}
export async function readRenderAuthenticationPredecessor(
  tx: Transaction,
  o: { firestore: Firestore; ref: MediaJobRef; verifiedCallerEmail: string }
) {
  const { episode, execution } = await readPreparedYouTubeEpisodeInTransaction(tx, { ...o, render: true });
  return readBoundRenderAuthenticationPredecessor(tx, execution, episode);
}

async function readBoundRenderAuthenticationPredecessor(
  tx: Transaction,
  execution: DocumentSnapshot,
  episode: AcquisitionEpisode
) {
  const receipt = await readBoundYouTubeRenderReceipt(tx, episode.ref, episode, execution);
  if (receipt.kind !== 'waiting_auth') return fail();
  const render = execution.ref.collection('render');
  const [candidate, close] = await Promise.all([tx.get(render.doc('candidate')), tx.get(render.doc('close'))]);
  return { episode, execution, candidateHash: nativeHash(candidate), closeHash: nativeHash(close) };
}

async function readBoundRenderAuthentication(
  tx: Transaction,
  execution: DocumentSnapshot,
  episode: AcquisitionEpisode
) {
  const original = await readBoundRenderAuthenticationPredecessor(tx, execution, episode);
  const ready = await readReadyRenderAuthentication(
    tx,
    {
      firestore: execution.ref.firestore,
      ref: episode.ref,
      verifiedCallerEmail: episode.preparedBy.serviceAccount,
    },
    original
  );
  if (!ready) return fail();
  return { ...original, ready };
}

export async function readCurrentRenderAuthenticationSeal(
  tx: Transaction,
  execution: DocumentSnapshot,
  episode: AcquisitionEpisode,
  owner: AcquisitionHostProcess,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  const reference = episode.predecessor?.authenticationGeneration;
  if (reference === undefined) return undefined;
  const root = acquisitionDelegationRef(execution);
  const previousIntent = await tx.get(root.collection('episodes').doc(episode.predecessor!.id));
  const previous = intent(previousIntent.data(), episode.ref);
  const previousExecution = await tx.get(
    previous.ordinal === 1 ? root : previousIntent.ref.collection('runtime').doc('current')
  );
  const { ready } = await readBoundRenderAuthentication(tx, previousExecution, previous);
  if (ready.generation !== reference || ready.proofHash !== episode.predecessor!.authenticationHash) return fail();
  const now = mediaWallTime();
  return ready.owner.bootId === owner.bootId &&
    ready.owner.pidNamespace === owner.pidNamespace &&
    ready.owner.buildId === owner.buildId &&
    now >= ready.closedAt &&
    ready.profileSeal ===
      (await readRenderProfileSeal(AbortSignal.any([signal, AbortSignal.timeout(1000)])).catch(() => undefined))
    ? ready.profileSeal
    : null;
}

async function renderArchiveFacts(tx: Transaction, execution: DocumentSnapshot, episode: AcquisitionEpisode) {
  const receipt = await readBoundYouTubeRenderReceipt(tx, episode.ref, episode, execution);
  if (receipt.kind !== 'waiting_archive') return fail();
  const render = execution.ref.collection('render');
  const [provider, close] = await Promise.all([tx.get(render.doc('candidate')), tx.get(render.doc('close'))]);
  return { providerHash: nativeHash(provider), closeHash: nativeHash(close) };
}

async function readRenderArchiveProof(tx: Transaction, execution: DocumentSnapshot, episode: AcquisitionEpisode) {
  const facts = await renderArchiveFacts(tx, execution, episode);
  const render = execution.ref.collection('render');
  const [wait, authorized] = await Promise.all([
    tx.get(render.doc('archiveWait')),
    tx.get(render.doc('archiveWaitAuthorized')),
  ]);
  immutable(wait);
  immutable(authorized);
  const projection = invocation(wait.get('projection'));
  const timer = wait.get('wait') as MediaArchiveWait;
  validateArchiveWait(timer);
  if (
    !isDeepStrictEqual(wait.data(), {
      schemaVersion: 1,
      episodeId: episode.id,
      ref: episode.ref,
      projection,
      wait: timer,
      ...facts,
    }) ||
    timer.attempt !== episode.archiveAttempt + 1 ||
    projection.workflowId !== episode.invocation.workflowId ||
    projection.runId !== episode.invocation.runId ||
    projection.activityId === episode.invocation.activityId
  )
    return fail();
  if (authorized.get('schemaVersion') === 2) {
    const proposalId = authorized.get('proposalId');
    if (!uuid(proposalId) || !authorized.createTime!.isEqual(wait.createTime!)) return fail();
    const proposal = await tx.get(wait.ref.collection('proposals').doc(proposalId));
    if (
      !isDeepStrictEqual(proposal.data(), wait.data()) ||
      !isDeepStrictEqual(authorized.data(), { schemaVersion: 2, proposalId, proposalHash: nativeHash(proposal) })
    )
      return fail();
  } else if (!isDeepStrictEqual(authorized.data(), { schemaVersion: 1, waitHash: nativeHash(wait) })) return fail();
  return { wait, authorized, ...facts };
}

export async function recordNativeYouTubeRenderArchiveWait(o: {
  firestore: Firestore;
  ref: MediaJobRef;
  wait: MediaArchiveWait;
  invocation: AcquisitionInvocation;
  sourceBuildId: string;
  assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<void>;
}) {
  assertStagingAcquisitionDatabase(o.firestore);
  validateArchiveWait(o.wait);
  const proposalId = randomUUID(),
    projection = invocation(o.invocation),
    wall = mediaWallTime(),
    mono = performance.now();
  const fresh = () => {
    if (mediaWallTime() < wall || mediaWallTime() - wall >= 5000 || performance.now() - mono >= 5000) fail();
  };
  const verify = async (tx: Transaction) => {
    const root = await tx.get(o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(o.ref)));
    if (root.get('renderProtocol') !== 1) return fail();
    const execution = await readAcquisitionExecution(tx, root);
    const { episode } = await readPreparedYouTubeEpisodeInTransaction(tx, {
      ...o,
      verifiedCallerEmail: execution.get('preparedBy.serviceAccount'),
      render: true,
    });
    if (
      o.sourceBuildId !== episode.preparedBy.buildId ||
      o.wait.attempt !== episode.archiveAttempt + 1 ||
      projection.workflowId !== episode.invocation.workflowId ||
      projection.runId !== episode.invocation.runId ||
      projection.activityId === episode.invocation.activityId
    )
      return fail();
    const facts = await renderArchiveFacts(tx, execution, episode);
    const render = execution.ref.collection('render');
    const [wait, authorized] = await Promise.all([
      tx.get(render.doc('archiveWait')),
      tx.get(render.doc('archiveWaitAuthorized')),
    ]);
    await o.assertCurrent(tx, o.ref);
    fresh();
    return {
      execution,
      episode,
      wait,
      authorized,
      expected: { schemaVersion: 1, episodeId: episode.id, ref: o.ref, projection, wait: o.wait, ...facts },
    };
  };
  const created = await o.firestore.runTransaction(
    async (tx) => {
      const x = await verify(tx);
      if (x.wait.exists) {
        const prior = invocation(x.wait.get('projection'));
        if (
          !isDeepStrictEqual(x.wait.data(), { ...x.expected, projection: prior }) ||
          prior.activityId !== projection.activityId ||
          prior.attempt > projection.attempt
        )
          return fail();
        await readRenderArchiveProof(tx, x.execution, x.episode);
        fresh();
        return undefined;
      }
      if (x.authorized.exists || wall < o.wait.scheduledAt || wall - o.wait.scheduledAt > 5 * 60_000) return fail();
      const proposal = x.wait.ref.collection('proposals').doc(proposalId);
      tx.create(proposal, x.expected);
      return proposal;
    },
    { maxAttempts: 1 }
  );
  if (!created) return;
  await o.firestore.runTransaction(
    async (tx) => {
      const x = await verify(tx);
      const proposal = await tx.get(created);
      if (
        x.wait.exists ||
        x.authorized.exists ||
        created.path !== x.wait.ref.collection('proposals').doc(proposalId).path ||
        !isDeepStrictEqual(proposal.data(), x.expected)
      )
        return fail();
      const proposalHash = nativeHash(proposal);
      fresh();
      tx.create(x.wait.ref, x.expected);
      tx.create(x.authorized.ref, { schemaVersion: 2, proposalId, proposalHash });
    },
    { maxAttempts: 1 }
  );
  fresh();
}

/** Fixed native projection entrypoint, BEFORE the Workflow's durable archive
 * timer. No HTTP endpoint, elapsed timer or observer can create/repair it. */
export async function recordNativeYouTubeArchiveWait(o: {
  firestore: Firestore;
  ref: MediaJobRef;
  wait: MediaArchiveWait;
  invocation: AcquisitionInvocation;
  sourceBuildId: string;
  assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<void>;
}): Promise<void> {
  assertStagingAcquisitionDatabase(o.firestore);
  validateArchiveWait(o.wait);
  const projection = invocation(o.invocation),
    wall = mediaWallTime(),
    mono = performance.now();
  const fresh = () => {
    if (mediaWallTime() < wall || mediaWallTime() - wall >= 5000 || performance.now() - mono >= 5000) return fail();
  };
  const rootRef = o.firestore.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(o.ref));
  let created = false,
    expected: Record<string, unknown> | undefined,
    doc: DocumentSnapshot['ref'] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    await o.firestore.runTransaction(
      async (tx) => {
        const root = await tx.get(rootRef);
        if (!root.exists) return; // Ordinary local/traditional path has no delegation.
        const execution = await readAcquisitionExecution(tx, root),
          current = readYouTubeAcquisitionOperation(execution.data(), o.ref);
        const id = execution.get('preparedEpisode');
        if (
          !uuid(id) ||
          current.status !== 'waiting_archive' ||
          current.result?.kind !== 'waiting_archive' ||
          current.unclaimedClose !== undefined ||
          current.nativeClose?.outcome !== 'completed'
        )
          return fail();
        doc = rootRef.collection('episodes').doc(id);
        const original = await tx.get(doc),
          episode = intent(original.data(), o.ref);
        await episodeOriginal(tx, execution, original, episode);
        await assertReleasedYouTubeEpisode(tx, execution);
        if (
          o.sourceBuildId !== episode.preparedBy.buildId ||
          o.wait.attempt !== episode.archiveAttempt + 1 ||
          projection.workflowId !== episode.invocation.workflowId ||
          projection.runId !== episode.invocation.runId ||
          projection.activityId === episode.invocation.activityId
        )
          return fail();
        const [provider, closed, released, uploads, saved, authorized] = await Promise.all([
          tx.get(doc.collection('facts').doc('providerOutcome')),
          tx.get(execution.ref.collection('nativeClose').doc('original')),
          tx.get(doc.collection('facts').doc('released')),
          tx.get(execution.ref.collection('uploads').limit(1)),
          tx.get(doc.collection('facts').doc('archiveWait')),
          tx.get(doc.collection('facts').doc('archiveWaitAuthorized')),
        ]);
        providerOutcome(provider, id);
        if (!uploads.empty || execution.get('activeUpload') !== undefined || provider.get('kind') !== 'waiting_archive')
          return fail();
        expected = {
          schemaVersion: 1,
          kind: 'archive',
          operationId: episode.operationId,
          episodeId: id,
          ref: episode.ref,
          acquisition: episode.invocation,
          projection,
          sourceBuildId: o.sourceBuildId,
          wait: { ...o.wait },
          providerHash: nativeHash(provider),
          closeHash: nativeHash(closed),
          releaseHash: nativeHash(released),
        };
        await o.assertCurrent(tx, o.ref);
        fresh();
        if (saved.exists) {
          const prior = saved.get('projection') as AcquisitionInvocation;
          invocation(prior);
          if (
            prior.workflowId !== projection.workflowId ||
            prior.runId !== projection.runId ||
            prior.activityId !== projection.activityId ||
            prior.attempt > projection.attempt ||
            !isDeepStrictEqual(saved.data(), { ...expected, projection: prior })
          )
            return fail();
          await readArchiveWait(tx, doc, episode, provider, closed, released);
          return;
        }
        if (
          authorized.exists ||
          mediaWallTime() < o.wait.scheduledAt ||
          mediaWallTime() - o.wait.scheduledAt > 5 * 60_000
        )
          return fail();
        tx.create(doc.collection('facts').doc('archiveWait'), expected);
        created = true;
      },
      { maxAttempts: 1 }
    );
    fresh();
    if (!created || !doc || !expected) return;
    await o.firestore.runTransaction(
      async (tx) => {
        const root = await tx.get(rootRef),
          execution = await readAcquisitionExecution(tx, root);
        if (execution.get('preparedEpisode') !== doc!.id || execution.get('status') !== 'waiting_archive')
          return fail();
        const saved = await tx.get(doc!.collection('facts').doc('archiveWait'));
        immutable(saved);
        if (!isDeepStrictEqual(saved.data(), expected)) return fail();
        await o.assertCurrent(tx, o.ref);
        fresh();
        tx.create(doc!.collection('facts').doc('archiveWaitAuthorized'), {
          schemaVersion: 1,
          waitHash: nativeHash(saved),
        });
      },
      { maxAttempts: 1 }
    );
    fresh();
  };
  try {
    await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('YOUTUBE_ARCHIVE_WAIT_UNCONFIRMED')), 5000);
      }),
    ]);
    fresh();
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const wall = mediaWallTime(),
    mono = performance.now();
  const fresh = () => {
    if (mediaWallTime() < wall || mediaWallTime() - wall >= 5000 || performance.now() - mono >= 5000) return fail();
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
