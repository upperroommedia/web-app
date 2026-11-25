import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MOSES_BACKLOG_FENCES_PATH, MOSES_RECOVERY_RECEIPTS_PATH } from '../../packages/contracts/mosesDeferredRecovery';
import type { Database } from 'firebase-admin/database';
import { getFunctions, type TaskQueue } from 'firebase-admin/functions';
import type { AddIntroOutroInputType } from '../../packages/contracts/addIntroOutro/types';
import {
  buildInitialYouTubeQueueState,
  computeProcessAudioTaskId,
  getProcessAudioTaskQueueNameForSource,
  getProcessAudioSourceType,
  PROCESS_AUDIO_LOCKS_PATH,
  PROCESS_AUDIO_QUEUE_CLAIMS_PATH,
  PROCESS_AUDIO_QUEUE_CLAIM_TTL_MS,
  PROCESS_AUDIO_REQUESTS_PATH,
  sanitizeProcessAudioPayload,
  type StoredDeferredYouTubeRequest,
  type StoredProcessAudioRequestState,
  type StoredYouTubeQueueState,
  type YouTubeQueueProbeMode,
  YOUTUBE_QUEUE_DEFERRED_PATH,
  YOUTUBE_QUEUE_STATE_PATH,
} from '../../packages/contracts/processAudioQueue';

const PROCESS_AUDIO_BASE_URLS = {
  prod: {
    storage: 'https://process-audio-yshbijirxq-uc.a.run.app',
    youtube: 'https://yt-worker.upperroommedia.org',
  },
  staging: {
    storage: 'https://process-audio-staging-pvaq33fxyq-uc.a.run.app',
    youtube: 'https://yt-worker-staging.upperroommedia.org',
  },
  local: 'http://127.0.0.1:8080',
};

const CLAIM_ACQUIRE_ATTEMPTS = 20;
const CLAIM_ACQUIRE_DELAY_MS = 150;
const PROCESS_AUDIO_TASK_TIMEOUT_SECONDS = 1800;

type QueueCleanupResult = {
  deletedTaskId: string | null;
  advancedProbe: boolean;
  deferredRemaining: number;
  disposition?: 'stale' | 'held';
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
};

const getNowIsoString = (): string => new Date().toISOString();

const normalizeBaseUrl = (value: string): string => value.replace(/\/process-audio\/?$/u, '').replace(/\/+$/u, '');

export const getProcessAudioTargetUriForQueueCleanup = (sourceType: 'youtube' | 'storage' = 'storage'): string => {
  const configuredTarget =
    sourceType === 'youtube'
      ? process.env.PROCESS_AUDIO_YOUTUBE_TASK_TARGET_URI ||
        process.env.PROCESS_AUDIO_YOUTUBE_SERVICE_URL ||
        process.env.NEXT_PUBLIC_PROCESS_AUDIO_YOUTUBE_SERVICE_URL
      : process.env.PROCESS_AUDIO_FILE_TASK_TARGET_URI ||
        process.env.PROCESS_AUDIO_FILE_SERVICE_URL ||
        process.env.NEXT_PUBLIC_PROCESS_AUDIO_FILE_SERVICE_URL ||
        process.env.PROCESS_AUDIO_TASK_TARGET_URI ||
        process.env.PROCESS_AUDIO_SERVICE_URL ||
        process.env.NEXT_PUBLIC_PROCESS_AUDIO_SERVICE_URL;

  if (configuredTarget) {
    return `${normalizeBaseUrl(configuredTarget)}/process-audio`;
  }

  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    return `${PROCESS_AUDIO_BASE_URLS.local}/process-audio`;
  }

  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  const baseUrlSet = projectId === 'urm-app-staging' ? PROCESS_AUDIO_BASE_URLS.staging : PROCESS_AUDIO_BASE_URLS.prod;
  const baseUrl = baseUrlSet[sourceType];
  return `${baseUrl}/process-audio`;
};

const parseYouTubeQueueState = (value: unknown): StoredYouTubeQueueState => {
  const record = asRecord(value);
  return {
    ...buildInitialYouTubeQueueState(),
    ...(record as Partial<StoredYouTubeQueueState> | null),
  };
};

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
    updatedAt,
  };
};

const isTaskMissingError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('task') && normalized.includes('not found');
};

async function deleteExistingTask(queue: TaskQueue<AddIntroOutroInputType>, taskId: string | null | undefined): Promise<void> {
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
        await claimRef.transaction(current => current === null || current.requestId === ownerId ? null : undefined, undefined, false);
      }
    }

    await sleep(CLAIM_ACQUIRE_DELAY_MS);
  }

  throw new Error(`Timed out acquiring process-audio queue mutation claim for sermon ${sermonId}.`);
}

const sortDeferredEntries = (entries: StoredDeferredYouTubeRequest[]): StoredDeferredYouTubeRequest[] => {
  return [...entries].sort((left, right) => Date.parse(left.deferredAt) - Date.parse(right.deferredAt));
};

const selectNextDeferredProbe = (
  entries: StoredDeferredYouTubeRequest[],
  preferredMode: YouTubeQueueProbeMode | null
): StoredDeferredYouTubeRequest | null => {
  const sortedEntries = sortDeferredEntries(entries);
  if (!preferredMode) {
    return sortedEntries[0] ?? null;
  }

  return sortedEntries.find((entry) => entry.probeMode === preferredMode) ?? sortedEntries[0] ?? null;
};

async function enqueueTask(
  queue: TaskQueue<AddIntroOutroInputType>,
  payload: AddIntroOutroInputType,
  taskId: string,
  targetUri: string
): Promise<void> {
  await queue.enqueue(sanitizeProcessAudioPayload(payload), {
    id: taskId,
    dispatchDeadlineSeconds: PROCESS_AUDIO_TASK_TIMEOUT_SECONDS,
    uri: targetUri,
  });
}

export async function cleanupDeletedSermonProcessAudioState(args: {
  database: Database;
  sermonId: string;
  ownerId: string;
  targetUri?: string;
  deletedAtMs?: number;
  isLiveProbeCandidate?: (entry: StoredDeferredYouTubeRequest) => Promise<boolean>;
  classifySource?: (backlog: unknown) => Promise<'stale' | 'ordinary' | 'held'>;
}): Promise<QueueCleanupResult> {
  const { database, sermonId } = args;
  const ownerId = args.ownerId + ':' + randomUUID();
  const queueStateRef = database.ref(YOUTUBE_QUEUE_STATE_PATH);
  type Advance = { entry: StoredDeferredYouTubeRequest; queueState: StoredYouTubeQueueState };
  const result = await withProcessAudioQueueClaim(database, sermonId, ownerId, async (): Promise<{ cleanup: QueueCleanupResult; advance?: Advance }> => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${sermonId}`);
    const lockRef = database.ref(`${PROCESS_AUDIO_LOCKS_PATH}/${sermonId}`);
    const [requestSnapshot, queueStateSnapshot, deferredSnapshot, backlog, observedLock] = await Promise.all([
      requestRef.get(), queueStateRef.get(), database.ref(YOUTUBE_QUEUE_DEFERRED_PATH).get(),
      database.ref(MOSES_BACKLOG_FENCES_PATH + '/' + sermonId).get(), lockRef.get(),
    ]);
    const queueState = parseYouTubeQueueState(queueStateSnapshot.val());
    const entries = Object.values((deferredSnapshot.val() ?? {}) as Record<string, StoredDeferredYouTubeRequest>);
    const request = requestSnapshot.val() as StoredProcessAudioRequestState | null;
    const disposition = args.classifySource ? await args.classifySource(backlog.val()) : backlog.exists() ? 'held' : 'ordinary';
    if (disposition !== 'ordinary' || backlog.exists() || (args.deletedAtMs !== undefined && request &&
        (!Number.isFinite(Date.parse(request.updatedAt)) || Date.parse(request.updatedAt) >= args.deletedAtMs))) {
      return { cleanup: { deletedTaskId: null, advancedProbe: false, deferredRemaining: entries.length,
        disposition: disposition === 'ordinary' ? 'stale' : disposition } };
    }

    const deletedTaskId = request?.queuedTaskId ?? null;
    const queue = getFunctions().taskQueue<AddIntroOutroInputType>(getProcessAudioTaskQueueNameForSource(request?.sourceType ?? 'storage'));
    const stillOwns = async () => {
      const claim = (await database.ref(PROCESS_AUDIO_QUEUE_CLAIMS_PATH + '/' + sermonId).get()).val();
      return claim?.requestId === ownerId && Number.isFinite(claim.acquiredAt) && Date.now() - claim.acquiredAt < PROCESS_AUDIO_QUEUE_CLAIM_TTL_MS;
    };
    const changed = { cleanup: { deletedTaskId, advancedProbe: false, deferredRemaining: entries.length, disposition: 'stale' as const } };
    if (!await stillOwns()) return changed;
    await deleteExistingTask(queue, deletedTaskId);
    if (!await stillOwns() || (args.classifySource && await args.classifySource(backlog.val()) !== 'ordinary')) return changed;
    const current = await Promise.all([requestSnapshot, deferredSnapshot.child(sermonId), observedLock].map(async observed => {
      const value = observed.val();
      const removed = await observed.ref.transaction(live => live === null || isDeepStrictEqual(live, value) ? null : undefined, undefined, false);
      return removed.committed && !removed.snapshot.exists();
    }));
    if (!current.every(Boolean)) return changed;
    const remaining = entries.filter(entry => entry.sermonId !== sermonId);
    const cleanup = { deletedTaskId, advancedProbe: false, deferredRemaining: remaining.length };
    const candidate = selectNextDeferredProbe(remaining.filter(entry => !('mosesRecoveryReservation' in entry)), queueState.probeMode);
    if (queueState.probeTaskSermonId === sermonId && candidate) return { cleanup, advance: { entry: candidate, queueState } };
    await queueStateRef.transaction(raw => {
      if (raw === null) return null;
      const current = parseYouTubeQueueState(raw);
      if (!isDeepStrictEqual(current, queueState)) return undefined;
      if (current.probeTaskSermonId !== sermonId) return { ...raw, deferredYouTubeTaskCount: remaining.length };
      return { ...buildInitialYouTubeQueueState(), probeStatus: remaining.length ? 'waiting_for_auth_required_request' : 'idle',
        deferredYouTubeTaskCount: remaining.length };
    }, undefined, false);
    return { cleanup };
  });
  if (!result.advance) return result.cleanup;

  // Release the deleted sermon's claim before taking the candidate's own claim.
  const { entry, queueState } = result.advance;
  return withProcessAudioQueueClaim(database, entry.sermonId, ownerId, async () => {
    const nextRequestRef = database.ref(PROCESS_AUDIO_REQUESTS_PATH + '/' + entry.sermonId);
    const nextDeferredRef = database.ref(YOUTUBE_QUEUE_DEFERRED_PATH + '/' + entry.sermonId);
    const [observedRow, liveDeferred, liveQueue, reserved, lock, recovery] = await Promise.all([nextRequestRef.get(), nextDeferredRef.get(), queueStateRef.get(),
      database.ref(MOSES_BACKLOG_FENCES_PATH + '/' + entry.sermonId).get(), database.ref(PROCESS_AUDIO_LOCKS_PATH + '/' + entry.sermonId).get(),
      database.ref(MOSES_RECOVERY_RECEIPTS_PATH + '/' + entry.sermonId + '/' + entry.requestVersion).get()]);
    if (!isDeepStrictEqual(parseYouTubeQueueState(liveQueue.val()), queueState)) return result.cleanup;
    const nextRequest = observedRow.val() as StoredProcessAudioRequestState | null;
    if (reserved.exists() || recovery.exists() || lock.exists() || (args.isLiveProbeCandidate && !await args.isLiveProbeCandidate(entry)) ||
        !isDeepStrictEqual(liveDeferred.val(), entry) || 'mosesRecoveryReservation' in entry ||
        entry.payload.id !== entry.sermonId || !('youtubeUrl' in entry.payload) ||
        (nextRequest && (nextRequest.currentRequestVersion !== entry.requestVersion || !isDeepStrictEqual(nextRequest.currentPayload, entry.payload) ||
          nextRequest.queuedTaskId || nextRequest.runningRequestId || nextRequest.nextRequestVersion || nextRequest.mosesGuestPilot || nextRequest.mosesGuestPilotIntent))) {
      await queueStateRef.transaction(raw => raw === null ? null : !isDeepStrictEqual(parseYouTubeQueueState(raw), queueState) ? undefined :
        { ...raw, probeTaskSermonId: null, probeRequestVersion: null, probeStartedAt: null, probeMode: null,
          probeDispatchReservationId: null, probeStatus: 'waiting_for_auth_required_request' }, undefined, false);
      return result.cleanup;
    }
    const now = getNowIsoString();
    const taskId = computeProcessAudioTaskId(entry.sermonId, entry.requestVersion, args.ownerId + ':' + entry.deferredAt);
    const reservation = { ...queueState, blocked: false, blockerReason: null, blockedAt: null, probeDispatchReservationId: taskId, probeStartedAt: now, probeStatus: 'probing' as const,
      probeMode: entry.probeMode, probeTaskSermonId: entry.sermonId, probeRequestVersion: entry.requestVersion };
    const reservedState = await queueStateRef.transaction(raw => raw === null ? null :
      isDeepStrictEqual(parseYouTubeQueueState(raw), queueState) ? reservation : undefined, undefined, false);
    if (!reservedState.committed || reservedState.snapshot.child('probeDispatchReservationId').val() !== taskId) return result.cleanup;
    const youtube = getFunctions().taskQueue<AddIntroOutroInputType>(getProcessAudioTaskQueueNameForSource('youtube'));
    await enqueueTask(youtube, entry.payload, taskId, getProcessAudioTargetUriForQueueCleanup('youtube'));
    const owner = (await database.ref(PROCESS_AUDIO_QUEUE_CLAIMS_PATH + '/' + entry.sermonId).get()).val();
    if (owner?.requestId !== ownerId || Date.now() - owner.acquiredAt >= PROCESS_AUDIO_QUEUE_CLAIM_TTL_MS ||
        (await queueStateRef.child('probeDispatchReservationId').get()).val() !== taskId)
      throw new Error('Native probe ownership changed after task dispatch.');
    const state = nextRequest ?? buildProcessAudioRequestState(entry.payload, entry.requestVersion, now);
    const queued = { ...state, queuedTaskId: taskId, queuedAt: now, updatedAt: now };
    delete (queued as Partial<StoredProcessAudioRequestState>).deferredAt;
    const recorded = await nextRequestRef.transaction(current => current === null && nextRequest ? null :
      isDeepStrictEqual(current, nextRequest) ? queued : undefined, undefined, false);
    if (!recorded.committed || recorded.snapshot.child('queuedTaskId').val() !== taskId)
      throw new Error('Dispatched probe has no confirmed request owner.');
    // Retire only this reservation, counting the actual remaining children inside the same transaction.
    const settled = await queueStateRef.parent!.transaction(current => {
      if (!current) return null;
      if (current.state?.probeDispatchReservationId !== taskId || current.state.probeTaskSermonId !== entry.sermonId ||
          current.state.probeRequestVersion !== entry.requestVersion || !isDeepStrictEqual(current.deferred?.[entry.sermonId], entry))
        return undefined;
      const deferred = { ...current.deferred };
      delete deferred[entry.sermonId];
      return { ...current, deferred, state: { ...current.state, probeDispatchReservationId: null,
        deferredYouTubeTaskCount: Object.keys(deferred).length } };
    }, undefined, false);
    if (!settled.committed || settled.snapshot.child('state/probeTaskSermonId').val() !== entry.sermonId ||
        settled.snapshot.child('state/probeDispatchReservationId').exists() || settled.snapshot.child('deferred/' + entry.sermonId).exists())
      throw new Error('Dispatched probe reservation requires reconciliation.');
    return { ...result.cleanup, advancedProbe: true, deferredRemaining: settled.snapshot.child('state/deferredYouTubeTaskCount').val() as number };
  });
}
