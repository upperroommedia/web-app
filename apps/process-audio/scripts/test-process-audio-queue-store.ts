import assert from 'node:assert/strict';
import {
  buildCloudTasksCreateTaskRequest,
  deferYouTubeRequestForAuthentication,
  deferPostLiveArchiveYouTubeRequest,
  enqueueTaskViaCloudTasksApi,
  getPostLiveArchiveRetryDelaySeconds,
  getYouTubeQueueScopeDiagnostics,
  normalizeCloudTasksAccessToken,
  resumeDeferredYouTubeQueueOnStartup,
  setCloudTasksApiDepsForTesting,
  setProcessAudioTaskQueueFactoryForTesting,
} from '../src/processAudioQueueStore';
import {
  PROCESS_AUDIO_DEFERRED_DISPOSITIONS,
  getYouTubeFailureDisposition,
} from '../../../packages/contracts/processAudioQueue';
import {
  isYouTubeQueuePaused as isFunctionsYouTubeQueuePaused,
  recoverStaleYouTubeQueueProbe,
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
  constructor(private readonly store: Record<string, unknown>, private readonly key: string) {}

  async get(): Promise<MockSnapshot> {
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
    const next = updateFn(this.store[this.key]);
    if (typeof next === 'undefined') {
      return { committed: false, snapshot: new MockSnapshot(this.store[this.key]) };
    }
    this.store[this.key] = next;
    return { committed: true, snapshot: new MockSnapshot(next) };
  }
}

function createMockDatabase(initialData: Record<string, unknown> = {}) {
  const store = { ...initialData };
  return {
    store,
    ref(key: string): MockRef {
      return new MockRef(store, key);
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
  const legacyRecoveryStore = createMockDatabase({
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
  });
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
  await resumeDeferredYouTubeQueueOnStartup({ database: legacyRecoveryStore as any });
  assert.equal(legacyDispatchCount, 1);
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
  const staleProbeStore = createMockDatabase({
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
  });
  const staleRecovery = await recoverStaleYouTubeQueueProbe(staleProbeStore as any);
  assert.equal(staleRecovery.recovered, true);
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
  await deferYouTubeRequestForAuthentication({
    database: authDeferredStore as any,
    payload: youtubePayload,
    requestId: 'auth-request-1',
    failureClass: 'account_required_content',
    failureMessage: 'LOGIN_REQUIRED',
  });
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
  });
  assert.equal((authDeferredStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>).blocked, false);

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

  await enqueueTaskViaCloudTasksApi(youtubePayload, 'processaudioyoutubetask', 'pa-existing-task', {
    authFactory: async () => ({
      getAccessToken: async () => 'test-token',
    }),
    fetchImpl: async () =>
      new Response('{"error":{"status":"ALREADY_EXISTS"}}', {
        status: 409,
        statusText: 'Conflict',
        headers: { 'Content-Type': 'application/json' },
      }),
  });

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

    const postLiveStore = createMockDatabase({
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
    });

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
      assert.equal(scheduledRetryBodies.length, options.taskDeleteThrows ? 1 : 2);
      assert.ok(scheduledRetryBodies[0]?.task.scheduleTime);
      if (!options.taskDeleteThrows) {
        assert.equal(scheduledRetryBodies[1]?.task.scheduleTime, undefined);
      }
      assert.equal(postLiveStore.store['processAudioQueues/youtube/deferred/sermon-123'], undefined);
      const queueState = postLiveStore.store['processAudioQueues/youtube/state'] as Record<string, unknown>;
      if (options.taskDeleteThrows) {
        assert.equal(queueState.probeStatus, 'waiting_for_auth_required_request');
        assert.equal(queueState.deferredYouTubeTaskCount, 1);
      } else {
        assert.equal(queueState.probeStatus, 'probing');
        assert.equal(queueState.probeTaskSermonId, 'sermon-456');
        assert.equal(queueState.deferredYouTubeTaskCount, 0);
      }
      const currentRequest = postLiveStore.store['processAudioRequests/sermon-123'] as Record<string, unknown>;
      assert.equal(currentRequest.transientRetryReason, 'post_live_archive_not_ready');
      assert.equal(currentRequest.transientRetryCount, 1);
      assert.ok(currentRequest.transientRetryNextRunAt);
      const nextRequest = postLiveStore.store['processAudioRequests/sermon-456'] as Record<string, unknown>;
      if (options.taskDeleteThrows) {
        assert.equal(nextRequest.queuedTaskId, 'next-old-task');
      } else {
        assert.notEqual(nextRequest.queuedTaskId, null);
      }

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
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
