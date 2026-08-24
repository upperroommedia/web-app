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
import {
  getProcessAudioTaskQueueNameForSource,
  PROCESS_AUDIO_DEFERRED_DISPOSITIONS,
} from '@upperroom/contracts/processAudioQueue';
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
const POST_LIVE_ARCHIVE_RETRY_DELAYS_SECONDS = [30 * 60, 60 * 60, 2 * 60 * 60, 4 * 60 * 60, 6 * 60 * 60];
const DEFAULT_POST_LIVE_ARCHIVE_MAX_RETRY_COUNT = 12;
const PROCESS_AUDIO_TASKS_LOCATION = process.env.PROCESS_AUDIO_TASKS_LOCATION?.trim() || 'us-central1';
const CLOUD_TASKS_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
};

const getNowIsoString = (): string => new Date().toISOString();

const parsePositiveIntegerEnv = (name: string): number | null => {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const getPostLiveArchiveRetryDelaySeconds = (retryCount: number): number => {
  const configuredDelaySeconds = parsePositiveIntegerEnv('YOUTUBE_POST_LIVE_ARCHIVE_RETRY_DELAY_SECONDS');
  if (configuredDelaySeconds) {
    return configuredDelaySeconds;
  }

  const normalizedRetryCount = Math.max(1, Math.floor(retryCount));
  return POST_LIVE_ARCHIVE_RETRY_DELAYS_SECONDS[
    Math.min(normalizedRetryCount - 1, POST_LIVE_ARCHIVE_RETRY_DELAYS_SECONDS.length - 1)
  ];
};

const getPostLiveArchiveMaxRetryCount = (): number =>
  parsePositiveIntegerEnv('YOUTUBE_POST_LIVE_ARCHIVE_MAX_RETRY_COUNT') ?? DEFAULT_POST_LIVE_ARCHIVE_MAX_RETRY_COUNT;

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

type ProcessAudioTaskQueueLike = Pick<TaskQueue<AddIntroOutroInputType>, 'delete'>;

let processAudioTaskQueueFactory: ((queueName: ProcessAudioTaskQueueName) => ProcessAudioTaskQueueLike) | null = null;
let cloudTasksApiDepsForTesting: CloudTasksApiDeps | null = null;

export function setProcessAudioTaskQueueFactoryForTesting(
  factory: ((queueName: ProcessAudioTaskQueueName) => ProcessAudioTaskQueueLike) | null
): void {
  processAudioTaskQueueFactory = factory;
}

export function setCloudTasksApiDepsForTesting(deps: CloudTasksApiDeps | null): void {
  cloudTasksApiDepsForTesting = deps;
}

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

const computeProcessAudioTaskId = (sermonId: string, requestVersion: string, enqueueToken?: string | null): string => {
  const sermonHash = createHash('sha256').update(sermonId).digest('hex').slice(0, 8);
  const enqueueHash = enqueueToken ? `-${createHash('sha256').update(enqueueToken).digest('hex').slice(0, 8)}` : '';
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
  authFactory?: () => Promise<{ getAccessToken: () => Promise<CloudTasksAccessTokenResponse> }>;
};

type CloudTasksAccessTokenResponse =
  | string
  | {
      token?: string | null;
    }
  | null
  | undefined;

export function normalizeCloudTasksAccessToken(accessToken: CloudTasksAccessTokenResponse): string | null {
  if (typeof accessToken === 'string') {
    return accessToken.trim() || null;
  }

  if (accessToken && typeof accessToken === 'object' && typeof accessToken.token === 'string') {
    return accessToken.token.trim() || null;
  }

  return null;
}

export function buildCloudTasksCreateTaskRequest(args: {
  payload: AddIntroOutroInputType;
  queueName: ProcessAudioTaskQueueName;
  taskId: string;
  projectId?: string;
  location?: string;
  scheduledFor?: Date;
}): CloudTasksCreateTaskRequest {
  const {
    payload,
    queueName,
    taskId,
    projectId = getProcessAudioProjectId(),
    location = PROCESS_AUDIO_TASKS_LOCATION,
    scheduledFor,
  } = args;
  const sanitizedPayload = sanitizeProcessAudioPayload(payload);
  const taskResourcePrefix = `projects/${projectId}/locations/${location}/queues/${queueName}`;
  const taskRequestBody = {
    task: {
      name: `${taskResourcePrefix}/tasks/${taskId}`,
      ...(scheduledFor ? { scheduleTime: scheduledFor.toISOString() } : {}),
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
  deps: CloudTasksApiDeps = {},
  options: { scheduledFor?: Date } = {}
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const authClient =
    (await deps.authFactory?.()) ??
    (await new GoogleAuth({
      scopes: [CLOUD_TASKS_SCOPE],
    }).getClient());
  const accessToken = normalizeCloudTasksAccessToken(await authClient.getAccessToken());

  if (!accessToken) {
    throw new Error(`Failed to acquire an access token for Cloud Tasks queue ${queueName}.`);
  }

  const request = buildCloudTasksCreateTaskRequest({
    payload,
    queueName,
    taskId,
    scheduledFor: options.scheduledFor,
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
    if (response.status === 409 && responseBody.toLowerCase().includes('already_exists')) {
      return;
    }
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

async function deleteExistingTask(queue: ProcessAudioTaskQueueLike, taskId: string | null | undefined): Promise<void> {
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

function getProcessAudioTaskQueue(queueName: ProcessAudioTaskQueueName): ProcessAudioTaskQueueLike {
  return processAudioTaskQueueFactory?.(queueName) ?? getFunctions().taskQueue<AddIntroOutroInputType>(queueName);
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
    Object.values((deferredSnapshot.val() as Record<string, StoredDeferredYouTubeRequest> | null) ?? {})
  );
  const queueState = parseYouTubeQueueState(queueStateSnapshot.val());
  if (queueState.deferredYouTubeTaskCount !== deferredEntries.length) {
    await database.ref(YOUTUBE_QUEUE_STATE_PATH).update({ deferredYouTubeTaskCount: deferredEntries.length });
    queueState.deferredYouTubeTaskCount = deferredEntries.length;
  }

  return { queueState, deferredEntries };
}

export async function getYouTubeQueueScopeDiagnostics(database: Database): Promise<{
  guest: {
    blocked: false;
    blockerReason: null;
    depth: 0;
    oldestDeferredAt: null;
  };
  authenticated: {
    blocked: boolean;
    blockerReason: string | null;
    depth: number;
    oldestDeferredAt: string | null;
  };
  probe: {
    status: StoredYouTubeQueueState['probeStatus'];
    lastSucceededAt: string | null;
    lastFailedAt: string | null;
    lastFailureClass: string | null;
  };
}> {
  const [queueStateSnapshot, deferredSnapshot] = await Promise.all([
    database.ref(YOUTUBE_QUEUE_STATE_PATH).get(),
    database.ref(YOUTUBE_QUEUE_DEFERRED_PATH).get(),
  ]);
  const queueState = parseYouTubeQueueState(queueStateSnapshot.val());
  const deferredEntries = sortDeferredEntries(
    Object.values((deferredSnapshot.val() as Record<string, StoredDeferredYouTubeRequest> | null) ?? {})
  );

  return {
    guest: {
      blocked: false,
      blockerReason: null,
      depth: 0,
      oldestDeferredAt: null,
    },
    authenticated: {
      blocked: queueState.blocked,
      blockerReason:
        queueState.blockerReason ??
        (deferredEntries.length > 0 ? PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH : null),
      depth: deferredEntries.length,
      oldestDeferredAt: deferredEntries[0]?.deferredAt ?? null,
    },
    probe: {
      status: queueState.probeStatus,
      lastSucceededAt: queueState.probeLastSucceededAt,
      lastFailedAt: queueState.probeLastFailedAt,
      lastFailureClass: queueState.probeLastFailureClass,
    },
  };
}

function isYouTubeQueuePaused(_queueState: StoredYouTubeQueueState): boolean {
  return false;
}

async function enqueueTask(payload: AddIntroOutroInputType, taskId: string, scheduledFor?: Date): Promise<void> {
  await enqueueTaskViaCloudTasksApi(
    payload,
    getProcessAudioTaskQueueNameForSource(getProcessAudioSourceType(payload)),
    taskId,
    cloudTasksApiDepsForTesting ?? {},
    { scheduledFor }
  );
}

async function enqueueDeferredRequestIgnoringPause(
  database: Database,
  entry: StoredDeferredYouTubeRequest,
  ownerId: string
): Promise<void> {
  const queue = getProcessAudioTaskQueue(getProcessAudioTaskQueueNameForSource('youtube'));

  await withProcessAudioQueueClaim(database, entry.sermonId, ownerId, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${entry.sermonId}`);
    const requestSnapshot = await requestRef.get();
    const now = getNowIsoString();
    const state = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(entry.payload, entry.requestVersion, now);
    const taskId = computeProcessAudioTaskId(
      entry.sermonId,
      entry.requestVersion,
      `deferred-attempt:${entry.attemptCount ?? 0}`
    );

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

async function drainDeferredYouTubeRequestsAfterProbe(args: {
  database: Database;
  entries: StoredDeferredYouTubeRequest[];
  ownerId: string;
  probeMode: YouTubeQueueProbeMode;
  probeSucceededAt: string;
  log: ReturnType<typeof createLoggerWithContext>;
}): Promise<void> {
  const { database, entries, ownerId, probeMode, probeSucceededAt, log } = args;

  for (const entry of entries) {
    try {
      await enqueueDeferredRequestIgnoringPause(database, entry, `${ownerId}:${entry.sermonId}`);
    } catch (error) {
      log.error('Failed to enqueue deferred YouTube request after successful probe', {
        error: error instanceof Error ? error.message : String(error),
        deferredSermonId: entry.sermonId,
        probeMode,
      });
    }
  }

  const { deferredEntries } = await getQueueStateAndDeferredEntries(database);
  if (deferredEntries.length === 0) {
    await database.ref(YOUTUBE_QUEUE_STATE_PATH).update({
      ...buildInitialYouTubeQueueState(),
      deferredYouTubeTaskCount: 0,
    } satisfies Partial<StoredYouTubeQueueState>);
    return;
  }

  await database.ref(YOUTUBE_QUEUE_STATE_PATH).update({
    ...buildInitialYouTubeQueueState(),
    probeStatus: 'probe_succeeded',
    probeMode,
    probeLastSucceededAt: probeSucceededAt,
    deferredYouTubeTaskCount: deferredEntries.length,
  } satisfies Partial<StoredYouTubeQueueState>);
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
  const queue = getProcessAudioTaskQueue(
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

        await drainDeferredYouTubeRequestsAfterProbe({
          database,
          entries: remainingEntries,
          ownerId: `drain:${requestId}`,
          probeMode: browserProbeSucceeded ? 'browser_fallback' : 'cookie_provider',
          probeSucceededAt: now,
          log,
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

      await drainDeferredYouTubeRequestsAfterProbe({
        database,
        entries: remainingEntries,
        ownerId: `drain:${requestId}`,
        probeMode: 'browser_fallback',
        probeSucceededAt: now,
        log,
      });
    }

    if (requestState.nextPayload && requestState.nextRequestVersion) {
      const nextPayload = requestState.nextPayload;
      const nextTaskId = computeProcessAudioTaskId(
        nextPayload.id,
        requestState.nextRequestVersion,
        `${requestId}:${now}`
      );
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
          deferredYouTubeTaskCount:
            activeQueueState.deferredYouTubeTaskCount + (existingDeferredSnapshot.exists() ? 0 : 1),
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
        transientRetryReason: null,
        transientRetryCount: 0,
        transientRetryNextRunAt: null,
        transientRetryLastFailureMessage: null,
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
      transientRetryReason: null,
      transientRetryCount: 0,
      transientRetryNextRunAt: null,
      transientRetryLastFailureMessage: null,
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
      deferredAt: null,
      transientRetryReason: null,
      transientRetryCount: 0,
      transientRetryNextRunAt: null,
      transientRetryLastFailureMessage: null,
      updatedAt: now,
    } satisfies StoredProcessAudioRequestState);
  });
}

export async function deferPostLiveArchiveYouTubeRequest(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  requestId: string;
  taskId: string | null;
  failureClass: string;
  failureMessage: string;
}): Promise<{
  scheduled: boolean;
  scheduledTaskId: string | null;
  scheduledFor: string | null;
  retryCount: number;
  maxRetryCount: number;
}> {
  const { database, payload, requestId, taskId, failureClass, failureMessage } = args;
  const sanitizedPayload = sanitizeProcessAudioPayload(payload);
  const maxRetryCount = getPostLiveArchiveMaxRetryCount();
  let scheduledTaskId: string | null = null;
  let scheduledForIso: string | null = null;
  let retryCount = 1;

  await withProcessAudioQueueClaim(database, sanitizedPayload.id, `post-live:${requestId}`, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${sanitizedPayload.id}`);
    const queueStateRef = database.ref(YOUTUBE_QUEUE_STATE_PATH);
    const deferredRef = database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${sanitizedPayload.id}`);
    const [requestSnapshot, queueStateSnapshot, deferredSnapshot] = await Promise.all([
      requestRef.get(),
      queueStateRef.get(),
      database.ref(YOUTUBE_QUEUE_DEFERRED_PATH).get(),
    ]);
    const now = getNowIsoString();
    const requestState = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(sanitizedPayload, computeProcessAudioRequestVersion(sanitizedPayload), now);
    const queueState = parseYouTubeQueueState(queueStateSnapshot.val());
    const remainingDeferredEntries = sortDeferredEntries(
      Object.values((deferredSnapshot.val() as Record<string, StoredDeferredYouTubeRequest> | null) ?? {}).filter(
        (entry) => entry.sermonId !== sanitizedPayload.id
      )
    );
    const latestPayload = sanitizeProcessAudioPayload(
      requestState.nextPayload ?? requestState.currentPayload ?? sanitizedPayload
    );
    const latestVersion =
      requestState.nextRequestVersion ??
      requestState.currentRequestVersion ??
      computeProcessAudioRequestVersion(latestPayload);
    const previousRetryCount =
      requestState.transientRetryReason === failureClass && typeof requestState.transientRetryCount === 'number'
        ? requestState.transientRetryCount
        : 0;

    const releaseCurrentProbe = async (): Promise<void> => {
      if (queueState.probeStatus !== 'probing' || queueState.probeTaskSermonId !== sanitizedPayload.id) {
        await deferredRef.remove();
        return;
      }

      const nextProbe = selectNextDeferredProbe(remainingDeferredEntries, queueState.probeMode);
      if (!nextProbe) {
        await Promise.all([
          deferredRef.remove(),
          queueStateRef.set({
            ...buildInitialYouTubeQueueState(),
            probeLastFailedAt: now,
            probeLastFailureClass: failureClass,
            probeLastFailureMessage: failureMessage.slice(0, 1000),
            deferredYouTubeTaskCount: 0,
          } satisfies StoredYouTubeQueueState),
        ]);
        return;
      }

      try {
        await enqueueDeferredRequestIgnoringPause(database, nextProbe, `post-live:${requestId}:${nextProbe.sermonId}`);
        await Promise.all([
          deferredRef.remove(),
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
            probeLastFailedAt: now,
            probeLastFailureClass: failureClass,
            probeLastFailureMessage: failureMessage.slice(0, 1000),
            deferredYouTubeTaskCount: Math.max(0, remainingDeferredEntries.length - 1),
          } satisfies StoredYouTubeQueueState),
        ]);
      } catch (error) {
        await Promise.all([
          deferredRef.remove(),
          queueStateRef.set({
            ...buildInitialYouTubeQueueState(),
            probeStatus: 'waiting_for_auth_required_request',
            probeLastFailedAt: now,
            probeLastFailureClass: 'probe_advance_failed',
            probeLastFailureMessage:
              error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
            deferredYouTubeTaskCount: remainingDeferredEntries.length,
          } satisfies StoredYouTubeQueueState),
        ]);
      }
    };

    retryCount = previousRetryCount + 1;
    if (retryCount > maxRetryCount) {
      await releaseCurrentProbe();
      return;
    }

    const delaySeconds = getPostLiveArchiveRetryDelaySeconds(retryCount);
    const scheduledFor = new Date(Date.now() + delaySeconds * 1000);
    const nowToken = `${now}:${requestId}:post-live:${retryCount}`;
    const nextTaskId = computeProcessAudioTaskId(sanitizedPayload.id, latestVersion, nowToken);
    const queue = getProcessAudioTaskQueue(
      getProcessAudioTaskQueueNameForSource(getProcessAudioSourceType(latestPayload))
    );

    if (requestState.queuedTaskId && requestState.queuedTaskId !== taskId) {
      await deleteExistingTask(queue, requestState.queuedTaskId);
    }

    await enqueueTask(latestPayload, nextTaskId, scheduledFor);

    scheduledTaskId = nextTaskId;
    scheduledForIso = scheduledFor.toISOString();

    await requestRef.set({
      ...requestState,
      sermonId: sanitizedPayload.id,
      sourceType: 'youtube',
      currentPayload: latestPayload,
      currentRequestVersion: latestVersion,
      queuedTaskId: nextTaskId,
      queuedAt: now,
      runningRequestId: null,
      runningTaskId: null,
      runningRequestVersion: null,
      runningAt: null,
      nextPayload: null,
      nextRequestVersion: null,
      nextUpdatedAt: null,
      deferredAt: now,
      transientRetryReason: failureClass,
      transientRetryCount: retryCount,
      transientRetryNextRunAt: scheduledForIso,
      transientRetryLastFailureMessage: failureMessage.slice(0, 1000),
      updatedAt: now,
    } satisfies StoredProcessAudioRequestState);

    await releaseCurrentProbe();
  });

  return {
    scheduled: scheduledTaskId !== null,
    scheduledTaskId,
    scheduledFor: scheduledForIso,
    retryCount,
    maxRetryCount,
  };
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
  const queue = getProcessAudioTaskQueue(
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
  force?: boolean;
}): Promise<{ resumed: boolean; deferredRemaining: number; nextProbeSermonId: string | null }> {
  const { database, ctx, force = false } = args;
  const log = createLoggerWithContext(ctx);
  const queueStateRef = database.ref(YOUTUBE_QUEUE_STATE_PATH);
  const { queueState, deferredEntries: storedDeferredEntries } = await getQueueStateAndDeferredEntries(database);
  const deferredEntries = [...storedDeferredEntries];

  if (queueState.probeStatus === 'probing' && !force) {
    const probeStartedAtMs = queueState.probeStartedAt ? Date.parse(queueState.probeStartedAt) : Number.NaN;
    const probeStillWithinTaskRetryWindow =
      Number.isFinite(probeStartedAtMs) && Date.now() - probeStartedAtMs < PROCESS_AUDIO_TASK_TIMEOUT_SECONDS * 1000;
    if (probeStillWithinTaskRetryWindow) {
      return {
        resumed: false,
        deferredRemaining: deferredEntries.length,
        nextProbeSermonId: queueState.probeTaskSermonId,
      };
    }
  }

  const activeProbeAlreadyDeferred = deferredEntries.some((entry) => entry.sermonId === queueState.probeTaskSermonId);
  if (queueState.probeTaskSermonId && !activeProbeAlreadyDeferred) {
    const requestSnapshot = await database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${queueState.probeTaskSermonId}`).get();
    const requestState = requestSnapshot.exists() ? (requestSnapshot.val() as StoredProcessAudioRequestState) : null;
    if (requestState?.currentPayload && requestState.currentRequestVersion) {
      deferredEntries.push({
        sermonId: queueState.probeTaskSermonId,
        payload: requestState.currentPayload,
        requestVersion: requestState.currentRequestVersion,
        deferredAt: queueState.probeStartedAt ?? requestState.queuedAt ?? requestState.updatedAt,
        reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        dependencyScope: 'authenticated_session',
        probeMode: queueState.probeMode ?? 'cookie_provider',
        blockerEpisodeId: queueState.blockerEpisodeId,
        lastFailureClass: queueState.probeLastFailureClass,
        lastFailureMessage: queueState.probeLastFailureMessage,
        attemptCount: 0,
      });
    }
  }

  const migratedEntries = deferredEntries.map(
    (entry) =>
      ({
        ...entry,
        disposition: entry.disposition ?? PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        dependencyScope: entry.dependencyScope ?? 'authenticated_session',
        attemptCount: entry.attemptCount ?? 0,
      } satisfies StoredDeferredYouTubeRequest)
  );
  await Promise.all(
    migratedEntries.map((entry) => database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${entry.sermonId}`).set(entry))
  );

  if (migratedEntries.length === 0) {
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

  const nextProbe = selectNextDeferredProbe(migratedEntries, queueState.probeMode);
  if (!nextProbe) {
    await queueStateRef.set({
      ...buildInitialYouTubeQueueState(),
      probeStatus: 'waiting_for_auth_required_request',
      deferredYouTubeTaskCount: migratedEntries.length,
    } satisfies StoredYouTubeQueueState);

    log.info('Deferred YouTube queue still has items on startup but no probe candidate could be selected', {
      deferredRemaining: migratedEntries.length,
    });

    return {
      resumed: false,
      deferredRemaining: migratedEntries.length,
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
    deferredYouTubeTaskCount: Math.max(0, migratedEntries.length - 1),
  } satisfies StoredYouTubeQueueState);

  log.info('Resumed deferred YouTube queue on startup', {
    nextProbeSermonId: nextProbe.sermonId,
    previousBlocked: queueState.blocked,
    previousProbeStatus: queueState.probeStatus,
    deferredRemaining: Math.max(0, migratedEntries.length - 1),
  });

  return {
    resumed: true,
    deferredRemaining: Math.max(0, migratedEntries.length - 1),
    nextProbeSermonId: nextProbe.sermonId,
  };
}

export async function deferYouTubeRequestForAuthentication(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  requestId: string;
  failureClass: string;
  failureMessage: string;
  probeMode?: YouTubeQueueProbeMode;
}): Promise<void> {
  const { database, payload, requestId, failureClass, failureMessage, probeMode = 'cookie_provider' } = args;
  const sanitizedPayload = sanitizeProcessAudioPayload(payload);

  await withProcessAudioQueueClaim(database, sanitizedPayload.id, `auth-wait:${requestId}`, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${sanitizedPayload.id}`);
    const deferredRef = database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${sanitizedPayload.id}`);
    const queueStateRef = database.ref(YOUTUBE_QUEUE_STATE_PATH);
    const [requestSnapshot, deferredEntrySnapshot, deferredSnapshot, queueStateSnapshot] = await Promise.all([
      requestRef.get(),
      deferredRef.get(),
      database.ref(YOUTUBE_QUEUE_DEFERRED_PATH).get(),
      queueStateRef.get(),
    ]);
    const now = getNowIsoString();
    const existingDeferred = deferredEntrySnapshot.exists()
      ? (deferredEntrySnapshot.val() as StoredDeferredYouTubeRequest)
      : null;
    const requestState = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(
          existingDeferred?.payload ?? sanitizedPayload,
          existingDeferred?.requestVersion ?? computeProcessAudioRequestVersion(sanitizedPayload),
          now
        );
    const latestPayload = sanitizeProcessAudioPayload(
      requestState.nextPayload ?? requestState.currentPayload ?? existingDeferred?.payload ?? sanitizedPayload
    );
    const latestVersion =
      requestState.nextRequestVersion ??
      requestState.currentRequestVersion ??
      existingDeferred?.requestVersion ??
      computeProcessAudioRequestVersion(latestPayload);
    const originalDeferredAt = existingDeferred?.deferredAt ?? now;
    const queueState = parseYouTubeQueueState(queueStateSnapshot.val());
    const deferredCount = countChildren(deferredSnapshot.val());
    const preserveOtherActiveProbe =
      queueState.probeStatus === 'probing' && queueState.probeTaskSermonId !== sanitizedPayload.id;

    await Promise.all([
      deferredRef.set({
        sermonId: sanitizedPayload.id,
        payload: latestPayload,
        requestVersion: latestVersion,
        deferredAt: originalDeferredAt,
        reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        dependencyScope: 'authenticated_session',
        probeMode,
        blockerEpisodeId: existingDeferred?.blockerEpisodeId ?? queueState.blockerEpisodeId,
        lastFailureClass: failureClass,
        lastFailureMessage: failureMessage.slice(0, 1000),
        attemptCount: (existingDeferred?.attemptCount ?? 0) + 1,
      } satisfies StoredDeferredYouTubeRequest),
      requestRef.set({
        ...requestState,
        sermonId: sanitizedPayload.id,
        sourceType: 'youtube',
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
        deferredAt: originalDeferredAt,
        updatedAt: now,
      } satisfies StoredProcessAudioRequestState),
      queueStateRef.set({
        ...queueState,
        blocked: false,
        blockerReason: null,
        blockedAt: null,
        probeStatus: preserveOtherActiveProbe ? queueState.probeStatus : 'waiting_for_auth_required_request',
        probeTaskSermonId: preserveOtherActiveProbe ? queueState.probeTaskSermonId : null,
        probeRequestVersion: preserveOtherActiveProbe ? queueState.probeRequestVersion : null,
        probeStartedAt: preserveOtherActiveProbe ? queueState.probeStartedAt : null,
        deferredYouTubeTaskCount: deferredCount + (existingDeferred ? 0 : 1),
      } satisfies StoredYouTubeQueueState),
    ]);
  });
}

export async function deferStaleYouTubeRequest(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  requestId: string;
  failureClass: string;
  failureMessage: string;
  probeMode?: YouTubeQueueProbeMode;
}): Promise<{ shouldAlert: boolean; blockerEpisodeId: string | null }> {
  await deferYouTubeRequestForAuthentication(args);
  return {
    shouldAlert: true,
    blockerEpisodeId: null,
  };
}

export const extractCloudTaskId = (headerValue: string | string[] | undefined): string | null => {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const segments = trimmed.split('/');
  return segments[segments.length - 1] || trimmed;
};
