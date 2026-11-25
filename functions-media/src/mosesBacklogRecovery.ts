import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Database } from 'firebase-admin/database';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import { computeProcessAudioRequestVersion, computeProcessAudioTaskId, sanitizeProcessAudioPayload } from '@upperroom/contracts/processAudioQueue';
import {
  MOSES_BACKLOG_FENCES_PATH, MOSES_RECOVERY_RECEIPTS_PATH, computeMosesBacklogCustody, computeMosesBacklogTaskId,
  getMosesRecoverySelection, mosesRecoveryDigest, type MosesBacklogEvidence, type MosesBacklogKind,
  type MosesBacklogReceipt, type MosesBacklogWitness,
} from '@upperroom/contracts/mosesDeferredRecovery';
import { MOSES_PILOT_INTENTS_PATH, PilotTaskNotCreated, type PilotTransport } from './legacyMosesGuestPilot';
import { withProcessAudioQueueClaim } from './processAudioQueueStore';

export interface BacklogSelection {
  kind: MosesBacklogKind;
  sermonId: string;
  videoId: string;
  requestVersion?: string;
  custodySha256?: string;
  releaseSha: string;
  witnessGeneration?: string;
  deriveCohortMissingVersion?: true;
}

export function getMosesBacklogSelection(env: NodeJS.ProcessEnv): BacklogSelection | null {
  const kind = env.PROCESS_AUDIO_MOSES_RECOVERY_KIND;
  const releaseSha = env.PROCESS_AUDIO_MOSES_BACKLOG_RELEASE_SHA;
  if ((kind !== 'failed_request' && kind !== 'missing_admission') || !releaseSha || !/^[a-f0-9]{40}$/u.test(releaseSha)) return null;
  // Discovery of a reconstructed version is read-only. Every apply requires an explicitly pinned version.
  const discoverVersion = kind === 'missing_admission' && env.PROCESS_AUDIO_MOSES_RECOVERY_REQUEST_VERSION === undefined;
  const selected = getMosesRecoverySelection(discoverVersion ? { ...env, PROCESS_AUDIO_MOSES_RECOVERY_REQUEST_VERSION: '0'.repeat(16) } : env);
  return selected && { ...selected, requestVersion: discoverVersion ? undefined : selected.requestVersion, kind, releaseSha };
}

export interface MosesBacklogNativeHead {
  payload: AddIntroOutroInputType;
  bumperGenerations: MosesBacklogEvidence['bumperGenerations'];
  documentCreateTime: string;
  documentUpdateTime: string;
}

export interface MosesBacklogDependencies {
  database: Database;
  readHead: (selection: BacklogSelection, originalPayload: AddIntroOutroInputType | undefined,
    priorTaskId: string | undefined, ownTaskId: string | undefined) => Promise<MosesBacklogNativeHead>;
  verifySourcePresent: (fence: MosesBacklogReceipt) => Promise<void>;
  verifyDocumentFence: (fence: MosesBacklogReceipt, install: boolean) => Promise<void>;
  readWitness: (fence: MosesBacklogReceipt) => Promise<MosesBacklogWitness | null>;
  prepare: () => Promise<PilotTransport>;
  assertCohortIdle?: () => Promise<void>;
}

const nope = (): never => { throw new Error('Backlog custody unavailable or changed.'); };
const holdIf = (condition: unknown): void => { if (condition) nope(); };

export async function recoverMosesBacklogRequest(mode: 'preview' | 'apply', select: BacklogSelection, deps: MosesBacklogDependencies) {
  const { database } = deps;
  const { sermonId, kind, videoId, releaseSha } = select;
  const fenceRef = database.ref(`${MOSES_BACKLOG_FENCES_PATH}/${sermonId}`);
  if (mode === 'apply') {
    const nativeMissing = select.kind === 'missing_admission' && select.deriveCohortMissingVersion === true;
    holdIf((!select.requestVersion && !nativeMissing) || !select.custodySha256);
  }
  const ownerPrefix = `moses-backlog:${select.custodySha256}:`;
  const owner = ownerPrefix + randomUUID();
  const read = async (ownTaskId?: string): Promise<MosesBacklogEvidence> => {
    const [request, lock, progress, deferred, probe, pilot, otherReceipts] = await Promise.all([
      database.ref(`processAudioRequests/${sermonId}`).get(), database.ref(`processAudioLocks/${sermonId}`).get(),
      database.ref(`addIntroOutro/${sermonId}`).get(), database.ref(`processAudioQueues/youtube/deferred/${sermonId}`).get(),
      database.ref('processAudioQueues/youtube/state/probeTaskSermonId').get(), database.ref(`${MOSES_PILOT_INTENTS_PATH}/${sermonId}`).get(),
      database.ref(`${MOSES_RECOVERY_RECEIPTS_PATH}/${sermonId}`).get(),
    ]);
    holdIf(lock.exists() || progress.exists() || deferred.exists() || pilot.exists() || otherReceipts.exists() ||
      (probe.exists() && (typeof probe.val() !== 'string' || probe.val() === sermonId)));
    const row = request.val();
    let original: AddIntroOutroInputType | undefined;
    let priorTaskId: string | undefined;
    if (kind === 'failed_request') {
      // The nine approved historical requests all have this native enqueue shape. Unknown or later state holds.
      const nativeFields = ['currentPayload', 'currentRequestVersion', 'queuedAt', 'queuedTaskId', 'sermonId', 'sourceType', 'transientRetryCount', 'updatedAt'];
      holdIf(!row || !isDeepStrictEqual(Object.keys(row).sort(), nativeFields) || row.transientRetryCount !== 0 ||
        row.sermonId !== sermonId || row.sourceType !== 'youtube' || row.currentRequestVersion !== select.requestVersion ||
        typeof row.queuedTaskId !== 'string' || !select.requestVersion ||
        !new RegExp('^' + computeProcessAudioTaskId(sermonId, select.requestVersion!) + '-[0-9a-f]{8}$', 'u').test(row.queuedTaskId) ||
        ![row.queuedAt, row.updatedAt].every(t => typeof t === 'string' && Number.isFinite(Date.parse(t)) && new Date(t).toISOString() === t) ||
        Date.parse(row.queuedAt) > Date.parse(row.updatedAt));
      original = row.currentPayload;
      priorTaskId = row.queuedTaskId;
      if (!original || !('youtubeUrl' in original)) return nope();
      holdIf(!isDeepStrictEqual(original, sanitizeProcessAudioPayload(original)) || computeProcessAudioRequestVersion(original) !== select.requestVersion);
    } else holdIf(request.exists());

    const head = await deps.readHead(select, original, priorTaskId, ownTaskId);
    const data = head.payload;
    holdIf(data.id !== sermonId || !('youtubeUrl' in data) || data.youtubeUrl !== `https://www.youtube.com/watch?v=${videoId}` ||
      !Number.isFinite(data.startTime) || data.startTime < 0 || !Number.isFinite(data.duration) || data.duration <= 0 || data.skipTranscode ||
      !isDeepStrictEqual(data, sanitizeProcessAudioPayload(data)) || (original && !isDeepStrictEqual(original, data)));
    const requestVersion = computeProcessAudioRequestVersion(data);
    holdIf(select.requestVersion && select.requestVersion !== requestVersion);
    return { schema: 2, kind, sermonId, videoId, releaseSha, requestVersion, requestSha256: mosesRecoveryDigest(row),
      ...(priorTaskId && { priorTaskId }), ...head };
  };
  const owns = async () => {
    const claims = await Promise.all([sermonId, '__youtube_auth_recovery__'].map(id => database.ref(`processAudioQueueClaims/${id}`).get()));
    holdIf(claims.some(s => mode === 'preview' ? s.exists() : s.child('requestId').val() !== owner ||
      !(Date.now() - s.child('acquiredAt').val() < 40_000)));
  };
  const run = async () => {
    if (mode === 'apply' && deps.assertCohortIdle) await deps.assertCohortIdle();
    await owns();
    let fence: MosesBacklogReceipt | null = (await fenceRef.get()).val();
    if (fence) {
      holdIf(fence.schema !== 2 || fence.sermonId !== sermonId || fence.kind !== kind || fence.videoId !== videoId ||
        (select.witnessGeneration && fence.witness && fence.witness.generation !== select.witnessGeneration) ||
        fence.releaseSha !== releaseSha || (select.requestVersion && fence.requestVersion !== select.requestVersion) ||
        (select.custodySha256 && fence.custodySha256 !== select.custodySha256) || computeMosesBacklogCustody(fence) !== fence.custodySha256 ||
        fence.taskId !== computeMosesBacklogTaskId(kind, sermonId, fence.requestVersion, fence.custodySha256) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(fence.nonce));
      if (['consumed', 'acknowledged', 'rejected'].includes(fence.phase)) {
        await deps.verifySourcePresent(fence);
        return { phase: fence.phase, requestVersion: fence.requestVersion, custodySha256: fence.custodySha256, taskId: fence.taskId };
      }
      holdIf(!['fenced', 'prepared', 'sending'].includes(fence.phase));
    }
    const evidence = await read(fence?.phase === 'sending' ? fence.taskId : undefined);
    const custodySha256 = computeMosesBacklogCustody(evidence);
    holdIf((select.custodySha256 && custodySha256 !== select.custodySha256) || (fence && fence.custodySha256 !== custodySha256));
    const taskId = computeMosesBacklogTaskId(kind, sermonId, evidence.requestVersion, custodySha256);
    const summary = (phase: string) => ({ phase, taskId, custodySha256, requestVersion: evidence.requestVersion });
    const move = async (next: MosesBacklogReceipt) => {
      await owns();
      const saved = await fenceRef.transaction(current => {
        if (current === null && fence) return null;
        return isDeepStrictEqual(current, fence) ? next : undefined;
      }, undefined, false);
      holdIf(!saved.committed || !isDeepStrictEqual(saved.snapshot.val(), next));
      fence = next;
      return summary(next.phase);
    };
    if (fence) await deps.verifyDocumentFence(fence, mode === 'apply' && fence.phase === 'fenced');
    if (mode === 'preview') return summary(fence?.phase ?? 'eligible_to_fence');
    // Installation is its own operator action. Empty queues and a GET 404 never authorize a POST.
    if (!fence) {
      const initial: MosesBacklogReceipt = { ...evidence, custodySha256, taskId, nonce: randomUUID(), phase: 'fenced', fencedAt: new Date().toISOString() };
      await move(initial);
      await deps.verifyDocumentFence(initial, true);
      return summary('fenced');
    }
    if (fence.phase !== 'sending') {
      const witness = await deps.readWitness(fence);
      if (!witness) return summary('waiting_for_witness');
      holdIf(witness.releaseSha !== releaseSha || !/^[1-9][0-9]*$/u.test(witness.generation) || !/^[a-f0-9]{64}$/u.test(witness.sha256) ||
        !Number.isFinite(Date.parse(witness.observedAt)) || Date.parse(witness.observedAt) < Date.parse(fence.fencedAt) ||
        Date.parse(witness.observedAt) > Date.now() || Date.now() - Date.parse(witness.observedAt) > 300_000);
      // Refresh a proven pre-send preparation after a crash, preserving fence nonce and stable task identity.
      await move({ ...fence, phase: 'prepared', queuedAt: new Date().toISOString(), witness });
    }
    const provider = await deps.prepare();
    const current: MosesBacklogReceipt = (await fenceRef.get()).val();
    holdIf(!isDeepStrictEqual(current, fence) || !current.witness || !current.queuedAt);
    const intent = { taskId, nonce: current.nonce, queuedAt: current.queuedAt!, requestVersion: evidence.requestVersion, eventId: custodySha256 };
    if (current.phase === 'prepared') {
      // Install only after a second post-witness native read, while the receipt and claims still own this head.
      const fresh = await read();
      await deps.verifyDocumentFence(current, false);
      holdIf(!isDeepStrictEqual(evidence, fresh) || Date.now() - Date.parse(current.queuedAt!) >= 25_000 ||
        Date.now() - Date.parse(current.witness!.observedAt) > 300_000);
      await move({ ...current, phase: 'sending' });
      try { await provider('create', evidence.payload, intent); }
      catch (error) {
        if (error instanceof PilotTaskNotCreated) return move({ ...current, phase: 'rejected' });
        throw new Error('Backlog task outcome unknown. Inspect the original task only.');
      }
    } else {
      holdIf(current.phase !== 'sending');
      await provider('inspect', evidence.payload, intent);
    }
    return move({ ...current, phase: 'acknowledged' });
  };
  if (mode === 'preview') return run();
  const ownExpired = (id: string) => id.startsWith(ownerPrefix);
  return withProcessAudioQueueClaim(database, '__youtube_auth_recovery__', owner,
    () => withProcessAudioQueueClaim(database, sermonId, owner, run, ownExpired), ownExpired);
}
