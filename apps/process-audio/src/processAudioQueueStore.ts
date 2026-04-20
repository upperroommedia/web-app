import type { Database } from 'firebase-admin/database';
import { getFunctions, type TaskQueue } from 'firebase-admin/functions';
import { GoogleAuth } from 'google-auth-library';
import { createHash } from 'node:crypto';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import type {
  ProcessAudioSourceType,
  ProcessAudioTaskQueueName,
  StoredDeferredYouTubeRequest,
  StoredProcessAudioRequestState,
  StoredYouTubeQueueState,
  YouTubeQueueProbeMode,
} from '@upperroom/contracts/processAudioQueue';
import { getProcessAudioTaskQueueNameForSource } from '@upperroom/contracts/processAudioQueue';
import { createLoggerWithContext } from './WinstonLogger';
import type { LogContext } from './context';

const PROCESS_AUDIO_QUEUE_CLAIM_TTL_MS = 60 * 1000;
const PROCESS_AUDIO_REQUESTS_PATH = 'processAudioRequests';
const PROCESS_AUDIO_LOCKS_PATH = 'processAudioLocks';
const PROCESS_AUDIO_QUEUE_CLAIMS_PATH = 'processAudioQueueClaims';
const PROCESS_AUDIO_QUEUES_PATH = 'processAudioQueues';
const YOUTUBE_QUEUE_STATE_PATH = `${PROCESS_AUDIO_QUEUES_PATH}/youtube/state`;
const YOUTUBE_QUEUE_DEFERRED_PATH = `${PROCESS_AUDIO_QUEUES_PATH}/youtube/deferred`;

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
const PROCESS_AUDIO_TASKS_LOCATION = process.env.PROCESS_AUDIO_TASKS_LOCATION?.trim() || 'us-central1';
const CLOUD_TASKS_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
};

const getNowIsoString = (): string => new Date().toISOString();

const getProcessAudioProjectId = (): string => {
  return (
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.PROJECT_ID ||
    'urm-app'
  );
};

const getProcessAudioSourceType = (payload: AddIntroOutroInputType): ProcessAudioSourceType => {
  return 'youtubeUrl' in payload ? 'youtube' : 'storage';
};

const sanitizeProcessAudioPayload = (payload: AddIntroOutroInputType): AddIntroOutroInputType => {
  const basePayload = {
    id: payload.id,
    startTime: payload.startTime,
    duration: payload.duration,
    deleteOriginal: payload.deleteOriginal ?? false,
    skipTranscode: payload.skipTranscode ?? false,
  };

  const introOutro =
    typeof payload.introUrl === 'string' || typeof payload.outroUrl === 'string'
      ? {
          ...(typeof payload.introUrl === 'string' ? { introUrl: payload.introUrl } : {}),
          ...(typeof payload.outroUrl === 'string' ? { outroUrl: payload.outroUrl } : {}),
        }
      : {};

  if ('youtubeUrl' in payload) {
    return {
      ...basePayload,
      ...introOutro,
      youtubeUrl: payload.youtubeUrl,
    };
  }

  return {
    ...basePayload,
    ...introOutro,
    storageFilePath: payload.storageFilePath,
  };
};

const computeProcessAudioRequestVersion = (payload: AddIntroOutroInputType): string => {
  const normalized = {
    sermonId: payload.id,
    sourceType: getProcessAudioSourceType(payload),
    sourceValue: 'youtubeUrl' in payload ? payload.youtubeUrl : payload.storageFilePath,
    startTime: payload.startTime,
    duration: payload.duration,
    deleteOriginal: payload.deleteOriginal ?? false,
    skipTranscode: payload.skipTranscode ?? false,
    introUrl: payload.introUrl ?? null,
    outroUrl: payload.outroUrl ?? null,
  };

  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
};

const computeProcessAudioTaskId = (
  sermonId: string,
  requestVersion: string,
  enqueueToken?: string | null
): string => {
  const sermonHash = createHash('sha256').update(sermonId).digest('hex').slice(0, 8);
  const enqueueHash = enqueueToken
    ? `-${createHash('sha256').update(enqueueToken).digest('hex').slice(0, 8)}`
    : '';
  return `pa-${sermonHash}-${requestVersion}${enqueueHash}`;
};

const buildInitialYouTubeQueueState = (): StoredYouTubeQueueState => ({
  blocked: false,
  blockerReason: null,
  blockedAt: null,
  blockerEpisodeId: null,
  probeMode: null,
  probeStatus: 'idle',
  probeTaskSermonId: null,
  probeRequestVersion: null,
  probeStartedAt: null,
  probeLastSucceededAt: null,
  probeLastFailedAt: null,
  probeLastFailureClass: null,
  probeLastFailureMessage: null,
  alertSentAt: null,
  deferredYouTubeTaskCount: 0,
});

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

function getProcessAudioBaseUrl(sourceType: ProcessAudioSourceType = 'storage'): string {
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
    return normalizeBaseUrl(configuredTarget);
  }

  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    return PROCESS_AUDIO_BASE_URLS.local;
  }

  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  const targetSet = projectId === 'urm-app-staging' ? PROCESS_AUDIO_BASE_URLS.staging : PROCESS_AUDIO_BASE_URLS.prod;
  return targetSet[sourceType];
}

function getProcessAudioTargetUri(sourceType: ProcessAudioSourceType = 'storage'): string {
  return `${getProcessAudioBaseUrl(sourceType)}/process-audio`;
}

type CloudTasksCreateTaskRequest = {
  url: string;
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
  };
};

type CloudTasksApiDeps = {
  fetchImpl?: typeof fetch;
  authFactory?: () => Promise<{ getAccessToken: () => Promise<string | null | undefined> }>;
};

export function buildCloudTasksCreateTaskRequest(args: {
  payload: AddIntroOutroInputType;
  queueName: ProcessAudioTaskQueueName;
  taskId: string;
  projectId?: string;
  location?: string;
}): CloudTasksCreateTaskRequest {
  const { payload, queueName, taskId, projectId = getProcessAudioProjectId(), location = PROCESS_AUDIO_TASKS_LOCATION } =
    args;
  const sanitizedPayload = sanitizeProcessAudioPayload(payload);
  const taskResourcePrefix = `projects/${projectId}/locations/${location}/queues/${queueName}`;
  const taskRequestBody = {
    task: {
      name: `${taskResourcePrefix}/tasks/${taskId}`,
      dispatchDeadline: `${PROCESS_AUDIO_TASK_TIMEOUT_SECONDS}s`,
      httpRequest: {
        httpMethod: 'POST',
        url: getProcessAudioTargetUri(getProcessAudioSourceType(payload)),
        headers: {
          'Content-Type': 'application/json',
        },
        body: Buffer.from(JSON.stringify({ data: sanitizedPayload }), 'utf8').toString('base64'),
      },
    },
  };

  return {
    url: `https://cloudtasks.googleapis.com/v2/${taskResourcePrefix}/tasks`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(taskRequestBody),
    },
  };
}

export async function enqueueTaskViaCloudTasksApi(
  payload: AddIntroOutroInputType,
  queueName: ProcessAudioTaskQueueName,
  taskId: string,
  deps: CloudTasksApiDeps = {}
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const authClient =
    (await deps.authFactory?.()) ??
    (await new GoogleAuth({
      scopes: [CLOUD_TASKS_SCOPE],
    }).getClient());
  const accessToken = await authClient.getAccessToken();

  if (!accessToken) {
    throw new Error(`Failed to acquire an access token for Cloud Tasks queue ${queueName}.`);
  }

  const request = buildCloudTasksCreateTaskRequest({
    payload,
    queueName,
    taskId,
  });
  const response = await fetchImpl(request.url, {
    ...request.init,
    headers: {
      ...request.init.headers,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Failed to create Cloud Task ${taskId} in queue ${queueName}: HTTP ${response.status} ${
        response.statusText || ''
      } ${responseBody}`.trim()
    );
  }
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

  const deferredEntries = sortDeferredEntries(
    Object.values(
    (deferredSnapshot.val() as Record<string, StoredDeferredYouTubeRequest> | null) ?? {}
    )
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

async function enqueueTask(payload: AddIntroOutroInputType, taskId: string): Promise<void> {
  await enqueueTaskViaCloudTasksApi(payload, getProcessAudioTaskQueueNameForSource(getProcessAudioSourceType(payload)), taskId);
}

async function enqueueDeferredRequestIgnoringPause(
  database: Database,
  entry: StoredDeferredYouTubeRequest,
  ownerId: string
): Promise<void> {
  const queue = getFunctions().taskQueue<AddIntroOutroInputType>(getProcessAudioTaskQueueNameForSource('youtube'));

  await withProcessAudioQueueClaim(database, entry.sermonId, ownerId, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${entry.sermonId}`);
    const requestSnapshot = await requestRef.get();
    const now = getNowIsoString();
    const state = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(entry.payload, entry.requestVersion, now);
    const taskId = computeProcessAudioTaskId(entry.sermonId, entry.requestVersion, `${ownerId}:${now}`);

    await deleteExistingTask(queue, state.queuedTaskId);
    await enqueueTask(entry.payload, taskId);

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

function didBrowserProbeSucceed(queueState: StoredYouTubeQueueState, payload: AddIntroOutroInputType): boolean {
  return (
    getProcessAudioSourceType(payload) === 'youtube' &&
    queueState.probeMode === 'browser_fallback' &&
    queueState.probeStatus === 'probing' &&
    queueState.probeTaskSermonId === payload.id
  );
}

async function didCookieProbeSucceed(
  database: Database,
  youtubeUrl: string,
  probeStartedAt: string | null
): Promise<boolean> {
  void database;
  void youtubeUrl;
  void probeStartedAt;
  return true;
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
  const queue = getFunctions().taskQueue<AddIntroOutroInputType>(
    getProcessAudioTaskQueueNameForSource(getProcessAudioSourceType(sanitizedPayload))
  );

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
      const browserProbeSucceeded = didBrowserProbeSucceed(queueState, sanitizedPayload);
      const youtubePayload = 'youtubeUrl' in sanitizedPayload ? sanitizedPayload : null;
      const cookieProbeSucceeded = browserProbeSucceeded
        ? false
        : await didCookieProbeSucceed(database, youtubePayload?.youtubeUrl ?? '', queueState.probeStartedAt);

      if (browserProbeSucceeded || cookieProbeSucceeded) {
        const { deferredEntries } = await getQueueStateAndDeferredEntries(database);
        const remainingEntries = deferredEntries
          .filter((entry) => entry.sermonId !== sanitizedPayload.id)
          .sort((left, right) => Date.parse(left.deferredAt) - Date.parse(right.deferredAt));

        await database.ref(YOUTUBE_QUEUE_STATE_PATH).set({
          ...buildInitialYouTubeQueueState(),
          probeStatus: 'probe_succeeded',
          probeMode: browserProbeSucceeded ? 'browser_fallback' : 'cookie_provider',
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
          probeMode: null,
          probeStatus: 'waiting_for_auth_required_request',
          probeTaskSermonId: null,
          probeRequestVersion: null,
          probeStartedAt: null,
        });
      }
    } else if (didBrowserProbeSucceed(queueState, sanitizedPayload)) {
      const { deferredEntries } = await getQueueStateAndDeferredEntries(database);
      const remainingEntries = deferredEntries
        .filter((entry) => entry.sermonId !== sanitizedPayload.id)
        .sort((left, right) => Date.parse(left.deferredAt) - Date.parse(right.deferredAt));

      await database.ref(YOUTUBE_QUEUE_STATE_PATH).set({
        ...buildInitialYouTubeQueueState(),
        probeStatus: 'probe_succeeded',
        probeMode: 'browser_fallback',
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
    }

    if (requestState.nextPayload && requestState.nextRequestVersion) {
      const nextPayload = requestState.nextPayload;
      const nextTaskId = computeProcessAudioTaskId(nextPayload.id, requestState.nextRequestVersion, `${requestId}:${now}`);
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
          probeMode: activeQueueState.probeMode ?? 'cookie_provider',
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
        await enqueueTask(nextPayload, nextTaskId);
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

export async function cleanupDeletedSermonProcessAudioState(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  requestId: string;
  taskId: string | null;
  ctx?: LogContext;
}): Promise<{ advancedProbe: boolean; deferredRemaining: number }> {
  const { database, payload, requestId, taskId, ctx } = args;
  const sanitizedPayload = sanitizeProcessAudioPayload(payload);
  const log = createLoggerWithContext(ctx);
  const queue = getFunctions().taskQueue<AddIntroOutroInputType>(
    getProcessAudioTaskQueueNameForSource(getProcessAudioSourceType(sanitizedPayload))
  );

  return await withProcessAudioQueueClaim(database, sanitizedPayload.id, `cleanup:${requestId}`, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${sanitizedPayload.id}`);
    const deferredRef = database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${sanitizedPayload.id}`);
    const lockRef = database.ref(`${PROCESS_AUDIO_LOCKS_PATH}/${sanitizedPayload.id}`);
    const queueStateRef = database.ref(YOUTUBE_QUEUE_STATE_PATH);
    const [requestSnapshot, { queueState, deferredEntries }] = await Promise.all([
      requestRef.get(),
      getQueueStateAndDeferredEntries(database),
    ]);
    const requestState = requestSnapshot.exists() ? (requestSnapshot.val() as StoredProcessAudioRequestState) : null;
    const remainingDeferredEntries = deferredEntries.filter((entry) => entry.sermonId !== sanitizedPayload.id);
    const activeTaskId = requestState?.queuedTaskId ?? taskId;

    await deleteExistingTask(queue, activeTaskId);
    await Promise.all([requestRef.remove(), deferredRef.remove(), lockRef.remove()]);

    if (queueState.probeTaskSermonId !== sanitizedPayload.id) {
      if (queueState.deferredYouTubeTaskCount !== remainingDeferredEntries.length) {
        await queueStateRef.update({ deferredYouTubeTaskCount: remainingDeferredEntries.length });
      }
      log.info('Cleared deleted sermon from process-audio queue state', {
        sermonId: sanitizedPayload.id,
        advancedProbe: false,
        deferredRemaining: remainingDeferredEntries.length,
      });
      return {
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
      log.info('Cleared deleted sermon and reset YouTube queue probe state', {
        sermonId: sanitizedPayload.id,
        advancedProbe: false,
        deferredRemaining: remainingDeferredEntries.length,
      });
      return {
        advancedProbe: false,
        deferredRemaining: remainingDeferredEntries.length,
      };
    }

    const now = getNowIsoString();
    await enqueueDeferredRequestIgnoringPause(database, nextProbe, `cleanup:${requestId}:${nextProbe.sermonId}`);
    await queueStateRef.set({
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
    } satisfies StoredYouTubeQueueState);

    log.info('Cleared deleted sermon and advanced YouTube queue probe', {
      sermonId: sanitizedPayload.id,
      nextProbeSermonId: nextProbe.sermonId,
      deferredRemaining: Math.max(0, remainingDeferredEntries.length - 1),
    });
    return {
      advancedProbe: true,
      deferredRemaining: Math.max(0, remainingDeferredEntries.length - 1),
    };
  });
}

export async function resumeDeferredYouTubeQueueOnStartup(args: {
  database: Database;
  ctx?: LogContext;
}): Promise<{ resumed: boolean; deferredRemaining: number; nextProbeSermonId: string | null }> {
  const { database, ctx } = args;
  const log = createLoggerWithContext(ctx);
  const queueStateRef = database.ref(YOUTUBE_QUEUE_STATE_PATH);
  const { queueState, deferredEntries } = await getQueueStateAndDeferredEntries(database);

  if (deferredEntries.length === 0) {
    if (queueState.blocked || queueState.probeStatus !== 'idle' || queueState.deferredYouTubeTaskCount !== 0) {
      await queueStateRef.set(buildInitialYouTubeQueueState());
      log.info('Reset stale YouTube queue state on startup with no deferred entries remaining', {
        blocked: queueState.blocked,
        probeStatus: queueState.probeStatus,
        deferredRemaining: 0,
      });
    }

    return {
      resumed: false,
      deferredRemaining: 0,
      nextProbeSermonId: null,
    };
  }

  const nextProbe = selectNextDeferredProbe(deferredEntries, queueState.probeMode);
  if (!nextProbe) {
    await queueStateRef.set({
      ...buildInitialYouTubeQueueState(),
      probeStatus: 'waiting_for_auth_required_request',
      deferredYouTubeTaskCount: deferredEntries.length,
    } satisfies StoredYouTubeQueueState);

    log.info('Deferred YouTube queue still has items on startup but no probe candidate could be selected', {
      deferredRemaining: deferredEntries.length,
    });

    return {
      resumed: false,
      deferredRemaining: deferredEntries.length,
      nextProbeSermonId: null,
    };
  }

  const now = getNowIsoString();
  await enqueueDeferredRequestIgnoringPause(database, nextProbe, `startup:${now}:${nextProbe.sermonId}`);
  await queueStateRef.set({
    ...queueState,
    blocked: false,
    blockerReason: null,
    blockedAt: null,
    probeMode: nextProbe.probeMode,
    probeStatus: 'probing',
    probeTaskSermonId: nextProbe.sermonId,
    probeRequestVersion: nextProbe.requestVersion,
    probeStartedAt: now,
    deferredYouTubeTaskCount: Math.max(0, deferredEntries.length - 1),
  } satisfies StoredYouTubeQueueState);

  log.info('Resumed deferred YouTube queue on startup', {
    nextProbeSermonId: nextProbe.sermonId,
    previousBlocked: queueState.blocked,
    previousProbeStatus: queueState.probeStatus,
    deferredRemaining: Math.max(0, deferredEntries.length - 1),
  });

  return {
    resumed: true,
    deferredRemaining: Math.max(0, deferredEntries.length - 1),
    nextProbeSermonId: nextProbe.sermonId,
  };
}

export async function deferStaleYouTubeRequest(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  requestId: string;
  failureClass: string;
  failureMessage: string;
  probeMode?: YouTubeQueueProbeMode;
}): Promise<{ shouldAlert: boolean; blockerEpisodeId: string | null }> {
  const { database, payload, requestId, failureClass, failureMessage, probeMode = 'cookie_provider' } = args;
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
        probeMode,
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
        probeMode,
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
