export type YouTubeCapabilityScope = 'youtube_guest' | 'youtube_authenticated';

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
}

export interface YouTubeMediaByteCanaryDiagnostic {
  checkedAt: string | null;
  succeeded: boolean | null;
  bytesDownloaded: number | null;
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

const ageFromIsoTimestamp = (timestamp: string | null, checkedAtMs: number): number | null => {
  if (!timestamp) return null;
  return Math.max(0, checkedAtMs - Date.parse(timestamp));
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
  const degradedScopes: YouTubeCapabilityScope[] = [];
  if (input.youtubeProcessingEnabled && !guestReady) degradedScopes.push('youtube_guest');
  if (input.youtubeProcessingEnabled && !authenticatedReady) degradedScopes.push('youtube_authenticated');

  return {
    checkedAt: new Date(input.checkedAtMs).toISOString(),
    liveness: {
      ok: true,
    },
    serviceReadiness: {
      ready: !input.youtubeProcessingEnabled || guestReady,
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
          guestReady && (!input.authenticatedSession.configured || input.authenticatedSession.healthy !== true),
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
