const mockTaskDelete = jest.fn(async (_taskId?: string) => undefined);
const mockTaskEnqueue = jest.fn(async (_payload?: unknown, _options?: unknown) => undefined);

jest.mock('firebase-admin/functions', () => ({
  getFunctions: () => ({
    taskQueue: () => ({
      delete: mockTaskDelete,
      enqueue: mockTaskEnqueue,
    }),
  }),
}));

import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { cleanupDeletedSermonProcessAudioState } from '../../processAudioQueueCleanup';
import { buildInitialYouTubeQueueState } from '../../../../packages/contracts/processAudioQueue';

const database = firebaseAdmin.database();

describe('cleanupDeletedSermonProcessAudioState', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([
      database.ref('processAudioRequests').remove(),
      database.ref('processAudioLocks').remove(),
      database.ref('processAudioQueueClaims').remove(),
      database.ref('processAudioQueues').remove(),
    ]);
  });

  it('removes a deleted probe sermon and advances the queue to the next deferred sermon', async () => {
    await Promise.all([
      database.ref('processAudioRequests/deleted-sermon').set({
        sermonId: 'deleted-sermon',
        sourceType: 'youtube',
        currentPayload: {
          id: 'deleted-sermon',
          youtubeUrl: 'https://youtu.be/deleted',
          startTime: 0,
          duration: 10,
          deleteOriginal: true,
          skipTranscode: false,
        },
        currentRequestVersion: 'probe-version',
        queuedTaskId: 'probe-task-id',
        queuedAt: '2026-03-28T00:00:00.000Z',
        runningRequestId: null,
        runningTaskId: null,
        runningRequestVersion: null,
        runningAt: null,
        nextPayload: null,
        nextRequestVersion: null,
        nextUpdatedAt: null,
        deferredAt: null,
        updatedAt: '2026-03-28T00:00:00.000Z',
      }),
      database.ref('processAudioRequests/next-sermon').set({
        sermonId: 'next-sermon',
        sourceType: 'youtube',
        currentPayload: {
          id: 'next-sermon',
          youtubeUrl: 'https://youtu.be/next',
          startTime: 1,
          duration: 20,
          deleteOriginal: true,
          skipTranscode: false,
        },
        currentRequestVersion: 'next-version',
        queuedTaskId: null,
        queuedAt: null,
        runningRequestId: null,
        runningTaskId: null,
        runningRequestVersion: null,
        runningAt: null,
        nextPayload: null,
        nextRequestVersion: null,
        nextUpdatedAt: null,
        deferredAt: '2026-03-28T00:01:00.000Z',
        updatedAt: '2026-03-28T00:01:00.000Z',
      }),
      database.ref('processAudioQueues/youtube/deferred/next-sermon').set({
        sermonId: 'next-sermon',
        payload: {
          id: 'next-sermon',
          youtubeUrl: 'https://youtu.be/next',
          startTime: 1,
          duration: 20,
          deleteOriginal: true,
          skipTranscode: false,
        },
        requestVersion: 'next-version',
        deferredAt: '2026-03-28T00:01:00.000Z',
        reason: 'browser_fallback_unavailable',
        probeMode: 'browser_fallback',
        blockerEpisodeId: 'episode-1',
        lastFailureClass: 'browser_fallback_unavailable',
      }),
      database.ref('processAudioQueues/youtube/state').set({
        ...buildInitialYouTubeQueueState(),
        blocked: false,
        probeMode: 'browser_fallback',
        probeStatus: 'probing',
        probeTaskSermonId: 'deleted-sermon',
        probeRequestVersion: 'probe-version',
        probeStartedAt: '2026-03-28T00:00:30.000Z',
        deferredYouTubeTaskCount: 1,
      }),
    ]);

    const result = await cleanupDeletedSermonProcessAudioState({
      database,
      sermonId: 'deleted-sermon',
      ownerId: 'test-owner',
      targetUri: 'https://example.com/process-audio',
    });

    expect(result).toEqual({
      deletedTaskId: 'probe-task-id',
      advancedProbe: true,
      deferredRemaining: 0,
    });
    expect(mockTaskDelete).toHaveBeenCalledWith('probe-task-id');
    expect(mockTaskEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'next-sermon',
        youtubeUrl: 'https://youtu.be/next',
      }),
      expect.objectContaining({
        uri: 'https://example.com/process-audio',
      })
    );

    const [deletedRequest, nextDeferred, queueState, nextRequest] = await Promise.all([
      database.ref('processAudioRequests/deleted-sermon').get(),
      database.ref('processAudioQueues/youtube/deferred/next-sermon').get(),
      database.ref('processAudioQueues/youtube/state').get(),
      database.ref('processAudioRequests/next-sermon').get(),
    ]);

    expect(deletedRequest.exists()).toBe(false);
    expect(nextDeferred.exists()).toBe(false);
    expect(queueState.val()).toMatchObject({
      probeMode: 'browser_fallback',
      probeStatus: 'probing',
      probeTaskSermonId: 'next-sermon',
      probeRequestVersion: 'next-version',
      deferredYouTubeTaskCount: 0,
    });
    expect(nextRequest.val()).toMatchObject({
      queuedTaskId: expect.stringMatching(/^pa-/u),
    });
    expect(nextRequest.val()?.deferredAt ?? null).toBeNull();
  });
});
