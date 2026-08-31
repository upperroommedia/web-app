import { randomUUID } from 'node:crypto';
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

export function setYouTubeTaskQueueFactoryForTesting(
  factory: (() => TaskQueue<AddIntroOutroInputType>) | null
): void {
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

async function withProcessAudioQueueClaim<T>(
  database: Database,
  sermonId: string,
  ownerId: string,
  run: () => Promise<T>
): Promise<T> {
  const claimRef = database.ref(`${PROCESS_AUDIO_QUEUE_CLAIMS_PATH}/${sermonId}`);

  for (let attempt = 1; attempt <= CLAIM_ACQUIRE_ATTEMPTS; attempt += 1) {
    const now = Date.now();
    const result = await claimRef.transaction((current) => {
      const record = asRecord(current);
      const acquiredAt = typeof record?.acquiredAt === 'number' ? record.acquiredAt : 0;
      const requestId = typeof record?.requestId === 'string' ? record.requestId : null;
      const expired = !acquiredAt || now - acquiredAt > PROCESS_AUDIO_QUEUE_CLAIM_TTL_MS;

      if (requestId && requestId !== ownerId && !expired) {
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
        const snapshot = await claimRef.get();
        if (snapshot.val()?.requestId === ownerId) {
          await claimRef.remove();
        }
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
      const requestState = requestSnapshot.exists()
        ? (requestSnapshot.val() as StoredProcessAudioRequestState)
        : null;
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
          (currentQueueState.probeDispatchReservationId ?? null) !==
            (queueState.probeDispatchReservationId ?? null)
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

export async function queueOrReplaceProcessAudioRequest(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  targetUri: string;
  ownerId: string;
}): Promise<QueueMutationResult> {
  const { database, payload, targetUri, ownerId } = args;
  const sanitizedPayload = sanitizeProcessAudioPayload(payload);
  const requestVersion = computeProcessAudioRequestVersion(sanitizedPayload);
  const sourceType = getProcessAudioSourceType(sanitizedPayload);
  const queue = getFunctions().taskQueue<AddIntroOutroInputType>(getProcessAudioTaskQueueNameForSource(sourceType));

  return await withProcessAudioQueueClaim(database, sanitizedPayload.id, ownerId, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${sanitizedPayload.id}`);
    const lockRef = database.ref(`${PROCESS_AUDIO_LOCKS_PATH}/${sanitizedPayload.id}`);
    const [requestSnapshot, lockSnapshot] = await Promise.all([requestRef.get(), lockRef.get()]);
    const now = getNowIsoString();
    const taskId = computeProcessAudioTaskId(sanitizedPayload.id, requestVersion, `${ownerId}:${now}`);
    const currentState = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(sanitizedPayload, requestVersion, now);
    const lockActive = isProcessAudioLockActive(lockSnapshot.val());

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

    await deleteExistingTask(queue, currentState.queuedTaskId);
    await queue.enqueue(sanitizedPayload, {
      id: taskId,
      dispatchDeadlineSeconds: 1800,
      uri: targetUri,
    });

    await requestRef.set({
      ...nextState,
      queuedTaskId: taskId,
      queuedAt: now,
      deferredAt: null,
    } satisfies StoredProcessAudioRequestState);

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
  const probeCandidate = deferredEntries.sort(
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
    const liveProbeCandidate = liveDeferredEntries[0];
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
