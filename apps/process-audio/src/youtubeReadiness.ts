export type YouTubeCapabilityScope = 'youtube_guest' | 'youtube_authenticated';
export type YouTubeMediaByteCanaryScope = 'guest' | 'authenticated';

export const YOUTUBE_MEDIA_BYTE_CANARIES_PATH = 'processAudioDiagnostics/youtube/mediaByteCanaries';

export type YouTubeReadinessReasonCode =
  | 'YOUTUBE_PROCESSING_DISABLED'
  | 'YOUTUBE_PROVIDER_NOT_CONFIGURED'
  | 'YOUTUBE_PROVIDER_DISCOVERY_NOT_CHECKED'
  | 'YOUTUBE_PROVIDER_NOT_DISCOVERED'
  | 'YOUTUBE_PROVIDER_VERSION_UNKNOWN'
  | 'YOUTUBE_PROVIDER_REACHABILITY_NOT_CHECKED'
  | 'YOUTUBE_PROVIDER_UNREACHABLE'
  | 'YOUTUBE_GUEST_MEDIA_CANARY_NEVER_RUN'
  | 'YOUTUBE_GUEST_MEDIA_CANARY_FAILED'
  | 'YOUTUBE_GUEST_MEDIA_CANARY_NO_BYTES'
  | 'YOUTUBE_GUEST_MEDIA_CANARY_STALE'
  | 'YOUTUBE_GUEST_QUEUE_BLOCKED'
  | 'YOUTUBE_GUEST_QUEUE_OLDEST_AGE_UNKNOWN'
  | 'YOUTUBE_GUEST_QUEUE_BACKLOG_STALE'
  | 'YOUTUBE_AUTH_SESSION_NOT_CONFIGURED'
  | 'YOUTUBE_AUTH_SESSION_HEALTH_NOT_CHECKED'
  | 'YOUTUBE_AUTH_SESSION_UNHEALTHY'
  | 'YOUTUBE_AUTH_MEDIA_CANARY_NEVER_RUN'
  | 'YOUTUBE_AUTH_MEDIA_CANARY_FAILED'
  | 'YOUTUBE_AUTH_MEDIA_CANARY_NO_BYTES'
  | 'YOUTUBE_AUTH_MEDIA_CANARY_STALE'
  | 'YOUTUBE_AUTH_QUEUE_BLOCKED'
  | 'YOUTUBE_AUTH_QUEUE_OLDEST_AGE_UNKNOWN'
  | 'YOUTUBE_AUTH_QUEUE_BACKLOG_STALE';

export interface YouTubeProviderDiagnostic {
  configured: boolean;
  discovered: boolean | null;
  version: string | null;
  reachable: boolean | null;
  lastCheckedAt: string | null;
  discoveryCheckedAt?: string | null;
  reachabilityCheckedAt?: string | null;
}

export interface YouTubeMediaByteCanaryDiagnostic {
  checkedAt: string | null;
  succeeded: boolean | null;
  bytesDownloaded: number | null;
  failureClass: string | null;
}

export interface YouTubeMediaByteCanaryReport {
  scope: YouTubeMediaByteCanaryScope;
  checkedAt: string;
  succeeded: boolean;
  bytesDownloaded: number;
  failureClass: string | null;
}

export interface YouTubeQueueDiagnostic {
  blocked: boolean;
  blockerReason: string | null;
  depth: number;
  oldestDeferredAt: string | null;
}

export interface YouTubeReadinessLimits {
  mediaByteCanaryMaxAgeMs: number;
  queueOldestMaxAgeMs: number;
}

export interface BuildYouTubeReadinessSnapshotInput {
  checkedAtMs: number;
  youtubeProcessingEnabled: boolean;
  provider: YouTubeProviderDiagnostic;
  guest: {
    mediaByteCanary: YouTubeMediaByteCanaryDiagnostic;
    queue: YouTubeQueueDiagnostic;
  };
  authenticatedSession: {
    configured: boolean;
    healthy: boolean | null;
    lastCheckedAt: string | null;
    mediaByteCanary: YouTubeMediaByteCanaryDiagnostic;
    queue: YouTubeQueueDiagnostic;
  };
  limits: YouTubeReadinessLimits;
}

interface YouTubeObservedMediaByteCanary extends YouTubeMediaByteCanaryDiagnostic {
  ageMs: number | null;
}

interface YouTubeObservedQueue extends YouTubeQueueDiagnostic {
  oldestAgeMs: number | null;
}

export interface YouTubeReadinessSnapshot {
  checkedAt: string;
  liveness: {
    ok: true;
  };
  serviceReadiness: {
    ready: boolean;
    reasonCodes: YouTubeReadinessReasonCode[];
    degradedScopes: YouTubeCapabilityScope[];
  };
  provider: YouTubeProviderDiagnostic;
  capabilities: {
    guest: {
      enabled: boolean;
      ready: boolean;
      reasonCodes: YouTubeReadinessReasonCode[];
      mediaByteCanary: YouTubeObservedMediaByteCanary;
      queue: YouTubeObservedQueue;
    };
    authenticated: {
      enabled: boolean;
      ready: boolean;
      reasonCodes: YouTubeReadinessReasonCode[];
      waitingForYouTubeAuthEligible: boolean;
      session: {
        configured: boolean;
        healthy: boolean | null;
        lastCheckedAt: string | null;
      };
      mediaByteCanary: YouTubeObservedMediaByteCanary;
      queue: YouTubeObservedQueue;
    };
  };
}

export interface NonOverlappingAsyncTaskRunner {
  run(): Promise<boolean>;
  isRunning(): boolean;
}

export const clampYouTubeMediaByteCanaryIntervalMs = (configuredIntervalMs: number): number =>
  Math.min(10 * 60 * 1000, Math.max(60_000, configuredIntervalMs));

/**
 * Wraps a scheduled async task so timer ticks cannot start a second copy while
 * the previous cycle is still active. The boolean result is intentionally
 * observable for deterministic scheduler tests and skipped-run telemetry.
 */
export const createNonOverlappingAsyncTaskRunner = (task: () => Promise<void>): NonOverlappingAsyncTaskRunner => {
  let running = false;
  return {
    isRunning: () => running,
    run: async () => {
      if (running) return false;
      running = true;
      try {
        await task();
        return true;
      } finally {
        running = false;
      }
    },
  };
};

const ageFromIsoTimestamp = (timestamp: string | null, checkedAtMs: number): number | null => {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return null;
  const ageMs = checkedAtMs - Date.parse(timestamp);
  return ageMs < -5 * 60 * 1000 ? Number.POSITIVE_INFINITY : Math.max(0, ageMs);
};

const CANARY_REPORT_KEYS = ['bytesDownloaded', 'checkedAt', 'failureClass', 'scope', 'succeeded'] as const;
const FAILURE_CLASS_PATTERN = /^[a-z][a-z0-9_]{0,79}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const DEFAULT_CANARY_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
};

export const getTerminalYouTubeAcquisitionFailureClass = (evidence: unknown): 'account_required_content' | null => {
  const record = asRecord(evidence);
  return record?.terminalFailureClass === 'account_required_content' ? 'account_required_content' : null;
};

export const validateYouTubeMediaByteCanaryReport = (
  value: unknown,
  options: { checkedAtMs?: number; maxFutureSkewMs?: number } = {}
): YouTubeMediaByteCanaryReport => {
  const record = asRecord(value);
  if (!record) {
    throw new Error('YouTube media-byte canary report must be a JSON object.');
  }

  const keys = Object.keys(record).sort();
  if (keys.length !== CANARY_REPORT_KEYS.length || keys.some((key, index) => key !== CANARY_REPORT_KEYS[index])) {
    throw new Error(`YouTube media-byte canary report must contain only: ${CANARY_REPORT_KEYS.join(', ')}.`);
  }

  if (record.scope !== 'guest' && record.scope !== 'authenticated') {
    throw new Error('YouTube media-byte canary scope must be guest or authenticated.');
  }
  if (
    typeof record.checkedAt !== 'string' ||
    !ISO_TIMESTAMP_PATTERN.test(record.checkedAt) ||
    !Number.isFinite(Date.parse(record.checkedAt))
  ) {
    throw new Error('YouTube media-byte canary checkedAt must be a valid ISO timestamp.');
  }
  const checkedAtMs = options.checkedAtMs ?? Date.now();
  const maxFutureSkewMs = options.maxFutureSkewMs ?? DEFAULT_CANARY_MAX_FUTURE_SKEW_MS;
  if (Date.parse(record.checkedAt) > checkedAtMs + maxFutureSkewMs) {
    throw new Error('YouTube media-byte canary checkedAt is too far in the future.');
  }
  if (typeof record.succeeded !== 'boolean') {
    throw new Error('YouTube media-byte canary succeeded must be a boolean.');
  }
  if (!Number.isSafeInteger(record.bytesDownloaded) || (record.bytesDownloaded as number) < 0) {
    throw new Error('YouTube media-byte canary bytesDownloaded must be a non-negative safe integer.');
  }
  if (
    record.failureClass !== null &&
    (typeof record.failureClass !== 'string' || !FAILURE_CLASS_PATTERN.test(record.failureClass))
  ) {
    throw new Error('YouTube media-byte canary failureClass must be null or a machine-readable failure code.');
  }
  if (record.succeeded && ((record.bytesDownloaded as number) <= 0 || record.failureClass !== null)) {
    throw new Error('A successful YouTube media-byte canary must report nonzero bytes and no failure class.');
  }
  if (!record.succeeded && ((record.bytesDownloaded as number) !== 0 || typeof record.failureClass !== 'string')) {
    throw new Error('A failed YouTube media-byte canary must report zero bytes and a failure class.');
  }

  return {
    scope: record.scope,
    checkedAt: new Date(record.checkedAt).toISOString(),
    succeeded: record.succeeded,
    bytesDownloaded: record.bytesDownloaded as number,
    failureClass: record.failureClass,
  };
};

export const isFreshSuccessfulYouTubeMediaByteCanary = (
  canary: YouTubeMediaByteCanaryDiagnostic,
  checkedAtMs: number,
  maxAgeMs: number,
  maxFutureSkewMs = DEFAULT_CANARY_MAX_FUTURE_SKEW_MS
): boolean => {
  if (canary.succeeded !== true || (canary.bytesDownloaded ?? 0) <= 0 || !canary.checkedAt) return false;
  const canaryCheckedAtMs = Date.parse(canary.checkedAt);
  if (!Number.isFinite(canaryCheckedAtMs)) return false;
  const ageMs = checkedAtMs - canaryCheckedAtMs;
  return ageMs >= -maxFutureSkewMs && ageMs <= maxAgeMs;
};

export const shouldReplacePersistedYouTubeMediaByteCanary = (
  persistedValue: unknown,
  incoming: YouTubeMediaByteCanaryReport
): boolean => {
  const persisted = parsePersistedYouTubeMediaByteCanary(persistedValue);
  if (!persisted.checkedAt) return true;
  const persistedCheckedAtMs = Date.parse(persisted.checkedAt);
  const incomingCheckedAtMs = Date.parse(incoming.checkedAt);
  if (incomingCheckedAtMs > persistedCheckedAtMs) return true;
  if (incomingCheckedAtMs < persistedCheckedAtMs) return false;
  return (
    persisted.succeeded === incoming.succeeded &&
    persisted.bytesDownloaded === incoming.bytesDownloaded &&
    persisted.failureClass === incoming.failureClass
  );
};

export const parsePersistedYouTubeMediaByteCanary = (value: unknown): YouTubeMediaByteCanaryDiagnostic => {
  const record = asRecord(value);
  if (!record) {
    return { checkedAt: null, succeeded: null, bytesDownloaded: null, failureClass: null };
  }

  const checkedAt =
    typeof record.checkedAt === 'string' &&
    ISO_TIMESTAMP_PATTERN.test(record.checkedAt) &&
    Number.isFinite(Date.parse(record.checkedAt))
      ? new Date(record.checkedAt).toISOString()
      : null;
  const succeeded = typeof record.succeeded === 'boolean' ? record.succeeded : null;
  const bytesDownloaded =
    Number.isSafeInteger(record.bytesDownloaded) && (record.bytesDownloaded as number) >= 0
      ? (record.bytesDownloaded as number)
      : null;
  const failureClass =
    typeof record.failureClass === 'string' && FAILURE_CLASS_PATTERN.test(record.failureClass)
      ? record.failureClass
      : null;

  const validSuccess =
    succeeded === true && checkedAt !== null && bytesDownloaded !== null && bytesDownloaded > 0 && !failureClass;
  const validFailure = succeeded === false && checkedAt !== null && bytesDownloaded === 0 && !!failureClass;
  return validSuccess || validFailure
    ? { checkedAt, succeeded, bytesDownloaded, failureClass }
    : { checkedAt: null, succeeded: null, bytesDownloaded: null, failureClass: null };
};

export const isLoopbackRemoteAddress = (remoteAddress: string | undefined): boolean => {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.trim().toLowerCase();
  if (normalized === '::1') return true;
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  return /^127(?:\.\d{1,3}){3}$/u.test(ipv4);
};

export const parseYtDlpPoTokenProviderDiscovery = (
  diagnosticOutput: string
): { discovered: boolean; version: string | null } => {
  const match = diagnosticOutput.match(/PO Token Providers:[^\n]*\bbgutil:http-([0-9A-Za-z._+-]+)/u);
  return match ? { discovered: true, version: match[1] } : { discovered: false, version: null };
};

export const buildYouTubeReadinessSnapshot = (input: BuildYouTubeReadinessSnapshotInput): YouTubeReadinessSnapshot => {
  const guestReasonCodes: YouTubeReadinessReasonCode[] = [];
  const authenticatedReasonCodes: YouTubeReadinessReasonCode[] = [];
  const guestCanaryAgeMs = ageFromIsoTimestamp(input.guest.mediaByteCanary.checkedAt, input.checkedAtMs);
  const authCanaryAgeMs = ageFromIsoTimestamp(input.authenticatedSession.mediaByteCanary.checkedAt, input.checkedAtMs);
  const guestQueueOldestAgeMs = ageFromIsoTimestamp(input.guest.queue.oldestDeferredAt, input.checkedAtMs);
  const authQueueOldestAgeMs = ageFromIsoTimestamp(
    input.authenticatedSession.queue.oldestDeferredAt,
    input.checkedAtMs
  );
  const addSharedReason = (reasonCode: YouTubeReadinessReasonCode): void => {
    guestReasonCodes.push(reasonCode);
    authenticatedReasonCodes.push(reasonCode);
  };

  if (!input.provider.configured) {
    addSharedReason('YOUTUBE_PROVIDER_NOT_CONFIGURED');
  }
  if (input.provider.discovered === null) {
    addSharedReason('YOUTUBE_PROVIDER_DISCOVERY_NOT_CHECKED');
  }
  if (input.provider.discovered === false) {
    addSharedReason('YOUTUBE_PROVIDER_NOT_DISCOVERED');
  }
  if (!input.provider.version) {
    addSharedReason('YOUTUBE_PROVIDER_VERSION_UNKNOWN');
  }
  if (input.provider.reachable === null) {
    addSharedReason('YOUTUBE_PROVIDER_REACHABILITY_NOT_CHECKED');
  }
  if (input.provider.reachable === false) {
    addSharedReason('YOUTUBE_PROVIDER_UNREACHABLE');
  }

  if (input.guest.mediaByteCanary.succeeded === null) {
    guestReasonCodes.push('YOUTUBE_GUEST_MEDIA_CANARY_NEVER_RUN');
  }
  if (input.guest.mediaByteCanary.succeeded === false) {
    guestReasonCodes.push('YOUTUBE_GUEST_MEDIA_CANARY_FAILED');
  }
  if (
    input.guest.mediaByteCanary.succeeded === true &&
    (input.guest.mediaByteCanary.bytesDownloaded === null || input.guest.mediaByteCanary.bytesDownloaded <= 0)
  ) {
    guestReasonCodes.push('YOUTUBE_GUEST_MEDIA_CANARY_NO_BYTES');
  }
  if (guestCanaryAgeMs !== null && guestCanaryAgeMs > input.limits.mediaByteCanaryMaxAgeMs) {
    guestReasonCodes.push('YOUTUBE_GUEST_MEDIA_CANARY_STALE');
  }
  if (input.guest.queue.blocked) {
    guestReasonCodes.push('YOUTUBE_GUEST_QUEUE_BLOCKED');
  }
  if (input.guest.queue.depth > 0 && guestQueueOldestAgeMs === null) {
    guestReasonCodes.push('YOUTUBE_GUEST_QUEUE_OLDEST_AGE_UNKNOWN');
  }
  if (
    input.guest.queue.depth > 0 &&
    guestQueueOldestAgeMs !== null &&
    guestQueueOldestAgeMs > input.limits.queueOldestMaxAgeMs
  ) {
    guestReasonCodes.push('YOUTUBE_GUEST_QUEUE_BACKLOG_STALE');
  }

  if (!input.authenticatedSession.configured) {
    authenticatedReasonCodes.push('YOUTUBE_AUTH_SESSION_NOT_CONFIGURED');
  } else if (input.authenticatedSession.healthy === null) {
    authenticatedReasonCodes.push('YOUTUBE_AUTH_SESSION_HEALTH_NOT_CHECKED');
  } else if (input.authenticatedSession.healthy === false) {
    authenticatedReasonCodes.push('YOUTUBE_AUTH_SESSION_UNHEALTHY');
  }
  if (input.authenticatedSession.mediaByteCanary.succeeded === null) {
    authenticatedReasonCodes.push('YOUTUBE_AUTH_MEDIA_CANARY_NEVER_RUN');
  }
  if (input.authenticatedSession.mediaByteCanary.succeeded === false) {
    authenticatedReasonCodes.push('YOUTUBE_AUTH_MEDIA_CANARY_FAILED');
  }
  if (
    input.authenticatedSession.mediaByteCanary.succeeded === true &&
    (input.authenticatedSession.mediaByteCanary.bytesDownloaded === null ||
      input.authenticatedSession.mediaByteCanary.bytesDownloaded <= 0)
  ) {
    authenticatedReasonCodes.push('YOUTUBE_AUTH_MEDIA_CANARY_NO_BYTES');
  }
  if (authCanaryAgeMs !== null && authCanaryAgeMs > input.limits.mediaByteCanaryMaxAgeMs) {
    authenticatedReasonCodes.push('YOUTUBE_AUTH_MEDIA_CANARY_STALE');
  }
  if (input.authenticatedSession.queue.blocked) {
    authenticatedReasonCodes.push('YOUTUBE_AUTH_QUEUE_BLOCKED');
  }
  if (input.authenticatedSession.queue.depth > 0 && authQueueOldestAgeMs === null) {
    authenticatedReasonCodes.push('YOUTUBE_AUTH_QUEUE_OLDEST_AGE_UNKNOWN');
  }
  if (
    input.authenticatedSession.queue.depth > 0 &&
    authQueueOldestAgeMs !== null &&
    authQueueOldestAgeMs > input.limits.queueOldestMaxAgeMs
  ) {
    authenticatedReasonCodes.push('YOUTUBE_AUTH_QUEUE_BACKLOG_STALE');
  }

  const effectiveGuestReasonCodes: YouTubeReadinessReasonCode[] = input.youtubeProcessingEnabled
    ? guestReasonCodes
    : ['YOUTUBE_PROCESSING_DISABLED'];
  const effectiveAuthenticatedReasonCodes: YouTubeReadinessReasonCode[] = input.youtubeProcessingEnabled
    ? authenticatedReasonCodes
    : ['YOUTUBE_PROCESSING_DISABLED'];
  const guestReady = input.youtubeProcessingEnabled && effectiveGuestReasonCodes.length === 0;
  const authenticatedReady = input.youtubeProcessingEnabled && effectiveAuthenticatedReasonCodes.length === 0;
  const guestRestrictionIsAuthenticationResolvable =
    input.guest.mediaByteCanary.succeeded === false &&
    (input.guest.mediaByteCanary.failureClass === 'public_path_bot_blocked' ||
      input.guest.mediaByteCanary.failureClass === 'account_required_content') &&
    guestCanaryAgeMs !== null &&
    guestCanaryAgeMs <= input.limits.mediaByteCanaryMaxAgeMs &&
    guestReasonCodes.every((reasonCode) => reasonCode === 'YOUTUBE_GUEST_MEDIA_CANARY_FAILED');
  const authenticatedMediaCanaryReady = isFreshSuccessfulYouTubeMediaByteCanary(
    input.authenticatedSession.mediaByteCanary,
    input.checkedAtMs,
    input.limits.mediaByteCanaryMaxAgeMs
  );
  const readyThroughAuthenticatedFallback =
    input.youtubeProcessingEnabled &&
    guestRestrictionIsAuthenticationResolvable &&
    input.authenticatedSession.configured &&
    input.authenticatedSession.healthy === true &&
    authenticatedMediaCanaryReady &&
    !input.authenticatedSession.queue.blocked;
  const degradedScopes: YouTubeCapabilityScope[] = [];
  if (input.youtubeProcessingEnabled && !guestReady) degradedScopes.push('youtube_guest');
  if (input.youtubeProcessingEnabled && !authenticatedReady) degradedScopes.push('youtube_authenticated');

  return {
    checkedAt: new Date(input.checkedAtMs).toISOString(),
    liveness: {
      ok: true,
    },
    serviceReadiness: {
      ready: !input.youtubeProcessingEnabled || guestReady || readyThroughAuthenticatedFallback,
      reasonCodes: input.youtubeProcessingEnabled ? effectiveGuestReasonCodes : [],
      degradedScopes,
    },
    provider: input.provider,
    capabilities: {
      guest: {
        enabled: input.youtubeProcessingEnabled,
        ready: guestReady,
        reasonCodes: effectiveGuestReasonCodes,
        mediaByteCanary: {
          ...input.guest.mediaByteCanary,
          ageMs: guestCanaryAgeMs,
        },
        queue: {
          ...input.guest.queue,
          oldestAgeMs: guestQueueOldestAgeMs,
        },
      },
      authenticated: {
        enabled: input.youtubeProcessingEnabled,
        ready: authenticatedReady,
        reasonCodes: effectiveAuthenticatedReasonCodes,
        waitingForYouTubeAuthEligible:
          (guestReady || guestRestrictionIsAuthenticationResolvable) &&
          (!input.authenticatedSession.configured || input.authenticatedSession.healthy !== true),
        session: {
          configured: input.authenticatedSession.configured,
          healthy: input.authenticatedSession.healthy,
          lastCheckedAt: input.authenticatedSession.lastCheckedAt,
        },
        mediaByteCanary: {
          ...input.authenticatedSession.mediaByteCanary,
          ageMs: authCanaryAgeMs,
        },
        queue: {
          ...input.authenticatedSession.queue,
          oldestAgeMs: authQueueOldestAgeMs,
        },
      },
    },
  };
};
