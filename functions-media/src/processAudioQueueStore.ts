import type { Database } from 'firebase-admin/database';
import { getFunctions, type TaskQueue } from 'firebase-admin/functions';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import type { GetYouTubeCookieStatusOutputType } from '@upperroom/contracts/getYouTubeCookieStatus';
import {
  buildInitialYouTubeQueueState,
  computeProcessAudioRequestVersion,
  computeProcessAudioTaskId,
  getProcessAudioSourceType,
  isProcessAudioLockActive,
  PROCESS_AUDIO_LOCKS_PATH,
  PROCESS_AUDIO_QUEUE_CLAIMS_PATH,
  PROCESS_AUDIO_REQUESTS_PATH,
  PROCESS_AUDIO_TASK_QUEUE_NAME,
  PROCESS_AUDIO_QUEUE_CLAIM_TTL_MS,
  type ProcessAudioSourceType,
  type StoredDeferredYouTubeRequest,
  type StoredProcessAudioRequestState,
  type StoredYouTubeQueueState,
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

const buildProcessAudioRequestState = (
  payload: AddIntroOutroInputType,
  requestVersion: string,
  updatedAt: string
): StoredProcessAudioRequestState => ({
  sermonId: payload.id,
  sourceType: getProcessAudioSourceType(payload),
  currentPayload: payload,
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
});

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
  const queueState = parseYouTubeQueueState(queueStateSnapshot.val());
  if (queueState.deferredYouTubeTaskCount !== deferredCount) {
    await database.ref(YOUTUBE_QUEUE_STATE_PATH).update({ deferredYouTubeTaskCount: deferredCount });
    queueState.deferredYouTubeTaskCount = deferredCount;
  }

  return { queueState, deferredCount };
}

export async function getYouTubeQueueSnapshot(
  database: Database
): Promise<{ queueState: StoredYouTubeQueueState; deferredCount: number }> {
  return await getQueueStateAndDeferredCount(database);
}

export function isYouTubeQueuePaused(queueState: StoredYouTubeQueueState): boolean {
  return queueState.blocked || queueState.probeStatus === 'probing' || queueState.probeStatus === 'waiting_for_auth_required_request';
}

export function buildYouTubeCookieStatus(
  hasCookies: boolean,
  metadata: YouTubeCookieMetadata | null,
  queueState: StoredYouTubeQueueState,
  deferredCount: number
): GetYouTubeCookieStatusOutputType {
  const disabledUntil = metadata?.disabledUntil ?? null;
  const cookieBreakerOpen = !!disabledUntil && Date.parse(disabledUntil) > Date.now();
  const youtubeQueueBlocked = isYouTubeQueuePaused(queueState);

  return {
    hasCookies,
    cookieBreakerOpen,
    disabledUntil,
    youtubeQueueBlocked,
    probeStatus: queueState.probeStatus,
    deferredYouTubeTaskCount: deferredCount,
    blockerReason: queueState.blockerReason,
    blockerEpisodeId: queueState.blockerEpisodeId,
    blockerUpdatedAt: queueState.blockedAt ?? queueState.probeStartedAt ?? null,
    metadata,
  };
}

async function writeDeferredYouTubeRequest(
  database: Database,
  payload: AddIntroOutroInputType,
  requestVersion: string,
  reason: string
): Promise<void> {
  const deferredRequest: StoredDeferredYouTubeRequest = {
    sermonId: payload.id,
    payload,
    requestVersion,
    deferredAt: getNowIsoString(),
    reason,
    requiresCookieProbe: true,
    blockerEpisodeId: null,
    lastFailureClass: null,
  };

  await database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${payload.id}`).set(deferredRequest);
}

export async function queueOrReplaceProcessAudioRequest(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  targetUri: string;
  ownerId: string;
}): Promise<QueueMutationResult> {
  const { database, payload, targetUri, ownerId } = args;
  const requestVersion = computeProcessAudioRequestVersion(payload);
  const taskId = computeProcessAudioTaskId(payload.id, requestVersion);
  const queue = getFunctions().taskQueue<AddIntroOutroInputType>(PROCESS_AUDIO_TASK_QUEUE_NAME);

  return await withProcessAudioQueueClaim(database, payload.id, ownerId, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${payload.id}`);
    const lockRef = database.ref(`${PROCESS_AUDIO_LOCKS_PATH}/${payload.id}`);
    const [requestSnapshot, lockSnapshot] = await Promise.all([requestRef.get(), lockRef.get()]);
    const now = getNowIsoString();
    const sourceType = getProcessAudioSourceType(payload);
    const currentState = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(payload, requestVersion, now);
    const lockActive = isProcessAudioLockActive(lockSnapshot.val());

    if (lockActive) {
      const nextPayload =
        currentState.currentRequestVersion === requestVersion && !currentState.nextPayload
          ? null
          : currentState.nextRequestVersion === requestVersion && currentState.nextPayload
            ? currentState.nextPayload
            : payload;
      await requestRef.set({
        ...currentState,
        sermonId: payload.id,
        sourceType,
        currentPayload: payload,
        currentRequestVersion: requestVersion,
        nextPayload,
        nextRequestVersion: nextPayload ? requestVersion : null,
        nextUpdatedAt: nextPayload ? now : null,
        updatedAt: now,
      } satisfies StoredProcessAudioRequestState);
      return { action: 'running_replaced', requestVersion, sourceType };
    }

    const { queueState, deferredCount } = await getQueueStateAndDeferredCount(database);
    const deferredRef = database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${payload.id}`);
    const deferredSnapshot = await deferredRef.get();
    const alreadyDeferred = deferredSnapshot.exists();
    const nextState: StoredProcessAudioRequestState = {
      ...currentState,
      sermonId: payload.id,
      sourceType,
      currentPayload: payload,
      currentRequestVersion: requestVersion,
      nextPayload: null,
      nextRequestVersion: null,
      nextUpdatedAt: null,
      runningRequestId: null,
      runningTaskId: null,
      runningRequestVersion: null,
      runningAt: null,
      updatedAt: now,
    };

    if (sourceType === 'youtube' && isYouTubeQueuePaused(queueState)) {
      await writeDeferredYouTubeRequest(database, payload, requestVersion, queueState.blockerReason || queueState.probeStatus);
      nextState.queuedTaskId = null;
      nextState.queuedAt = null;
      nextState.deferredAt = now;
      await requestRef.set(nextState);
      await database
        .ref(YOUTUBE_QUEUE_STATE_PATH)
        .update({ deferredYouTubeTaskCount: deferredCount + (alreadyDeferred ? 0 : 1) });
      return { action: 'deferred', requestVersion, sourceType };
    }

    if (currentState.queuedTaskId === taskId) {
      await requestRef.set({
        ...nextState,
        queuedTaskId: taskId,
        queuedAt: currentState.queuedAt ?? now,
        deferredAt: null,
      });
      return { action: 'queued', requestVersion, taskId, sourceType };
    }

    await deleteExistingTask(queue, currentState.queuedTaskId);
    await queue.enqueue(payload, {
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
}): Promise<void> {
  const { database, targetUri, ownerId } = args;
  const queue = getFunctions().taskQueue<AddIntroOutroInputType>(PROCESS_AUDIO_TASK_QUEUE_NAME);
  const deferredSnapshot = await database.ref(YOUTUBE_QUEUE_DEFERRED_PATH).get();
  const deferredEntries = Object.values((deferredSnapshot.val() as Record<string, StoredDeferredYouTubeRequest> | null) ?? {});
  const probeCandidate = deferredEntries
    .filter((entry) => entry.requiresCookieProbe)
    .sort((left, right) => Date.parse(left.deferredAt) - Date.parse(right.deferredAt))[0];
  const deferredCount = deferredEntries.length;

  if (!probeCandidate) {
    const currentState = parseYouTubeQueueState((await database.ref(YOUTUBE_QUEUE_STATE_PATH).get()).val());
    await database.ref(YOUTUBE_QUEUE_STATE_PATH).set(
      deferredCount > 0
        ? {
            ...currentState,
            blocked: false,
            probeStatus: 'waiting_for_auth_required_request',
            deferredYouTubeTaskCount: deferredCount,
            probeTaskSermonId: null,
            probeRequestVersion: null,
            probeStartedAt: null,
            probeLastFailureClass: null,
            probeLastFailureMessage: null,
          }
        : buildInitialYouTubeQueueState()
    );
    return;
  }

  await withProcessAudioQueueClaim(database, probeCandidate.sermonId, ownerId, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${probeCandidate.sermonId}`);
    const requestSnapshot = await requestRef.get();
    const existingState = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(probeCandidate.payload, probeCandidate.requestVersion, getNowIsoString());
    const taskId = computeProcessAudioTaskId(probeCandidate.sermonId, probeCandidate.requestVersion);
    const now = getNowIsoString();

    await deleteExistingTask(queue, existingState.queuedTaskId);
    await queue.enqueue(probeCandidate.payload, {
      id: taskId,
      dispatchDeadlineSeconds: 1800,
      uri: targetUri,
    });

    await Promise.all([
      requestRef.set({
        ...existingState,
        sermonId: probeCandidate.sermonId,
        sourceType: 'youtube',
        currentPayload: probeCandidate.payload,
        currentRequestVersion: probeCandidate.requestVersion,
        queuedTaskId: taskId,
        queuedAt: now,
        deferredAt: null,
        updatedAt: now,
      } satisfies StoredProcessAudioRequestState),
      database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${probeCandidate.sermonId}`).remove(),
      database.ref(YOUTUBE_QUEUE_STATE_PATH).update({
        blocked: false,
        blockerReason: null,
        blockedAt: null,
        probeStatus: 'probing',
        probeTaskSermonId: probeCandidate.sermonId,
        probeRequestVersion: probeCandidate.requestVersion,
        probeStartedAt: now,
        deferredYouTubeTaskCount: Math.max(0, deferredCount - 1),
      }),
    ]);
  });
}
