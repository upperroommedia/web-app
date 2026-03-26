import type { Database } from 'firebase-admin/database';
import { getFunctions, type TaskQueue } from 'firebase-admin/functions';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import {
  buildInitialYouTubeQueueState,
  computeProcessAudioRequestVersion,
  computeProcessAudioTaskId,
  getProcessAudioSourceType,
  PROCESS_AUDIO_QUEUE_CLAIMS_PATH,
  PROCESS_AUDIO_REQUESTS_PATH,
  PROCESS_AUDIO_TASK_QUEUE_NAME,
  PROCESS_AUDIO_QUEUE_CLAIM_TTL_MS,
  sanitizeProcessAudioPayload,
  type StoredDeferredYouTubeRequest,
  type StoredProcessAudioRequestState,
  type StoredYouTubeQueueState,
  YOUTUBE_QUEUE_DEFERRED_PATH,
  YOUTUBE_QUEUE_STATE_PATH,
} from '@upperroom/contracts/processAudioQueue';
import type { YouTubeCookieMetadata } from '@upperroom/contracts/youtubeCookies';
import { createLoggerWithContext } from './WinstonLogger';
import type { LogContext } from './context';

const PROCESS_AUDIO_BASE_URLS = {
  prod: 'https://process-audio-yshbijirxq-uc.a.run.app',
  staging: 'https://process-audio-staging-pvaq33fxyq-uc.a.run.app',
  local: 'http://127.0.0.1:8080',
};

const CLAIM_ACQUIRE_ATTEMPTS = 20;
const CLAIM_ACQUIRE_DELAY_MS = 150;
const PROCESS_AUDIO_TASK_TIMEOUT_SECONDS = 1800;
const COOKIE_META_KEY = 'yt-dlp-cookies-meta';

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

const normalizeBaseUrl = (value: string): string => value.replace(/\/process-audio\/?$/u, '').replace(/\/+$/u, '');

function getProcessAudioBaseUrl(): string {
  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    return PROCESS_AUDIO_BASE_URLS.local;
  }

  const configuredTarget =
    process.env.PROCESS_AUDIO_TASK_TARGET_URI ||
    process.env.PROCESS_AUDIO_SERVICE_URL ||
    process.env.NEXT_PUBLIC_PROCESS_AUDIO_SERVICE_URL;

  if (configuredTarget) {
    return normalizeBaseUrl(configuredTarget);
  }

  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  return projectId === 'urm-app-staging' ? PROCESS_AUDIO_BASE_URLS.staging : PROCESS_AUDIO_BASE_URLS.prod;
}

function getProcessAudioTargetUri(): string {
  return `${getProcessAudioBaseUrl()}/process-audio`;
}

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

async function getQueueStateAndDeferredEntries(
  database: Database
): Promise<{ queueState: StoredYouTubeQueueState; deferredEntries: StoredDeferredYouTubeRequest[] }> {
  const [queueStateSnapshot, deferredSnapshot] = await Promise.all([
    database.ref(YOUTUBE_QUEUE_STATE_PATH).get(),
    database.ref(YOUTUBE_QUEUE_DEFERRED_PATH).get(),
  ]);

  const deferredEntries = Object.values(
    (deferredSnapshot.val() as Record<string, StoredDeferredYouTubeRequest> | null) ?? {}
  );
  const queueState = parseYouTubeQueueState(queueStateSnapshot.val());
  if (queueState.deferredYouTubeTaskCount !== deferredEntries.length) {
    await database.ref(YOUTUBE_QUEUE_STATE_PATH).update({ deferredYouTubeTaskCount: deferredEntries.length });
    queueState.deferredYouTubeTaskCount = deferredEntries.length;
  }

  return { queueState, deferredEntries };
}

function isYouTubeQueuePaused(queueState: StoredYouTubeQueueState): boolean {
  return queueState.blocked || queueState.probeStatus === 'probing' || queueState.probeStatus === 'waiting_for_auth_required_request';
}

async function enqueueTask(
  queue: TaskQueue<AddIntroOutroInputType>,
  payload: AddIntroOutroInputType,
  taskId: string
): Promise<void> {
  const sanitizedPayload = sanitizeProcessAudioPayload(payload);
  await queue.enqueue(sanitizedPayload, {
    id: taskId,
    dispatchDeadlineSeconds: PROCESS_AUDIO_TASK_TIMEOUT_SECONDS,
    uri: getProcessAudioTargetUri(),
  });
}

async function enqueueDeferredRequestIgnoringPause(
  database: Database,
  entry: StoredDeferredYouTubeRequest,
  ownerId: string
): Promise<void> {
  const queue = getFunctions().taskQueue<AddIntroOutroInputType>(PROCESS_AUDIO_TASK_QUEUE_NAME);

  await withProcessAudioQueueClaim(database, entry.sermonId, ownerId, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${entry.sermonId}`);
    const requestSnapshot = await requestRef.get();
    const now = getNowIsoString();
    const state = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(entry.payload, entry.requestVersion, now);
    const taskId = computeProcessAudioTaskId(entry.sermonId, entry.requestVersion);

    await deleteExistingTask(queue, state.queuedTaskId);
    await enqueueTask(queue, entry.payload, taskId);

    await Promise.all([
      requestRef.set({
        ...state,
        sermonId: entry.sermonId,
        sourceType: 'youtube',
        currentPayload: sanitizeProcessAudioPayload(entry.payload),
        currentRequestVersion: entry.requestVersion,
        queuedTaskId: taskId,
        queuedAt: now,
        deferredAt: null,
        updatedAt: now,
      } satisfies StoredProcessAudioRequestState),
      database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${entry.sermonId}`).remove(),
    ]);
  });
}

function getYouTubeVideoId(url: string): string | null {
  const match = url.match(/[?&]v=([^&]+)/u) ?? url.match(/youtu\.be\/([^?&]+)/u);
  return match?.[1] ?? null;
}

async function didCookieProbeSucceed(
  database: Database,
  youtubeUrl: string,
  probeStartedAt: string | null
): Promise<boolean> {
  const metaSnapshot = await database.ref(COOKIE_META_KEY).get();
  if (!metaSnapshot.exists()) {
    return false;
  }

  const metadata = metaSnapshot.val() as YouTubeCookieMetadata;
  const videoId = getYouTubeVideoId(youtubeUrl);
  const lastSuccessAt = metadata.lastSuccessAt ? Date.parse(metadata.lastSuccessAt) : NaN;
  const startedAt = probeStartedAt ? Date.parse(probeStartedAt) : NaN;

  return (
    metadata.lastSuccessfulMode === 'cookie_provider' &&
    !!videoId &&
    metadata.lastValidatedVideoId === videoId &&
    !Number.isNaN(lastSuccessAt) &&
    (Number.isNaN(startedAt) || lastSuccessAt >= startedAt)
  );
}

export async function markProcessAudioRequestRunning(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  requestId: string;
  taskId: string | null;
  ctx?: LogContext;
}): Promise<void> {
  const { database, payload, requestId, taskId, ctx } = args;
  const sanitizedPayload = sanitizeProcessAudioPayload(payload);
  const requestVersion = computeProcessAudioRequestVersion(sanitizedPayload);
  const now = getNowIsoString();
  const log = createLoggerWithContext(ctx);

  await withProcessAudioQueueClaim(database, sanitizedPayload.id, `running:${requestId}`, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${sanitizedPayload.id}`);
    const requestSnapshot = await requestRef.get();
    const existingState = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(sanitizedPayload, requestVersion, now);

    await requestRef.set({
      ...existingState,
      sermonId: sanitizedPayload.id,
      sourceType: getProcessAudioSourceType(sanitizedPayload),
      currentPayload: sanitizedPayload,
      currentRequestVersion: requestVersion,
      queuedTaskId: taskId ?? existingState.queuedTaskId,
      runningRequestId: requestId,
      runningTaskId: taskId,
      runningRequestVersion: requestVersion,
      runningAt: now,
      updatedAt: now,
    } satisfies StoredProcessAudioRequestState);

    log.info('Marked process-audio request as running', {
      sermonId: sanitizedPayload.id,
      requestVersion,
      taskId,
    });
  });
}

export async function completeProcessAudioSuccess(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  requestId: string;
  taskId: string | null;
  ctx?: LogContext;
}): Promise<void> {
  const { database, payload, requestId, taskId, ctx } = args;
  const sanitizedPayload = sanitizeProcessAudioPayload(payload);
  const log = createLoggerWithContext(ctx);
  const queue = getFunctions().taskQueue<AddIntroOutroInputType>(PROCESS_AUDIO_TASK_QUEUE_NAME);

  await withProcessAudioQueueClaim(database, sanitizedPayload.id, `success:${requestId}`, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${sanitizedPayload.id}`);
    const [requestSnapshot, queueSnapshot] = await Promise.all([
      requestRef.get(),
      database.ref(YOUTUBE_QUEUE_STATE_PATH).get(),
    ]);
    const now = getNowIsoString();
    const requestState = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(sanitizedPayload, computeProcessAudioRequestVersion(sanitizedPayload), now);
    const queueState = parseYouTubeQueueState(queueSnapshot.val());
    const shouldResolveProbe =
      getProcessAudioSourceType(sanitizedPayload) === 'youtube' &&
      queueState.probeStatus === 'probing' &&
      queueState.probeTaskSermonId === sanitizedPayload.id &&
      queueState.probeRequestVersion === requestState.runningRequestVersion;

    if (shouldResolveProbe) {
      const youtubePayload = 'youtubeUrl' in sanitizedPayload ? sanitizedPayload : null;
      const cookieProbeSucceeded = await didCookieProbeSucceed(
        database,
        youtubePayload?.youtubeUrl ?? '',
        queueState.probeStartedAt
      );

      if (cookieProbeSucceeded) {
        const { deferredEntries } = await getQueueStateAndDeferredEntries(database);
        const remainingEntries = deferredEntries
          .filter((entry) => entry.sermonId !== sanitizedPayload.id)
          .sort((left, right) => Date.parse(left.deferredAt) - Date.parse(right.deferredAt));

        await database.ref(YOUTUBE_QUEUE_STATE_PATH).set({
          ...buildInitialYouTubeQueueState(),
          probeStatus: 'probe_succeeded',
          probeLastSucceededAt: now,
          deferredYouTubeTaskCount: remainingEntries.length,
        } satisfies StoredYouTubeQueueState);

        for (const entry of remainingEntries) {
          await enqueueDeferredRequestIgnoringPause(database, entry, `drain:${requestId}:${entry.sermonId}`);
        }

        await database.ref(YOUTUBE_QUEUE_STATE_PATH).update({
          ...buildInitialYouTubeQueueState(),
          deferredYouTubeTaskCount: 0,
        });
      } else {
        await database.ref(YOUTUBE_QUEUE_STATE_PATH).update({
          blocked: false,
          probeStatus: 'waiting_for_auth_required_request',
          probeTaskSermonId: null,
          probeRequestVersion: null,
          probeStartedAt: null,
        });
      }
    }

    if (requestState.nextPayload && requestState.nextRequestVersion) {
      const nextPayload = requestState.nextPayload;
      const nextTaskId = computeProcessAudioTaskId(nextPayload.id, requestState.nextRequestVersion);
      const activeQueueState = parseYouTubeQueueState((await database.ref(YOUTUBE_QUEUE_STATE_PATH).get()).val());
      const nextSourceType = getProcessAudioSourceType(nextPayload);
      let queuedTaskId: string | null = nextTaskId;
      let queuedAt: string | null = now;
      let deferredAt: string | null = null;

      if (nextSourceType === 'youtube' && isYouTubeQueuePaused(activeQueueState)) {
        const existingDeferredSnapshot = await database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${nextPayload.id}`).get();
        await database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${nextPayload.id}`).set({
          sermonId: nextPayload.id,
          payload: nextPayload,
          requestVersion: requestState.nextRequestVersion,
          deferredAt: now,
          reason: activeQueueState.blockerReason || activeQueueState.probeStatus,
          requiresCookieProbe: true,
          blockerEpisodeId: activeQueueState.blockerEpisodeId,
          lastFailureClass: null,
        } satisfies StoredDeferredYouTubeRequest);
        queuedTaskId = null;
        queuedAt = null;
        deferredAt = now;
        await database.ref(YOUTUBE_QUEUE_STATE_PATH).update({
          deferredYouTubeTaskCount: activeQueueState.deferredYouTubeTaskCount + (existingDeferredSnapshot.exists() ? 0 : 1),
        });
      } else {
        await deleteExistingTask(queue, requestState.queuedTaskId);
        await enqueueTask(queue, nextPayload, nextTaskId);
      }

      await requestRef.set({
        ...requestState,
        currentPayload: nextPayload,
        currentRequestVersion: requestState.nextRequestVersion,
        queuedTaskId,
        queuedAt,
        runningRequestId: null,
        runningTaskId: null,
        runningRequestVersion: null,
        runningAt: null,
        nextPayload: null,
        nextRequestVersion: null,
        nextUpdatedAt: null,
        deferredAt,
        updatedAt: now,
      } satisfies StoredProcessAudioRequestState);
      return;
    }

    await requestRef.set({
      ...requestState,
      queuedTaskId: requestState.queuedTaskId === taskId ? null : requestState.queuedTaskId,
      queuedAt: requestState.queuedTaskId === taskId ? null : requestState.queuedAt,
      runningRequestId: null,
      runningTaskId: null,
      runningRequestVersion: null,
      runningAt: null,
      deferredAt: null,
      updatedAt: now,
    } satisfies StoredProcessAudioRequestState);

    log.info('Completed process-audio request successfully', {
      sermonId: sanitizedPayload.id,
      taskId,
    });
  });
}

export async function completeProcessAudioFailure(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  requestId: string;
  taskId: string | null;
}): Promise<void> {
  const { database, payload, requestId, taskId } = args;
  const sanitizedPayload = sanitizeProcessAudioPayload(payload);

  await withProcessAudioQueueClaim(database, sanitizedPayload.id, `failure:${requestId}`, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${sanitizedPayload.id}`);
    const requestSnapshot = await requestRef.get();
    const now = getNowIsoString();
    const requestState = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(sanitizedPayload, computeProcessAudioRequestVersion(sanitizedPayload), now);

    await requestRef.set({
      ...requestState,
      queuedTaskId: taskId ?? requestState.queuedTaskId,
      queuedAt: requestState.queuedAt ?? now,
      runningRequestId: null,
      runningTaskId: null,
      runningRequestVersion: null,
      runningAt: null,
      updatedAt: now,
    } satisfies StoredProcessAudioRequestState);
  });
}

export async function deferStaleYouTubeRequest(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  requestId: string;
  failureClass: string;
  failureMessage: string;
}): Promise<{ shouldAlert: boolean; blockerEpisodeId: string | null }> {
  const { database, payload, requestId, failureClass, failureMessage } = args;
  const sanitizedPayload = sanitizeProcessAudioPayload(payload);
  const now = getNowIsoString();
  let shouldAlert = false;
  let blockerEpisodeId: string | null = null;

  await withProcessAudioQueueClaim(database, sanitizedPayload.id, `stale:${requestId}`, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${sanitizedPayload.id}`);
    const [requestSnapshot, queueStateSnapshot, deferredSnapshot] = await Promise.all([
      requestRef.get(),
      database.ref(YOUTUBE_QUEUE_STATE_PATH).get(),
      database.ref(YOUTUBE_QUEUE_DEFERRED_PATH).get(),
    ]);
    const requestState = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(sanitizedPayload, computeProcessAudioRequestVersion(sanitizedPayload), now);
    const queueState = parseYouTubeQueueState(queueStateSnapshot.val());
    const latestPayload = sanitizeProcessAudioPayload(requestState.nextPayload ?? requestState.currentPayload ?? sanitizedPayload);
    const latestVersion =
      requestState.nextRequestVersion ??
      requestState.currentRequestVersion ??
      computeProcessAudioRequestVersion(latestPayload);
    const deferredCount = countChildren(deferredSnapshot.val());

    blockerEpisodeId = queueState.blockerEpisodeId || `${sanitizedPayload.id}:${Date.now()}`;
    shouldAlert = !queueState.alertSentAt;
    const existingDeferredForSermon = asRecord(deferredSnapshot.val())?.[sanitizedPayload.id];

    await Promise.all([
      database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${sanitizedPayload.id}`).set({
        sermonId: sanitizedPayload.id,
        payload: latestPayload,
        requestVersion: latestVersion,
        deferredAt: now,
        reason: failureClass,
        requiresCookieProbe: true,
        blockerEpisodeId,
        lastFailureClass: failureClass,
      } satisfies StoredDeferredYouTubeRequest),
      requestRef.set({
        ...requestState,
        currentPayload: latestPayload,
        currentRequestVersion: latestVersion,
        queuedTaskId: null,
        queuedAt: null,
        runningRequestId: null,
        runningTaskId: null,
        runningRequestVersion: null,
        runningAt: null,
        nextPayload: null,
        nextRequestVersion: null,
        nextUpdatedAt: null,
        deferredAt: now,
        updatedAt: now,
      } satisfies StoredProcessAudioRequestState),
      database.ref(YOUTUBE_QUEUE_STATE_PATH).set({
        ...queueState,
        blocked: true,
        blockerReason: failureClass,
        blockedAt: now,
        blockerEpisodeId,
        probeStatus: 'blocked',
        probeTaskSermonId: null,
        probeRequestVersion: null,
        probeStartedAt: null,
        probeLastFailedAt: now,
        probeLastFailureClass: failureClass,
        probeLastFailureMessage: failureMessage.slice(0, 1000),
        alertSentAt: queueState.alertSentAt ?? now,
        deferredYouTubeTaskCount: deferredCount + (existingDeferredForSermon ? 0 : 1),
      } satisfies StoredYouTubeQueueState),
    ]);
  });

  return { shouldAlert, blockerEpisodeId };
}

export const extractCloudTaskId = (headerValue: string | string[] | undefined): string | null => {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const segments = trimmed.split('/');
  return segments[segments.length - 1] || trimmed;
};
