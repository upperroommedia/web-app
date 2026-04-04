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
}): Promise<QueueCleanupResult> {
  const { database, sermonId, ownerId } = args;

  return await withProcessAudioQueueClaim(database, sermonId, ownerId, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${sermonId}`);
    const deferredRef = database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${sermonId}`);
    const lockRef = database.ref(`${PROCESS_AUDIO_LOCKS_PATH}/${sermonId}`);
    const queueStateRef = database.ref(YOUTUBE_QUEUE_STATE_PATH);
    const [requestSnapshot, queueStateSnapshot, deferredSnapshot] = await Promise.all([
      requestRef.get(),
      queueStateRef.get(),
      database.ref(YOUTUBE_QUEUE_DEFERRED_PATH).get(),
    ]);

    const requestState = requestSnapshot.exists() ? (requestSnapshot.val() as StoredProcessAudioRequestState) : null;
    const queueState = parseYouTubeQueueState(queueStateSnapshot.val());
    const deferredEntries = Object.values(
      (deferredSnapshot.val() as Record<string, StoredDeferredYouTubeRequest> | null) ?? {}
    );
    const remainingDeferredEntries = sortDeferredEntries(deferredEntries.filter((entry) => entry.sermonId !== sermonId));
    const deletedTaskId = requestState?.queuedTaskId ?? null;
    const requestSourceType = requestState?.sourceType ?? 'storage';
    const queue = getFunctions().taskQueue<AddIntroOutroInputType>(getProcessAudioTaskQueueNameForSource(requestSourceType));

    await deleteExistingTask(queue, deletedTaskId);
    await Promise.all([requestRef.remove(), deferredRef.remove(), lockRef.remove()]);

    if (queueState.probeTaskSermonId !== sermonId) {
      if (queueState.deferredYouTubeTaskCount !== remainingDeferredEntries.length) {
        await queueStateRef.update({ deferredYouTubeTaskCount: remainingDeferredEntries.length });
      }
      return {
        deletedTaskId,
        advancedProbe: false,
        deferredRemaining: remainingDeferredEntries.length,
      };
    }

    const nextProbe = selectNextDeferredProbe(remainingDeferredEntries, queueState.probeMode);
    if (!nextProbe) {
      await queueStateRef.set(
        remainingDeferredEntries.length > 0
          ? {
              ...buildInitialYouTubeQueueState(),
              probeStatus: 'waiting_for_auth_required_request',
              deferredYouTubeTaskCount: remainingDeferredEntries.length,
            }
          : buildInitialYouTubeQueueState()
      );

      return {
        deletedTaskId,
        advancedProbe: false,
        deferredRemaining: remainingDeferredEntries.length,
      };
    }

    const nextRequestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${nextProbe.sermonId}`);
    const nextRequestSnapshot = await nextRequestRef.get();
    const now = getNowIsoString();
    const nextTargetUri = getProcessAudioTargetUriForQueueCleanup('youtube');
    const nextRequestState = nextRequestSnapshot.exists()
      ? (nextRequestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(nextProbe.payload, nextProbe.requestVersion, now);
    const nextTaskId = computeProcessAudioTaskId(nextProbe.sermonId, nextProbe.requestVersion, `${ownerId}:${now}`);

    await deleteExistingTask(queue, nextRequestState.queuedTaskId);
    await enqueueTask(
      getFunctions().taskQueue<AddIntroOutroInputType>(getProcessAudioTaskQueueNameForSource('youtube')),
      nextProbe.payload,
      nextTaskId,
      nextTargetUri
    );

    await Promise.all([
      nextRequestRef.set({
        ...nextRequestState,
        sermonId: nextProbe.sermonId,
        sourceType: 'youtube',
        currentPayload: sanitizeProcessAudioPayload(nextProbe.payload),
        currentRequestVersion: nextProbe.requestVersion,
        queuedTaskId: nextTaskId,
        queuedAt: now,
        deferredAt: null,
        updatedAt: now,
      } satisfies StoredProcessAudioRequestState),
      database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${nextProbe.sermonId}`).remove(),
      queueStateRef.set({
        ...queueState,
        blocked: false,
        blockerReason: null,
        blockedAt: null,
        probeMode: nextProbe.probeMode,
        probeStatus: 'probing',
        probeTaskSermonId: nextProbe.sermonId,
        probeRequestVersion: nextProbe.requestVersion,
        probeStartedAt: now,
        deferredYouTubeTaskCount: Math.max(0, remainingDeferredEntries.length - 1),
      } satisfies StoredYouTubeQueueState),
    ]);

    return {
      deletedTaskId,
      advancedProbe: true,
      deferredRemaining: Math.max(0, remainingDeferredEntries.length - 1),
    };
  });
}
