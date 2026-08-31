import assert from 'node:assert/strict';
import {
  buildCloudTasksCreateTaskRequest,
  CloudTaskNameTombstonedError,
  cleanupDeletedSermonProcessAudioState,
  completeProcessAudioSuccess,
  deferYouTubeRequestForAuthentication,
  deferPostLiveArchiveYouTubeRequest,
  enqueueTaskViaCloudTasksApi,
  getPostLiveArchiveRetryDelaySeconds,
  getYouTubeQueueScopeDiagnostics,
  normalizeCloudTasksAccessToken,
  releaseYouTubeAuthAlertReservation,
  resumeDeferredYouTubeQueueOnStartup,
  setCloudTasksApiDepsForTesting,
  setProcessAudioTaskQueueFactoryForTesting,
} from '../src/processAudioQueueStore';
import {
  PROCESS_AUDIO_DEFERRED_DISPOSITIONS,
  getYouTubeFailureDisposition,
} from '../../../packages/contracts/processAudioQueue';
import {
  beginYouTubeQueueProbe,
  isYouTubeQueuePaused as isFunctionsYouTubeQueuePaused,
  recoverStaleYouTubeQueueProbe,
  setYouTubeTaskQueueFactoryForTesting,
} from '../../../functions-media/src/processAudioQueueStore';

class MockSnapshot {
  constructor(private readonly value: unknown) {}

  exists(): boolean {
    return this.value !== undefined && this.value !== null;
  }

  val(): unknown {
    return this.value;
  }
}

class MockRef {
  constructor(
    private readonly store: Record<string, unknown>,
    private readonly key: string,
    private readonly failSetOnceFor: Set<string>,
    private readonly beforeTransactionOnceFor: Map<string, Array<(store: Record<string, unknown>) => void>>,
    private readonly beforeGetOnceFor: Map<string, Array<(store: Record<string, unknown>) => void>>,
    private readonly coldTransactionOnceFor: Set<string>
  ) {}

  async get(): Promise<MockSnapshot> {
    const hooks = this.beforeGetOnceFor.get(this.key);
    const hook = hooks?.shift();
    hook?.(this.store);

    if (Object.prototype.hasOwnProperty.call(this.store, this.key)) {
      return new MockSnapshot(this.store[this.key]);
    }

    const prefix = `${this.key}/`;
    const children = Object.entries(this.store).reduce<Record<string, unknown>>((acc, [key, value]) => {
      if (key.startsWith(prefix)) {
        const childKey = key.slice(prefix.length).split('/')[0];
        acc[childKey] = value;
      }
      return acc;
    }, {});

    return new MockSnapshot(Object.keys(children).length > 0 ? children : undefined);
  }

  async set(value: unknown): Promise<void> {
    if (this.failSetOnceFor.delete(this.key)) {
      throw new Error(`Injected set failure for ${this.key}`);
    }
    this.store[this.key] = value;
  }

  async update(patch: Record<string, unknown>): Promise<void> {
    this.store[this.key] = {
      ...((this.store[this.key] as Record<string, unknown> | undefined) ?? {}),
      ...patch,
    };
  }

  async remove(): Promise<void> {
    delete this.store[this.key];
  }

  async transaction(updateFn: (current: unknown) => unknown): Promise<{ committed: boolean; snapshot: MockSnapshot }> {
    const hooks = this.beforeTransactionOnceFor.get(this.key);
    const hook = hooks?.shift();
    hook?.(this.store);
    const serverCurrent = this.store[this.key];
    if (this.coldTransactionOnceFor.delete(this.key)) {
      const coldNext = updateFn(null);
      if (typeof coldNext === 'undefined') {
        return { committed: false, snapshot: new MockSnapshot(serverCurrent) };
      }
      if (serverCurrent === null || typeof serverCurrent === 'undefined') {
        this.store[this.key] = coldNext;
        return { committed: true, snapshot: new MockSnapshot(coldNext) };
      }
    }

    const next = updateFn(serverCurrent);
    if (typeof next === 'undefined') {
      return { committed: false, snapshot: new MockSnapshot(this.store[this.key]) };
    }
    this.store[this.key] = next;
    return { committed: true, snapshot: new MockSnapshot(next) };
  }
}

function createMockDatabase(
  initialData: Record<string, unknown> = {},
  failSetOnceFor: string[] = [],
  beforeTransactionOnceFor: Record<string, Array<(store: Record<string, unknown>) => void>> = {},
  beforeGetOnceFor: Record<string, Array<(store: Record<string, unknown>) => void>> = {},
  coldTransactionOnceFor: string[] = []
) {
  const store = { ...initialData };
  const pendingSetFailures = new Set(failSetOnceFor);
  const pendingTransactionHooks = new Map(Object.entries(beforeTransactionOnceFor));
  const pendingGetHooks = new Map(Object.entries(beforeGetOnceFor));
  const pendingColdTransactions = new Set(coldTransactionOnceFor);
  return {
    store,
    ref(key: string): MockRef {
      return new MockRef(
        store,
        key,
        pendingSetFailures,
        pendingTransactionHooks,
        pendingGetHooks,
        pendingColdTransactions
      );
    },
  };
}

async function main(): Promise<void> {
  const youtubePayload = {
    id: 'sermon-123',
    startTime: 12,
    duration: 345,
    youtubeUrl: 'https://www.youtube.com/watch?v=dKaZ89SkVYY',
  } as const;

  assert.deepEqual(
    getYouTubeFailureDisposition({
      attemptedModes: ['public_provider', 'cookie_provider'],
      guestFailureClass: 'account_required_content',
      authenticatedFailureClass: 'account_required_content',
      requiresAuthenticationRecovery: true,
    }),
    {
      action: 'defer',
      code: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
      dependencyScope: 'authenticated_session',
      retryable: true,
    }
  );

  assert.deepEqual(
    getYouTubeFailureDisposition({
      attemptedModes: ['public_provider'],
      guestFailureClass: 'media_http_403',
      requiresAuthenticationRecovery: false,
    }),
    { action: 'task_retry', retryable: true }
  );
  assert.deepEqual(
    getYouTubeFailureDisposition({
      attemptedModes: ['public_provider', 'cookie_provider', 'browser_fallback'],
      guestFailureClass: 'account_required_content',
      authenticatedFailureClass: 'account_required_content',
      browserFallbackFailureClass: 'account_required_content',
      terminalFailureClass: 'account_required_content',
      requiresAuthenticationRecovery: false,
    }),
    { action: 'terminal', code: 'account_required_content', retryable: false }
  );
  assert.equal(
    isFunctionsYouTubeQueuePaused({
      blocked: true,
      blockerReason: 'cookie_session_stale_or_challenged',
      blockedAt: '2026-08-24T00:00:00.000Z',
      blockerEpisodeId: 'legacy-blocker',
      probeMode: 'cookie_provider',
      probeStatus: 'blocked',
      probeTaskSermonId: null,
      probeRequestVersion: null,
      probeStartedAt: null,
      probeLastSucceededAt: null,
      probeLastFailedAt: '2026-08-24T00:00:00.000Z',
      probeLastFailureClass: 'media_http_403',
      probeLastFailureMessage: 'HTTP Error 403',
      alertSentAt: '2026-08-24T00:00:00.000Z',
      deferredYouTubeTaskCount: 6,
    }),
    false
  );

  const legacySecondPayload = {
    id: 'legacy-second',
    youtubeUrl: 'https://www.youtube.com/watch?v=legacySecond',
    startTime: 0,
    duration: 180,
    deleteOriginal: false,
    skipTranscode: false,
  } as const;
  const legacyRecoveryStore = createMockDatabase(
    {
      'processAudioQueues/youtube/state': {
        blocked: true,
        blockerReason: 'cookie_session_stale_or_challenged',
        probeMode: 'cookie_provider',
        probeStatus: 'blocked',
        deferredYouTubeTaskCount: 2,
      },
      'processAudioQueues/youtube/deferred/sermon-123': {
        sermonId: 'sermon-123',
        payload: youtubePayload,
        requestVersion: 'legacy-first-version',
        deferredAt: '2026-08-23T22:07:10.842Z',
        reason: 'cookie_session_stale_or_challenged',
        probeMode: 'cookie_provider',
        blockerEpisodeId: 'legacy-episode',
        lastFailureClass: 'cookie_session_stale_or_challenged',
      },
      'processAudioQueues/youtube/deferred/legacy-second': {
        sermonId: 'legacy-second',
        payload: legacySecondPayload,
        requestVersion: 'legacy-second-version',
        deferredAt: '2026-08-23T23:00:00.000Z',
        reason: 'cookie_session_stale_or_challenged',
        probeMode: 'cookie_provider',
        blockerEpisodeId: 'legacy-episode',
        lastFailureClass: 'cookie_session_stale_or_challenged',
      },
    },
    [],
    {},
    {},
    ['processAudioQueues/youtube/state']
  );
  assert.deepEqual(await getYouTubeQueueScopeDiagnostics(legacyRecoveryStore as any), {
    guest: {
      blocked: false,
      blockerReason: null,
      depth: 0,
      oldestDeferredAt: null,
    },
    authenticated: {
      blocked: true,
      blockerReason: 'cookie_session_stale_or_challenged',
      depth: 2,
      oldestDeferredAt: '2026-08-23T22:07:10.842Z',
    },
    probe: {
      status: 'blocked',
      lastSucceededAt: null,
      lastFailedAt: null,
      lastFailureClass: null,
    },
  });
  let legacyDispatchCount = 0;
  setProcessAudioTaskQueueFactoryForTesting(() => ({
    async delete(): Promise<void> {},
  }));
  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'legacy-token' }),
    fetchImpl: async () => {
      legacyDispatchCount += 1;
      return new Response('{}', { status: 200 });
    },
  });
  const firstLegacyRecovery = await resumeDeferredYouTubeQueueOnStartup({
    database: legacyRecoveryStore as any,
    force: true,
    authenticatedRecoveryGeneration: 'auth-canary-generation-1',
  });
  assert.equal(firstLegacyRecovery.resumed, true);
  assert.equal(legacyDispatchCount, 1);
  assert.deepEqual(legacyRecoveryStore.store['processAudioQueues/youtube/deferred/legacy-second'], {
    sermonId: 'legacy-second',
    payload: legacySecondPayload,
    requestVersion: 'legacy-second-version',
    deferredAt: '2026-08-23T23:00:00.000Z',
    reason: 'cookie_session_stale_or_challenged',
    probeMode: 'cookie_provider',
    blockerEpisodeId: 'legacy-episode',
    lastFailureClass: 'cookie_session_stale_or_challenged',
    disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
    dependencyScope: 'authenticated_session',
    attemptCount: 0,
  });
  await legacyRecoveryStore.ref('processAudioQueues/youtube/state').update({
    probeStatus: 'waiting_for_auth_required_request',
    probeTaskSermonId: null,
    probeRequestVersion: null,
    probeStartedAt: null,
  });
  const unchangedGenerationRecovery = await resumeDeferredYouTubeQueueOnStartup({
    database: legacyRecoveryStore as any,
    authenticatedRecoveryGeneration: 'auth-canary-generation-1',
  });
  assert.equal(legacyDispatchCount, 1);
  assert.equal(unchangedGenerationRecovery.resumed, false);
  assert.equal(unchangedGenerationRecovery.nextProbeSermonId, null);
  setCloudTasksApiDepsForTesting(null);
  setProcessAudioTaskQueueFactoryForTesting(null);

  const completedProbeStartedAt = new Date(Date.now() - 1_000).toISOString();
  const completedProbeUpdatedAt = new Date().toISOString();
  const liveCompletedProbeRecoveryStore = createMockDatabase({
    'processAudioQueues/youtube/state': {
      blocked: false,
      probeMode: 'cookie_provider',
      probeStatus: 'probing',
      probeTaskSermonId: 'sermon-123',
      probeRequestVersion: 'live-completed-version',
      probeStartedAt: completedProbeStartedAt,
      deferredYouTubeTaskCount: 1,
      lastAttemptedAuthRecoveryGeneration: 'stale-auth-generation',
    },
    'processAudioQueues/youtube/deferred/legacy-second': {
      sermonId: 'legacy-second',
      payload: legacySecondPayload,
      requestVersion: 'legacy-second-version',
      deferredAt: '2026-08-23T23:00:00.000Z',
      reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
      disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
      dependencyScope: 'authenticated_session',
      probeMode: 'cookie_provider',
      blockerEpisodeId: 'live-completed-episode',
      lastFailureClass: 'cookie_session_stale_or_challenged',
      attemptCount: 1,
    },
    'processAudioRequests/sermon-123': {
      sermonId: 'sermon-123',
      sourceType: 'youtube',
      currentPayload: youtubePayload,
      currentRequestVersion: 'live-completed-version',
      nextPayload: null,
      nextRequestVersion: null,
      nextUpdatedAt: null,
      updatedAt: completedProbeUpdatedAt,
    },
  });
  let liveCompletedRecoveryDispatchCount = 0;
  setProcessAudioTaskQueueFactoryForTesting(() => ({ async delete(): Promise<void> {} }));
  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'live-completed-recovery-token' }),
    fetchImpl: async () => {
      liveCompletedRecoveryDispatchCount += 1;
      return new Response('{}', { status: 200 });
    },
  });
  const liveCompletedRecovery = await resumeDeferredYouTubeQueueOnStartup({
    database: liveCompletedProbeRecoveryStore as any,
    authenticatedRecoveryGeneration: 'fresh-auth-generation',
  });
  assert.equal(liveCompletedRecovery.resumed, true);
  assert.equal(liveCompletedRecovery.nextProbeSermonId, 'legacy-second');
  assert.equal(liveCompletedRecoveryDispatchCount, 1);
  assert.equal(
    liveCompletedProbeRecoveryStore.store['processAudioQueues/youtube/deferred/sermon-123'],
    undefined,
    'a legacy completed probe fingerprint must not be restored or reprocessed'
  );
  assert.equal(
    (liveCompletedProbeRecoveryStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>)
      .probeTaskSermonId,
    'legacy-second'
  );
  setCloudTasksApiDepsForTesting(null);
  setProcessAudioTaskQueueFactoryForTesting(null);

  const completedProbeReservationRaceStore = createMockDatabase(
    {
      'processAudioQueues/youtube/state': {
        blocked: false,
        probeMode: 'cookie_provider',
        probeStatus: 'probing',
        probeTaskSermonId: 'sermon-123',
        probeRequestVersion: 'live-completed-version',
        probeStartedAt: completedProbeStartedAt,
        deferredYouTubeTaskCount: 1,
        lastAttemptedAuthRecoveryGeneration: 'stale-auth-generation',
      },
      'processAudioQueues/youtube/deferred/legacy-second': {
        sermonId: 'legacy-second',
        payload: legacySecondPayload,
        requestVersion: 'legacy-second-version',
        deferredAt: '2026-08-23T23:00:00.000Z',
        reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        dependencyScope: 'authenticated_session',
        probeMode: 'cookie_provider',
        blockerEpisodeId: 'live-completed-episode',
        lastFailureClass: 'cookie_session_stale_or_challenged',
        attemptCount: 1,
      },
      'processAudioRequests/sermon-123': {
        sermonId: 'sermon-123',
        sourceType: 'youtube',
        currentPayload: youtubePayload,
        currentRequestVersion: 'live-completed-version',
        updatedAt: completedProbeUpdatedAt,
      },
    },
    [],
    {
      'processAudioQueues/youtube/state': [
        (store) => {
          store['processAudioQueues/youtube/state'] = {
            ...(store['processAudioQueues/youtube/state'] as Record<string, unknown>),
            probeTaskSermonId: 'concurrent-owner',
            probeRequestVersion: 'concurrent-version',
            probeStartedAt: new Date().toISOString(),
          };
        },
      ],
    }
  );
  let completedProbeRaceDispatchCount = 0;
  setProcessAudioTaskQueueFactoryForTesting(() => ({ async delete(): Promise<void> {} }));
  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'completed-probe-race-token' }),
    fetchImpl: async () => {
      completedProbeRaceDispatchCount += 1;
      return new Response('{}', { status: 200 });
    },
  });
  const completedProbeRaceRecovery = await resumeDeferredYouTubeQueueOnStartup({
    database: completedProbeReservationRaceStore as any,
    authenticatedRecoveryGeneration: 'fresh-race-generation',
  });
  assert.equal(completedProbeRaceRecovery.resumed, false);
  assert.equal(completedProbeRaceDispatchCount, 0, 'a lost probe reservation must not dispatch a Cloud Task');
  assert.equal(
    (completedProbeReservationRaceStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>)
      .probeTaskSermonId,
    'concurrent-owner',
    'recovery must not overwrite a concurrently claimed probe'
  );
  assert.notEqual(
    completedProbeReservationRaceStore.store['processAudioQueues/youtube/deferred/legacy-second'],
    undefined,
    'a lost recovery reservation must retain the durable deferred request'
  );
  setCloudTasksApiDepsForTesting(null);
  setProcessAudioTaskQueueFactoryForTesting(null);

  const buildSingleDeferredRecoveryStore = () =>
    createMockDatabase({
      'processAudioQueues/youtube/state': {
        blocked: false,
        probeStatus: 'waiting_for_auth_required_request',
        deferredYouTubeTaskCount: 1,
      },
      'processAudioQueues/youtube/deferred/sermon-123': {
        sermonId: 'sermon-123',
        payload: youtubePayload,
        requestVersion: 'probe-version',
        deferredAt: '2026-08-23T22:07:10.842Z',
        reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        dependencyScope: 'authenticated_session',
        probeMode: 'cookie_provider',
        blockerEpisodeId: 'probe-episode',
        lastFailureClass: 'cookie_session_stale_or_challenged',
        attemptCount: 1,
      },
    });

  const tombstoneRecoveryStore = buildSingleDeferredRecoveryStore();
  let tombstoneRecoveryRequestCount = 0;
  setProcessAudioTaskQueueFactoryForTesting(() => ({ async delete(): Promise<void> {} }));
  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'tombstone-recovery-token' }),
    fetchImpl: async () => {
      tombstoneRecoveryRequestCount += 1;
      if (tombstoneRecoveryRequestCount === 1) {
        return new Response('{"error":{"status":"ALREADY_EXISTS"}}', { status: 409 });
      }
      if (tombstoneRecoveryRequestCount === 2) {
        assert.notEqual(
          tombstoneRecoveryStore.store['processAudioQueues/youtube/deferred/sermon-123'],
          undefined,
          'a tombstoned task name must not delete the durable deferred request'
        );
        return new Response('{"error":{"status":"NOT_FOUND"}}', { status: 404 });
      }
      if (tombstoneRecoveryRequestCount === 3) {
        const retainedEntry = tombstoneRecoveryStore.store['processAudioQueues/youtube/deferred/sermon-123'] as Record<
          string,
          unknown
        >;
        assert.equal(retainedEntry.dispatchGeneration, 1);
        return new Response('{}', { status: 200 });
      }
      throw new Error('Unexpected extra Cloud Tasks request');
    },
  });
  await resumeDeferredYouTubeQueueOnStartup({
    database: tombstoneRecoveryStore as any,
    authenticatedRecoveryGeneration: 'tombstone-recovery-generation',
  });
  assert.equal(tombstoneRecoveryRequestCount, 3);
  assert.equal(tombstoneRecoveryStore.store['processAudioQueues/youtube/deferred/sermon-123'], undefined);
  assert.ok((tombstoneRecoveryStore.store['processAudioRequests/sermon-123'] as Record<string, unknown>).queuedTaskId);
  setCloudTasksApiDepsForTesting(null);
  setProcessAudioTaskQueueFactoryForTesting(null);

  const liveDuplicateRecoveryStore = buildSingleDeferredRecoveryStore();
  let liveDuplicateRecoveryRequestCount = 0;
  let liveDuplicateTaskName = '';
  setProcessAudioTaskQueueFactoryForTesting(() => ({ async delete(): Promise<void> {} }));
  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'live-duplicate-recovery-token' }),
    fetchImpl: async (_url, init) => {
      liveDuplicateRecoveryRequestCount += 1;
      if (liveDuplicateRecoveryRequestCount === 1) {
        liveDuplicateTaskName = (JSON.parse(String(init?.body)) as { task: { name: string } }).task.name;
        return new Response('{"error":{"status":"ALREADY_EXISTS"}}', { status: 409 });
      }
      assert.notEqual(
        liveDuplicateRecoveryStore.store['processAudioQueues/youtube/deferred/sermon-123'],
        undefined,
        'a verified live duplicate must retain the durable request until it is adopted'
      );
      return new Response(JSON.stringify({ name: liveDuplicateTaskName }), { status: 200 });
    },
  });
  await resumeDeferredYouTubeQueueOnStartup({
    database: liveDuplicateRecoveryStore as any,
    authenticatedRecoveryGeneration: 'live-duplicate-generation',
  });
  assert.equal(liveDuplicateRecoveryRequestCount, 2);
  assert.equal(liveDuplicateRecoveryStore.store['processAudioQueues/youtube/deferred/sermon-123'], undefined);
  setCloudTasksApiDepsForTesting(null);
  setProcessAudioTaskQueueFactoryForTesting(null);

  const concurrentRecoveryStore = createMockDatabase({
    'processAudioQueues/youtube/state': {
      blocked: false,
      probeStatus: 'waiting_for_auth_required_request',
      deferredYouTubeTaskCount: 2,
    },
    'processAudioQueues/youtube/deferred/sermon-123': {
      sermonId: 'sermon-123',
      payload: youtubePayload,
      requestVersion: 'concurrent-first-version',
      deferredAt: '2026-08-23T22:07:10.842Z',
      reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
      disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
      dependencyScope: 'authenticated_session',
      probeMode: 'cookie_provider',
      blockerEpisodeId: 'concurrent-episode',
      lastFailureClass: 'cookie_session_stale_or_challenged',
      attemptCount: 1,
    },
    'processAudioQueues/youtube/deferred/legacy-second': {
      sermonId: 'legacy-second',
      payload: legacySecondPayload,
      requestVersion: 'concurrent-second-version',
      deferredAt: '2026-08-23T23:00:00.000Z',
      reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
      disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
      dependencyScope: 'authenticated_session',
      probeMode: 'cookie_provider',
      blockerEpisodeId: 'concurrent-episode',
      lastFailureClass: 'cookie_session_stale_or_challenged',
      attemptCount: 1,
    },
  });
  let releaseConcurrentDispatch: () => void = () => undefined;
  const concurrentDispatchGate = new Promise<void>((resolve) => {
    releaseConcurrentDispatch = resolve;
  });
  let signalConcurrentDispatchStarted: () => void = () => undefined;
  const concurrentDispatchStarted = new Promise<void>((resolve) => {
    signalConcurrentDispatchStarted = resolve;
  });
  let concurrentDispatchCount = 0;
  setProcessAudioTaskQueueFactoryForTesting(() => ({ async delete(): Promise<void> {} }));
  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'concurrent-token' }),
    fetchImpl: async () => {
      concurrentDispatchCount += 1;
      signalConcurrentDispatchStarted();
      await concurrentDispatchGate;
      return new Response('{}', { status: 200 });
    },
  });
  const firstConcurrentRecovery = resumeDeferredYouTubeQueueOnStartup({
    database: concurrentRecoveryStore as any,
    authenticatedRecoveryGeneration: 'concurrent-generation',
  });
  await concurrentDispatchStarted;
  const secondConcurrentRecovery = resumeDeferredYouTubeQueueOnStartup({
    database: concurrentRecoveryStore as any,
    authenticatedRecoveryGeneration: 'concurrent-generation',
  });
  releaseConcurrentDispatch();
  const concurrentResults = await Promise.all([firstConcurrentRecovery, secondConcurrentRecovery]);
  assert.equal(concurrentDispatchCount, 1, 'concurrent reconcilers must dispatch only one authenticated probe');
  assert.equal(concurrentResults.filter((result) => result.resumed).length, 1);
  assert.equal(
    (concurrentRecoveryStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>)
      .lastAttemptedAuthRecoveryGeneration,
    'concurrent-generation'
  );
  setCloudTasksApiDepsForTesting(null);
  setProcessAudioTaskQueueFactoryForTesting(null);

  const oldestAcrossModesStore = createMockDatabase({
    'processAudioQueues/youtube/state': {
      blocked: false,
      probeMode: 'cookie_provider',
      probeStatus: 'waiting_for_auth_required_request',
      deferredYouTubeTaskCount: 2,
    },
    'processAudioQueues/youtube/deferred/older-browser': {
      sermonId: 'older-browser',
      payload: { ...youtubePayload, id: 'older-browser' },
      requestVersion: 'older-browser-version',
      deferredAt: '2026-08-23T20:00:00.000Z',
      reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
      disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
      dependencyScope: 'authenticated_session',
      probeMode: 'browser_fallback',
      blockerEpisodeId: 'oldest-mode-episode',
      lastFailureClass: 'browser_fallback_failed',
      attemptCount: 1,
    },
    'processAudioQueues/youtube/deferred/newer-cookie': {
      sermonId: 'newer-cookie',
      payload: { ...youtubePayload, id: 'newer-cookie' },
      requestVersion: 'newer-cookie-version',
      deferredAt: '2026-08-23T21:00:00.000Z',
      reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
      disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
      dependencyScope: 'authenticated_session',
      probeMode: 'cookie_provider',
      blockerEpisodeId: 'oldest-mode-episode',
      lastFailureClass: 'cookie_session_stale_or_challenged',
      attemptCount: 1,
    },
  });
  setProcessAudioTaskQueueFactoryForTesting(() => ({ async delete(): Promise<void> {} }));
  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'oldest-mode-token' }),
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
  const oldestAcrossModesRecovery = await resumeDeferredYouTubeQueueOnStartup({
    database: oldestAcrossModesStore as any,
    authenticatedRecoveryGeneration: 'oldest-across-modes-generation',
  });
  assert.equal(oldestAcrossModesRecovery.nextProbeSermonId, 'older-browser');
  assert.equal(
    (oldestAcrossModesStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>).probeMode,
    'browser_fallback'
  );

  const concurrentRecoveryEntry = {
    sermonId: 'concurrent-during-recovery',
    payload: { ...youtubePayload, id: 'concurrent-during-recovery' },
    requestVersion: 'concurrent-recovery-version',
    deferredAt: '2026-08-24T00:00:00.000Z',
    reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
    disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
    dependencyScope: 'authenticated_session' as const,
    probeMode: 'cookie_provider' as const,
    blockerEpisodeId: 'concurrent-recovery-episode',
    lastFailureClass: 'cookie_session_stale_or_challenged',
    attemptCount: 1,
  };
  const concurrentDeferralDuringRecoveryStore = createMockDatabase(
    {
      'processAudioQueues/youtube/state': {
        blocked: false,
        probeStatus: 'waiting_for_auth_required_request',
        deferredYouTubeTaskCount: 1,
      },
      'processAudioQueues/youtube/deferred/sermon-123': {
        sermonId: 'sermon-123',
        payload: youtubePayload,
        requestVersion: 'concurrent-recovery-probe-version',
        deferredAt: '2026-08-23T20:00:00.000Z',
        reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        dependencyScope: 'authenticated_session',
        probeMode: 'cookie_provider',
        blockerEpisodeId: 'original-recovery-episode',
        lastFailureClass: 'cookie_session_stale_or_challenged',
        attemptCount: 1,
      },
    },
    [],
    {
      'processAudioQueues/youtube/state': [
        (store) => {
          store['processAudioQueues/youtube/state'] = {
            ...(store['processAudioQueues/youtube/state'] as Record<string, unknown>),
            blockerEpisodeId: 'concurrent-recovery-episode',
            alertSentAt: '2026-08-24T00:00:00.000Z',
            alertReservationId: 'concurrent-recovery-reservation',
            deferredYouTubeTaskCount: 2,
          };
          store['processAudioQueues/youtube/deferred/concurrent-during-recovery'] = concurrentRecoveryEntry;
        },
      ],
    }
  );
  await resumeDeferredYouTubeQueueOnStartup({
    database: concurrentDeferralDuringRecoveryStore as any,
    authenticatedRecoveryGeneration: 'concurrent-deferral-recovery-generation',
  });
  const concurrentRecoveryQueueState = concurrentDeferralDuringRecoveryStore.store[
    'processAudioQueues/youtube/state'
  ] as Record<string, unknown>;
  assert.equal(concurrentRecoveryQueueState.deferredYouTubeTaskCount, 1);
  assert.equal(concurrentRecoveryQueueState.blockerEpisodeId, 'concurrent-recovery-episode');
  assert.equal(concurrentRecoveryQueueState.alertSentAt, '2026-08-24T00:00:00.000Z');
  assert.equal(concurrentRecoveryQueueState.alertReservationId, 'concurrent-recovery-reservation');
  assert.notEqual(
    concurrentDeferralDuringRecoveryStore.store['processAudioQueues/youtube/deferred/concurrent-during-recovery'],
    undefined,
    'a concurrent deferral must survive authenticated recovery state advancement'
  );
  setCloudTasksApiDepsForTesting(null);
  setProcessAudioTaskQueueFactoryForTesting(null);

  const buildProbeSuccessStore = (
    beforeTransactionOnceFor: Record<string, Array<(store: Record<string, unknown>) => void>> = {},
    beforeGetOnceFor: Record<string, Array<(store: Record<string, unknown>) => void>> = {}
  ) =>
    createMockDatabase(
      {
        'processAudioQueues/youtube/state': {
          blocked: false,
          blockerReason: null,
          probeMode: 'cookie_provider',
          probeStatus: 'probing',
          probeTaskSermonId: 'sermon-123',
          probeRequestVersion: 'probe-version',
          probeStartedAt: new Date().toISOString(),
          deferredYouTubeTaskCount: 1,
        },
        'processAudioQueues/youtube/deferred/legacy-second': {
          sermonId: 'legacy-second',
          payload: legacySecondPayload,
          requestVersion: 'legacy-second-version',
          deferredAt: '2026-08-23T23:00:00.000Z',
          reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
          disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
          dependencyScope: 'authenticated_session',
          probeMode: 'cookie_provider',
          blockerEpisodeId: 'legacy-episode',
          lastFailureClass: 'cookie_session_stale_or_challenged',
          attemptCount: 1,
        },
        'processAudioRequests/sermon-123': {
          sermonId: 'sermon-123',
          sourceType: 'youtube',
          currentPayload: youtubePayload,
          currentRequestVersion: 'probe-version',
          queuedTaskId: 'probe-task',
          queuedAt: new Date().toISOString(),
          runningRequestId: 'probe-request',
          runningTaskId: 'probe-task',
          runningRequestVersion: 'probe-version',
          runningAt: new Date().toISOString(),
          nextPayload: null,
          nextRequestVersion: null,
          nextUpdatedAt: null,
          deferredAt: null,
          updatedAt: new Date().toISOString(),
        },
      },
      [],
      beforeTransactionOnceFor,
      beforeGetOnceFor
    );

  setProcessAudioTaskQueueFactoryForTesting(() => ({ async delete(): Promise<void> {} }));
  let probeDrainDispatchCount = 0;
  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'probe-token' }),
    fetchImpl: async () => {
      probeDrainDispatchCount += 1;
      return new Response('{}', { status: 200 });
    },
  });
  const guestProbeStore = buildProbeSuccessStore();
  await completeProcessAudioSuccess({
    database: guestProbeStore as any,
    payload: youtubePayload,
    requestId: 'probe-request',
    taskId: 'probe-task',
    ctx: { requestId: 'probe-request', youtubeSuccessfulAcquisitionAuthority: 'public_provider' },
  });
  assert.notEqual(
    guestProbeStore.store['processAudioQueues/youtube/deferred/legacy-second'],
    undefined,
    'guest-only success must retain authenticated deferrals'
  );
  assert.equal(probeDrainDispatchCount, 0);
  assert.equal(
    (guestProbeStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>).probeLastSucceededAt ?? null,
    null
  );

  const authenticatedProbeStore = buildProbeSuccessStore();
  await completeProcessAudioSuccess({
    database: authenticatedProbeStore as any,
    payload: youtubePayload,
    requestId: 'probe-request',
    taskId: 'probe-task',
    ctx: { requestId: 'probe-request', youtubeSuccessfulAcquisitionAuthority: 'cookie_provider' },
  });
  assert.equal(authenticatedProbeStore.store['processAudioQueues/youtube/deferred/legacy-second'], undefined);
  assert.equal(probeDrainDispatchCount, 1);
  const authenticatedProbeRequestState = authenticatedProbeStore.store['processAudioRequests/sermon-123'] as Record<
    string,
    unknown
  >;
  assert.equal(authenticatedProbeRequestState.lastSuccessfulYouTubeAcquisitionAuthority, 'cookie_provider');
  assert.equal(authenticatedProbeRequestState.lastSuccessfulYouTubeAcquisitionRequestVersion, 'probe-version');
  const successfulDrainQueueState = authenticatedProbeStore.store['processAudioQueues/youtube/state'] as Record<
    string,
    unknown
  >;
  assert.equal(successfulDrainQueueState.lastDrainOutcome, 'succeeded');
  assert.equal(successfulDrainQueueState.lastDrainAttemptedCount, 1);
  assert.equal(successfulDrainQueueState.lastDrainSucceededCount, 1);
  assert.equal(typeof successfulDrainQueueState.lastSuccessfulDrainAt, 'string');
  assert.equal(
    successfulDrainQueueState.lastSuccessfulDrainAt,
    successfulDrainQueueState.lastDrainAttemptedAt,
    'a fully successful drain must persist its own completion timestamp'
  );

  let lostDrainOwnershipDispatchCount = 0;
  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'lost-drain-token' }),
    fetchImpl: async () => {
      lostDrainOwnershipDispatchCount += 1;
      return new Response('{}', { status: 200 });
    },
  });
  const lostDrainOwnershipStore = buildProbeSuccessStore({
    'processAudioQueueClaims/legacy-second': [
      (store) => {
        store['processAudioQueues/youtube/state'] = {
          ...(store['processAudioQueues/youtube/state'] as Record<string, unknown>),
          probeStatus: 'probing',
          probeTaskSermonId: 'replacement-drain-owner',
          probeRequestVersion: 'replacement-drain-version',
          probeStartedAt: new Date().toISOString(),
          probeDispatchReservationId: 'replacement-drain-reservation',
        };
      },
    ],
  });
  await completeProcessAudioSuccess({
    database: lostDrainOwnershipStore as any,
    payload: youtubePayload,
    requestId: 'lost-drain-owner-request',
    taskId: 'probe-task',
    ctx: { requestId: 'lost-drain-owner-request', youtubeSuccessfulAcquisitionAuthority: 'cookie_provider' },
  });
  assert.equal(
    lostDrainOwnershipDispatchCount,
    0,
    'a successful probe must recheck drain ownership before each external task dispatch'
  );
  assert.notEqual(lostDrainOwnershipStore.store['processAudioQueues/youtube/deferred/legacy-second'], undefined);
  assert.equal(
    (lostDrainOwnershipStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>)
      .probeTaskSermonId,
    'replacement-drain-owner'
  );

  const tombstoneDrainOwnershipStore = buildProbeSuccessStore();
  let tombstoneDrainRequestCount = 0;
  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'tombstone-drain-token' }),
    fetchImpl: async () => {
      tombstoneDrainRequestCount += 1;
      if (tombstoneDrainRequestCount === 1) {
        return new Response('{"error":{"status":"ALREADY_EXISTS"}}', { status: 409 });
      }
      if (tombstoneDrainRequestCount === 2) {
        tombstoneDrainOwnershipStore.store['processAudioQueues/youtube/state'] = {
          ...(tombstoneDrainOwnershipStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>),
          probeStatus: 'probing',
          probeTaskSermonId: 'replacement-after-tombstone',
          probeRequestVersion: 'replacement-after-tombstone-version',
          probeStartedAt: new Date().toISOString(),
          probeDispatchReservationId: 'replacement-after-tombstone-reservation',
        };
        return new Response('{"error":{"status":"NOT_FOUND"}}', { status: 404 });
      }
      return new Response('{}', { status: 200 });
    },
  });
  await completeProcessAudioSuccess({
    database: tombstoneDrainOwnershipStore as any,
    payload: youtubePayload,
    requestId: 'tombstone-drain-owner-request',
    taskId: 'probe-task',
    ctx: { requestId: 'tombstone-drain-owner-request', youtubeSuccessfulAcquisitionAuthority: 'cookie_provider' },
  });
  assert.equal(
    tombstoneDrainRequestCount,
    2,
    'drain ownership must be rechecked before retrying a tombstoned Cloud Task generation'
  );
  assert.notEqual(
    tombstoneDrainOwnershipStore.store['processAudioQueues/youtube/deferred/legacy-second'],
    undefined
  );

  const persistedAuthorityRetryStore = buildProbeSuccessStore();
  persistedAuthorityRetryStore.store['processAudioRequests/sermon-123'] = {
    ...(persistedAuthorityRetryStore.store['processAudioRequests/sermon-123'] as Record<string, unknown>),
    runningRequestId: null,
    runningTaskId: null,
    runningRequestVersion: null,
    runningAt: null,
    lastSuccessfulYouTubeAcquisitionAuthority: 'browser_fallback',
    lastSuccessfulYouTubeAcquisitionRequestVersion: 'probe-version',
  };
  await completeProcessAudioSuccess({
    database: persistedAuthorityRetryStore as any,
    payload: youtubePayload,
    requestId: 'already-processed-retry',
    taskId: 'probe-task',
    ctx: { requestId: 'already-processed-retry' },
  });
  assert.equal(
    persistedAuthorityRetryStore.store['processAudioQueues/youtube/deferred/legacy-second'],
    undefined,
    'an idempotent PROCESSED retry must reuse matching durable authenticated acquisition evidence'
  );
  assert.equal(
    (persistedAuthorityRetryStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>)
      .lastDrainOutcome,
    'succeeded'
  );

  const missingAuthorityRetryStore = buildProbeSuccessStore();
  missingAuthorityRetryStore.store['processAudioRequests/sermon-123'] = {
    ...(missingAuthorityRetryStore.store['processAudioRequests/sermon-123'] as Record<string, unknown>),
    runningRequestId: null,
    runningTaskId: null,
    runningRequestVersion: null,
    runningAt: null,
  };
  await completeProcessAudioSuccess({
    database: missingAuthorityRetryStore as any,
    payload: youtubePayload,
    requestId: 'already-processed-missing-authority',
    taskId: 'probe-task',
    ctx: { requestId: 'already-processed-missing-authority' },
  });
  assert.equal(
    (missingAuthorityRetryStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>).probeStatus,
    'waiting_for_auth_required_request',
    'a successful result without authenticated authority must release, not strand or certify, the probe'
  );
  assert.notEqual(missingAuthorityRetryStore.store['processAudioQueues/youtube/deferred/legacy-second'], undefined);

  const alreadyProcessedAdvanceStore = buildProbeSuccessStore();
  alreadyProcessedAdvanceStore.store['processAudioQueues/youtube/state'] = {
    ...(alreadyProcessedAdvanceStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>),
    deferredYouTubeTaskCount: 2,
  };
  alreadyProcessedAdvanceStore.store['processAudioQueues/youtube/deferred/sermon-123'] = {
    sermonId: 'sermon-123',
    payload: youtubePayload,
    requestVersion: 'probe-version',
    deferredAt: '2026-08-23T22:00:00.000Z',
    reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
    disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
    dependencyScope: 'authenticated_session',
    probeMode: 'cookie_provider',
    blockerEpisodeId: 'lingering-self-episode',
    lastFailureClass: 'cookie_session_stale_or_challenged',
    attemptCount: 1,
  };
  alreadyProcessedAdvanceStore.store['processAudioRequests/sermon-123'] = {
    ...(alreadyProcessedAdvanceStore.store['processAudioRequests/sermon-123'] as Record<string, unknown>),
    runningRequestId: null,
    runningTaskId: null,
    runningRequestVersion: null,
    runningAt: null,
  };
  await completeProcessAudioSuccess({
    database: alreadyProcessedAdvanceStore as any,
    payload: youtubePayload,
    requestId: 'live-stuck-processed-probe-recovery',
    taskId: 'probe-task',
    ctx: { requestId: 'live-stuck-processed-probe-recovery' },
    alreadyProcessed: true,
  });
  const alreadyProcessedAdvanceQueueState = alreadyProcessedAdvanceStore.store[
    'processAudioQueues/youtube/state'
  ] as Record<string, unknown>;
  assert.equal(alreadyProcessedAdvanceQueueState.probeStatus, 'probing');
  assert.equal(alreadyProcessedAdvanceQueueState.probeTaskSermonId, 'legacy-second');
  assert.equal(alreadyProcessedAdvanceQueueState.probeRequestVersion, 'legacy-second-version');
  assert.equal(alreadyProcessedAdvanceQueueState.deferredYouTubeTaskCount, 0);
  assert.equal(
    alreadyProcessedAdvanceQueueState.probeLastSucceededAt ?? null,
    null,
    'an already-PROCESSED task without authority may advance recovery but must not certify auth'
  );
  assert.equal(
    alreadyProcessedAdvanceStore.store['processAudioQueues/youtube/deferred/legacy-second'],
    undefined,
    'the advanced probe is removed only after its Cloud Task is durably adopted'
  );
  assert.equal(
    alreadyProcessedAdvanceStore.store['processAudioQueues/youtube/deferred/sermon-123'],
    undefined,
    'an idempotent PROCESSED retry must remove, never redispatch, its own lingering deferred row'
  );

  let alreadyProcessedOwnershipRaceDispatchCount = 0;
  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'already-processed-race-token' }),
    fetchImpl: async () => {
      alreadyProcessedOwnershipRaceDispatchCount += 1;
      return new Response('{}', { status: 200 });
    },
  });
  const alreadyProcessedOwnershipRaceStore = buildProbeSuccessStore(
    {},
    {
      'processAudioQueues/youtube/state': [
        () => undefined,
        (store) => {
          store['processAudioQueues/youtube/state'] = {
            ...(store['processAudioQueues/youtube/state'] as Record<string, unknown>),
            probeTaskSermonId: 'concurrent-owner',
            probeRequestVersion: 'concurrent-version',
            probeStartedAt: new Date().toISOString(),
          };
        },
      ],
    }
  );
  alreadyProcessedOwnershipRaceStore.store['processAudioRequests/sermon-123'] = {
    ...(alreadyProcessedOwnershipRaceStore.store['processAudioRequests/sermon-123'] as Record<string, unknown>),
    runningRequestId: null,
    runningTaskId: null,
    runningRequestVersion: null,
    runningAt: null,
  };
  await completeProcessAudioSuccess({
    database: alreadyProcessedOwnershipRaceStore as any,
    payload: youtubePayload,
    requestId: 'already-processed-ownership-race',
    taskId: 'probe-task',
    ctx: { requestId: 'already-processed-ownership-race' },
    alreadyProcessed: true,
  });
  assert.equal(
    alreadyProcessedOwnershipRaceDispatchCount,
    0,
    'an idempotent completion that lost probe ownership must not dispatch a replacement probe'
  );
  assert.equal(
    (alreadyProcessedOwnershipRaceStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>)
      .probeTaskSermonId,
    'concurrent-owner'
  );
  assert.notEqual(
    alreadyProcessedOwnershipRaceStore.store['processAudioQueues/youtube/deferred/legacy-second'],
    undefined,
    'a lost idempotent-completion reservation must retain the deferred request'
  );

  const concurrentCompletionEntry = {
    sermonId: 'concurrent-during-completion',
    payload: { ...youtubePayload, id: 'concurrent-during-completion' },
    requestVersion: 'concurrent-completion-version',
    deferredAt: '2026-08-24T00:00:00.000Z',
    reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
    disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
    dependencyScope: 'authenticated_session' as const,
    probeMode: 'cookie_provider' as const,
    blockerEpisodeId: 'concurrent-completion-episode',
    lastFailureClass: 'cookie_session_stale_or_challenged',
    attemptCount: 1,
  };
  const concurrentCompletionStore = buildProbeSuccessStore({
    'processAudioQueues/youtube/state': [
      (store) => {
        store['processAudioQueues/youtube/state'] = {
          ...(store['processAudioQueues/youtube/state'] as Record<string, unknown>),
          blockerEpisodeId: 'concurrent-completion-episode',
          alertSentAt: '2026-08-24T00:00:00.000Z',
          alertReservationId: 'concurrent-completion-reservation',
          deferredYouTubeTaskCount: 2,
        };
        store['processAudioQueues/youtube/deferred/concurrent-during-completion'] = concurrentCompletionEntry;
      },
    ],
  });
  await completeProcessAudioSuccess({
    database: concurrentCompletionStore as any,
    payload: youtubePayload,
    requestId: 'probe-request',
    taskId: 'probe-task',
    ctx: { requestId: 'probe-request', youtubeSuccessfulAcquisitionAuthority: 'cookie_provider' },
  });
  const concurrentCompletionQueueState = concurrentCompletionStore.store['processAudioQueues/youtube/state'] as Record<
    string,
    unknown
  >;
  assert.equal(concurrentCompletionQueueState.deferredYouTubeTaskCount, 1);
  assert.equal(concurrentCompletionQueueState.blockerEpisodeId, 'concurrent-completion-episode');
  assert.equal(concurrentCompletionQueueState.alertSentAt, '2026-08-24T00:00:00.000Z');
  assert.equal(concurrentCompletionQueueState.alertReservationId, 'concurrent-completion-reservation');
  assert.notEqual(
    concurrentCompletionStore.store['processAudioQueues/youtube/deferred/concurrent-during-completion'],
    undefined,
    'a concurrent deferral must survive probe completion and draining of the earlier snapshot'
  );

  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'probe-token' }),
    fetchImpl: async () => new Response('{}', { status: 500 }),
  });
  const partiallyFailedDrainStore = buildProbeSuccessStore();
  await completeProcessAudioSuccess({
    database: partiallyFailedDrainStore as any,
    payload: youtubePayload,
    requestId: 'probe-request',
    taskId: 'probe-task',
    ctx: { requestId: 'probe-request', youtubeSuccessfulAcquisitionAuthority: 'browser_fallback' },
  });
  const partiallyFailedDrainQueueState = partiallyFailedDrainStore.store['processAudioQueues/youtube/state'] as Record<
    string,
    unknown
  >;
  assert.equal(typeof partiallyFailedDrainQueueState.probeLastSucceededAt, 'string');
  assert.equal(partiallyFailedDrainQueueState.lastDrainOutcome, 'partial_failure');
  assert.equal(partiallyFailedDrainQueueState.lastDrainAttemptedCount, 1);
  assert.equal(partiallyFailedDrainQueueState.lastDrainSucceededCount, 0);
  assert.equal(partiallyFailedDrainQueueState.lastSuccessfulDrainAt, null);
  assert.notEqual(
    partiallyFailedDrainStore.store['processAudioQueues/youtube/deferred/legacy-second'],
    undefined,
    'probe success must not imply that deferred dispatch succeeded'
  );
  setCloudTasksApiDepsForTesting(null);
  setProcessAudioTaskQueueFactoryForTesting(null);

  const staleProbePayload = {
    id: 'stale-probe-sermon',
    youtubeUrl: 'https://www.youtube.com/watch?v=staleProbe1',
    startTime: 0,
    duration: 120,
    deleteOriginal: false,
    skipTranscode: false,
  } as const;
  const staleProbeStore = createMockDatabase(
    {
      'processAudioQueues/youtube/state': {
        blocked: false,
        probeMode: 'cookie_provider',
        probeStatus: 'probing',
        probeTaskSermonId: 'stale-probe-sermon',
        probeRequestVersion: 'stale-version',
        probeStartedAt: '2026-08-23T00:00:00.000Z',
        deferredYouTubeTaskCount: 0,
      },
      'processAudioRequests/stale-probe-sermon': {
        sermonId: 'stale-probe-sermon',
        sourceType: 'youtube',
        currentPayload: staleProbePayload,
        currentRequestVersion: 'stale-version',
        queuedTaskId: 'missing-task',
        queuedAt: '2026-08-23T00:00:00.000Z',
        runningRequestId: null,
        runningTaskId: null,
        runningRequestVersion: null,
        runningAt: null,
        nextPayload: null,
        nextRequestVersion: null,
        nextUpdatedAt: null,
        deferredAt: null,
        updatedAt: '2026-08-23T00:00:00.000Z',
      },
    },
    [],
    {
      'processAudioQueues/youtube/state': [
        (store) => {
          store['processAudioQueues/youtube/state'] = {
            ...(store['processAudioQueues/youtube/state'] as Record<string, unknown>),
            blockerEpisodeId: 'stale-recovery-concurrent-episode',
            alertSentAt: '2026-08-23T00:01:00.000Z',
            alertReservationId: 'stale-recovery-concurrent-reservation',
            deferredYouTubeTaskCount: 1,
          };
          store['processAudioQueues/youtube/deferred/stale-recovery-concurrent'] = {
            sermonId: 'stale-recovery-concurrent',
            payload: { ...staleProbePayload, id: 'stale-recovery-concurrent' },
            requestVersion: 'stale-recovery-concurrent-version',
            deferredAt: '2026-08-23T00:01:00.000Z',
            reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
            disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
            dependencyScope: 'authenticated_session',
            probeMode: 'cookie_provider',
            blockerEpisodeId: 'stale-recovery-concurrent-episode',
            lastFailureClass: 'cookie_session_stale_or_challenged',
            attemptCount: 1,
          };
        },
      ],
    }
  );
  const staleRecovery = await recoverStaleYouTubeQueueProbe(staleProbeStore as any);
  assert.equal(staleRecovery.recovered, true);
  assert.equal(staleRecovery.deferredCount, 2);
  const staleRecoveryQueueState = staleProbeStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>;
  assert.equal(staleRecoveryQueueState.deferredYouTubeTaskCount, 2);
  assert.equal(staleRecoveryQueueState.blockerEpisodeId, 'stale-recovery-concurrent-episode');
  assert.equal(staleRecoveryQueueState.alertSentAt, '2026-08-23T00:01:00.000Z');
  assert.equal(staleRecoveryQueueState.alertReservationId, 'stale-recovery-concurrent-reservation');
  assert.deepEqual(staleProbeStore.store['processAudioQueues/youtube/deferred/stale-probe-sermon'], {
    sermonId: 'stale-probe-sermon',
    payload: staleProbePayload,
    requestVersion: 'stale-version',
    deferredAt: '2026-08-23T00:00:00.000Z',
    reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
    disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
    dependencyScope: 'authenticated_session',
    probeMode: 'cookie_provider',
    blockerEpisodeId: null,
    lastFailureClass: 'cookie_session_stale_or_challenged',
    lastFailureMessage: 'Recovered a stale YouTube probe that was no longer making progress.',
    attemptCount: 0,
  });

  const staleProbeAbaStore = createMockDatabase(
    {
      'processAudioQueues/youtube/state': {
        blocked: false,
        probeMode: 'cookie_provider',
        probeStatus: 'probing',
        probeTaskSermonId: 'stale-probe-sermon',
        probeRequestVersion: 'stale-version',
        probeStartedAt: '2026-08-23T00:00:00.000Z',
        probeDispatchReservationId: 'original-dispatch',
        deferredYouTubeTaskCount: 0,
      },
      'processAudioRequests/stale-probe-sermon': {
        sermonId: 'stale-probe-sermon',
        sourceType: 'youtube',
        currentPayload: staleProbePayload,
        currentRequestVersion: 'stale-version',
        queuedTaskId: 'replacement-live-task',
        queuedAt: '2026-08-23T00:00:00.000Z',
        runningRequestId: null,
        runningTaskId: null,
        runningRequestVersion: null,
        runningAt: null,
        nextPayload: null,
        nextRequestVersion: null,
        nextUpdatedAt: null,
        deferredAt: null,
        updatedAt: '2026-08-23T00:00:00.000Z',
      },
    },
    [],
    {
      'processAudioQueues/youtube/state': [
        (store) => {
          store['processAudioQueues/youtube/state'] = {
            ...(store['processAudioQueues/youtube/state'] as Record<string, unknown>),
            probeStartedAt: '2026-08-23T00:01:00.000Z',
            probeDispatchReservationId: 'replacement-dispatch',
          };
        },
      ],
    }
  );
  const staleAbaRecovery = await recoverStaleYouTubeQueueProbe(staleProbeAbaStore as any);
  assert.equal(staleAbaRecovery.recovered, false);
  const staleAbaQueueState = staleProbeAbaStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>;
  assert.equal(staleAbaQueueState.probeStatus, 'probing');
  assert.equal(staleAbaQueueState.probeStartedAt, '2026-08-23T00:01:00.000Z');
  assert.equal(staleAbaQueueState.probeDispatchReservationId, 'replacement-dispatch');
  assert.equal(
    (staleProbeAbaStore.store['processAudioRequests/stale-probe-sermon'] as Record<string, unknown>).queuedTaskId,
    'replacement-live-task',
    'stale recovery must not clear a same-version probe whose dispatch identity changed'
  );
  assert.equal(staleProbeAbaStore.store['processAudioQueues/youtube/deferred/stale-probe-sermon'], undefined);

  const staleProbeNewGenerationStore = createMockDatabase({
    'processAudioQueues/youtube/state': {
      blocked: false,
      probeMode: 'cookie_provider',
      probeStatus: 'probing',
      probeTaskSermonId: 'stale-probe-sermon',
      probeRequestVersion: 'stale-version',
      probeStartedAt: '2026-08-23T00:00:00.000Z',
      probeDispatchReservationId: 'stale-generation-reservation',
      deferredYouTubeTaskCount: 0,
    },
    'processAudioRequests/stale-probe-sermon': {
      sermonId: 'stale-probe-sermon',
      sourceType: 'youtube',
      currentPayload: { ...staleProbePayload, duration: 121 },
      currentRequestVersion: 'new-live-version',
      queuedTaskId: 'new-live-task',
      queuedAt: '2026-08-23T00:02:00.000Z',
      runningRequestId: null,
      runningTaskId: null,
      runningRequestVersion: null,
      runningAt: null,
      nextPayload: null,
      nextRequestVersion: null,
      nextUpdatedAt: null,
      deferredAt: null,
      updatedAt: '2026-08-23T00:02:00.000Z',
    },
  });
  const staleNewGenerationRecovery = await recoverStaleYouTubeQueueProbe(staleProbeNewGenerationStore as any);
  assert.equal(staleNewGenerationRecovery.recovered, true);
  assert.equal(
    (staleProbeNewGenerationStore.store['processAudioRequests/stale-probe-sermon'] as Record<string, unknown>)
      .queuedTaskId,
    'new-live-task',
    'stale probe recovery must not clear a newer request generation for the same sermon'
  );
  assert.equal(
    staleProbeNewGenerationStore.store['processAudioQueues/youtube/deferred/stale-probe-sermon'],
    undefined
  );

  let functionsProbeEnqueueCount = 0;
  setYouTubeTaskQueueFactoryForTesting(
    () =>
      ({
        async delete(): Promise<void> {},
        async enqueue(): Promise<void> {
          functionsProbeEnqueueCount += 1;
        },
      }) as any
  );
  const noCandidateActiveProbeStore = createMockDatabase({
    'processAudioQueues/youtube/state': {
      blocked: false,
      probeMode: 'cookie_provider',
      probeStatus: 'probing',
      probeTaskSermonId: 'active-functions-probe',
      probeRequestVersion: 'active-functions-version',
      probeStartedAt: new Date().toISOString(),
      probeDispatchReservationId: 'active-functions-reservation',
      deferredYouTubeTaskCount: 0,
    },
  });
  await beginYouTubeQueueProbe({
    database: noCandidateActiveProbeStore as any,
    targetUri: 'https://example.com/process-audio',
    ownerId: 'functions-no-candidate',
    probeMode: 'cookie_provider',
  });
  const noCandidateActiveState = noCandidateActiveProbeStore.store[
    'processAudioQueues/youtube/state'
  ] as Record<string, unknown>;
  assert.equal(noCandidateActiveState.probeTaskSermonId, 'active-functions-probe');
  assert.equal(noCandidateActiveState.probeDispatchReservationId, 'active-functions-reservation');

  const noCandidateConcurrentDeferralStore = createMockDatabase(
    {
      'processAudioQueues/youtube/state': {
        blocked: false,
        probeMode: null,
        probeStatus: 'idle',
        probeTaskSermonId: null,
        probeRequestVersion: null,
        probeStartedAt: null,
        probeDispatchReservationId: null,
        deferredYouTubeTaskCount: 0,
      },
    },
    [],
    {},
    {
      'processAudioQueues/youtube/state': [
        (store) => {
          store['processAudioQueues/youtube/state'] = {
            ...(store['processAudioQueues/youtube/state'] as Record<string, unknown>),
            probeStatus: 'waiting_for_auth_required_request',
            deferredYouTubeTaskCount: 1,
          };
          store['processAudioQueues/youtube/deferred/late-functions-deferral'] = {
            sermonId: 'late-functions-deferral',
            payload: { ...youtubePayload, id: 'late-functions-deferral' },
            requestVersion: 'late-functions-version',
            deferredAt: new Date().toISOString(),
            reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
            disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
            dependencyScope: 'authenticated_session',
            probeMode: 'cookie_provider',
            blockerEpisodeId: 'late-functions-episode',
            lastFailureClass: 'cookie_session_stale_or_challenged',
            attemptCount: 1,
          };
        },
      ],
    }
  );
  await beginYouTubeQueueProbe({
    database: noCandidateConcurrentDeferralStore as any,
    targetUri: 'https://example.com/process-audio',
    ownerId: 'functions-late-deferral',
    probeMode: 'cookie_provider',
  });
  assert.equal(
    (noCandidateConcurrentDeferralStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>)
      .probeStatus,
    'waiting_for_auth_required_request'
  );
  assert.notEqual(
    noCandidateConcurrentDeferralStore.store['processAudioQueues/youtube/deferred/late-functions-deferral'],
    undefined
  );

  const functionsProbeRaceStore = createMockDatabase(
    {
      'processAudioQueues/youtube/state': {
        blocked: false,
        probeMode: null,
        probeStatus: 'waiting_for_auth_required_request',
        probeTaskSermonId: null,
        probeRequestVersion: null,
        probeStartedAt: null,
        probeDispatchReservationId: null,
        deferredYouTubeTaskCount: 1,
      },
      'processAudioQueues/youtube/deferred/functions-candidate': {
        sermonId: 'functions-candidate',
        payload: { ...youtubePayload, id: 'functions-candidate' },
        requestVersion: 'functions-candidate-version',
        deferredAt: '2026-08-23T00:00:00.000Z',
        reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        dependencyScope: 'authenticated_session',
        probeMode: 'cookie_provider',
        blockerEpisodeId: 'functions-candidate-episode',
        lastFailureClass: 'cookie_session_stale_or_challenged',
        attemptCount: 1,
      },
    },
    [],
    {
      'processAudioQueues/youtube/state': [
        (store) => {
          store['processAudioQueues/youtube/state'] = {
            ...(store['processAudioQueues/youtube/state'] as Record<string, unknown>),
            probeMode: 'browser_fallback',
            probeStatus: 'probing',
            probeTaskSermonId: 'replacement-functions-owner',
            probeRequestVersion: 'replacement-functions-version',
            probeStartedAt: new Date().toISOString(),
            probeDispatchReservationId: 'replacement-functions-reservation',
          };
        },
      ],
    }
  );
  await beginYouTubeQueueProbe({
    database: functionsProbeRaceStore as any,
    targetUri: 'https://example.com/process-audio',
    ownerId: 'functions-probe-race',
    probeMode: 'cookie_provider',
  });
  assert.equal(functionsProbeEnqueueCount, 0, 'Functions recovery must reserve queue ownership before enqueueing');
  const functionsProbeRaceState = functionsProbeRaceStore.store[
    'processAudioQueues/youtube/state'
  ] as Record<string, unknown>;
  assert.equal(functionsProbeRaceState.probeTaskSermonId, 'replacement-functions-owner');
  assert.equal(functionsProbeRaceState.probeDispatchReservationId, 'replacement-functions-reservation');
  assert.notEqual(
    functionsProbeRaceStore.store['processAudioQueues/youtube/deferred/functions-candidate'],
    undefined
  );

  const functionsCandidateReplacementStore = createMockDatabase(
    {
      'processAudioQueues/youtube/state': {
        blocked: false,
        probeMode: null,
        probeStatus: 'waiting_for_auth_required_request',
        probeTaskSermonId: null,
        probeRequestVersion: null,
        probeStartedAt: null,
        probeDispatchReservationId: null,
        deferredYouTubeTaskCount: 1,
      },
      'processAudioQueues/youtube/deferred/functions-original': {
        sermonId: 'functions-original',
        payload: { ...youtubePayload, id: 'functions-original' },
        requestVersion: 'functions-original-version',
        deferredAt: '2026-08-23T00:00:00.000Z',
        reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        dependencyScope: 'authenticated_session',
        probeMode: 'cookie_provider',
        blockerEpisodeId: 'functions-original-episode',
        lastFailureClass: 'cookie_session_stale_or_challenged',
        attemptCount: 1,
      },
    },
    [],
    {
      'processAudioQueueClaims/functions-original': [
        (store) => {
          delete store['processAudioQueues/youtube/deferred/functions-original'];
          store['processAudioQueues/youtube/deferred/functions-replacement'] = {
            sermonId: 'functions-replacement',
            payload: { ...youtubePayload, id: 'functions-replacement' },
            requestVersion: 'functions-replacement-version',
            deferredAt: '2026-08-22T23:59:00.000Z',
            reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
            disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
            dependencyScope: 'authenticated_session',
            probeMode: 'cookie_provider',
            blockerEpisodeId: 'functions-replacement-episode',
            lastFailureClass: 'cookie_session_stale_or_challenged',
            attemptCount: 1,
          };
        },
      ],
    }
  );
  await beginYouTubeQueueProbe({
    database: functionsCandidateReplacementStore as any,
    targetUri: 'https://example.com/process-audio',
    ownerId: 'functions-candidate-replaced',
    probeMode: 'cookie_provider',
  });
  assert.equal(functionsProbeEnqueueCount, 0);
  assert.notEqual(
    functionsCandidateReplacementStore.store['processAudioQueues/youtube/deferred/functions-replacement'],
    undefined
  );
  setYouTubeTaskQueueFactoryForTesting(null);

  const deletedProbeStore = createMockDatabase(
    {
      'processAudioQueues/youtube/state': {
        blocked: false,
        probeMode: 'cookie_provider',
        probeStatus: 'probing',
        probeTaskSermonId: 'sermon-123',
        probeRequestVersion: 'deleted-probe-version',
        probeStartedAt: '2026-08-23T00:00:00.000Z',
        deferredYouTubeTaskCount: 2,
      },
      'processAudioQueues/youtube/deferred/sermon-123': {
        sermonId: 'sermon-123',
        payload: youtubePayload,
        requestVersion: 'deleted-probe-version',
        deferredAt: '2026-08-23T00:00:00.000Z',
        reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        dependencyScope: 'authenticated_session',
        probeMode: 'cookie_provider',
        blockerEpisodeId: 'deleted-original-episode',
        lastFailureClass: 'cookie_session_stale_or_challenged',
        attemptCount: 1,
      },
      'processAudioQueues/youtube/deferred/deleted-next': {
        sermonId: 'deleted-next',
        payload: { ...youtubePayload, id: 'deleted-next' },
        requestVersion: 'deleted-next-version',
        deferredAt: '2026-08-23T00:01:00.000Z',
        reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        dependencyScope: 'authenticated_session',
        probeMode: 'cookie_provider',
        blockerEpisodeId: 'deleted-original-episode',
        lastFailureClass: 'cookie_session_stale_or_challenged',
        attemptCount: 1,
      },
      'processAudioRequests/sermon-123': {
        sermonId: 'sermon-123',
        sourceType: 'youtube',
        currentPayload: youtubePayload,
        currentRequestVersion: 'deleted-probe-version',
        queuedTaskId: 'deleted-active-task',
        queuedAt: '2026-08-23T00:00:00.000Z',
        runningRequestId: null,
        runningTaskId: null,
        runningRequestVersion: null,
        runningAt: null,
        nextPayload: null,
        nextRequestVersion: null,
        nextUpdatedAt: null,
        deferredAt: null,
        updatedAt: '2026-08-23T00:00:00.000Z',
      },
    },
    [],
    {
      'processAudioQueueClaims/deleted-next': [
        (store) => {
          store['processAudioQueues/youtube/state'] = {
            ...(store['processAudioQueues/youtube/state'] as Record<string, unknown>),
            probeTaskSermonId: 'replacement-owner',
            probeRequestVersion: 'replacement-owner-version',
            probeStartedAt: '2026-08-23T00:02:00.000Z',
            probeDispatchReservationId: 'replacement-owner-reservation',
            blockerEpisodeId: 'deleted-concurrent-episode',
            alertSentAt: '2026-08-23T00:02:00.000Z',
            alertReservationId: 'deleted-concurrent-reservation',
            deferredYouTubeTaskCount: 3,
          };
          store['processAudioQueues/youtube/deferred/deleted-concurrent'] = {
            sermonId: 'deleted-concurrent',
            payload: { ...youtubePayload, id: 'deleted-concurrent' },
            requestVersion: 'deleted-concurrent-version',
            deferredAt: '2026-08-23T00:02:00.000Z',
            reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
            disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
            dependencyScope: 'authenticated_session',
            probeMode: 'cookie_provider',
            blockerEpisodeId: 'deleted-concurrent-episode',
            lastFailureClass: 'cookie_session_stale_or_challenged',
            attemptCount: 1,
          };
        },
      ],
    }
  );
  setProcessAudioTaskQueueFactoryForTesting(() => ({ async delete(): Promise<void> {} }));
  let deletedCleanupCreateCalls = 0;
  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'deleted-cleanup-token' }),
    fetchImpl: async () => {
      deletedCleanupCreateCalls += 1;
      return new Response('{}', { status: 200 });
    },
  });
  const deletedCleanupResult = await cleanupDeletedSermonProcessAudioState({
    database: deletedProbeStore as any,
    payload: youtubePayload,
    requestId: 'deleted-cleanup-request',
    taskId: 'deleted-active-task',
  });
  assert.equal(deletedCleanupResult.advancedProbe, false);
  assert.equal(deletedCleanupCreateCalls, 0, 'deleted cleanup must reserve ownership before creating a task');
  const deletedQueueState = deletedProbeStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>;
  assert.equal(deletedQueueState.probeTaskSermonId, 'replacement-owner');
  assert.equal(deletedQueueState.probeRequestVersion, 'replacement-owner-version');
  assert.equal(deletedQueueState.probeDispatchReservationId, 'replacement-owner-reservation');
  assert.equal(deletedQueueState.deferredYouTubeTaskCount, 3);
  assert.equal(deletedQueueState.blockerEpisodeId, 'deleted-concurrent-episode');
  assert.equal(deletedQueueState.alertSentAt, '2026-08-23T00:02:00.000Z');
  assert.equal(deletedQueueState.alertReservationId, 'deleted-concurrent-reservation');
  assert.notEqual(
    deletedProbeStore.store['processAudioQueues/youtube/deferred/deleted-concurrent'],
    undefined,
    'deleted-sermon probe advancement must preserve a concurrent authentication deferral'
  );
  setCloudTasksApiDepsForTesting(null);
  setProcessAudioTaskQueueFactoryForTesting(null);

  const authDeferredStore = createMockDatabase({
    'processAudioQueues/youtube/state': {
      blocked: true,
      blockerReason: 'cookie_session_stale_or_challenged',
      probeMode: 'cookie_provider',
      probeStatus: 'blocked',
      deferredYouTubeTaskCount: 1,
    },
    'processAudioQueues/youtube/deferred/sermon-123': {
      sermonId: 'sermon-123',
      payload: youtubePayload,
      requestVersion: 'legacy-version',
      deferredAt: '2026-08-23T22:07:10.842Z',
      reason: 'cookie_session_stale_or_challenged',
      probeMode: 'cookie_provider',
      blockerEpisodeId: 'legacy-episode',
      lastFailureClass: 'cookie_session_stale_or_challenged',
    },
  });
  const firstAuthDeferral = await deferYouTubeRequestForAuthentication({
    database: authDeferredStore as any,
    payload: youtubePayload,
    requestId: 'auth-request-1',
    failureClass: 'account_required_content',
    failureMessage: 'LOGIN_REQUIRED',
  });
  assert.equal(firstAuthDeferral.shouldAlert, true);
  assert.equal(firstAuthDeferral.attemptCount, 1);
  assert.deepEqual(authDeferredStore.store['processAudioQueues/youtube/deferred/sermon-123'], {
    sermonId: 'sermon-123',
    payload: {
      ...youtubePayload,
      deleteOriginal: false,
      skipTranscode: false,
    },
    requestVersion: 'legacy-version',
    deferredAt: '2026-08-23T22:07:10.842Z',
    reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
    disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
    dependencyScope: 'authenticated_session',
    probeMode: 'cookie_provider',
    blockerEpisodeId: 'legacy-episode',
    lastFailureClass: 'account_required_content',
    lastFailureMessage: 'LOGIN_REQUIRED',
    attemptCount: 1,
    dispatchGeneration: 0,
  });
  assert.equal((authDeferredStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>).blocked, false);
  const repeatedAuthDeferral = await deferYouTubeRequestForAuthentication({
    database: authDeferredStore as any,
    payload: youtubePayload,
    requestId: 'auth-request-2',
    failureClass: 'cookie_session_stale_or_challenged',
    failureMessage: 'LOGIN_REQUIRED_AGAIN',
  });
  assert.equal(repeatedAuthDeferral.shouldAlert, false);
  assert.equal(repeatedAuthDeferral.attemptCount, 2);
  assert.equal(
    await releaseYouTubeAuthAlertReservation({
      database: authDeferredStore as any,
      blockerEpisodeId: firstAuthDeferral.blockerEpisodeId ?? '',
      alertReservationId: 'another-request-reservation',
    }),
    false
  );
  assert.equal(
    await releaseYouTubeAuthAlertReservation({
      database: authDeferredStore as any,
      blockerEpisodeId: firstAuthDeferral.blockerEpisodeId ?? '',
      alertReservationId: firstAuthDeferral.alertReservationId ?? '',
    }),
    true
  );
  const authDeferralAfterFailedAlert = await deferYouTubeRequestForAuthentication({
    database: authDeferredStore as any,
    payload: youtubePayload,
    requestId: 'auth-request-3',
    failureClass: 'cookie_session_stale_or_challenged',
    failureMessage: 'LOGIN_REQUIRED_AFTER_ALERT_FAILURE',
  });
  assert.equal(authDeferralAfterFailedAlert.shouldAlert, true);

  const persistenceFailureStore = createMockDatabase({}, ['processAudioRequests/sermon-123']);
  await assert.rejects(
    deferYouTubeRequestForAuthentication({
      database: persistenceFailureStore as any,
      payload: youtubePayload,
      requestId: 'persistence-failure-request',
      failureClass: 'cookie_session_stale_or_challenged',
      failureMessage: 'AUTH_REQUIRED_BEFORE_PERSISTENCE_FAILURE',
    }),
    /Injected set failure/
  );
  const queueAfterPersistenceFailure = persistenceFailureStore.store['processAudioQueues/youtube/state'] as Record<
    string,
    unknown
  >;
  assert.equal(queueAfterPersistenceFailure.alertSentAt, null);
  assert.equal(queueAfterPersistenceFailure.alertReservationId, null);
  const retryAfterPersistenceFailure = await deferYouTubeRequestForAuthentication({
    database: persistenceFailureStore as any,
    payload: youtubePayload,
    requestId: 'persistence-retry-request',
    failureClass: 'cookie_session_stale_or_challenged',
    failureMessage: 'AUTH_REQUIRED_AFTER_PERSISTENCE_FAILURE',
  });
  assert.equal(retryAfterPersistenceFailure.shouldAlert, true);

  const concurrentDeferralStore = createMockDatabase();
  await Promise.all([
    deferYouTubeRequestForAuthentication({
      database: concurrentDeferralStore as any,
      payload: youtubePayload,
      requestId: 'concurrent-deferral-1',
      failureClass: 'cookie_session_stale_or_challenged',
      failureMessage: 'AUTH_REQUIRED_ONE',
    }),
    deferYouTubeRequestForAuthentication({
      database: concurrentDeferralStore as any,
      payload: legacySecondPayload,
      requestId: 'concurrent-deferral-2',
      failureClass: 'cookie_session_stale_or_challenged',
      failureMessage: 'AUTH_REQUIRED_TWO',
    }),
  ]);
  assert.equal(
    (concurrentDeferralStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>)
      .deferredYouTubeTaskCount,
    2,
    'concurrent per-sermon deferrals must atomically increment the shared authenticated queue count'
  );

  process.env.YOUTUBE_AUTH_DEFER_MAX_ATTEMPTS = '2';
  const terminalAuthStore = createMockDatabase({
    'processAudioQueues/youtube/state': {
      blocked: false,
      probeStatus: 'waiting_for_auth_required_request',
      deferredYouTubeTaskCount: 0,
    },
    'processAudioRequests/sermon-123': {
      sermonId: 'sermon-123',
      sourceType: 'youtube',
      currentPayload: youtubePayload,
      currentRequestVersion: 'terminal-version',
      queuedTaskId: 'terminal-task',
      queuedAt: new Date().toISOString(),
      runningRequestId: 'terminal-request',
      runningTaskId: 'terminal-task',
      runningRequestVersion: 'terminal-version',
      runningAt: new Date().toISOString(),
      nextPayload: null,
      nextRequestVersion: null,
      nextUpdatedAt: null,
      deferredAt: null,
      authenticatedDeferralAttemptCount: 1,
      updatedAt: new Date().toISOString(),
    },
  });
  const terminalAuthDeferral = await deferYouTubeRequestForAuthentication({
    database: terminalAuthStore as any,
    payload: youtubePayload,
    requestId: 'terminal-request',
    failureClass: 'account_required_content',
    failureMessage: 'Authenticated account cannot access this content.',
  });
  assert.deepEqual(terminalAuthDeferral, {
    deferred: false,
    terminal: true,
    attemptCount: 2,
    maxAttemptCount: 2,
    shouldAlert: true,
    blockerEpisodeId: null,
    alertReservationId: null,
  });
  assert.equal(terminalAuthStore.store['processAudioQueues/youtube/deferred/sermon-123'], undefined);
  delete process.env.YOUTUBE_AUTH_DEFER_MAX_ATTEMPTS;

  const request = buildCloudTasksCreateTaskRequest({
    payload: youtubePayload,
    queueName: 'processaudioyoutubetask',
    taskId: 'pa-test-task',
    projectId: 'urm-app',
    location: 'us-central1',
  });

  assert.equal(
    request.url,
    'https://cloudtasks.googleapis.com/v2/projects/urm-app/locations/us-central1/queues/processaudioyoutubetask/tasks'
  );
  assert.equal(
    request.taskName,
    'projects/urm-app/locations/us-central1/queues/processaudioyoutubetask/tasks/pa-test-task'
  );
  assert.equal(
    request.inspectionUrl,
    'https://cloudtasks.googleapis.com/v2/projects/urm-app/locations/us-central1/queues/processaudioyoutubetask/tasks/pa-test-task'
  );

  const parsedBody = JSON.parse(request.init.body) as {
    task: {
      name: string;
      scheduleTime?: string;
      dispatchDeadline: string;
      httpRequest: {
        httpMethod: string;
        url: string;
        headers: Record<string, string>;
        body: string;
      };
    };
  };

  assert.equal(
    parsedBody.task.name,
    'projects/urm-app/locations/us-central1/queues/processaudioyoutubetask/tasks/pa-test-task'
  );
  assert.equal(parsedBody.task.dispatchDeadline, '1800s');
  assert.equal(parsedBody.task.httpRequest.httpMethod, 'POST');
  assert.equal(parsedBody.task.httpRequest.url, 'https://yt-worker.upperroommedia.org/process-audio');
  assert.deepEqual(parsedBody.task.httpRequest.headers, {
    'Content-Type': 'application/json',
  });
  assert.deepEqual(JSON.parse(Buffer.from(parsedBody.task.httpRequest.body, 'base64').toString('utf8')), {
    data: {
      id: 'sermon-123',
      startTime: 12,
      duration: 345,
      deleteOriginal: false,
      skipTranscode: false,
      youtubeUrl: 'https://www.youtube.com/watch?v=dKaZ89SkVYY',
    },
  });
  assert.equal(parsedBody.task.scheduleTime, undefined);

  const scheduledRequest = buildCloudTasksCreateTaskRequest({
    payload: youtubePayload,
    queueName: 'processaudioyoutubetask',
    taskId: 'pa-test-task-scheduled',
    projectId: 'urm-app',
    location: 'us-central1',
    scheduledFor: new Date('2026-05-10T20:30:00.000Z'),
  });
  const scheduledBody = JSON.parse(scheduledRequest.init.body) as {
    task: {
      scheduleTime?: string;
    };
  };
  assert.equal(scheduledBody.task.scheduleTime, '2026-05-10T20:30:00.000Z');
  assert.equal(getPostLiveArchiveRetryDelaySeconds(1), 30 * 60);
  assert.equal(getPostLiveArchiveRetryDelaySeconds(3), 2 * 60 * 60);
  assert.equal(getPostLiveArchiveRetryDelaySeconds(50), 6 * 60 * 60);

  let fetchUrl: string | undefined;
  let fetchInit: RequestInit | undefined;

  await enqueueTaskViaCloudTasksApi(youtubePayload, 'processaudioyoutubetask', 'pa-test-task', {
    authFactory: async () => ({
      getAccessToken: async () => 'test-token',
    }),
    fetchImpl: async (url, init) => {
      fetchUrl = String(url);
      fetchInit = init;
      return new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    },
  });

  assert.equal(fetchUrl, request.url);
  assert.equal(fetchInit?.method, 'POST');
  assert.ok(fetchInit);
  assert.equal((fetchInit?.headers as Record<string, string>).Authorization, 'Bearer test-token');
  assert.equal((fetchInit?.headers as Record<string, string>)['Content-Type'], 'application/json');

  fetchUrl = undefined;
  fetchInit = undefined;
  let secondAuthorizationHeader: string | undefined;

  await enqueueTaskViaCloudTasksApi(youtubePayload, 'processaudioyoutubetask', 'pa-test-task', {
    authFactory: async () => ({
      getAccessToken: async () => ({ token: 'object-token' }),
    }),
    fetchImpl: async (url, init) => {
      fetchUrl = String(url);
      fetchInit = init;
      secondAuthorizationHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    },
  });

  assert.equal(fetchUrl, request.url);
  assert.ok(fetchInit);
  assert.equal(secondAuthorizationHeader, 'Bearer object-token');
  assert.equal(normalizeCloudTasksAccessToken({ token: '  object-token  ' }), 'object-token');
  assert.equal(normalizeCloudTasksAccessToken({}), null);

  const duplicateTaskRequest = buildCloudTasksCreateTaskRequest({
    payload: youtubePayload,
    queueName: 'processaudioyoutubetask',
    taskId: 'pa-existing-task',
  });
  let liveDuplicateRequestCount = 0;
  await enqueueTaskViaCloudTasksApi(youtubePayload, 'processaudioyoutubetask', 'pa-existing-task', {
    authFactory: async () => ({
      getAccessToken: async () => 'test-token',
    }),
    fetchImpl: async () => {
      liveDuplicateRequestCount += 1;
      return liveDuplicateRequestCount === 1
        ? new Response('{"error":{"status":"ALREADY_EXISTS"}}', {
            status: 409,
            statusText: 'Conflict',
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(JSON.stringify({ name: JSON.parse(duplicateTaskRequest.init.body).task.name }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
    },
  });
  assert.equal(liveDuplicateRequestCount, 2);

  let tombstoneRequestCount = 0;
  await assert.rejects(
    enqueueTaskViaCloudTasksApi(youtubePayload, 'processaudioyoutubetask', 'pa-tombstoned-task', {
      authFactory: async () => ({ getAccessToken: async () => 'test-token' }),
      fetchImpl: async () => {
        tombstoneRequestCount += 1;
        return tombstoneRequestCount === 1
          ? new Response('{"error":{"status":"CONFLICT"}}', { status: 409 })
          : new Response('{"error":{"status":"NOT_FOUND"}}', { status: 404 });
      },
    }),
    CloudTaskNameTombstonedError
  );
  assert.equal(tombstoneRequestCount, 2);

  const createdTasks: Array<{ url: string; body: { task: { name: string; scheduleTime?: string } } }> = [];
  await enqueueTaskViaCloudTasksApi(
    youtubePayload,
    'processaudioyoutubetask',
    'pa-scheduled-post-live',
    {
      authFactory: async () => ({
        getAccessToken: async () => 'scheduled-token',
      }),
      fetchImpl: async (url, init) => {
        createdTasks.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return new Response('{}', {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        });
      },
    },
    { scheduledFor: new Date('2026-05-10T21:00:00.000Z') }
  );
  assert.equal(createdTasks[0]?.body.task.scheduleTime, '2026-05-10T21:00:00.000Z');

  const runPostLiveDeferralCase = async (options: { taskDeleteThrows: boolean }) => {
    const deletedTaskIds: string[] = [];
    setProcessAudioTaskQueueFactoryForTesting(() => ({
      async delete(taskId: string): Promise<void> {
        deletedTaskIds.push(taskId);
        if (options.taskDeleteThrows && taskId === 'next-old-task') {
          throw new Error('simulated next probe enqueue failure');
        }
      },
    }));

    const postLiveStore = createMockDatabase(
      {
        'processAudioQueues/youtube/state': {
          blocked: false,
          blockerReason: null,
          blockedAt: null,
          blockerEpisodeId: null,
          probeMode: 'cookie_provider',
          probeStatus: 'probing',
          probeTaskSermonId: 'sermon-123',
          probeRequestVersion: 'current-version',
          probeStartedAt: '2026-05-10T19:00:00.000Z',
          probeLastSucceededAt: null,
          probeLastFailedAt: null,
          probeLastFailureClass: null,
          probeLastFailureMessage: null,
          alertSentAt: null,
          deferredYouTubeTaskCount: 2,
        },
        'processAudioQueues/youtube/deferred/sermon-123': {
          sermonId: 'sermon-123',
          payload: youtubePayload,
          requestVersion: 'current-version',
          deferredAt: '2026-05-10T19:00:00.000Z',
          reason: 'cookie_session_stale_or_challenged',
          probeMode: 'cookie_provider',
          blockerEpisodeId: null,
          lastFailureClass: null,
        },
        'processAudioQueues/youtube/deferred/sermon-456': {
          sermonId: 'sermon-456',
          payload: {
            id: 'sermon-456',
            startTime: 0,
            duration: 300,
            youtubeUrl: 'https://www.youtube.com/watch?v=nextVideo123',
          },
          requestVersion: 'next-version',
          deferredAt: '2026-05-10T19:05:00.000Z',
          reason: 'cookie_session_stale_or_challenged',
          probeMode: 'cookie_provider',
          blockerEpisodeId: null,
          lastFailureClass: null,
        },
        'processAudioRequests/sermon-123': {
          sermonId: 'sermon-123',
          sourceType: 'youtube',
          currentPayload: youtubePayload,
          currentRequestVersion: 'current-version',
          queuedTaskId: 'current-task',
          queuedAt: '2026-05-10T19:00:00.000Z',
          runningRequestId: 'req-1',
          runningTaskId: 'current-task',
          runningRequestVersion: 'current-version',
          runningAt: '2026-05-10T19:01:00.000Z',
          nextPayload: null,
          nextRequestVersion: null,
          nextUpdatedAt: null,
          deferredAt: null,
          transientRetryReason: null,
          transientRetryCount: 0,
          transientRetryNextRunAt: null,
          transientRetryLastFailureMessage: null,
          updatedAt: '2026-05-10T19:01:00.000Z',
        },
        'processAudioRequests/sermon-456': {
          sermonId: 'sermon-456',
          sourceType: 'youtube',
          currentPayload: {
            id: 'sermon-456',
            startTime: 0,
            duration: 300,
            youtubeUrl: 'https://www.youtube.com/watch?v=nextVideo123',
          },
          currentRequestVersion: 'next-version',
          queuedTaskId: options.taskDeleteThrows ? 'next-old-task' : null,
          queuedAt: null,
          runningRequestId: null,
          runningTaskId: null,
          runningRequestVersion: null,
          runningAt: null,
          nextPayload: null,
          nextRequestVersion: null,
          nextUpdatedAt: null,
          deferredAt: '2026-05-10T19:05:00.000Z',
          transientRetryReason: null,
          transientRetryCount: 0,
          transientRetryNextRunAt: null,
          transientRetryLastFailureMessage: null,
          updatedAt: '2026-05-10T19:05:00.000Z',
        },
      },
      [],
      {
        'processAudioQueues/youtube/state': [
          (store) => {
            store['processAudioQueues/youtube/state'] = {
              ...(store['processAudioQueues/youtube/state'] as Record<string, unknown>),
              blockerEpisodeId: 'post-live-concurrent-episode',
              alertSentAt: '2026-05-10T19:06:00.000Z',
              alertReservationId: 'post-live-concurrent-reservation',
              deferredYouTubeTaskCount: 3,
            };
            store['processAudioQueues/youtube/deferred/post-live-concurrent'] = {
              sermonId: 'post-live-concurrent',
              payload: { ...youtubePayload, id: 'post-live-concurrent' },
              requestVersion: 'post-live-concurrent-version',
              deferredAt: '2026-05-10T19:06:00.000Z',
              reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
              disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
              dependencyScope: 'authenticated_session',
              probeMode: 'cookie_provider',
              blockerEpisodeId: 'post-live-concurrent-episode',
              lastFailureClass: 'cookie_session_stale_or_challenged',
              attemptCount: 1,
            };
          },
        ],
      }
    );

    const originalFetch = globalThis.fetch;
    const scheduledRetryBodies: Array<{ task: { name: string; scheduleTime?: string } }> = [];
    const scheduledFetch = (async (_url, init) => {
      scheduledRetryBodies.push(JSON.parse(String(init?.body)));
      return new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }) as typeof fetch;
    setCloudTasksApiDepsForTesting({
      authFactory: async () => ({
        getAccessToken: async () => 'post-live-token',
      }),
      fetchImpl: scheduledFetch,
    });
    globalThis.fetch = scheduledFetch;

    try {
      const result = await deferPostLiveArchiveYouTubeRequest({
        database: postLiveStore as any,
        payload: youtubePayload,
        requestId: 'req-1',
        taskId: 'current-task',
        failureClass: 'post_live_archive_not_ready',
        failureMessage: 'ERROR: [youtube] sermon-123: This live event has ended.',
      });

      assert.equal(result.scheduled, true);
      assert.equal(result.retryCount, 1);
      assert.equal(scheduledRetryBodies.length, 2);
      assert.ok(scheduledRetryBodies[0]?.task.scheduleTime);
      assert.equal(scheduledRetryBodies[1]?.task.scheduleTime, undefined);
      assert.equal(postLiveStore.store['processAudioQueues/youtube/deferred/sermon-123'], undefined);
      const queueState = postLiveStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>;
      assert.equal(queueState.probeStatus, 'probing');
      assert.equal(queueState.probeTaskSermonId, 'sermon-456');
      assert.equal(queueState.deferredYouTubeTaskCount, 1);
      assert.equal(queueState.blockerEpisodeId, 'post-live-concurrent-episode');
      assert.equal(queueState.alertSentAt, '2026-05-10T19:06:00.000Z');
      assert.equal(queueState.alertReservationId, 'post-live-concurrent-reservation');
      assert.notEqual(
        postLiveStore.store['processAudioQueues/youtube/deferred/post-live-concurrent'],
        undefined,
        'post-live probe advancement must preserve a concurrent authentication deferral'
      );
      const currentRequest = postLiveStore.store['processAudioRequests/sermon-123'] as Record<string, unknown>;
      assert.equal(currentRequest.transientRetryReason, 'post_live_archive_not_ready');
      assert.equal(currentRequest.transientRetryCount, 1);
      assert.ok(currentRequest.transientRetryNextRunAt);
      const nextRequest = postLiveStore.store['processAudioRequests/sermon-456'] as Record<string, unknown>;
      assert.notEqual(nextRequest.queuedTaskId, null);

      process.env.YOUTUBE_POST_LIVE_ARCHIVE_MAX_RETRY_COUNT = '1';
      const exhaustedResult = await deferPostLiveArchiveYouTubeRequest({
        database: postLiveStore as any,
        payload: youtubePayload,
        requestId: 'req-2',
        taskId: currentRequest.queuedTaskId as string,
        failureClass: 'post_live_archive_not_ready',
        failureMessage: 'ERROR: [youtube] sermon-123: This live event has ended.',
      });
      assert.equal(exhaustedResult.scheduled, false);
      assert.equal(exhaustedResult.retryCount, 2);
    } finally {
      globalThis.fetch = originalFetch;
      setCloudTasksApiDepsForTesting(null);
      delete process.env.YOUTUBE_POST_LIVE_ARCHIVE_MAX_RETRY_COUNT;
      setProcessAudioTaskQueueFactoryForTesting(null);
    }
  };

  await runPostLiveDeferralCase({ taskDeleteThrows: false });
  await runPostLiveDeferralCase({ taskDeleteThrows: true });

  const postLiveNoNextRaceStore = createMockDatabase(
    {
      'processAudioQueues/youtube/state': {
        blocked: false,
        probeMode: 'cookie_provider',
        probeStatus: 'probing',
        probeTaskSermonId: 'sermon-123',
        probeRequestVersion: 'current-version',
        probeStartedAt: '2026-05-10T19:00:00.000Z',
        probeDispatchReservationId: 'current-post-live-reservation',
        deferredYouTubeTaskCount: 1,
      },
      'processAudioQueues/youtube/deferred/sermon-123': {
        sermonId: 'sermon-123',
        payload: youtubePayload,
        requestVersion: 'current-version',
        deferredAt: '2026-05-10T19:00:00.000Z',
        reason: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        disposition: PROCESS_AUDIO_DEFERRED_DISPOSITIONS.WAITING_FOR_YOUTUBE_AUTH,
        dependencyScope: 'authenticated_session',
        probeMode: 'cookie_provider',
        blockerEpisodeId: 'post-live-no-next-episode',
        lastFailureClass: 'cookie_session_stale_or_challenged',
        attemptCount: 1,
      },
      'processAudioRequests/sermon-123': {
        sermonId: 'sermon-123',
        sourceType: 'youtube',
        currentPayload: youtubePayload,
        currentRequestVersion: 'current-version',
        queuedTaskId: 'current-task',
        queuedAt: '2026-05-10T19:00:00.000Z',
        runningRequestId: 'post-live-no-next-request',
        runningTaskId: 'current-task',
        runningRequestVersion: 'current-version',
        runningAt: '2026-05-10T19:01:00.000Z',
        nextPayload: null,
        nextRequestVersion: null,
        nextUpdatedAt: null,
        deferredAt: null,
        transientRetryReason: null,
        transientRetryCount: 0,
        transientRetryNextRunAt: null,
        transientRetryLastFailureMessage: null,
        updatedAt: '2026-05-10T19:01:00.000Z',
      },
    },
    [],
    {
      'processAudioQueues/youtube/state': [
        (store) => {
          store['processAudioQueues/youtube/state'] = {
            ...(store['processAudioQueues/youtube/state'] as Record<string, unknown>),
            probeMode: 'browser_fallback',
            probeStatus: 'probing',
            probeTaskSermonId: 'post-live-replacement-owner',
            probeRequestVersion: 'post-live-replacement-version',
            probeStartedAt: new Date().toISOString(),
            probeDispatchReservationId: 'post-live-replacement-reservation',
          };
        },
      ],
    }
  );
  setProcessAudioTaskQueueFactoryForTesting(() => ({ async delete(): Promise<void> {} }));
  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'post-live-no-next-token' }),
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
  await deferPostLiveArchiveYouTubeRequest({
    database: postLiveNoNextRaceStore as any,
    payload: youtubePayload,
    requestId: 'post-live-no-next-request',
    taskId: 'current-task',
    failureClass: 'post_live_archive_not_ready',
    failureMessage: 'This live event has ended.',
  });
  const postLiveNoNextRaceState = postLiveNoNextRaceStore.store[
    'processAudioQueues/youtube/state'
  ] as Record<string, unknown>;
  assert.equal(postLiveNoNextRaceState.probeTaskSermonId, 'post-live-replacement-owner');
  assert.equal(postLiveNoNextRaceState.probeDispatchReservationId, 'post-live-replacement-reservation');
  setCloudTasksApiDepsForTesting(null);
  setProcessAudioTaskQueueFactoryForTesting(null);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
