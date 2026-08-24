import assert from 'node:assert/strict';

import {
  buildYouTubeReadinessSnapshot,
  clampYouTubeMediaByteCanaryIntervalMs,
  createNonOverlappingAsyncTaskRunner,
  getTerminalYouTubeAcquisitionFailureClass,
  isLoopbackRemoteAddress,
  isFreshSuccessfulYouTubeMediaByteCanary,
  parsePersistedYouTubeMediaByteCanary,
  parseYtDlpPoTokenProviderDiscovery,
  shouldReplacePersistedYouTubeMediaByteCanary,
  validateYouTubeMediaByteCanaryReport,
  type BuildYouTubeReadinessSnapshotInput,
} from '../src/youtubeReadiness';

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

const guestRestrictionWithHealthyAuthSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  guest: {
    ...baseInput.guest,
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:58:00.000Z',
      succeeded: false,
      bytesDownloaded: 0,
      failureClass: 'public_path_bot_blocked',
    },
  },
  authenticatedSession: {
    ...baseInput.authenticatedSession,
    healthy: true,
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:59:00.000Z',
      succeeded: true,
      bytesDownloaded: 8192,
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

assert.equal(guestRestrictionWithHealthyAuthSnapshot.capabilities.guest.ready, false);
assert.deepEqual(guestRestrictionWithHealthyAuthSnapshot.serviceReadiness, {
  ready: true,
  reasonCodes: ['YOUTUBE_GUEST_MEDIA_CANARY_FAILED'],
  degradedScopes: ['youtube_guest'],
});
assert.equal(guestRestrictionWithHealthyAuthSnapshot.capabilities.authenticated.waitingForYouTubeAuthEligible, false);

const guestRestrictionWithStaleAuthSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  guest: {
    ...baseInput.guest,
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:58:00.000Z',
      succeeded: false,
      bytesDownloaded: 0,
      failureClass: 'public_path_bot_blocked',
    },
  },
  authenticatedSession: {
    ...baseInput.authenticatedSession,
    healthy: true,
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:30:00.000Z',
      succeeded: true,
      bytesDownloaded: 8192,
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

assert.equal(guestRestrictionWithStaleAuthSnapshot.serviceReadiness.ready, false);

const guestRestrictionWithBlockedAuthQueueSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  guest: {
    ...baseInput.guest,
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:58:00.000Z',
      succeeded: false,
      bytesDownloaded: 0,
      failureClass: 'public_path_bot_blocked',
    },
  },
  authenticatedSession: {
    ...baseInput.authenticatedSession,
    healthy: true,
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:59:00.000Z',
      succeeded: true,
      bytesDownloaded: 8192,
      failureClass: null,
    },
    queue: {
      blocked: true,
      blockerReason: 'authenticated_session',
      depth: 1,
      oldestDeferredAt: '2026-08-24T11:59:00.000Z',
    },
  },
});

assert.equal(guestRestrictionWithBlockedAuthQueueSnapshot.serviceReadiness.ready, false);

const guestRestrictionWithDrainingAuthBacklogSnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  guest: {
    ...baseInput.guest,
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:58:00.000Z',
      succeeded: false,
      bytesDownloaded: 0,
      failureClass: 'public_path_bot_blocked',
    },
  },
  authenticatedSession: {
    ...baseInput.authenticatedSession,
    healthy: true,
    mediaByteCanary: {
      checkedAt: '2026-08-24T11:59:00.000Z',
      succeeded: true,
      bytesDownloaded: 8192,
      failureClass: null,
    },
    queue: {
      blocked: false,
      blockerReason: null,
      depth: 1,
      oldestDeferredAt: '2026-08-24T05:00:00.000Z',
    },
  },
});
assert.equal(guestRestrictionWithDrainingAuthBacklogSnapshot.serviceReadiness.ready, true);
assert.deepEqual(guestRestrictionWithDrainingAuthBacklogSnapshot.serviceReadiness.degradedScopes, [
  'youtube_guest',
  'youtube_authenticated',
]);

const guestRestrictionWithoutConfiguredAuthSnapshot = buildYouTubeReadinessSnapshot({
  ...guestRestrictionWithDrainingAuthBacklogSnapshot,
  checkedAtMs: NOW_MS,
  youtubeProcessingEnabled: true,
  provider: baseInput.provider,
  guest: {
    mediaByteCanary: guestRestrictionWithDrainingAuthBacklogSnapshot.capabilities.guest.mediaByteCanary,
    queue: guestRestrictionWithDrainingAuthBacklogSnapshot.capabilities.guest.queue,
  },
  authenticatedSession: {
    configured: false,
    healthy: true,
    lastCheckedAt: '2026-08-24T11:59:00.000Z',
    mediaByteCanary: guestRestrictionWithDrainingAuthBacklogSnapshot.capabilities.authenticated.mediaByteCanary,
    queue: guestRestrictionWithDrainingAuthBacklogSnapshot.capabilities.authenticated.queue,
  },
  limits: baseInput.limits,
});
assert.equal(guestRestrictionWithoutConfiguredAuthSnapshot.serviceReadiness.ready, false);

const futureGuestCanarySnapshot = buildYouTubeReadinessSnapshot({
  ...baseInput,
  guest: {
    ...baseInput.guest,
    mediaByteCanary: {
      checkedAt: '2026-08-24T12:10:00.000Z',
      succeeded: true,
      bytesDownloaded: 8192,
      failureClass: null,
    },
  },
});
assert.deepEqual(futureGuestCanarySnapshot.capabilities.guest.reasonCodes, ['YOUTUBE_GUEST_MEDIA_CANARY_STALE']);
assert.equal(futureGuestCanarySnapshot.serviceReadiness.ready, false);

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

assert.deepEqual(
  validateYouTubeMediaByteCanaryReport(
    {
      scope: 'guest',
      checkedAt: '2026-08-24T11:58:00.000Z',
      succeeded: false,
      bytesDownloaded: 0,
      failureClass: 'public_path_bot_blocked',
    },
    { checkedAtMs: NOW_MS }
  ),
  {
    scope: 'guest',
    checkedAt: '2026-08-24T11:58:00.000Z',
    succeeded: false,
    bytesDownloaded: 0,
    failureClass: 'public_path_bot_blocked',
  }
);

assert.deepEqual(
  validateYouTubeMediaByteCanaryReport(
    {
      scope: 'authenticated',
      checkedAt: '2026-08-24T11:59:00.000Z',
      succeeded: true,
      bytesDownloaded: 16384,
      failureClass: null,
    },
    { checkedAtMs: NOW_MS }
  ),
  {
    scope: 'authenticated',
    checkedAt: '2026-08-24T11:59:00.000Z',
    succeeded: true,
    bytesDownloaded: 16384,
    failureClass: null,
  }
);

for (const invalidReport of [
  {
    scope: 'authenticated',
    checkedAt: '2026-08-24T11:59:00.000Z',
    succeeded: true,
    bytesDownloaded: 16384,
    failureClass: null,
    cookies: 'secret',
  },
  {
    scope: 'guest',
    checkedAt: 'not-a-date',
    succeeded: false,
    bytesDownloaded: 0,
    failureClass: 'public_path_bot_blocked',
  },
  {
    scope: 'guest',
    checkedAt: '2026-08-24T11:58:00.000Z',
    succeeded: true,
    bytesDownloaded: 0,
    failureClass: null,
  },
  {
    scope: 'authenticated',
    checkedAt: '2026-08-24T11:59:00.000Z',
    succeeded: false,
    bytesDownloaded: 0,
    failureClass: null,
  },
]) {
  assert.throws(() => validateYouTubeMediaByteCanaryReport(invalidReport, { checkedAtMs: NOW_MS }));
}

assert.throws(() =>
  validateYouTubeMediaByteCanaryReport(
    {
      scope: 'authenticated',
      checkedAt: '2026-08-24T12:10:00.000Z',
      succeeded: true,
      bytesDownloaded: 16384,
      failureClass: null,
    },
    { checkedAtMs: NOW_MS, maxFutureSkewMs: 60_000 }
  )
);

assert.deepEqual(
  parsePersistedYouTubeMediaByteCanary({
    checkedAt: '2026-08-24T11:59:00.000Z',
    succeeded: true,
    bytesDownloaded: 16384,
  }),
  {
    checkedAt: '2026-08-24T11:59:00.000Z',
    succeeded: true,
    bytesDownloaded: 16384,
    failureClass: null,
  }
);
assert.deepEqual(parsePersistedYouTubeMediaByteCanary({ succeeded: true }), {
  checkedAt: null,
  succeeded: null,
  bytesDownloaded: null,
  failureClass: null,
});

const successfulAuthReport = validateYouTubeMediaByteCanaryReport(
  {
    scope: 'authenticated',
    checkedAt: '2026-08-24T11:59:00.000Z',
    succeeded: true,
    bytesDownloaded: 16384,
    failureClass: null,
  },
  { checkedAtMs: NOW_MS }
);
assert.equal(isFreshSuccessfulYouTubeMediaByteCanary(successfulAuthReport, NOW_MS, 15 * 60 * 1000), true);
assert.equal(
  isFreshSuccessfulYouTubeMediaByteCanary(successfulAuthReport, NOW_MS + 16 * 60 * 1000, 15 * 60 * 1000),
  false
);
const successfulGuestReport = validateYouTubeMediaByteCanaryReport(
  {
    scope: 'guest',
    checkedAt: '2026-08-24T11:50:00.000Z',
    succeeded: true,
    bytesDownloaded: 8192,
    failureClass: null,
  },
  { checkedAtMs: NOW_MS }
);
assert.equal(isFreshSuccessfulYouTubeMediaByteCanary(successfulGuestReport, NOW_MS, 15 * 60 * 1000), true);
assert.equal(
  isFreshSuccessfulYouTubeMediaByteCanary(successfulGuestReport, NOW_MS + 6 * 60 * 1000, 15 * 60 * 1000),
  false
);
assert.equal(
  shouldReplacePersistedYouTubeMediaByteCanary(
    {
      checkedAt: '2026-08-24T11:59:30.000Z',
      succeeded: false,
      bytesDownloaded: 0,
      failureClass: 'account_required_content',
    },
    successfulAuthReport
  ),
  false
);
assert.equal(shouldReplacePersistedYouTubeMediaByteCanary(null, successfulAuthReport), true);

assert.equal(isLoopbackRemoteAddress('127.0.0.1'), true);
assert.equal(isLoopbackRemoteAddress('127.42.0.8'), true);
assert.equal(isLoopbackRemoteAddress('::1'), true);
assert.equal(isLoopbackRemoteAddress('::ffff:127.0.0.1'), true);
assert.equal(isLoopbackRemoteAddress('10.0.0.8'), false);
assert.equal(isLoopbackRemoteAddress(undefined), false);

assert.deepEqual(
  parseYtDlpPoTokenProviderDiscovery(
    '[debug] PO Token Providers: bgutil:http-1.3.2 (external)\n[debug] Extractor Plugins: 1850'
  ),
  { discovered: true, version: '1.3.2' }
);
assert.deepEqual(parseYtDlpPoTokenProviderDiscovery('[debug] PO Token Providers: none'), {
  discovered: false,
  version: null,
});

assert.equal(
  getTerminalYouTubeAcquisitionFailureClass({
    attemptedModes: ['public_provider', 'cookie_provider', 'browser_fallback'],
    browserFallbackFailureClass: 'account_required_content',
    terminalFailureClass: 'account_required_content',
    requiresAuthenticationRecovery: false,
  }),
  'account_required_content'
);
assert.equal(
  getTerminalYouTubeAcquisitionFailureClass({
    attemptedModes: ['public_provider', 'cookie_provider'],
    authenticatedFailureClass: 'account_required_content',
    requiresAuthenticationRecovery: true,
  }),
  null
);

assert.equal(clampYouTubeMediaByteCanaryIntervalMs(1), 60_000);
assert.equal(clampYouTubeMediaByteCanaryIntervalMs(7 * 60 * 1000), 7 * 60 * 1000);
assert.equal(clampYouTubeMediaByteCanaryIntervalMs(30 * 60 * 1000), 10 * 60 * 1000);

void (async () => {
  let taskCallCount = 0;
  let releaseFirstRun: (() => void) | undefined;
  const firstRunBlocked = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });
  const taskRunner = createNonOverlappingAsyncTaskRunner(async () => {
    taskCallCount += 1;
    if (taskCallCount === 1) await firstRunBlocked;
  });

  const firstRun = taskRunner.run();
  await Promise.resolve();
  assert.equal(taskRunner.isRunning(), true);
  assert.equal(await taskRunner.run(), false);
  assert.equal(taskCallCount, 1);

  releaseFirstRun?.();
  assert.equal(await firstRun, true);
  assert.equal(taskRunner.isRunning(), false);
  assert.equal(await taskRunner.run(), true);
  assert.equal(taskCallCount, 2);

  process.stdout.write('youtube readiness verification passed\n');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
