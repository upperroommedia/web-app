import assert from 'node:assert/strict';

import { buildYouTubeReadinessSnapshot, type BuildYouTubeReadinessSnapshotInput } from '../src/youtubeReadiness';

const NOW_MS = Date.parse('2026-08-24T12:00:00.000Z');

const baseInput = {
  checkedAtMs: NOW_MS,
  youtubeProcessingEnabled: true,
  provider: {
    configured: true,
    discovered: true,
    version: '1.3.1',
    reachable: true,
    lastCheckedAt: '2026-08-24T11:59:30.000Z',
  },
  guest: {
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:55:00.000Z',
      succeeded: true,
      bytesDownloaded: 4096,
      failureClass: null,
    },
    queue: {
      blocked: false,
      blockerReason: null,
      depth: 1,
      oldestDeferredAt: '2026-08-24T11:59:00.000Z',
    },
  },
  authenticatedSession: {
    configured: true,
    healthy: false,
    lastCheckedAt: '2026-08-24T11:59:45.000Z',
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:58:00.000Z',
      succeeded: false,
      bytesDownloaded: 0,
      failureClass: 'authentication_required',
    },
    queue: {
      blocked: true,
      blockerReason: 'waiting_for_youtube_auth',
      depth: 2,
      oldestDeferredAt: '2026-08-24T11:57:00.000Z',
    },
  },
  limits: {
    mediaByteCanaryMaxAgeMs: 15 * 60 * 1000,
    queueOldestMaxAgeMs: 10 * 60 * 1000,
  },
} satisfies BuildYouTubeReadinessSnapshotInput;

const snapshot = buildYouTubeReadinessSnapshot(baseInput);

assert.equal(snapshot.liveness.ok, true);
assert.deepEqual(snapshot.serviceReadiness, {
  ready: true,
  reasonCodes: [],
  degradedScopes: ['youtube_authenticated'],
});
assert.deepEqual(snapshot.provider, {
  configured: true,
  discovered: true,
  version: '1.3.1',
  reachable: true,
  lastCheckedAt: '2026-08-24T11:59:30.000Z',
});
assert.deepEqual(snapshot.capabilities.guest, {
  enabled: true,
  ready: true,
  reasonCodes: [],
  mediaByteCanary: {
    checkedAt: '2026-08-24T11:55:00.000Z',
    succeeded: true,
    bytesDownloaded: 4096,
    failureClass: null,
    ageMs: 5 * 60 * 1000,
  },
  queue: {
    blocked: false,
    blockerReason: null,
    depth: 1,
    oldestDeferredAt: '2026-08-24T11:59:00.000Z',
    oldestAgeMs: 60 * 1000,
  },
});
assert.deepEqual(snapshot.capabilities.authenticated, {
  enabled: true,
  ready: false,
  reasonCodes: ['YOUTUBE_AUTH_SESSION_UNHEALTHY', 'YOUTUBE_AUTH_MEDIA_CANARY_FAILED', 'YOUTUBE_AUTH_QUEUE_BLOCKED'],
  waitingForYouTubeAuthEligible: true,
  session: {
    configured: true,
    healthy: false,
    lastCheckedAt: '2026-08-24T11:59:45.000Z',
  },
  mediaByteCanary: {
    checkedAt: '2026-08-24T11:58:00.000Z',
    succeeded: false,
    bytesDownloaded: 0,
    failureClass: 'authentication_required',
    ageMs: 2 * 60 * 1000,
  },
  queue: {
    blocked: true,
    blockerReason: 'waiting_for_youtube_auth',
    depth: 2,
    oldestDeferredAt: '2026-08-24T11:57:00.000Z',
    oldestAgeMs: 3 * 60 * 1000,
  },
});

const providerUnavailableSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  provider: {
    ...baseInput.provider,
    discovered: false,
    version: null,
    reachable: false,
  },
});

assert.deepEqual(providerUnavailableSnapshot.serviceReadiness, {
  ready: false,
  reasonCodes: ['YOUTUBE_PROVIDER_NOT_DISCOVERED', 'YOUTUBE_PROVIDER_VERSION_UNKNOWN', 'YOUTUBE_PROVIDER_UNREACHABLE'],
  degradedScopes: ['youtube_guest', 'youtube_authenticated'],
});
assert.deepEqual(providerUnavailableSnapshot.capabilities.guest.reasonCodes, [
  'YOUTUBE_PROVIDER_NOT_DISCOVERED',
  'YOUTUBE_PROVIDER_VERSION_UNKNOWN',
  'YOUTUBE_PROVIDER_UNREACHABLE',
]);
assert.equal(providerUnavailableSnapshot.capabilities.authenticated.waitingForYouTubeAuthEligible, false);

const providerUncheckedSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  provider: {
    configured: false,
    discovered: null,
    version: null,
    reachable: null,
    lastCheckedAt: null,
  },
});

assert.deepEqual(providerUncheckedSnapshot.capabilities.guest.reasonCodes, [
  'YOUTUBE_PROVIDER_NOT_CONFIGURED',
  'YOUTUBE_PROVIDER_DISCOVERY_NOT_CHECKED',
  'YOUTUBE_PROVIDER_VERSION_UNKNOWN',
  'YOUTUBE_PROVIDER_REACHABILITY_NOT_CHECKED',
]);

const guestCanaryMissingSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  guest: {
    ...baseInput.guest,
    mediaByteCanary: {
      checkedAt: null,
      succeeded: null,
      bytesDownloaded: null,
      failureClass: null,
    },
  },
});

assert.deepEqual(guestCanaryMissingSnapshot.capabilities.guest.reasonCodes, ['YOUTUBE_GUEST_MEDIA_CANARY_NEVER_RUN']);
assert.equal(guestCanaryMissingSnapshot.serviceReadiness.ready, false);
assert.equal(guestCanaryMissingSnapshot.capabilities.authenticated.waitingForYouTubeAuthEligible, false);

const guestCanaryFailedSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  guest: {
    ...baseInput.guest,
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:58:00.000Z',
      succeeded: false,
      bytesDownloaded: 0,
      failureClass: 'media_fetch_forbidden',
    },
  },
});

assert.deepEqual(guestCanaryFailedSnapshot.capabilities.guest.reasonCodes, ['YOUTUBE_GUEST_MEDIA_CANARY_FAILED']);

const guestCanaryInvalidSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  guest: {
    ...baseInput.guest,
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:30:00.000Z',
      succeeded: true,
      bytesDownloaded: 0,
      failureClass: null,
    },
  },
});

assert.deepEqual(guestCanaryInvalidSnapshot.capabilities.guest.reasonCodes, [
  'YOUTUBE_GUEST_MEDIA_CANARY_NO_BYTES',
  'YOUTUBE_GUEST_MEDIA_CANARY_STALE',
]);

const authNotConfiguredSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  authenticatedSession: {
    ...baseInput.authenticatedSession,
    configured: false,
    healthy: null,
    lastCheckedAt: null,
    mediaByteCanary: {
      checkedAt: null,
      succeeded: null,
      bytesDownloaded: null,
      failureClass: null,
    },
    queue: {
      blocked: false,
      blockerReason: null,
      depth: 0,
      oldestDeferredAt: null,
    },
  },
});

assert.equal(authNotConfiguredSnapshot.serviceReadiness.ready, true);
assert.deepEqual(authNotConfiguredSnapshot.serviceReadiness.degradedScopes, ['youtube_authenticated']);
assert.deepEqual(authNotConfiguredSnapshot.capabilities.authenticated.reasonCodes, [
  'YOUTUBE_AUTH_SESSION_NOT_CONFIGURED',
  'YOUTUBE_AUTH_MEDIA_CANARY_NEVER_RUN',
]);
assert.equal(authNotConfiguredSnapshot.capabilities.authenticated.waitingForYouTubeAuthEligible, true);

const guestQueueBlockedSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  guest: {
    ...baseInput.guest,
    queue: {
      blocked: true,
      blockerReason: 'provider_unavailable',
      depth: 4,
      oldestDeferredAt: '2026-08-24T11:30:00.000Z',
    },
  },
});

assert.deepEqual(guestQueueBlockedSnapshot.capabilities.guest.reasonCodes, [
  'YOUTUBE_GUEST_QUEUE_BLOCKED',
  'YOUTUBE_GUEST_QUEUE_BACKLOG_STALE',
]);
assert.equal(guestQueueBlockedSnapshot.serviceReadiness.ready, false);

const authQueueStaleSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  authenticatedSession: {
    configured: true,
    healthy: true,
    lastCheckedAt: '2026-08-24T11:59:45.000Z',
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:55:00.000Z',
      succeeded: true,
      bytesDownloaded: 2048,
      failureClass: null,
    },
    queue: {
      blocked: false,
      blockerReason: null,
      depth: 3,
      oldestDeferredAt: '2026-08-24T11:30:00.000Z',
    },
  },
});

assert.equal(authQueueStaleSnapshot.serviceReadiness.ready, true);
assert.deepEqual(authQueueStaleSnapshot.capabilities.authenticated.reasonCodes, ['YOUTUBE_AUTH_QUEUE_BACKLOG_STALE']);
assert.equal(authQueueStaleSnapshot.capabilities.authenticated.waitingForYouTubeAuthEligible, false);

const authCanaryInvalidSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  authenticatedSession: {
    configured: true,
    healthy: true,
    lastCheckedAt: '2026-08-24T11:59:45.000Z',
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:30:00.000Z',
      succeeded: true,
      bytesDownloaded: 0,
      failureClass: null,
    },
    queue: {
      blocked: false,
      blockerReason: null,
      depth: 0,
      oldestDeferredAt: null,
    },
  },
});

assert.equal(authCanaryInvalidSnapshot.serviceReadiness.ready, true);
assert.deepEqual(authCanaryInvalidSnapshot.capabilities.authenticated.reasonCodes, [
  'YOUTUBE_AUTH_MEDIA_CANARY_NO_BYTES',
  'YOUTUBE_AUTH_MEDIA_CANARY_STALE',
]);

const storageOnlySnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  youtubeProcessingEnabled: false,
});

assert.deepEqual(storageOnlySnapshot.serviceReadiness, {
  ready: true,
  reasonCodes: [],
  degradedScopes: [],
});
assert.deepEqual(storageOnlySnapshot.capabilities.guest, {
  ...snapshot.capabilities.guest,
  enabled: false,
  ready: false,
  reasonCodes: ['YOUTUBE_PROCESSING_DISABLED'],
});
assert.equal(storageOnlySnapshot.capabilities.authenticated.enabled, false);
assert.equal(storageOnlySnapshot.capabilities.authenticated.ready, false);
assert.equal(storageOnlySnapshot.capabilities.authenticated.waitingForYouTubeAuthEligible, false);

const authHealthUncheckedSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  authenticatedSession: {
    ...baseInput.authenticatedSession,
    healthy: null,
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:55:00.000Z',
      succeeded: true,
      bytesDownloaded: 2048,
      failureClass: null,
    },
    queue: {
      blocked: false,
      blockerReason: null,
      depth: 0,
      oldestDeferredAt: null,
    },
  },
});

assert.deepEqual(authHealthUncheckedSnapshot.capabilities.authenticated.reasonCodes, [
  'YOUTUBE_AUTH_SESSION_HEALTH_NOT_CHECKED',
]);

const queueAgeUnknownSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  guest: {
    ...baseInput.guest,
    queue: {
      blocked: false,
      blockerReason: null,
      depth: 1,
      oldestDeferredAt: null,
    },
  },
  authenticatedSession: {
    configured: true,
    healthy: true,
    lastCheckedAt: '2026-08-24T11:59:45.000Z',
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:55:00.000Z',
      succeeded: true,
      bytesDownloaded: 2048,
      failureClass: null,
    },
    queue: {
      blocked: false,
      blockerReason: null,
      depth: 1,
      oldestDeferredAt: null,
    },
  },
});

assert.deepEqual(queueAgeUnknownSnapshot.capabilities.guest.reasonCodes, ['YOUTUBE_GUEST_QUEUE_OLDEST_AGE_UNKNOWN']);
assert.deepEqual(queueAgeUnknownSnapshot.capabilities.authenticated.reasonCodes, [
  'YOUTUBE_AUTH_QUEUE_OLDEST_AGE_UNKNOWN',
]);

process.stdout.write('youtube readiness verification passed\n');
