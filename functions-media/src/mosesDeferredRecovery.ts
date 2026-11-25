import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Database } from 'firebase-admin/database';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import { computeProcessAudioRequestVersion, sanitizeProcessAudioPayload } from '@upperroom/contracts/processAudioQueue';
import {
  computeMosesRecoveryCustody, computeMosesRecoveryTaskId, MOSES_RECOVERY_RECEIPTS_PATH, mosesRecoveryDigest,
  type MosesDeferredRecoveryReceipt, type MosesDeferredRecoveryReservation, type MosesRecoverySelection,
} from '@upperroom/contracts/mosesDeferredRecovery';
import { MOSES_PILOT_INTENTS_PATH, PilotTaskNotCreated, type PilotTransport } from './legacyMosesGuestPilot';
import { withProcessAudioQueueClaim } from './processAudioQueueStore';

const QUEUE = 'processAudioQueues/youtube';
type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
const requireEvidence = (ok: unknown): void => { if (!ok) throw new Error('Recovery evidence is missing or has changed.'); };

type NativeDocument = { documentCreateTime: string; documentUpdateTime: string };
export interface MosesRecoveryDependencies {
  database: Database;
  readNative: (payload: AddIntroOutroInputType, ownedTaskId?: string) => Promise<NativeDocument>;
  prepare: () => Promise<PilotTransport>;
}

function isWaiting(state: unknown): boolean {
  const queue = row(state);
  return queue?.probeStatus === 'waiting_for_auth_required_request' && queue.probeTaskSermonId == null &&
    queue.probeRequestVersion == null && queue.probeDispatchReservationId == null;
}

function queueAllowsReservedItem(state: unknown, sermonId: string): boolean {
  const queue = row(state);
  if (!queue || queue.probeTaskSermonId === sermonId) return false;
  if (queue.probeStatus === 'probing') return typeof queue.probeTaskSermonId === 'string' && queue.probeTaskSermonId !== '';
  return ['idle', 'blocked', 'waiting_for_auth_required_request', 'probe_succeeded', 'probe_failed'].includes(String(queue.probeStatus));
}

function checkedPayload(selection: MosesRecoverySelection, request: Row, deferred: Row): AddIntroOutroInputType {
  const raw = row(request.currentPayload);
  requireEvidence(raw && raw.id === selection.sermonId && raw.youtubeUrl === `https://www.youtube.com/watch?v=${selection.videoId}` &&
    Number.isFinite(raw.startTime) && Number(raw.startTime) >= 0 && Number.isFinite(raw.duration) && Number(raw.duration) > 0 &&
    raw.skipTranscode !== true && isDeepStrictEqual(raw, deferred.payload));
  const payload = raw as AddIntroOutroInputType;
  requireEvidence(isDeepStrictEqual(payload, sanitizeProcessAudioPayload(payload)) &&
    computeProcessAudioRequestVersion(payload) === selection.requestVersion &&
    request.sermonId === selection.sermonId && request.sourceType === 'youtube' && request.currentRequestVersion === selection.requestVersion &&
    deferred.sermonId === selection.sermonId && deferred.requestVersion === selection.requestVersion &&
    deferred.probeMode === 'cookie_provider' && deferred.disposition === 'WAITING_FOR_YOUTUBE_AUTH' &&
    deferred.dependencyScope === 'authenticated_session' && deferred.lastFailureClass === 'cookie_session_stale_or_challenged' &&
    typeof deferred.deferredAt === 'string' && deferred.deferredAt === request.deferredAt &&
    Number.isFinite(Date.parse(deferred.deferredAt)) &&
    ['queuedTaskId', 'queuedAt', 'runningRequestId', 'runningTaskId', 'runningRequestVersion', 'runningAt', 'nextPayload',
      'nextRequestVersion', 'nextUpdatedAt', 'lastCompletedRequestVersion', 'lastSuccessfulYouTubeAcquisitionRequestVersion',
      'mosesGuestPilot', 'mosesGuestPilotIntent', 'transientRetryNextRunAt'].every(key => request[key] == null));
  return payload;
}

function reservation(receipt: MosesDeferredRecoveryReceipt): MosesDeferredRecoveryReservation {
  const { taskId, nonce, requestVersion, custodySha256 } = receipt;
  return { taskId, nonce, requestVersion, custodySha256 };
}

// The reservation and the entire original deferral share one atomic transaction. Nothing
// changes for another item or the shared cookie probe, including its physical deferred count.
async function transition(database: Database, original: Row, from: MosesDeferredRecoveryReceipt | null, to: MosesDeferredRecoveryReceipt) {
  const result = await database.ref(QUEUE).transaction(current => {
    if (current === null) return null;
    const deferred = row(current.deferred?.[to.sermonId]);
    if (!deferred || !(from ? queueAllowsReservedItem(current.state, to.sermonId) : isWaiting(current.state))) return undefined;
    const { mosesRecoveryReservation, ...source } = deferred;
    if (!isDeepStrictEqual(source, original) ||
        !isDeepStrictEqual(mosesRecoveryReservation ?? null, from && reservation(from)) ||
        !isDeepStrictEqual(current.mosesRecoveries?.[to.sermonId]?.[to.requestVersion] ?? null, from)) return undefined;
    return {
      ...current,
      deferred: { ...current.deferred, [to.sermonId]: to.phase === 'rejected' ? source : { ...source, mosesRecoveryReservation: reservation(to) } },
      mosesRecoveries: { ...current.mosesRecoveries, [to.sermonId]: { ...current.mosesRecoveries?.[to.sermonId], [to.requestVersion]: to } },
    };
  }, undefined, false);
  requireEvidence(result.committed && isDeepStrictEqual(result.snapshot.child(`mosesRecoveries/${to.sermonId}/${to.requestVersion}`).val(), to));
}

export async function recoverDeferredMosesRequest(
  mode: 'preview' | 'apply', selection: MosesRecoverySelection, deps: MosesRecoveryDependencies
) {
  const { database } = deps;
  const { sermonId, requestVersion, videoId } = selection;
  if (mode === 'apply') requireEvidence(selection.custodySha256);
  const ownerPrefix = `moses-recovery:${selection.custodySha256}:`;
  const owner = ownerPrefix + randomUUID();
  const ownsClaims = async () => {
    const claims = await Promise.all([sermonId, '__youtube_auth_recovery__'].map(id =>
      database.ref(`processAudioQueueClaims/${id}`).get()));
    requireEvidence(claims.every(snapshot => snapshot.child('requestId').val() === owner &&
      typeof snapshot.child('acquiredAt').val() === 'number' && Date.now() - snapshot.child('acquiredAt').val() < 40_000));
  };
  const run = async () => {
    const [requestSnap, deferredSnap, queue, lock, progress, pilot, stored] = await Promise.all([
      database.ref(`processAudioRequests/${sermonId}`).get(), database.ref(`${QUEUE}/deferred/${sermonId}`).get(),
      database.ref(`${QUEUE}/state`).get(), database.ref(`processAudioLocks/${sermonId}`).get(),
      database.ref(`addIntroOutro/${sermonId}`).get(), database.ref(`${MOSES_PILOT_INTENTS_PATH}/${sermonId}`).get(),
      database.ref(`${MOSES_RECOVERY_RECEIPTS_PATH}/${sermonId}/${requestVersion}`).get(),
    ]);
    let receipt = stored.val() as MosesDeferredRecoveryReceipt | null;
    if (receipt) {
      requireEvidence(receipt.schema === 1 && receipt.kind === 'deferred_cookie' &&
        receipt.sermonId === sermonId && receipt.videoId === videoId && receipt.requestVersion === requestVersion &&
        (!selection.custodySha256 || receipt.custodySha256 === selection.custodySha256) &&
        computeMosesRecoveryCustody(receipt) === receipt.custodySha256 &&
        receipt.taskId === computeMosesRecoveryTaskId(sermonId, requestVersion, receipt.custodySha256) &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(receipt.nonce) &&
        typeof receipt.queuedAt === 'string' && Number.isFinite(Date.parse(receipt.queuedAt)) &&
        new Date(receipt.queuedAt).toISOString() === receipt.queuedAt);
      if (['acknowledged', 'rejected', 'consumed'].includes(receipt.phase)) {
        return { phase: receipt.phase, taskId: receipt.taskId, custodySha256: receipt.custodySha256 };
      }
      requireEvidence(receipt.phase === 'prepared' || receipt.phase === 'sending');
    }
    const request = row(requestSnap.val());
    const entry = row(deferredSnap.val());
    if (!request || !entry || lock.exists() || progress.exists() || pilot.exists() ||
        !(receipt ? queueAllowsReservedItem(queue.val(), sermonId) : isWaiting(queue.val()))) {
      throw new Error('The selected deferral has an incumbent owner or is unavailable.');
    }
    const { mosesRecoveryReservation, ...deferred } = entry;
    requireEvidence(isDeepStrictEqual(mosesRecoveryReservation ?? null, receipt && reservation(receipt)));
    const payload = checkedPayload(selection, request, deferred);
    const document = await deps.readNative(payload, receipt?.phase === 'sending' ? receipt.taskId : undefined);
    const evidence = { sermonId, videoId, requestVersion, requestSha256: mosesRecoveryDigest(request),
      deferredSha256: mosesRecoveryDigest(deferred), ...document };
    const custodySha256 = computeMosesRecoveryCustody(evidence);
    const taskId = computeMosesRecoveryTaskId(sermonId, requestVersion, custodySha256);
    if (selection.custodySha256) requireEvidence(selection.custodySha256 === custodySha256);
    if (receipt) requireEvidence(custodySha256 === receipt.custodySha256);
    if (mode === 'preview') return { phase: receipt?.phase ?? 'eligible', custodySha256, taskId };
    const provider = await deps.prepare();
    if (!receipt) {
      receipt = { ...evidence, custodySha256, taskId, schema: 1, kind: 'deferred_cookie', nonce: randomUUID(),
        queuedAt: new Date().toISOString(), phase: 'prepared' };
      await ownsClaims();
      await transition(database, deferred, null, receipt);
    }
    const intent = { eventId: custodySha256, taskId, requestVersion, nonce: receipt.nonce, queuedAt: receipt.queuedAt };
    const move = async (phase: MosesDeferredRecoveryReceipt['phase']) => {
      await ownsClaims();
      const next = { ...receipt!, phase };
      await transition(database, deferred, receipt, next);
      receipt = next;
      return { phase, taskId, custodySha256 };
    };
    if (receipt.phase === 'prepared') {
      // Retry a pre-send crash only while the original dispatch window is still valid.
      if (Date.now() >= Date.parse(receipt.queuedAt) + 25_000) return move('rejected');
      const [freshRequest, freshLock, freshProgress, freshDocument] = await Promise.all([
        database.ref(`processAudioRequests/${sermonId}`).get(), database.ref(`processAudioLocks/${sermonId}`).get(),
        database.ref(`addIntroOutro/${sermonId}`).get(), deps.readNative(payload),
      ]);
      if (!isDeepStrictEqual(freshRequest.val(), request) || freshLock.exists() || freshProgress.exists() ||
          !isDeepStrictEqual(freshDocument, document) || Date.now() >= Date.parse(receipt.queuedAt) + 25_000) {
        return move('rejected');
      }
      await move('sending');
      try { await provider('create', payload, intent); }
      catch (error) {
        if (error instanceof PilotTaskNotCreated) return move('rejected');
        throw new Error('Recovery send outcome is unknown. Reconcile only this task.');
      }
    } else {
      await provider('inspect', payload, intent);
    }
    return move('acknowledged');
  };
  if (mode === 'preview') {
    const claims = await Promise.all([sermonId, '__youtube_auth_recovery__'].map(id => database.ref(`processAudioQueueClaims/${id}`).get()));
    requireEvidence(claims.every(snapshot => !snapshot.exists()));
    return run();
  }
  // Same lock order as worker startup. Recheck physical owners again inside both claims.
  const ownExpired = (id: string) => id.startsWith(ownerPrefix);
  return withProcessAudioQueueClaim(database, '__youtube_auth_recovery__', owner,
    () => withProcessAudioQueueClaim(database, sermonId, owner, run, ownExpired), ownExpired);
}
