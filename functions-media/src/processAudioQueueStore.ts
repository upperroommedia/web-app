import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MOSES_BACKLOG_FENCES_PATH, type MosesBacklogReceipt } from '@upperroom/contracts/mosesDeferredRecovery';
import { getProcessAudioTargetUri } from './processAudioService';
import { MOSES_PILOT_INTENTS_PATH, PilotTaskNotCreated, prepareLegacyMosesPilotTransport, type PilotSendIntent, type PilotTransport } from './legacyMosesGuestPilot';
import type { Database } from 'firebase-admin/database';
import { getFunctions, type TaskQueue } from 'firebase-admin/functions';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import type { BrowserFallbackErrorCode, BrowserFallbackSessionState } from '@upperroom/contracts/browserFallback';
import type { GetYouTubeCookieStatusOutputType } from '@upperroom/contracts/getYouTubeCookieStatus';
import {
  buildInitialYouTubeQueueState,
  computeProcessAudioRequestVersion,
  computeProcessAudioTaskId,
  getProcessAudioTaskQueueNameForSource,
  getProcessAudioSourceType,
  isProcessAudioLockActive,
  PROCESS_AUDIO_LOCKS_PATH,
  PROCESS_AUDIO_QUEUE_CLAIMS_PATH,
  PROCESS_AUDIO_REQUESTS_PATH,
  PROCESS_AUDIO_QUEUE_CLAIM_TTL_MS,
  PROCESS_AUDIO_DEFERRED_DISPOSITIONS,
  sanitizeProcessAudioPayload,
  type ProcessAudioSourceType,
  type MosesGuestPilotMarker,
  type LegacyStoredDeferredYouTubeRequest,
  type StoredDeferredYouTubeRequest,
  type StoredProcessAudioRequestState,
  type StoredYouTubeQueueState,
  type YouTubeQueueProbeMode,
  YOUTUBE_BROWSER_FALLBACK_BLOCKER_REASON,
  YOUTUBE_QUEUE_DEFERRED_PATH,
  YOUTUBE_QUEUE_STATE_PATH,
} from '@upperroom/contracts/processAudioQueue';
import type { YouTubeCookieMetadata } from '@upperroom/contracts/youtubeCookies';

type QueueMutationResult =
  | {
      action: 'queued';
      requestVersion: string;
      taskId: string;
      sourceType: ProcessAudioSourceType;
    }
  | {
      action: 'deferred';
      requestVersion: string;
      sourceType: ProcessAudioSourceType;
    }
  | {
      action: 'running_replaced';
      requestVersion: string;
      sourceType: ProcessAudioSourceType;
    }
  | {
      action: 'unchanged';
      requestVersion: string;
      sourceType: ProcessAudioSourceType;
    };

const CLAIM_ACQUIRE_ATTEMPTS = 20;
const CLAIM_ACQUIRE_DELAY_MS = 150;
const STALE_YOUTUBE_QUEUE_PROBE_MS = 2 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
};

const getNowIsoString = (): string => new Date().toISOString();

const countChildren = (value: unknown): number => {
  const record = asRecord(value);
  return record ? Object.keys(record).length : 0;
};

const parseYouTubeQueueState = (value: unknown): StoredYouTubeQueueState => {
  const record = asRecord(value);
  return {
    ...buildInitialYouTubeQueueState(),
    ...(record as Partial<StoredYouTubeQueueState> | null),
  };
};

// RTDB transactions begin from a process-local cache. In a cold Functions
// instance that cache is `null`; returning `undefined` there aborts before the
// SDK asks the server for the live queue state. Prime the comparison with one
// null-to-null no-op so guarded transitions retry against authoritative data.
const runGuardedYouTubeQueueStateTransaction = async (
  database: Database,
  update: (currentQueueState: StoredYouTubeQueueState) => StoredYouTubeQueueState | undefined
) => {
  let primedColdCache = false;
  let mutationApplied = false;
  const result = await database.ref(YOUTUBE_QUEUE_STATE_PATH).transaction(
    (current) => {
      if (current === null && !primedColdCache) {
        primedColdCache = true;
        return null;
      }

      const next = update(parseYouTubeQueueState(current));
      if (next === undefined) {
        return undefined;
      }
      mutationApplied = true;
      return next;
    },
    undefined,
    false
  );

  return {
    ...result,
    committed: result.committed && mutationApplied,
  };
};

const reconcileDeferredYouTubeTaskCount = (
  currentCount: number,
  observedCount: number,
  desiredObservedCount: number
): number => Math.max(0, currentCount + desiredObservedCount - observedCount);

const matchesObservedYouTubeProbe = (current: StoredYouTubeQueueState, observed: StoredYouTubeQueueState): boolean =>
  current.probeStatus === observed.probeStatus &&
  current.probeMode === observed.probeMode &&
  current.probeTaskSermonId === observed.probeTaskSermonId &&
  current.probeRequestVersion === observed.probeRequestVersion &&
  current.probeStartedAt === observed.probeStartedAt &&
  (current.probeDispatchReservationId ?? null) === (observed.probeDispatchReservationId ?? null) &&
  (current.lastAttemptedAuthRecoveryGeneration ?? null) === (observed.lastAttemptedAuthRecoveryGeneration ?? null);

let youtubeTaskQueueFactoryForTesting: (() => TaskQueue<AddIntroOutroInputType>) | null = null;

export function setYouTubeTaskQueueFactoryForTesting(factory: (() => TaskQueue<AddIntroOutroInputType>) | null): void {
  youtubeTaskQueueFactoryForTesting = factory;
}

const getYouTubeTaskQueue = (): TaskQueue<AddIntroOutroInputType> =>
  youtubeTaskQueueFactoryForTesting?.() ??
  getFunctions().taskQueue<AddIntroOutroInputType>(getProcessAudioTaskQueueNameForSource('youtube'));

const buildProcessAudioRequestState = (
  payload: AddIntroOutroInputType,
  requestVersion: string,
  updatedAt: string
): StoredProcessAudioRequestState => {
  const sanitizedPayload = sanitizeProcessAudioPayload(payload);
  return {
    sermonId: sanitizedPayload.id,
    sourceType: getProcessAudioSourceType(sanitizedPayload),
    currentPayload: sanitizedPayload,
    currentRequestVersion: requestVersion,
    queuedTaskId: null,
    queuedAt: null,
    runningRequestId: null,
    runningTaskId: null,
    runningRequestVersion: null,
    runningAt: null,
    nextPayload: null,
    nextRequestVersion: null,
    nextUpdatedAt: null,
    deferredAt: null,
    transientRetryReason: null,
    transientRetryCount: 0,
    transientRetryNextRunAt: null,
    transientRetryLastFailureMessage: null,
    updatedAt,
  };
};

const isTaskMissingError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('task') && normalized.includes('not found');
};

const isTaskAlreadyExistsError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('task') && normalized.includes('already exists');
};

async function deleteExistingTask(
  queue: TaskQueue<AddIntroOutroInputType>,
  taskId: string | null | undefined
): Promise<void> {
  if (!taskId) return;

  try {
    await queue.delete(taskId);
  } catch (error) {
    if (isTaskMissingError(error)) {
      return;
    }
    throw error;
  }
}

export async function withProcessAudioQueueClaim<T>(
  database: Database,
  sermonId: string,
  ownerId: string,
  run: () => Promise<T>,
  mayRecoverExpiredOwner?: (requestId: string) => boolean
): Promise<T> {
  const claimRef = database.ref(`${PROCESS_AUDIO_QUEUE_CLAIMS_PATH}/${sermonId}`);

  for (let attempt = 1; attempt <= CLAIM_ACQUIRE_ATTEMPTS; attempt += 1) {
    const now = Date.now();
    const result = await claimRef.transaction((current) => {
      const record = asRecord(current);
      const acquiredAt = typeof record?.acquiredAt === 'number' ? record.acquiredAt : 0;
      const requestId = typeof record?.requestId === 'string' ? record.requestId : null;
      const expired = !acquiredAt || now - acquiredAt > PROCESS_AUDIO_QUEUE_CLAIM_TTL_MS;

      if (mayRecoverExpiredOwner && current !== null && (!requestId || !Number.isFinite(acquiredAt) || acquiredAt <= 0)) return undefined;
      if (requestId && requestId !== ownerId && (!expired || (mayRecoverExpiredOwner && !mayRecoverExpiredOwner(requestId)))) {
        return;
      }

      return {
        requestId: ownerId,
        acquiredAt: now,
        acquiredAtIso: new Date(now).toISOString(),
      };
    });

    if (result.committed && result.snapshot.val()?.requestId === ownerId) {
      try {
        return await run();
      } finally {
        await claimRef.transaction(current => current === null || current?.requestId === ownerId ? null : undefined, undefined, false);
      }
    }

    await sleep(CLAIM_ACQUIRE_DELAY_MS);
  }

  throw new Error(`Timed out acquiring process-audio queue mutation claim for sermon ${sermonId}.`);
}

async function getQueueStateAndDeferredCount(
  database: Database
): Promise<{ queueState: StoredYouTubeQueueState; deferredCount: number }> {
  const [queueStateSnapshot, deferredSnapshot] = await Promise.all([
    database.ref(YOUTUBE_QUEUE_STATE_PATH).get(),
    database.ref(YOUTUBE_QUEUE_DEFERRED_PATH).get(),
  ]);

  const deferredCount = countChildren(deferredSnapshot.val());
  let queueState = parseYouTubeQueueState(queueStateSnapshot.val());
  if (queueState.deferredYouTubeTaskCount !== deferredCount) {
    const observedCount = queueState.deferredYouTubeTaskCount;
    const result = await database.ref(YOUTUBE_QUEUE_STATE_PATH).transaction((current) => {
      const currentQueueState = parseYouTubeQueueState(current);
      return {
        ...currentQueueState,
        deferredYouTubeTaskCount: reconcileDeferredYouTubeTaskCount(
          currentQueueState.deferredYouTubeTaskCount,
          observedCount,
          deferredCount
        ),
      } satisfies StoredYouTubeQueueState;
    });
    queueState = parseYouTubeQueueState(result.snapshot.val());
  }

  return { queueState, deferredCount };
}

const getProbeBlockerReason = (probeMode: YouTubeQueueProbeMode | null): string => {
  return probeMode === 'browser_fallback'
    ? YOUTUBE_BROWSER_FALLBACK_BLOCKER_REASON
    : 'cookie_session_stale_or_challenged';
};

export async function getYouTubeQueueSnapshot(
  database: Database
): Promise<{ queueState: StoredYouTubeQueueState; deferredCount: number }> {
  return await getQueueStateAndDeferredCount(database);
}

export async function recoverStaleYouTubeQueueProbe(
  database: Database
): Promise<{ recovered: boolean; queueState: StoredYouTubeQueueState; deferredCount: number }> {
  const initial = await getQueueStateAndDeferredCount(database);
  const initialQueueState = initial.queueState;
  if (
    initialQueueState.probeStatus !== 'probing' ||
    !initialQueueState.probeTaskSermonId ||
    !initialQueueState.probeStartedAt
  ) {
    return { recovered: false, queueState: initialQueueState, deferredCount: initial.deferredCount };
  }

  const probeStartedAtMs = Date.parse(initialQueueState.probeStartedAt);
  if (Number.isNaN(probeStartedAtMs) || Date.now() - probeStartedAtMs < STALE_YOUTUBE_QUEUE_PROBE_MS) {
    return { recovered: false, queueState: initialQueueState, deferredCount: initial.deferredCount };
  }

  const probeSermonId = initialQueueState.probeTaskSermonId;
  return await withProcessAudioQueueClaim(
    database,
    probeSermonId,
    `recover-stale-youtube-probe:${randomUUID()}`,
    async () => {
      const { queueState, deferredCount } = await getQueueStateAndDeferredCount(database);
      if (
        (await database.ref(`${MOSES_BACKLOG_FENCES_PATH}/${probeSermonId}`).get()).exists() ||
        queueState.probeStatus !== 'probing' ||
        queueState.probeTaskSermonId !== probeSermonId ||
        !queueState.probeStartedAt
      ) {
        return { recovered: false, queueState, deferredCount };
      }

      const currentProbeStartedAtMs = Date.parse(queueState.probeStartedAt);
      if (
        Number.isNaN(currentProbeStartedAtMs) ||
        Date.now() - currentProbeStartedAtMs < STALE_YOUTUBE_QUEUE_PROBE_MS
      ) {
        return { recovered: false, queueState, deferredCount };
      }

      const [lockSnapshot, requestSnapshot, deferredEntrySnapshot] = await Promise.all([
        database.ref(`${PROCESS_AUDIO_LOCKS_PATH}/${probeSermonId}`).get(),
        database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${probeSermonId}`).get(),
        database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${probeSermonId}`).get(),
      ]);
      if (isProcessAudioLockActive(lockSnapshot.val())) {
        return { recovered: false, queueState, deferredCount };
      }

      const now = getNowIsoString();
      const staleFailureClass = queueState.probeLastFailureClass ?? getProbeBlockerReason(queueState.probeMode);
      const staleFailureMessage =
        queueState.probeLastFailureMessage ?? 'Recovered a stale YouTube probe that was no longer making progress.';
      const requestState = requestSnapshot.exists() ? (requestSnapshot.val() as StoredProcessAudioRequestState) : null;
      const requestMatchesProbe = requestState?.currentRequestVersion === queueState.probeRequestVersion;
      const canRestoreDeferredProbe =
        requestMatchesProbe &&
        !deferredEntrySnapshot.exists() &&
        !!requestState?.currentPayload &&
        !!requestState.currentRequestVersion;
      const restoredDeferredCount = deferredCount + (canRestoreDeferredProbe ? 1 : 0);
      const queueStateTransition = await runGuardedYouTubeQueueStateTransaction(database, (currentQueueState) => {
        if (
          currentQueueState.probeStatus !== 'probing' ||
          currentQueueState.probeMode !== queueState.probeMode ||
          currentQueueState.probeTaskSermonId !== queueState.probeTaskSermonId ||
          currentQueueState.probeRequestVersion !== queueState.probeRequestVersion ||
          currentQueueState.probeStartedAt !== queueState.probeStartedAt ||
          (currentQueueState.probeDispatchReservationId ?? null) !== (queueState.probeDispatchReservationId ?? null)
        ) {
          return undefined;
        }

        return {
          ...currentQueueState,
          blocked: false,
          blockerReason: null,
          blockedAt: null,
          probeMode: null,
          probeStatus: 'waiting_for_auth_required_request',
          probeTaskSermonId: null,
          probeRequestVersion: null,
          probeStartedAt: null,
          probeDispatchReservationId: null,
          probeLastFailedAt: now,
          probeLastFailureClass: staleFailureClass,
          probeLastFailureMessage: staleFailureMessage,
          deferredYouTubeTaskCount: reconcileDeferredYouTubeTaskCount(
            currentQueueState.deferredYouTubeTaskCount,
            queueState.deferredYouTubeTaskCount,
            restoredDeferredCount
          ),
        } satisfies StoredYouTubeQueueState;
      });
      const nextQueueState = parseYouTubeQueueState(queueStateTransition.snapshot.val());
      if (!queueStateTransition.committed) {
        return {
          recovered: false,
          queueState: nextQueueState,
          deferredCount: nextQueueState.deferredYouTubeTaskCount,
        };
      }

      const writes: Array<Promise<unknown>> = [];
      if (requestState && requestMatchesProbe) {
        writes.push(
          database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${probeSermonId}`).set({
            ...requestState,
            queuedTaskId: null,
            queuedAt: null,
            updatedAt: now,
          } satisfies StoredProcessAudioRequestState)
        );
      }
      if (canRestoreDeferredProbe && requestState?.currentPayload && requestState.currentRequestVersion) {
        writes.push(
          database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${probeSermonId}`).set({
            sermonId: probeSermonId,
            payload: requestState.currentPayload,
            requestVersion: requestState.currentRequestVersion,
            deferredAt: queueState.probeStartedAt,
            reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
            disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
            dependencyScope: 'authenticated_session',
            probeMode: queueState.probeMode ?? 'cookie_provider',
            blockerEpisodeId: queueState.blockerEpisodeId,
            lastFailureClass: staleFailureClass,
            lastFailureMessage: staleFailureMessage,
            attemptCount: 0,
          } satisfies StoredDeferredYouTubeRequest)
        );
      }

      await Promise.all(writes);
      return {
        recovered: true,
        queueState: nextQueueState,
        deferredCount: nextQueueState.deferredYouTubeTaskCount,
      };
    }
  );
}

export function isYouTubeQueuePaused(_queueState: StoredYouTubeQueueState): boolean {
  // Legacy queue-wide blockers caused one auth/provider failure to stop every
  // YouTube request. Deferred auth recovery is now scoped to each item, so
  // guest-capable requests always remain eligible for dispatch.
  return false;
}

export function buildYouTubeCookieStatus(
  hasCookies: boolean,
  metadata: YouTubeCookieMetadata | null,
  queueState: StoredYouTubeQueueState,
  deferredCount: number,
  browserFallbackStatus: {
    configured: boolean;
    reachable: boolean;
    healthy: boolean;
    sessionState: BrowserFallbackSessionState;
    healthcheckConfigured: boolean;
    profileUpdatedAt: string | null;
    lastCheckedAt: string | null;
    lastErrorCode: BrowserFallbackErrorCode | null;
    lastErrorMessage: string | null;
  } = {
    configured: false,
    reachable: false,
    healthy: false,
    sessionState: 'unknown',
    healthcheckConfigured: false,
    profileUpdatedAt: null,
    lastCheckedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  }
): GetYouTubeCookieStatusOutputType {
  const disabledUntil = metadata?.disabledUntil ?? null;
  const cookieBreakerOpen = !!disabledUntil && Date.parse(disabledUntil) > Date.now();
  const youtubeQueueBlocked = isYouTubeQueuePaused(queueState);
  const browserFallbackBlocked =
    youtubeQueueBlocked && queueState.blockerReason === YOUTUBE_BROWSER_FALLBACK_BLOCKER_REASON;

  return {
    hasCookies,
    cookieBreakerOpen,
    disabledUntil,
    youtubeQueueBlocked,
    browserFallbackBlocked,
    probeStatus: queueState.probeStatus,
    deferredYouTubeTaskCount: deferredCount,
    blockerReason: queueState.blockerReason,
    blockerEpisodeId: queueState.blockerEpisodeId,
    blockerUpdatedAt: queueState.blockedAt ?? queueState.probeStartedAt ?? null,
    browserFallbackConfigured: browserFallbackStatus.configured,
    browserFallbackReachable: browserFallbackStatus.reachable,
    browserFallbackHealthy: browserFallbackStatus.healthy,
    browserFallbackSessionState: browserFallbackStatus.sessionState,
    browserFallbackHealthcheckConfigured: browserFallbackStatus.healthcheckConfigured,
    browserFallbackProfileUpdatedAt: browserFallbackStatus.profileUpdatedAt,
    browserFallbackLastCheckedAt: browserFallbackStatus.lastCheckedAt,
    browserFallbackLastErrorCode: browserFallbackStatus.lastErrorCode,
    browserFallbackLastErrorMessage: browserFallbackStatus.lastErrorMessage,
    metadata,
  };
}

async function writeDeferredYouTubeRequest(
  database: Database,
  payload: AddIntroOutroInputType,
  requestVersion: string,
  reason: string,
  probeMode: YouTubeQueueProbeMode
): Promise<void> {
  const sanitizedPayload = sanitizeProcessAudioPayload(payload);
  const deferredRequest: StoredDeferredYouTubeRequest = {
    sermonId: sanitizedPayload.id,
    payload: sanitizedPayload,
    requestVersion,
    deferredAt: getNowIsoString(),
    reason,
    disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
    dependencyScope: 'authenticated_session',
    probeMode,
    blockerEpisodeId: null,
    lastFailureClass: null,
  };

  await database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${sanitizedPayload.id}`).set(deferredRequest);
}

type PilotReceiptPhase = 'prepared' | 'sending' | 'acknowledged' | 'rejected' | 'legacy_sending';
type PilotReceipt = PilotSendIntent & { phase: PilotReceiptPhase; reason?: string };

// Serial replacements are the only allowed differences from the original reserved row.
function matchesPendingPilot(value: unknown, pending: Record<string, unknown>): boolean {
  const row = asRecord(value);
  if (!row) return false;
  const { nextPayload, nextRequestVersion, nextUpdatedAt, ...original } = row;
  if (!isDeepStrictEqual(original, pending)) return false;
  if (nextPayload === undefined && nextRequestVersion === undefined && nextUpdatedAt === undefined) return true;
  const next = asRecord(nextPayload);
  if (!next || next.id !== original.sermonId || typeof next.startTime !== 'number' || typeof next.duration !== 'number' ||
      (typeof next.youtubeUrl !== 'string' && typeof next.storageFilePath !== 'string') ||
      typeof nextUpdatedAt !== 'string' || !Number.isFinite(Date.parse(nextUpdatedAt)) ||
      new Date(nextUpdatedAt).toISOString() !== nextUpdatedAt) return false;
  const data = next as AddIntroOutroInputType;
  return isDeepStrictEqual(data, sanitizeProcessAudioPayload(data)) && nextRequestVersion !== original.currentRequestVersion &&
    computeProcessAudioRequestVersion(data) === nextRequestVersion;
}

// The permanent receipt survives ordinary request cleanup. Only prepared -> sending
// grants the right to POST, and only an authenticated provider ACK can publish a marker.
export async function queueInitialMosesGuestPilot(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  eventId: string;
  isCurrentCreate: () => Promise<boolean>;
  isValidLegacySource: (successor?: AddIntroOutroInputType) => Promise<boolean>;
  targetUri: string;
}, prepare: () => Promise<PilotTransport> = prepareLegacyMosesPilotTransport): Promise<QueueMutationResult> {
  const { database, eventId } = args;
  const payload = sanitizeProcessAudioPayload(args.payload);
  const requestVersion = computeProcessAudioRequestVersion(payload);
  const sermonId = payload.id;
  const sourceType = getProcessAudioSourceType(payload);
  const unchanged = { action: 'unchanged' as const, requestVersion, sourceType };
  if (sourceType !== 'youtube') return unchanged;

  // CloudEvent redelivery has the same event ID. Each invocation needs its own exclusion owner.
  const result = await withProcessAudioQueueClaim(database, sermonId, `moses-pilot:${randomUUID()}`, async () => {
    if ((await database.ref(`${MOSES_BACKLOG_FENCES_PATH}/${sermonId}`).get()).exists()) return unchanged;
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${sermonId}`);
    const receiptRef = database.ref(`${MOSES_PILOT_INTENTS_PATH}/${sermonId}`);
    const [request, receipt, lock, deferred, probe, currentCreate] = await Promise.all([
      requestRef.get(), receiptRef.get(), database.ref(`${PROCESS_AUDIO_LOCKS_PATH}/${sermonId}`).get(),
      database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${sermonId}`).get(),
      database.ref(`${YOUTUBE_QUEUE_STATE_PATH}/probeTaskSermonId`).get(), args.isCurrentCreate(),
    ]);
    if (lock.exists() || deferred.exists() || (probe.exists() &&
        (typeof probe.val() !== 'string' || probe.val() === sermonId))) return unchanged;

    let record: PilotReceipt;
    if (!receipt.exists()) {
      if (request.exists()) return unchanged;
      const queuedAt = getNowIsoString();
      record = {
        eventId, requestVersion, queuedAt, nonce: randomUUID(), phase: 'prepared',
        taskId: computeProcessAudioTaskId(sermonId, requestVersion, `sermon-create:${eventId}:${queuedAt}`),
      };
      const reserved = await receiptRef.transaction(current => current === null ? record : undefined, undefined, false);
      if (!reserved.committed) return unchanged;
    } else {
      record = receipt.val();
      if (record?.eventId !== eventId || record.requestVersion !== requestVersion ||
          typeof record.queuedAt !== 'string' || !Number.isFinite(Date.parse(record.queuedAt)) ||
          new Date(record.queuedAt).toISOString() !== record.queuedAt ||
          typeof record.nonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.nonce) ||
          record.taskId !== computeProcessAudioTaskId(sermonId, requestVersion, `sermon-create:${eventId}:${record.queuedAt}`)) return unchanged;
    }
    const transition = async (phase: PilotReceiptPhase, reason?: string) => {
      const next: PilotReceipt = { ...record, phase, ...(reason && { reason }) };
      const result = await receiptRef.transaction(current => current === null ? null :
        isDeepStrictEqual(current, record) ? next : undefined, undefined, false);
      const moved = result.committed && isDeepStrictEqual(result.snapshot.val(), next);
      if (moved) record = next;
      return moved;
    };
    const { taskId, queuedAt, nonce } = record;
    const marker: MosesGuestPilotMarker = { eventId, taskId, queuedAt, requestVersion };
    const intent = { ...marker, nonce };
    const pending = Object.fromEntries(Object.entries({
      ...buildProcessAudioRequestState(payload, requestVersion, queuedAt), mosesGuestPilotIntent: marker,
    }).filter(([, value]) => value !== null)); // RTDB omits null children.

    if (record.phase === 'prepared' && !currentCreate) {
      if (!await transition('rejected', 'source_changed')) return unchanged;
    }
    if (record.phase === 'rejected') return 'legacy';
    // The original POST may already have reached Cloud Tasks when a newer edit arrives.
    // Exact readback can settle that incumbent while the edit waits in the normal next slot.
    if (!currentCreate && !request.child('nextPayload').exists()) return unchanged;
    if (request.exists() && !matchesPendingPilot(request.val(), pending)) return unchanged;
    if (!request.exists()) {
      if (record.phase !== 'prepared') return unchanged;
      const reserved = await requestRef.transaction(current => current === null ? pending : undefined, undefined, false);
      if (!reserved.committed) return unchanged;
    }

    let provider: PilotTransport;
    try {
      provider = await prepare();
    } catch {
      if (record.phase !== 'prepared') throw new Error('Could not authenticate inspection of the original pilot task.');
      return await transition('rejected', 'authorization_unavailable') ? 'legacy' : unchanged;
    }
    if (record.phase === 'prepared') {
      // A restart may resume a prepared record long after its original dispatch window.
      if (Date.now() >= Date.parse(queuedAt) + 25_000) {
        return await transition('rejected', 'schedule_elapsed') ? 'legacy' : unchanged;
      }
      if (!await transition('sending')) return unchanged;
      try {
        await provider('create', payload, intent);
      } catch (error) {
        if (!(error instanceof PilotTaskNotCreated)) throw error;
        return await transition('rejected', 'create_rejected') ? 'legacy' : unchanged;
      }
    } else if (record.phase === 'sending' || record.phase === 'acknowledged') {
      await provider('inspect', payload, intent);
    } else {
      return unchanged;
    }
    if (record.phase !== 'acknowledged' && !await transition('acknowledged')) return unchanged;
    const confirmed = await requestRef.transaction(current => {
      if (current === null) return null;
      if (!matchesPendingPilot(current, pending)) return undefined;
      return { ...current, queuedTaskId: taskId, queuedAt, mosesGuestPilotIntent: null, mosesGuestPilot: marker };
    }, undefined, false);
    return confirmed.committed && isDeepStrictEqual(confirmed.snapshot.child('mosesGuestPilot').val(), marker)
      ? { action: 'queued' as const, requestVersion, taskId, sourceType } : unchanged;
  });
  if (result !== 'legacy') return result;
  return queueOrReplaceProcessAudioRequest({
    database, payload, targetUri: args.targetUri, ownerId: `sermon-create:${eventId}`, onlyIfMissing: true,
    initialCreate: { eventId, isValidLegacySource: args.isValidLegacySource, declinedPilot: true },
  });
}

export async function queueOrReplaceProcessAudioRequest(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  targetUri: string;
  ownerId: string;
  onlyIfMissing?: boolean;
  markPending?: () => Promise<void>;
  authorizedBacklogEdit?: (fence: MosesBacklogReceipt, claimOwner: string) => Promise<QueueMutationResult>;
  initialCreate?: { eventId: string; isValidLegacySource: (successor?: AddIntroOutroInputType) => Promise<boolean>; declinedPilot?: boolean };
}): Promise<QueueMutationResult> {
  const { database, payload, ownerId, onlyIfMissing = false } = args;

  const claimOwner = args.initialCreate || args.markPending ? `${ownerId}:${randomUUID()}` : ownerId;
  return await withProcessAudioQueueClaim(database, payload.id, claimOwner, async () => {
    const backlogFence = await database.ref(`${MOSES_BACKLOG_FENCES_PATH}/${payload.id}`).get();
    if (backlogFence.exists()) {
      if (onlyIfMissing && args.initialCreate) {
        return { action: 'unchanged', requestVersion: computeProcessAudioRequestVersion(payload), sourceType: getProcessAudioSourceType(payload) };
      }
      if (!args.initialCreate && args.authorizedBacklogEdit) return args.authorizedBacklogEdit(backlogFence.val(), claimOwner);
      throw new Error('Recovery owns this original upload. Its existing request has been preserved.');
    }
    await args.markPending?.();
    let sanitizedPayload = sanitizeProcessAudioPayload(payload);
    let requestVersion = computeProcessAudioRequestVersion(sanitizedPayload);
    let sourceType = getProcessAudioSourceType(sanitizedPayload);
    let targetUri = args.targetUri;
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${sanitizedPayload.id}`);
    const lockRef = database.ref(`${PROCESS_AUDIO_LOCKS_PATH}/${sanitizedPayload.id}`);
    const receiptRef = database.ref(`${MOSES_PILOT_INTENTS_PATH}/${sanitizedPayload.id}`);
    let declinedReceipt: PilotReceipt | null = null;
    let declinedPending: Record<string, unknown> | null = null;
    const [requestSnapshot, lockSnapshot] = await Promise.all([requestRef.get(), lockRef.get()]);
    if (requestSnapshot.child('deferredAt').exists()) {
      const reservation = await database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${sanitizedPayload.id}/mosesRecoveryReservation`).get();
      if (reservation.exists()) {
        if (requestSnapshot.child('currentRequestVersion').val() === requestVersion) return { action: 'unchanged', requestVersion, sourceType };
        throw new Error('An audio recovery currently owns this deferred request. Retry the edit after it settles.');
      }
    }
    // An old Eventarc redelivery must still honor the permanent receipt after rollback.
    // Only the native create path reads this extra row; ordinary callable requests do not.
    if (args.initialCreate) {
      const { eventId, isValidLegacySource, declinedPilot } = args.initialCreate;
      let receipt = (await receiptRef.get()).val() as PilotReceipt | null;
      if (receipt || declinedPilot) {
        const unchanged = { action: 'unchanged' as const, requestVersion, sourceType };
        if (!receipt || receipt.eventId !== eventId || receipt.requestVersion !== requestVersion) return unchanged;
        if (receipt.phase === 'prepared' && !declinedPilot) {
          const rejected = { ...receipt, phase: 'rejected' as const, reason: 'pilot_disarmed' };
          const declined = await receiptRef.transaction(current => current === null ? null :
            isDeepStrictEqual(current, receipt) ? rejected : undefined, undefined, false);
          if (!declined.committed || !isDeepStrictEqual(declined.snapshot.val(), rejected)) return unchanged;
          receipt = rejected;
        }
        if (receipt.phase !== 'rejected') return unchanged;
        declinedReceipt = receipt;
        const [deferred, probe] = await Promise.all([
          database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${sanitizedPayload.id}`).get(),
          database.ref(`${YOUTUBE_QUEUE_STATE_PATH}/probeTaskSermonId`).get(),
        ]);
        if (lockSnapshot.exists() || deferred.exists() || (probe.exists() &&
            (typeof probe.val() !== 'string' || probe.val() === sanitizedPayload.id))) return unchanged;
        if (requestSnapshot.exists()) {
          const { taskId, queuedAt } = receipt;
          const marker = { eventId, taskId, queuedAt, requestVersion };
          const pending = Object.fromEntries(Object.entries({
            ...buildProcessAudioRequestState(sanitizedPayload, requestVersion, queuedAt), mosesGuestPilotIntent: marker,
          }).filter(([, value]) => value !== null));
          if (!matchesPendingPilot(requestSnapshot.val(), pending)) return unchanged;
          declinedPending = pending;
          // No pilot task was created. Dispatch the latest accepted callable edit directly.
          const successor = requestSnapshot.child('nextPayload').val() as AddIntroOutroInputType | null;
          if (successor && await isValidLegacySource(successor)) {
            sanitizedPayload = successor;
            sourceType = getProcessAudioSourceType(successor);
            targetUri = getProcessAudioTargetUri(sourceType);
            requestVersion = computeProcessAudioRequestVersion(successor);
          } else {
            if (!await isValidLegacySource()) return unchanged;
          }
        } else if (!await isValidLegacySource()) return unchanged;
      }
    }
    if (!declinedReceipt && (requestSnapshot.child('mosesGuestPilotIntent').exists() || requestSnapshot.child('mosesGuestPilot').exists())) {
      if (requestSnapshot.child('currentRequestVersion').val() === requestVersion ||
          requestSnapshot.child('nextRequestVersion').val() === requestVersion || args.initialCreate) {
        return { action: 'unchanged', requestVersion, sourceType };
      }
      const observed = requestSnapshot.val();
      const nextUpdatedAt = getNowIsoString();
      const staged = await requestRef.transaction(current => current === null ? null :
        isDeepStrictEqual(current, observed) ? { ...current, nextPayload: sanitizedPayload, nextRequestVersion: requestVersion, nextUpdatedAt } : undefined,
        undefined, false);
      if (!staged.committed || staged.snapshot.child('nextRequestVersion').val() !== requestVersion) {
        throw new Error('Audio request ownership changed before the replacement could be saved.');
      }
      return { action: 'running_replaced', requestVersion, sourceType };
    }
    const queue = getFunctions().taskQueue<AddIntroOutroInputType>(getProcessAudioTaskQueueNameForSource(sourceType));
    const now = getNowIsoString();
    const taskId = computeProcessAudioTaskId(sanitizedPayload.id, requestVersion, `${ownerId}:${now}`);
    const currentState = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(sanitizedPayload, requestVersion, now);
    const lockActive = isProcessAudioLockActive(lockSnapshot.val());

    const requestVersionAlreadyHandled =
      requestSnapshot.exists() &&
      (currentState.currentRequestVersion === requestVersion ||
        currentState.nextRequestVersion === requestVersion ||
        currentState.lastCompletedRequestVersion === requestVersion);
    if (!declinedReceipt && onlyIfMissing && requestVersionAlreadyHandled) {
      return { action: 'unchanged', requestVersion, sourceType };
    }

    if (lockActive) {
      const nextPayload =
        currentState.currentRequestVersion === requestVersion && !currentState.nextPayload
          ? null
          : currentState.nextRequestVersion === requestVersion && currentState.nextPayload
          ? currentState.nextPayload
          : sanitizedPayload;
      await requestRef.set({
        ...currentState,
        sermonId: sanitizedPayload.id,
        sourceType,
        currentPayload: sanitizedPayload,
        currentRequestVersion: requestVersion,
        nextPayload,
        nextRequestVersion: nextPayload ? requestVersion : null,
        nextUpdatedAt: nextPayload ? now : null,
        transientRetryReason: null,
        transientRetryCount: 0,
        transientRetryNextRunAt: null,
        transientRetryLastFailureMessage: null,
        updatedAt: now,
      } satisfies StoredProcessAudioRequestState);
      return { action: 'running_replaced', requestVersion, sourceType };
    }

    const { queueState, deferredCount } = await getQueueStateAndDeferredCount(database);
    const deferredRef = database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${sanitizedPayload.id}`);
    const deferredSnapshot = await deferredRef.get();
    const alreadyDeferred = deferredSnapshot.exists();
    const nextState: StoredProcessAudioRequestState = {
      ...currentState,
      sermonId: sanitizedPayload.id,
      sourceType,
      currentPayload: sanitizedPayload,
      currentRequestVersion: requestVersion,
      nextPayload: null,
      nextRequestVersion: null,
      nextUpdatedAt: null,
      runningRequestId: null,
      runningTaskId: null,
      runningRequestVersion: null,
      runningAt: null,
      transientRetryReason: null,
      transientRetryCount: 0,
      transientRetryNextRunAt: null,
      transientRetryLastFailureMessage: null,
      updatedAt: now,
    };

    if (sourceType === 'youtube' && isYouTubeQueuePaused(queueState)) {
      await writeDeferredYouTubeRequest(
        database,
        sanitizedPayload,
        requestVersion,
        queueState.blockerReason || queueState.probeStatus,
        queueState.probeMode ?? 'cookie_provider'
      );
      nextState.queuedTaskId = null;
      nextState.queuedAt = null;
      nextState.deferredAt = now;
      await requestRef.set(nextState);
      await database
        .ref(YOUTUBE_QUEUE_STATE_PATH)
        .update({ deferredYouTubeTaskCount: deferredCount + (alreadyDeferred ? 0 : 1) });
      return { action: 'deferred', requestVersion, sourceType };
    }

    if (declinedReceipt) {
      delete nextState.mosesGuestPilotIntent;
      delete nextState.mosesGuestPilot;
      // From here the ordinary Admin enqueue may have reached the provider. A replay,
      // including one after request cleanup, cannot create another legacy task.
      const sending = { ...declinedReceipt, phase: 'legacy_sending', legacyTaskId: taskId };
      const spend = await receiptRef.transaction(current => current === null ? null :
        isDeepStrictEqual(current, declinedReceipt) ? sending : undefined, undefined, false);
      if (!spend.committed || !isDeepStrictEqual(spend.snapshot.val(), sending)) {
        return { action: 'unchanged', requestVersion, sourceType };
      }
    }
    if ((await database.ref(`${MOSES_BACKLOG_FENCES_PATH}/${payload.id}`).get()).exists()) {
      throw new Error('Recovery has acquired this original upload.');
    }
    await deleteExistingTask(queue, currentState.queuedTaskId);
    await queue.enqueue(sanitizedPayload, {
      id: taskId,
      dispatchDeadlineSeconds: 1800,
      uri: targetUri,
    });

    const queued = { ...nextState, queuedTaskId: taskId, queuedAt: now, deferredAt: null };
    if (declinedReceipt) {
      // A late ordinary ACK must not overwrite a cancellation, early consumption, or a
      // more recent serial edit accepted after this invocation's claim expired.
      const published = await requestRef.transaction(current => {
        if (!declinedPending) return current === null ? queued : undefined;
        if (current === null) return null;
        if (!matchesPendingPilot(current, declinedPending)) return undefined;
        if (current.nextRequestVersion && current.nextRequestVersion !== requestVersion) {
          return { ...queued, nextPayload: current.nextPayload, nextRequestVersion: current.nextRequestVersion, nextUpdatedAt: current.nextUpdatedAt };
        }
        return queued;
      }, undefined, false);
      if (!published.committed || published.snapshot.child('queuedTaskId').val() !== taskId) {
        return { action: 'unchanged', requestVersion, sourceType };
      }
    } else {
      await requestRef.set(queued);
    }

    return { action: 'queued', requestVersion, taskId, sourceType };
  });
}

export async function beginYouTubeQueueProbe(args: {
  database: Database;
  targetUri: string;
  ownerId: string;
  probeMode: YouTubeQueueProbeMode;
}): Promise<void> {
  const { database, targetUri, ownerId } = args;
  const queue = getYouTubeTaskQueue();
  const deferredSnapshot = await database.ref(YOUTUBE_QUEUE_DEFERRED_PATH).get();
  const deferredEntries = Object.values(
    (deferredSnapshot.val() as Record<string, LegacyStoredDeferredYouTubeRequest> | null) ?? {}
  ).map(
    (entry): StoredDeferredYouTubeRequest => ({
      ...entry,
      disposition: entry.disposition ?? PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
      dependencyScope: entry.dependencyScope ?? 'authenticated_session',
    })
  );
  const available = deferredEntries.filter(entry => !('mosesRecoveryReservation' in entry));
  if (deferredEntries.length && !available.length) return;
  const probeCandidate = available.sort(
    (left, right) => Date.parse(left.deferredAt) - Date.parse(right.deferredAt)
  )[0];
  const deferredCount = deferredEntries.length;

  if (!probeCandidate) {
    const currentState = parseYouTubeQueueState((await database.ref(YOUTUBE_QUEUE_STATE_PATH).get()).val());
    if (currentState.deferredYouTubeTaskCount !== deferredCount) {
      return;
    }
    await runGuardedYouTubeQueueStateTransaction(database, (currentQueueState) => {
      if (
        !matchesObservedYouTubeProbe(currentQueueState, currentState) ||
        currentQueueState.deferredYouTubeTaskCount !== deferredCount ||
        currentQueueState.probeStatus === 'probing' ||
        !!currentQueueState.probeDispatchReservationId
      ) {
        return undefined;
      }
      const deferredYouTubeTaskCount = reconcileDeferredYouTubeTaskCount(
        currentQueueState.deferredYouTubeTaskCount,
        currentState.deferredYouTubeTaskCount,
        deferredCount
      );
      const hasDeferredRequests = deferredYouTubeTaskCount > 0;
      return {
        ...currentQueueState,
        blocked: false,
        blockerReason: null,
        blockedAt: null,
        blockerEpisodeId: hasDeferredRequests ? currentQueueState.blockerEpisodeId : null,
        alertSentAt: hasDeferredRequests ? currentQueueState.alertSentAt : null,
        alertReservationId: hasDeferredRequests ? currentQueueState.alertReservationId ?? null : null,
        probeStatus: hasDeferredRequests ? 'waiting_for_auth_required_request' : 'idle',
        probeMode: null,
        deferredYouTubeTaskCount,
        probeTaskSermonId: null,
        probeRequestVersion: null,
        probeStartedAt: null,
        probeDispatchReservationId: null,
        probeLastFailureClass: null,
        probeLastFailureMessage: null,
      } satisfies StoredYouTubeQueueState;
    });
    return;
  }

  const selectedProbeMode = probeCandidate.probeMode;

  const currentQueueState = parseYouTubeQueueState((await database.ref(YOUTUBE_QUEUE_STATE_PATH).get()).val());
  if (currentQueueState.probeStatus === 'probing' || !!currentQueueState.probeDispatchReservationId) {
    return;
  }

  await withProcessAudioQueueClaim(database, probeCandidate.sermonId, ownerId, async () => {
    if ((await database.ref(`${MOSES_BACKLOG_FENCES_PATH}/${probeCandidate.sermonId}`).get()).exists()) return;
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${probeCandidate.sermonId}`);
    const queueStateRef = database.ref(YOUTUBE_QUEUE_STATE_PATH);
    const [requestSnapshot, queueStateSnapshot, liveDeferredSnapshot] = await Promise.all([
      requestRef.get(),
      queueStateRef.get(),
      database.ref(YOUTUBE_QUEUE_DEFERRED_PATH).get(),
    ]);
    const liveDeferredEntries = Object.values(
      (liveDeferredSnapshot.val() as Record<string, LegacyStoredDeferredYouTubeRequest> | null) ?? {}
    )
      .map(
        (entry): StoredDeferredYouTubeRequest => ({
          ...entry,
          disposition: entry.disposition ?? PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
          dependencyScope: entry.dependencyScope ?? 'authenticated_session',
        })
      )
      .sort((left, right) => Date.parse(left.deferredAt) - Date.parse(right.deferredAt));
    const liveProbeCandidate = liveDeferredEntries.find(entry => !('mosesRecoveryReservation' in entry));
    if (
      liveProbeCandidate?.sermonId !== probeCandidate.sermonId ||
      liveProbeCandidate.requestVersion !== probeCandidate.requestVersion
    ) {
      return;
    }
    const existingState = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(probeCandidate.payload, probeCandidate.requestVersion, getNowIsoString());
    const queueState = parseYouTubeQueueState(queueStateSnapshot.val());
    const now = getNowIsoString();
    const taskId = computeProcessAudioTaskId(
      probeCandidate.sermonId,
      probeCandidate.requestVersion,
      `${ownerId}:${now}`
    );
    const sanitizedPayload = sanitizeProcessAudioPayload(probeCandidate.payload);
    if (queueState.probeStatus === 'probing' || !!queueState.probeDispatchReservationId) {
      return;
    }

    const reservationId = randomUUID();
    const reservation = await runGuardedYouTubeQueueStateTransaction(database, (liveQueueState) => {
      if (!matchesObservedYouTubeProbe(liveQueueState, queueState)) {
        return undefined;
      }

      return {
        ...liveQueueState,
        blocked: false,
        blockerReason: null,
        blockedAt: null,
        probeMode: selectedProbeMode,
        probeStatus: 'probing',
        probeTaskSermonId: probeCandidate.sermonId,
        probeRequestVersion: probeCandidate.requestVersion,
        probeStartedAt: now,
        probeDispatchReservationId: reservationId,
        deferredYouTubeTaskCount: reconcileDeferredYouTubeTaskCount(
          liveQueueState.deferredYouTubeTaskCount,
          queueState.deferredYouTubeTaskCount,
          Math.max(0, liveDeferredEntries.length - 1)
        ),
      } satisfies StoredYouTubeQueueState;
    });
    if (!reservation.committed) {
      return;
    }

    let taskAdopted = false;
    try {
      await deleteExistingTask(queue, existingState.queuedTaskId);
      try {
        await queue.enqueue(sanitizedPayload, {
          id: taskId,
          dispatchDeadlineSeconds: 1800,
          uri: targetUri,
        });
      } catch (error) {
        if (!isTaskAlreadyExistsError(error)) {
          throw error;
        }
      }
      taskAdopted = true;

      await requestRef.set({
        ...existingState,
        sermonId: probeCandidate.sermonId,
        sourceType: 'youtube',
        currentPayload: sanitizedPayload,
        currentRequestVersion: probeCandidate.requestVersion,
        queuedTaskId: taskId,
        queuedAt: now,
        deferredAt: null,
        updatedAt: now,
      } satisfies StoredProcessAudioRequestState);
      await database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${probeCandidate.sermonId}`).remove();
    } catch (error) {
      if (!taskAdopted) {
        await runGuardedYouTubeQueueStateTransaction(database, (liveQueueState) => {
          if (liveQueueState.probeDispatchReservationId !== reservationId) {
            return undefined;
          }
          return {
            ...liveQueueState,
            probeMode: null,
            probeStatus: 'waiting_for_auth_required_request',
            probeTaskSermonId: null,
            probeRequestVersion: null,
            probeStartedAt: null,
            probeDispatchReservationId: null,
            deferredYouTubeTaskCount: liveQueueState.deferredYouTubeTaskCount + 1,
          } satisfies StoredYouTubeQueueState;
        });
      }
      throw error;
    }
  });
}
