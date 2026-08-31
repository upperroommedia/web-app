import type { Database } from 'firebase-admin/database';
import { getFunctions, type TaskQueue } from 'firebase-admin/functions';
import { GoogleAuth } from 'google-auth-library';
import { createHash, randomUUID } from 'node:crypto';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import type {
  ProcessAudioSourceType,
  ProcessAudioTaskQueueName,
  LegacyStoredDeferredYouTubeRequest,
  StoredDeferredYouTubeRequest,
  StoredProcessAudioRequestState,
  StoredYouTubeQueueState,
  YouTubeSuccessfulAcquisitionAuthority,
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
  probeDispatchReservationId: null,
  probeLastSucceededAt: null,
  probeLastFailedAt: null,
  probeLastFailureClass: null,
  probeLastFailureMessage: null,
  alertSentAt: null,
  alertReservationId: null,
  deferredYouTubeTaskCount: 0,
  lastAttemptedAuthRecoveryGeneration: null,
  lastDrainAttemptedAt: null,
  lastSuccessfulDrainAt: null,
  lastDrainOutcome: 'not_attempted',
  lastDrainAttemptedCount: 0,
  lastDrainSucceededCount: 0,
});

const parseYouTubeQueueState = (value: unknown): StoredYouTubeQueueState => {
  const record = asRecord(value);
  return {
    ...buildInitialYouTubeQueueState(),
    ...(record as Partial<StoredYouTubeQueueState> | null),
  };
};

/**
 * Firebase RTDB transactions invoke their update callback once with the local
 * cache before consulting the server. A fresh Admin SDK process has no local
 * value for the queue state, so guarded callbacks that return `undefined` on
 * that initial `null` abort without ever comparing against the live state.
 *
 * Returning `null` once performs a no-op compare: a non-null server value
 * causes Firebase to retry with the authoritative state, while a genuinely
 * absent server value remains absent. `committed` is exposed only when the
 * caller's guarded mutation actually ran.
 */
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

const getYouTubeQueueDrainTelemetry = (
  queueState: StoredYouTubeQueueState
): Pick<
  StoredYouTubeQueueState,
  | 'lastDrainAttemptedAt'
  | 'lastSuccessfulDrainAt'
  | 'lastDrainOutcome'
  | 'lastDrainAttemptedCount'
  | 'lastDrainSucceededCount'
> => ({
  lastDrainAttemptedAt: queueState.lastDrainAttemptedAt ?? null,
  lastSuccessfulDrainAt: queueState.lastSuccessfulDrainAt ?? null,
  lastDrainOutcome: queueState.lastDrainOutcome ?? 'not_attempted',
  lastDrainAttemptedCount: queueState.lastDrainAttemptedCount ?? 0,
  lastDrainSucceededCount: queueState.lastDrainSucceededCount ?? 0,
});

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

async function reserveDeferredYouTubeProbeDispatch(args: {
  database: Database;
  observedQueueState: StoredYouTubeQueueState;
  observedDeferredCount: number;
  desiredDeferredCount: number;
  nextProbe: StoredDeferredYouTubeRequest;
  probeStartedAt: string;
  authenticatedRecoveryGeneration?: string;
}): Promise<{ reserved: boolean; reservationId: string }> {
  const {
    database,
    observedQueueState,
    observedDeferredCount,
    desiredDeferredCount,
    nextProbe,
    probeStartedAt,
    authenticatedRecoveryGeneration,
  } = args;
  const reservationId = randomUUID();
  const result = await runGuardedYouTubeQueueStateTransaction(database, (currentQueueState) => {
    if (!matchesObservedYouTubeProbe(currentQueueState, observedQueueState)) {
      return undefined;
    }

    return {
      ...currentQueueState,
      blocked: false,
      blockerReason: null,
      blockedAt: null,
      probeMode: nextProbe.probeMode,
      probeStatus: 'probing',
      probeTaskSermonId: nextProbe.sermonId,
      probeRequestVersion: nextProbe.requestVersion,
      probeStartedAt,
      probeDispatchReservationId: reservationId,
      deferredYouTubeTaskCount: reconcileDeferredYouTubeTaskCount(
        currentQueueState.deferredYouTubeTaskCount,
        observedDeferredCount,
        desiredDeferredCount
      ),
      lastAttemptedAuthRecoveryGeneration:
        authenticatedRecoveryGeneration ?? currentQueueState.lastAttemptedAuthRecoveryGeneration ?? null,
    } satisfies StoredYouTubeQueueState;
  });

  return { reserved: result.committed, reservationId };
}

async function compensateDeferredYouTubeProbeDispatch(args: {
  database: Database;
  nextProbe: StoredDeferredYouTubeRequest;
  reservationId: string;
}): Promise<void> {
  const { database, nextProbe, reservationId } = args;
  const deferredSnapshot = await database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${nextProbe.sermonId}`).get();
  if (!deferredSnapshot.exists()) {
    return;
  }

  await runGuardedYouTubeQueueStateTransaction(database, (currentQueueState) => {
    if (
      currentQueueState.probeDispatchReservationId !== reservationId ||
      currentQueueState.probeTaskSermonId !== nextProbe.sermonId ||
      currentQueueState.probeRequestVersion !== nextProbe.requestVersion
    ) {
      return undefined;
    }

    const deferredYouTubeTaskCount = currentQueueState.deferredYouTubeTaskCount + 1;
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
      deferredYouTubeTaskCount,
    } satisfies StoredYouTubeQueueState;
  });
}

async function stillOwnsReservedDeferredDispatch(args: {
  database: Database;
  entry: StoredDeferredYouTubeRequest;
  reservationId: string;
}): Promise<boolean> {
  const { database, entry, reservationId } = args;
  const [queueStateSnapshot, deferredSnapshot] = await Promise.all([
    database.ref(YOUTUBE_QUEUE_STATE_PATH).get(),
    database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${entry.sermonId}`).get(),
  ]);
  const queueState = parseYouTubeQueueState(queueStateSnapshot.val());
  const liveDeferred = deferredSnapshot.exists()
    ? parseDeferredEntries({ [entry.sermonId]: deferredSnapshot.val() })[0] ?? null
    : null;
  return (
    queueState.probeStatus === 'probing' &&
    queueState.probeTaskSermonId === entry.sermonId &&
    queueState.probeRequestVersion === entry.requestVersion &&
    queueState.probeDispatchReservationId === reservationId &&
    liveDeferred?.requestVersion === entry.requestVersion
  );
}

const sortDeferredEntries = (entries: StoredDeferredYouTubeRequest[]): StoredDeferredYouTubeRequest[] => {
  return [...entries].sort((left, right) => Date.parse(left.deferredAt) - Date.parse(right.deferredAt));
};

const parseDeferredEntries = (value: unknown): StoredDeferredYouTubeRequest[] =>
  Object.values((value as Record<string, LegacyStoredDeferredYouTubeRequest> | null) ?? {}).map((entry) => ({
    ...entry,
    disposition: entry.disposition ?? PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
    dependencyScope: entry.dependencyScope ?? 'authenticated_session',
  }));

const selectNextDeferredProbe = (entries: StoredDeferredYouTubeRequest[]): StoredDeferredYouTubeRequest | null => {
  return sortDeferredEntries(entries)[0] ?? null;
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
  taskName: string;
  inspectionUrl: string;
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

export class CloudTaskNameTombstonedError extends Error {
  constructor(readonly taskId: string, readonly queueName: ProcessAudioTaskQueueName) {
    super(`Cloud Task name ${taskId} remains reserved by a deleted task in queue ${queueName}.`);
    this.name = 'CloudTaskNameTombstonedError';
  }
}

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
  const taskName = `${taskResourcePrefix}/tasks/${taskId}`;
  const inspectionUrl = new URL(`/v2/${taskName}`, 'https://cloudtasks.googleapis.com').toString();
  const taskRequestBody = {
    task: {
      name: taskName,
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
    taskName,
    inspectionUrl,
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
    if (response.status === 409) {
      const inspectionResponse = await fetchImpl(request.inspectionUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (inspectionResponse.status === 404) {
        throw new CloudTaskNameTombstonedError(taskId, queueName);
      }
      if (!inspectionResponse.ok) {
        throw new Error(
          `Failed to inspect existing Cloud Task ${taskId} in queue ${queueName}: HTTP ${inspectionResponse.status} ${
            inspectionResponse.statusText || ''
          } ${(await inspectionResponse.text()).slice(0, 1000)}`.trim()
        );
      }

      const inspectedTask = (await inspectionResponse.json()) as { name?: unknown };
      if (inspectedTask.name !== request.taskName) {
        throw new Error(`Existing Cloud Task ${taskId} did not match the expected task resource.`);
      }
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

  const deferredEntries = sortDeferredEntries(parseDeferredEntries(deferredSnapshot.val()));
  let queueState = parseYouTubeQueueState(queueStateSnapshot.val());
  if (queueState.deferredYouTubeTaskCount !== deferredEntries.length) {
    const observedCount = queueState.deferredYouTubeTaskCount;
    const result = await database.ref(YOUTUBE_QUEUE_STATE_PATH).transaction((current) => {
      const currentQueueState = parseYouTubeQueueState(current);
      return {
        ...currentQueueState,
        deferredYouTubeTaskCount: reconcileDeferredYouTubeTaskCount(
          currentQueueState.deferredYouTubeTaskCount,
          observedCount,
          deferredEntries.length
        ),
      } satisfies StoredYouTubeQueueState;
    });
    queueState = parseYouTubeQueueState(result.snapshot.val());
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
  const deferredEntries = sortDeferredEntries(parseDeferredEntries(deferredSnapshot.val()));

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
  ownerId: string,
  stillOwnsDispatch?: () => Promise<boolean>
): Promise<boolean> {
  return await withProcessAudioQueueClaim(database, entry.sermonId, ownerId, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${entry.sermonId}`);
    const deferredRef = database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${entry.sermonId}`);
    const requestSnapshot = await requestRef.get();
    const now = getNowIsoString();
    const state = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(entry.payload, entry.requestVersion, now);
    let dispatchGeneration = Math.max(0, Math.floor(entry.dispatchGeneration ?? 0));
    let taskId: string | null = null;

    for (let generationAttempt = 0; generationAttempt < 8; generationAttempt += 1) {
      taskId = computeProcessAudioTaskId(
        entry.sermonId,
        entry.requestVersion,
        `deferred-dispatch:${dispatchGeneration}`
      );
      if (stillOwnsDispatch && !(await stillOwnsDispatch())) {
        return false;
      }

      await deferredRef.set({
        ...entry,
        dispatchGeneration,
      } satisfies StoredDeferredYouTubeRequest);

      try {
        await enqueueTask(entry.payload, taskId);
        break;
      } catch (error) {
        if (!(error instanceof CloudTaskNameTombstonedError)) {
          throw error;
        }
        dispatchGeneration += 1;
        await deferredRef.set({
          ...entry,
          dispatchGeneration,
        } satisfies StoredDeferredYouTubeRequest);
        taskId = null;
      }
    }

    if (!taskId) {
      throw new Error(`Unable to allocate a non-tombstoned Cloud Task name for deferred request ${entry.sermonId}.`);
    }

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
      deferredRef.remove(),
    ]);
    return true;
  });
}

async function drainDeferredYouTubeRequestsAfterProbe(args: {
  database: Database;
  entries: StoredDeferredYouTubeRequest[];
  ownerId: string;
  probeMode: YouTubeQueueProbeMode;
  probeSucceededAt: string;
  drainReservationId: string;
  log: ReturnType<typeof createLoggerWithContext>;
}): Promise<void> {
  const { database, entries, ownerId, probeMode, probeSucceededAt, drainReservationId, log } = args;
  const drainAttemptedAt = getNowIsoString();
  let drainSucceededCount = 0;

  for (const entry of entries) {
    try {
      const dispatched = await enqueueDeferredRequestIgnoringPause(
        database,
        entry,
        `${ownerId}:${entry.sermonId}`,
        async () => {
          const queueStateSnapshot = await database.ref(YOUTUBE_QUEUE_STATE_PATH).get();
          const queueState = parseYouTubeQueueState(queueStateSnapshot.val());
          return (
            queueState.probeStatus === 'probe_succeeded' &&
            queueState.probeDispatchReservationId === drainReservationId
          );
        }
      );
      if (!dispatched) {
        break;
      }
      drainSucceededCount += 1;
    } catch (error) {
      log.error('Failed to enqueue deferred YouTube request after successful probe', {
        error: error instanceof Error ? error.message : String(error),
        deferredSermonId: entry.sermonId,
        probeMode,
      });
    }
  }

  const drainSucceeded = drainSucceededCount === entries.length;
  await runGuardedYouTubeQueueStateTransaction(database, (queueState) => {
    if (queueState.probeDispatchReservationId !== drainReservationId) {
      return undefined;
    }
    const deferredYouTubeTaskCount = Math.max(0, queueState.deferredYouTubeTaskCount - drainSucceededCount);
    const hasDeferredRequests = deferredYouTubeTaskCount > 0;

    return {
      ...queueState,
      blocked: false,
      blockerReason: null,
      blockedAt: null,
      blockerEpisodeId: hasDeferredRequests ? queueState.blockerEpisodeId : null,
      alertSentAt: hasDeferredRequests ? queueState.alertSentAt : null,
      alertReservationId: hasDeferredRequests ? queueState.alertReservationId ?? null : null,
      probeStatus: hasDeferredRequests ? 'probe_succeeded' : 'idle',
      probeMode: hasDeferredRequests ? probeMode : null,
      probeTaskSermonId: null,
      probeRequestVersion: null,
      probeStartedAt: null,
      probeDispatchReservationId: null,
      probeLastSucceededAt: probeSucceededAt,
      deferredYouTubeTaskCount,
      lastDrainAttemptedAt: drainAttemptedAt,
      lastSuccessfulDrainAt: drainSucceeded ? drainAttemptedAt : queueState.lastSuccessfulDrainAt ?? null,
      lastDrainOutcome: drainSucceeded ? 'succeeded' : 'partial_failure',
      lastDrainAttemptedCount: entries.length,
      lastDrainSucceededCount: drainSucceededCount,
    } satisfies StoredYouTubeQueueState;
  });
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
  alreadyProcessed?: boolean;
}): Promise<void> {
  const { database, payload, requestId, taskId, ctx, alreadyProcessed = false } = args;
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
    let requestState = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : buildProcessAudioRequestState(sanitizedPayload, computeProcessAudioRequestVersion(sanitizedPayload), now);
    const queueState = parseYouTubeQueueState(queueSnapshot.val());
    const incomingSuccessfulAuthority = ctx?.youtubeSuccessfulAcquisitionAuthority;
    const activeRequestVersion = requestState.runningRequestVersion ?? requestState.currentRequestVersion;
    if (
      getProcessAudioSourceType(sanitizedPayload) === 'youtube' &&
      incomingSuccessfulAuthority &&
      activeRequestVersion
    ) {
      requestState = {
        ...requestState,
        lastSuccessfulYouTubeAcquisitionAuthority: incomingSuccessfulAuthority,
        lastSuccessfulYouTubeAcquisitionRequestVersion: activeRequestVersion,
        updatedAt: now,
      };
      await requestRef.set(requestState satisfies StoredProcessAudioRequestState);
    }

    const queuedProbeRequestVersion =
      taskId && requestState.queuedTaskId === taskId ? requestState.currentRequestVersion : null;
    const completionRequestVersion = requestState.runningRequestVersion ?? queuedProbeRequestVersion;
    const shouldResolveProbe =
      getProcessAudioSourceType(sanitizedPayload) === 'youtube' &&
      queueState.probeStatus === 'probing' &&
      queueState.probeTaskSermonId === sanitizedPayload.id &&
      !!completionRequestVersion &&
      queueState.probeRequestVersion === completionRequestVersion;

    if (shouldResolveProbe) {
      const persistedSuccessfulAuthority: YouTubeSuccessfulAcquisitionAuthority | undefined =
        requestState.lastSuccessfulYouTubeAcquisitionRequestVersion === completionRequestVersion
          ? requestState.lastSuccessfulYouTubeAcquisitionAuthority ?? undefined
          : undefined;
      const successfulAuthority = incomingSuccessfulAuthority ?? persistedSuccessfulAuthority;
      const authenticatedProbeMode =
        successfulAuthority === 'cookie_provider' || successfulAuthority === 'browser_fallback'
          ? successfulAuthority
          : null;

      if (authenticatedProbeMode) {
        const { deferredEntries } = await getQueueStateAndDeferredEntries(database);
        const remainingEntries = deferredEntries
          .filter((entry) => entry.sermonId !== sanitizedPayload.id)
          .sort((left, right) => Date.parse(left.deferredAt) - Date.parse(right.deferredAt));
        const drainReservationId = randomUUID();

        const probeTransition = await runGuardedYouTubeQueueStateTransaction(database, (currentQueueState) => {
          if (
            currentQueueState.probeStatus !== 'probing' ||
            currentQueueState.probeTaskSermonId !== sanitizedPayload.id ||
            currentQueueState.probeRequestVersion !== completionRequestVersion ||
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
            probeStatus: 'probe_succeeded',
            probeMode: authenticatedProbeMode,
            probeTaskSermonId: null,
            probeRequestVersion: null,
            probeStartedAt: now,
            probeDispatchReservationId: drainReservationId,
            probeLastSucceededAt: now,
            deferredYouTubeTaskCount: reconcileDeferredYouTubeTaskCount(
              currentQueueState.deferredYouTubeTaskCount,
              queueState.deferredYouTubeTaskCount,
              remainingEntries.length
            ),
          } satisfies StoredYouTubeQueueState;
        });

        if (probeTransition.committed) {
          await drainDeferredYouTubeRequestsAfterProbe({
            database,
            entries: remainingEntries,
            ownerId: `drain:${requestId}`,
            probeMode: authenticatedProbeMode,
            probeSucceededAt: now,
            drainReservationId,
            log,
          });
        }
      } else {
        const { queueState: observedQueueState, deferredEntries } = await getQueueStateAndDeferredEntries(database);
        const remainingDeferredEntries = deferredEntries.filter((entry) => entry.sermonId !== sanitizedPayload.id);
        const completedProbeDeferredRef = database.ref(
          `${YOUTUBE_QUEUE_DEFERRED_PATH}/${sanitizedPayload.id}`
        );
        const nextProbe = alreadyProcessed ? selectNextDeferredProbe(remainingDeferredEntries) : null;

        if (nextProbe) {
          const reservation = await reserveDeferredYouTubeProbeDispatch({
            database,
            observedQueueState: queueState,
            observedDeferredCount: observedQueueState.deferredYouTubeTaskCount,
            desiredDeferredCount: Math.max(0, remainingDeferredEntries.length - 1),
            nextProbe,
            probeStartedAt: now,
          });
          if (reservation.reserved) {
            try {
              await completedProbeDeferredRef.remove();
              const dispatched = await enqueueDeferredRequestIgnoringPause(
                database,
                nextProbe,
                `processed-without-authority:${requestId}:${nextProbe.sermonId}`,
                () =>
                  stillOwnsReservedDeferredDispatch({
                    database,
                    entry: nextProbe,
                    reservationId: reservation.reservationId,
                  })
              );
              if (!dispatched) {
                await compensateDeferredYouTubeProbeDispatch({
                  database,
                  nextProbe,
                  reservationId: reservation.reservationId,
                });
              }
            } catch (error) {
              await compensateDeferredYouTubeProbeDispatch({
                database,
                nextProbe,
                reservationId: reservation.reservationId,
              });
              log.error('Failed to advance authenticated probe after idempotent PROCESSED result', {
                error: error instanceof Error ? error.message : String(error),
                completedProbeSermonId: sanitizedPayload.id,
                nextProbeSermonId: nextProbe.sermonId,
              });
            }
          }
        } else {
          const releaseTransition = await runGuardedYouTubeQueueStateTransaction(database, (currentQueueState) => {
            if (
              currentQueueState.probeStatus !== 'probing' ||
              currentQueueState.probeTaskSermonId !== sanitizedPayload.id ||
              currentQueueState.probeRequestVersion !== completionRequestVersion
            ) {
              return undefined;
            }

            const deferredYouTubeTaskCount = reconcileDeferredYouTubeTaskCount(
              currentQueueState.deferredYouTubeTaskCount,
              observedQueueState.deferredYouTubeTaskCount,
              remainingDeferredEntries.length
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
              probeMode: null,
              probeStatus: hasDeferredRequests ? 'waiting_for_auth_required_request' : 'idle',
              probeTaskSermonId: null,
              probeRequestVersion: null,
              probeStartedAt: null,
              probeDispatchReservationId: null,
              deferredYouTubeTaskCount,
            } satisfies StoredYouTubeQueueState;
          });
          if (releaseTransition.committed) {
            await completedProbeDeferredRef.remove();
          }
        }
      }
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
          disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
          dependencyScope: 'authenticated_session',
          probeMode: activeQueueState.probeMode ?? 'cookie_provider',
          blockerEpisodeId: activeQueueState.blockerEpisodeId,
          lastFailureClass: null,
        } satisfies StoredDeferredYouTubeRequest);
        queuedTaskId = null;
        queuedAt = null;
        deferredAt = now;
        await database.ref(YOUTUBE_QUEUE_STATE_PATH).transaction((current) => {
          const currentQueueState = parseYouTubeQueueState(current);
          return {
            ...currentQueueState,
            deferredYouTubeTaskCount:
              currentQueueState.deferredYouTubeTaskCount + (existingDeferredSnapshot.exists() ? 0 : 1),
          } satisfies StoredYouTubeQueueState;
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
        authenticatedDeferralAttemptCount: 0,
        lastCompletedRequestVersion: activeRequestVersion,
        lastCompletedAt: now,
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
      authenticatedDeferralAttemptCount: 0,
      lastCompletedRequestVersion: activeRequestVersion,
      lastCompletedAt: now,
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
      parseDeferredEntries(deferredSnapshot.val()).filter((entry) => entry.sermonId !== sanitizedPayload.id)
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

      const nextProbe = selectNextDeferredProbe(remainingDeferredEntries);
      if (!nextProbe) {
        await Promise.all([
          deferredRef.remove(),
          runGuardedYouTubeQueueStateTransaction(database, (currentQueueState) => {
            if (!matchesObservedYouTubeProbe(currentQueueState, queueState)) {
              return undefined;
            }
            const deferredYouTubeTaskCount = reconcileDeferredYouTubeTaskCount(
              currentQueueState.deferredYouTubeTaskCount,
              queueState.deferredYouTubeTaskCount,
              0
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
              probeMode: null,
              probeStatus: hasDeferredRequests ? 'waiting_for_auth_required_request' : 'idle',
              probeTaskSermonId: null,
              probeRequestVersion: null,
              probeStartedAt: null,
              probeDispatchReservationId: null,
              probeLastFailedAt: now,
              probeLastFailureClass: failureClass,
              probeLastFailureMessage: failureMessage.slice(0, 1000),
              deferredYouTubeTaskCount,
            } satisfies StoredYouTubeQueueState;
          }),
        ]);
        return;
      }

      const reservation = await reserveDeferredYouTubeProbeDispatch({
        database,
        observedQueueState: queueState,
        observedDeferredCount: queueState.deferredYouTubeTaskCount,
        desiredDeferredCount: Math.max(0, remainingDeferredEntries.length - 1),
        nextProbe,
        probeStartedAt: now,
      });
      if (!reservation.reserved) {
        return;
      }

      try {
        const dispatched = await enqueueDeferredRequestIgnoringPause(
          database,
          nextProbe,
          `post-live:${requestId}:${nextProbe.sermonId}`,
          () =>
            stillOwnsReservedDeferredDispatch({
              database,
              entry: nextProbe,
              reservationId: reservation.reservationId,
            })
        );
        if (!dispatched) {
          await compensateDeferredYouTubeProbeDispatch({
            database,
            nextProbe,
            reservationId: reservation.reservationId,
          });
          await deferredRef.remove();
          return;
        }
        await deferredRef.remove();
        await runGuardedYouTubeQueueStateTransaction(database, (currentQueueState) => {
          if (currentQueueState.probeDispatchReservationId !== reservation.reservationId) {
            return undefined;
          }
          return {
            ...currentQueueState,
            probeLastFailedAt: now,
            probeLastFailureClass: failureClass,
            probeLastFailureMessage: failureMessage.slice(0, 1000),
          } satisfies StoredYouTubeQueueState;
        });
      } catch (error) {
        await compensateDeferredYouTubeProbeDispatch({
          database,
          nextProbe,
          reservationId: reservation.reservationId,
        });
        await deferredRef.remove();
        await runGuardedYouTubeQueueStateTransaction(database, (currentQueueState) => {
          if (currentQueueState.probeStatus !== 'waiting_for_auth_required_request') {
            return undefined;
          }
          return {
            ...currentQueueState,
            probeLastFailedAt: now,
            probeLastFailureClass: 'probe_advance_failed',
            probeLastFailureMessage:
              error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
          } satisfies StoredYouTubeQueueState;
        });
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
        await queueStateRef.transaction((current) => {
          const currentQueueState = parseYouTubeQueueState(current);
          return {
            ...currentQueueState,
            deferredYouTubeTaskCount: reconcileDeferredYouTubeTaskCount(
              currentQueueState.deferredYouTubeTaskCount,
              queueState.deferredYouTubeTaskCount,
              remainingDeferredEntries.length
            ),
          } satisfies StoredYouTubeQueueState;
        });
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

    const nextProbe = selectNextDeferredProbe(remainingDeferredEntries);
    if (!nextProbe) {
      await runGuardedYouTubeQueueStateTransaction(database, (currentQueueState) => {
        if (!matchesObservedYouTubeProbe(currentQueueState, queueState)) {
          return undefined;
        }
        const deferredYouTubeTaskCount = reconcileDeferredYouTubeTaskCount(
          currentQueueState.deferredYouTubeTaskCount,
          queueState.deferredYouTubeTaskCount,
          remainingDeferredEntries.length
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
          probeMode: null,
          probeStatus: hasDeferredRequests ? 'waiting_for_auth_required_request' : 'idle',
          probeTaskSermonId: null,
          probeRequestVersion: null,
          probeStartedAt: null,
          probeDispatchReservationId: null,
          deferredYouTubeTaskCount,
        } satisfies StoredYouTubeQueueState;
      });
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
    const reservation = await reserveDeferredYouTubeProbeDispatch({
      database,
      observedQueueState: queueState,
      observedDeferredCount: queueState.deferredYouTubeTaskCount,
      desiredDeferredCount: Math.max(0, remainingDeferredEntries.length - 1),
      nextProbe,
      probeStartedAt: now,
    });
    if (!reservation.reserved) {
      return {
        advancedProbe: false,
        deferredRemaining: remainingDeferredEntries.length,
      };
    }

    try {
      const dispatched = await enqueueDeferredRequestIgnoringPause(
        database,
        nextProbe,
        `cleanup:${requestId}:${nextProbe.sermonId}`,
        () =>
          stillOwnsReservedDeferredDispatch({
            database,
            entry: nextProbe,
            reservationId: reservation.reservationId,
          })
      );
      if (!dispatched) {
        await compensateDeferredYouTubeProbeDispatch({
          database,
          nextProbe,
          reservationId: reservation.reservationId,
        });
        return {
          advancedProbe: false,
          deferredRemaining: remainingDeferredEntries.length,
        };
      }
    } catch (error) {
      await compensateDeferredYouTubeProbeDispatch({
        database,
        nextProbe,
        reservationId: reservation.reservationId,
      });
      throw error;
    }

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

async function resumeDeferredYouTubeQueueUnderClaim(args: {
  database: Database;
  ctx?: LogContext;
  force?: boolean;
  authenticatedRecoveryGeneration?: string;
}): Promise<{ resumed: boolean; deferredRemaining: number; nextProbeSermonId: string | null }> {
  const { database, ctx, authenticatedRecoveryGeneration } = args;
  const log = createLoggerWithContext(ctx);
  const queueStateRef = database.ref(YOUTUBE_QUEUE_STATE_PATH);
  const { queueState, deferredEntries: storedDeferredEntries } = await getQueueStateAndDeferredEntries(database);
  let deferredEntries = [...storedDeferredEntries];
  let activeProbeRequestState: StoredProcessAudioRequestState | null = null;
  if (queueState.probeTaskSermonId) {
    const requestSnapshot = await database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${queueState.probeTaskSermonId}`).get();
    activeProbeRequestState = requestSnapshot.exists()
      ? (requestSnapshot.val() as StoredProcessAudioRequestState)
      : null;
  }

  const probeStartedAtMs = queueState.probeStartedAt ? Date.parse(queueState.probeStartedAt) : Number.NaN;
  const requestUpdatedAtMs = activeProbeRequestState?.updatedAt
    ? Date.parse(activeProbeRequestState.updatedAt)
    : Number.NaN;
  const explicitCompletionMatches =
    !!queueState.probeRequestVersion &&
    activeProbeRequestState?.lastCompletedRequestVersion === queueState.probeRequestVersion &&
    !!activeProbeRequestState.lastCompletedAt &&
    Date.parse(activeProbeRequestState.lastCompletedAt) >= probeStartedAtMs;
  const legacyCompletionFingerprintMatches =
    !!queueState.probeRequestVersion &&
    activeProbeRequestState?.currentRequestVersion === queueState.probeRequestVersion &&
    activeProbeRequestState.queuedTaskId == null &&
    activeProbeRequestState.runningRequestId == null &&
    activeProbeRequestState.runningTaskId == null &&
    activeProbeRequestState.runningRequestVersion == null &&
    activeProbeRequestState.deferredAt == null &&
    Number.isFinite(probeStartedAtMs) &&
    Number.isFinite(requestUpdatedAtMs) &&
    requestUpdatedAtMs >= probeStartedAtMs;
  const completedActiveProbe = explicitCompletionMatches || legacyCompletionFingerprintMatches;
  const hasFreshAuthenticatedRecovery =
    !!authenticatedRecoveryGeneration &&
    queueState.lastAttemptedAuthRecoveryGeneration !== authenticatedRecoveryGeneration;

  if (completedActiveProbe && queueState.probeTaskSermonId) {
    deferredEntries = deferredEntries.filter((entry) => entry.sermonId !== queueState.probeTaskSermonId);
    log.info('Skipping completed YouTube probe during authenticated recovery', {
      completedProbeSermonId: queueState.probeTaskSermonId,
      completedProbeRequestVersion: queueState.probeRequestVersion,
      completionEvidence: explicitCompletionMatches ? 'explicit_marker' : 'legacy_fingerprint',
      authenticatedRecoveryGeneration: authenticatedRecoveryGeneration ?? null,
    });
  }

  if (
    queueState.probeStatus === 'probe_succeeded' &&
    queueState.probeDispatchReservationId &&
    Number.isFinite(probeStartedAtMs) &&
    Date.now() - probeStartedAtMs < PROCESS_AUDIO_TASK_TIMEOUT_SECONDS * 1000
  ) {
    return {
      resumed: false,
      deferredRemaining: deferredEntries.length,
      nextProbeSermonId: null,
    };
  }

  if (queueState.probeStatus === 'probing' && !(completedActiveProbe && hasFreshAuthenticatedRecovery)) {
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
  if (queueState.probeTaskSermonId && !activeProbeAlreadyDeferred && !completedActiveProbe) {
    if (activeProbeRequestState?.currentPayload && activeProbeRequestState.currentRequestVersion) {
      deferredEntries.push({
        sermonId: queueState.probeTaskSermonId,
        payload: activeProbeRequestState.currentPayload,
        requestVersion: activeProbeRequestState.currentRequestVersion,
        deferredAt: queueState.probeStartedAt ?? activeProbeRequestState.queuedAt ?? activeProbeRequestState.updatedAt,
        reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        dependencyScope: 'authenticated_session',
        probeMode: queueState.probeMode ?? 'cookie_provider',
        blockerEpisodeId: queueState.blockerEpisodeId,
        lastFailureClass: queueState.probeLastFailureClass,
        lastFailureMessage: queueState.probeLastFailureMessage,
        attemptCount: activeProbeRequestState.authenticatedDeferralAttemptCount ?? 0,
        dispatchGeneration: 0,
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
      await queueStateRef.transaction((current) => {
        const currentQueueState = parseYouTubeQueueState(current);
        const deferredYouTubeTaskCount = reconcileDeferredYouTubeTaskCount(
          currentQueueState.deferredYouTubeTaskCount,
          queueState.deferredYouTubeTaskCount,
          0
        );
        if (deferredYouTubeTaskCount > 0) {
          return {
            ...currentQueueState,
            deferredYouTubeTaskCount,
          } satisfies StoredYouTubeQueueState;
        }

        return {
          ...buildInitialYouTubeQueueState(),
          ...getYouTubeQueueDrainTelemetry(currentQueueState),
          lastAttemptedAuthRecoveryGeneration: currentQueueState.lastAttemptedAuthRecoveryGeneration ?? null,
        } satisfies StoredYouTubeQueueState;
      });
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

  if (
    !authenticatedRecoveryGeneration ||
    queueState.lastAttemptedAuthRecoveryGeneration === authenticatedRecoveryGeneration
  ) {
    if (queueState.blocked || queueState.probeStatus !== 'waiting_for_auth_required_request') {
      await queueStateRef.transaction((current) => {
        const currentQueueState = parseYouTubeQueueState(current);
        return {
          ...currentQueueState,
          blocked: false,
          blockerReason: null,
          blockedAt: null,
          probeStatus: 'waiting_for_auth_required_request',
          probeTaskSermonId: null,
          probeRequestVersion: null,
          probeStartedAt: null,
          probeDispatchReservationId: null,
          deferredYouTubeTaskCount: reconcileDeferredYouTubeTaskCount(
            currentQueueState.deferredYouTubeTaskCount,
            queueState.deferredYouTubeTaskCount,
            migratedEntries.length
          ),
        } satisfies StoredYouTubeQueueState;
      });
    }

    return {
      resumed: false,
      deferredRemaining: migratedEntries.length,
      nextProbeSermonId: null,
    };
  }

  const nextProbe = selectNextDeferredProbe(migratedEntries);
  if (!nextProbe) {
    await queueStateRef.transaction((current) => {
      const currentQueueState = parseYouTubeQueueState(current);
      return {
        ...currentQueueState,
        blocked: false,
        blockerReason: null,
        blockedAt: null,
        probeStatus: 'waiting_for_auth_required_request',
        probeTaskSermonId: null,
        probeRequestVersion: null,
        probeStartedAt: null,
        probeDispatchReservationId: null,
        deferredYouTubeTaskCount: reconcileDeferredYouTubeTaskCount(
          currentQueueState.deferredYouTubeTaskCount,
          queueState.deferredYouTubeTaskCount,
          migratedEntries.length
        ),
      } satisfies StoredYouTubeQueueState;
    });

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
  const reservation = await reserveDeferredYouTubeProbeDispatch({
    database,
    observedQueueState: queueState,
    observedDeferredCount: queueState.deferredYouTubeTaskCount,
    desiredDeferredCount: Math.max(0, migratedEntries.length - 1),
    nextProbe,
    probeStartedAt: now,
    authenticatedRecoveryGeneration,
  });
  if (!reservation.reserved) {
    return {
      resumed: false,
      deferredRemaining: migratedEntries.length,
      nextProbeSermonId: null,
    };
  }

  try {
    await enqueueDeferredRequestIgnoringPause(database, nextProbe, `startup:${now}:${nextProbe.sermonId}`);
  } catch (error) {
    await compensateDeferredYouTubeProbeDispatch({
      database,
      nextProbe,
      reservationId: reservation.reservationId,
    });
    throw error;
  }

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

export async function resumeDeferredYouTubeQueueOnStartup(args: {
  database: Database;
  ctx?: LogContext;
  force?: boolean;
  authenticatedRecoveryGeneration?: string;
}): Promise<{ resumed: boolean; deferredRemaining: number; nextProbeSermonId: string | null }> {
  const ownerId = `youtube-auth-recovery:${args.ctx?.requestId ?? randomUUID()}`;
  return await withProcessAudioQueueClaim(args.database, '__youtube_auth_recovery__', ownerId, async () =>
    resumeDeferredYouTubeQueueUnderClaim(args)
  );
}

export async function deferYouTubeRequestForAuthentication(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  requestId: string;
  failureClass: string;
  failureMessage: string;
  probeMode?: YouTubeQueueProbeMode;
}): Promise<{
  deferred: boolean;
  terminal: boolean;
  attemptCount: number;
  maxAttemptCount: number;
  shouldAlert: boolean;
  blockerEpisodeId: string | null;
  alertReservationId: string | null;
}> {
  const { database, payload, requestId, failureClass, failureMessage, probeMode = 'cookie_provider' } = args;
  const sanitizedPayload = sanitizeProcessAudioPayload(payload);
  const maxAttemptCount = parsePositiveIntegerEnv('YOUTUBE_AUTH_DEFER_MAX_ATTEMPTS') ?? 6;
  const alertCooldownMs = parsePositiveIntegerEnv('YOUTUBE_AUTH_ALERT_COOLDOWN_MS') ?? 6 * 60 * 60 * 1000;

  return await withProcessAudioQueueClaim(database, sanitizedPayload.id, `auth-wait:${requestId}`, async () => {
    const requestRef = database.ref(`${PROCESS_AUDIO_REQUESTS_PATH}/${sanitizedPayload.id}`);
    const deferredRef = database.ref(`${YOUTUBE_QUEUE_DEFERRED_PATH}/${sanitizedPayload.id}`);
    const queueStateRef = database.ref(YOUTUBE_QUEUE_STATE_PATH);
    const [requestSnapshot, deferredEntrySnapshot] = await Promise.all([requestRef.get(), deferredRef.get()]);
    const now = getNowIsoString();
    const existingDeferred = deferredEntrySnapshot.exists()
      ? parseDeferredEntries({ entry: deferredEntrySnapshot.val() })[0] ?? null
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
    const attemptCount =
      Math.max(requestState.authenticatedDeferralAttemptCount ?? 0, existingDeferred?.attemptCount ?? 0) + 1;
    const terminal = failureClass === 'account_required_content' && attemptCount >= maxAttemptCount;

    if (terminal) {
      await Promise.all([
        deferredRef.remove(),
        requestRef.set({
          ...requestState,
          authenticatedDeferralAttemptCount: attemptCount,
          deferredAt: null,
          updatedAt: now,
        } satisfies StoredProcessAudioRequestState),
      ]);
      await queueStateRef.transaction((current) => {
        const queueState = parseYouTubeQueueState(current);
        const terminalWasActiveProbe = queueState.probeTaskSermonId === sanitizedPayload.id;
        const deferredYouTubeTaskCount = Math.max(0, queueState.deferredYouTubeTaskCount - (existingDeferred ? 1 : 0));
        return {
          ...queueState,
          blocked: false,
          blockerReason: null,
          blockedAt: null,
          probeStatus: terminalWasActiveProbe ? 'waiting_for_auth_required_request' : queueState.probeStatus,
          probeTaskSermonId: terminalWasActiveProbe ? null : queueState.probeTaskSermonId,
          probeRequestVersion: terminalWasActiveProbe ? null : queueState.probeRequestVersion,
          probeStartedAt: terminalWasActiveProbe ? null : queueState.probeStartedAt,
          probeDispatchReservationId: terminalWasActiveProbe ? null : queueState.probeDispatchReservationId ?? null,
          blockerEpisodeId: deferredYouTubeTaskCount === 0 ? null : queueState.blockerEpisodeId,
          alertSentAt: deferredYouTubeTaskCount === 0 ? null : queueState.alertSentAt,
          alertReservationId: deferredYouTubeTaskCount === 0 ? null : queueState.alertReservationId ?? null,
          deferredYouTubeTaskCount,
        } satisfies StoredYouTubeQueueState;
      });
      return {
        deferred: false,
        terminal: true,
        attemptCount,
        maxAttemptCount,
        shouldAlert: true,
        blockerEpisodeId: existingDeferred?.blockerEpisodeId ?? null,
        alertReservationId: null,
      };
    }

    const proposedEpisodeId = existingDeferred?.blockerEpisodeId ?? randomUUID();
    const proposedAlertReservationId = randomUUID();
    const queueTransaction = await queueStateRef.transaction((current) => {
      const queueState = parseYouTubeQueueState(current);
      const blockerEpisodeId = queueState.blockerEpisodeId ?? proposedEpisodeId;
      const lastAlertAtMs = queueState.alertSentAt ? Date.parse(queueState.alertSentAt) : Number.NaN;
      const reserveAlert = !Number.isFinite(lastAlertAtMs) || Date.now() - lastAlertAtMs >= alertCooldownMs;
      const preserveOtherActiveProbe =
        queueState.probeStatus === 'probing' && queueState.probeTaskSermonId !== sanitizedPayload.id;
      return {
        ...queueState,
        blocked: false,
        blockerReason: null,
        blockedAt: null,
        blockerEpisodeId,
        alertSentAt: reserveAlert ? now : queueState.alertSentAt,
        alertReservationId: reserveAlert ? proposedAlertReservationId : queueState.alertReservationId ?? null,
        probeStatus: preserveOtherActiveProbe ? queueState.probeStatus : 'waiting_for_auth_required_request',
        probeTaskSermonId: preserveOtherActiveProbe ? queueState.probeTaskSermonId : null,
        probeRequestVersion: preserveOtherActiveProbe ? queueState.probeRequestVersion : null,
        probeStartedAt: preserveOtherActiveProbe ? queueState.probeStartedAt : null,
        probeDispatchReservationId: preserveOtherActiveProbe ? queueState.probeDispatchReservationId ?? null : null,
        deferredYouTubeTaskCount: queueState.deferredYouTubeTaskCount + (existingDeferred ? 0 : 1),
      } satisfies StoredYouTubeQueueState;
    });
    const committedQueueState = parseYouTubeQueueState(queueTransaction.snapshot.val());
    const blockerEpisodeId = committedQueueState.blockerEpisodeId;
    const shouldAlert = committedQueueState.alertReservationId === proposedAlertReservationId;

    try {
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
          blockerEpisodeId,
          lastFailureClass: failureClass,
          lastFailureMessage: failureMessage.slice(0, 1000),
          attemptCount,
          dispatchGeneration: existingDeferred?.dispatchGeneration ?? 0,
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
          authenticatedDeferralAttemptCount: attemptCount,
          updatedAt: now,
        } satisfies StoredProcessAudioRequestState),
      ]);
    } catch (error) {
      if (shouldAlert && blockerEpisodeId) {
        await releaseYouTubeAuthAlertReservation({
          database,
          blockerEpisodeId,
          alertReservationId: proposedAlertReservationId,
        });
      }
      throw error;
    }

    return {
      deferred: true,
      terminal: false,
      attemptCount,
      maxAttemptCount,
      shouldAlert,
      blockerEpisodeId,
      alertReservationId: shouldAlert ? proposedAlertReservationId : null,
    };
  });
}

export async function releaseYouTubeAuthAlertReservation(args: {
  database: Database;
  blockerEpisodeId: string;
  alertReservationId: string;
}): Promise<boolean> {
  const { database, blockerEpisodeId, alertReservationId } = args;
  const result = await database.ref(YOUTUBE_QUEUE_STATE_PATH).transaction((current) => {
    const queueState = parseYouTubeQueueState(current);
    if (queueState.blockerEpisodeId !== blockerEpisodeId || queueState.alertReservationId !== alertReservationId) {
      return;
    }

    return {
      ...queueState,
      alertSentAt: null,
      alertReservationId: null,
    } satisfies StoredYouTubeQueueState;
  });
  return result.committed;
}

export async function deferStaleYouTubeRequest(args: {
  database: Database;
  payload: AddIntroOutroInputType;
  requestId: string;
  failureClass: string;
  failureMessage: string;
  probeMode?: YouTubeQueueProbeMode;
}): Promise<{ shouldAlert: boolean; blockerEpisodeId: string | null }> {
  const result = await deferYouTubeRequestForAuthentication(args);
  return {
    shouldAlert: result.shouldAlert,
    blockerEpisodeId: result.blockerEpisodeId,
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
