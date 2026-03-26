import { createHash } from 'node:crypto';
import type { AddIntroOutroInputType } from './addIntroOutro/types';

export const PROCESS_AUDIO_TASK_QUEUE_NAME = 'processaudiotask';
export const PROCESS_AUDIO_LOCK_TTL_MS = 30 * 60 * 1000;
export const PROCESS_AUDIO_QUEUE_CLAIM_TTL_MS = 60 * 1000;
export const PROCESS_AUDIO_REQUESTS_PATH = 'processAudioRequests';
export const PROCESS_AUDIO_LOCKS_PATH = 'processAudioLocks';
export const PROCESS_AUDIO_QUEUE_CLAIMS_PATH = 'processAudioQueueClaims';
export const PROCESS_AUDIO_QUEUES_PATH = 'processAudioQueues';
export const YOUTUBE_QUEUE_STATE_PATH = `${PROCESS_AUDIO_QUEUES_PATH}/youtube/state`;
export const YOUTUBE_QUEUE_DEFERRED_PATH = `${PROCESS_AUDIO_QUEUES_PATH}/youtube/deferred`;

export type ProcessAudioSourceType = 'youtube' | 'storage';

export type YouTubeQueueProbeStatus =
  | 'idle'
  | 'blocked'
  | 'probing'
  | 'waiting_for_auth_required_request'
  | 'probe_succeeded'
  | 'probe_failed';

export interface NormalizedProcessAudioRequest {
  sermonId: string;
  sourceType: ProcessAudioSourceType;
  sourceValue: string;
  startTime: number;
  duration: number;
  deleteOriginal: boolean;
  skipTranscode: boolean;
  introUrl: string | null;
  outroUrl: string | null;
}

export interface StoredProcessAudioRequestState {
  sermonId: string;
  sourceType: ProcessAudioSourceType;
  currentPayload: AddIntroOutroInputType | null;
  currentRequestVersion: string | null;
  queuedTaskId: string | null;
  queuedAt: string | null;
  runningRequestId: string | null;
  runningTaskId: string | null;
  runningRequestVersion: string | null;
  runningAt: string | null;
  nextPayload: AddIntroOutroInputType | null;
  nextRequestVersion: string | null;
  nextUpdatedAt: string | null;
  deferredAt: string | null;
  updatedAt: string;
}

export interface StoredDeferredYouTubeRequest {
  sermonId: string;
  payload: AddIntroOutroInputType;
  requestVersion: string;
  deferredAt: string;
  reason: string;
  requiresCookieProbe: boolean;
  blockerEpisodeId: string | null;
  lastFailureClass: string | null;
}

export interface StoredYouTubeQueueState {
  blocked: boolean;
  blockerReason: string | null;
  blockedAt: string | null;
  blockerEpisodeId: string | null;
  probeStatus: YouTubeQueueProbeStatus;
  probeTaskSermonId: string | null;
  probeRequestVersion: string | null;
  probeStartedAt: string | null;
  probeLastSucceededAt: string | null;
  probeLastFailedAt: string | null;
  probeLastFailureClass: string | null;
  probeLastFailureMessage: string | null;
  alertSentAt: string | null;
  deferredYouTubeTaskCount: number;
}

export const getProcessAudioSourceType = (payload: AddIntroOutroInputType): ProcessAudioSourceType => {
  return 'youtubeUrl' in payload ? 'youtube' : 'storage';
};

export const normalizeProcessAudioRequest = (payload: AddIntroOutroInputType): NormalizedProcessAudioRequest => {
  return {
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
};

export const sanitizeProcessAudioPayload = (payload: AddIntroOutroInputType): AddIntroOutroInputType => {
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

export const computeProcessAudioRequestVersion = (payload: AddIntroOutroInputType): string => {
  const normalized = normalizeProcessAudioRequest(payload);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
};

export const computeProcessAudioTaskId = (sermonId: string, requestVersion: string): string => {
  const sermonHash = createHash('sha256').update(sermonId).digest('hex').slice(0, 8);
  return `pa-${sermonHash}-${requestVersion}`;
};

export const buildInitialYouTubeQueueState = (): StoredYouTubeQueueState => ({
  blocked: false,
  blockerReason: null,
  blockedAt: null,
  blockerEpisodeId: null,
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

export const isProcessAudioLockActive = (value: unknown, now: number = Date.now()): boolean => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const acquiredAt = (value as { acquiredAt?: unknown }).acquiredAt;
  return typeof acquiredAt === 'number' && acquiredAt > 0 && now - acquiredAt <= PROCESS_AUDIO_LOCK_TTL_MS;
};
