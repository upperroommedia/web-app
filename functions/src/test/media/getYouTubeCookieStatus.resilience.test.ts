jest.mock('../../../../functions-media/src/browserFallbackService', () => ({
  getBrowserFallbackSessionStatus: jest.fn(),
}));

jest.mock('../../../../functions-media/src/processAudioQueueStore', () => {
  const actual = jest.requireActual('../../../../functions-media/src/processAudioQueueStore');
  return {
    ...actual,
    beginYouTubeQueueProbe: jest.fn(),
    getYouTubeQueueSnapshot: jest.fn(),
    recoverStaleYouTubeQueueProbe: jest.fn(),
  };
});

import { buildInitialYouTubeQueueState } from '../../../../packages/contracts/processAudioQueue';
import type { YouTubeCookieMetadata } from '../../../../packages/contracts/youtubeCookies';
import { getYouTubeCookieStatus } from '../../../../functions-media/src/youtubeCookieStore';
import { getBrowserFallbackSessionStatus } from '../../../../functions-media/src/browserFallbackService';
import {
  beginYouTubeQueueProbe,
  getYouTubeQueueSnapshot,
  recoverStaleYouTubeQueueProbe,
} from '../../../../functions-media/src/processAudioQueueStore';

const mockedGetBrowserFallbackSessionStatus = jest.mocked(getBrowserFallbackSessionStatus);
const mockedBeginYouTubeQueueProbe = jest.mocked(beginYouTubeQueueProbe);
const mockedGetYouTubeQueueSnapshot = jest.mocked(getYouTubeQueueSnapshot);
const mockedRecoverStaleYouTubeQueueProbe = jest.mocked(recoverStaleYouTubeQueueProbe);

const metadata: YouTubeCookieMetadata = {
  cookieHash: '265428c85a803368',
  uploadedAt: '2026-03-28T00:26:07.228Z',
  uploadedByUid: 'admin-1',
  uploadedByEmail: 'admin@example.com',
  sourceFileName: 'cookies.txt',
  lastUsedAt: null,
  lastValidatedAt: null,
  lastValidatedVideoId: null,
  lastSuccessfulMode: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureClass: null,
  lastFailureMessage: null,
  lastHealthCheckAt: null,
  lastHealthStatus: 'uploaded_unverified',
  consecutiveFailures: 0,
  disabledUntil: null,
};

const createSnapshot = (value: unknown) => ({
  exists: () => value !== null && value !== undefined,
  val: () => value,
});

const createDatabase = () =>
  ({
    ref: (path: string) => ({
      get: async () => {
        if (path === 'yt-dlp-cookies') {
          return createSnapshot('ZmFrZS1iYXNlNjQ=');
        }
        if (path === 'yt-dlp-cookies-meta') {
          return createSnapshot(metadata);
        }
        throw new Error(`Unexpected ref path: ${path}`);
      },
    }),
  }) as never;

describe('getYouTubeCookieStatus resilience', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns status even when the auto-probe collides with an existing Cloud Task', async () => {
    const database = createDatabase();

    mockedGetBrowserFallbackSessionStatus.mockResolvedValue({
      ok: true,
      service: 'browser-fallback',
      configured: true,
      reachable: true,
      serviceUrl: 'https://browser-fallback-staging.example.com',
      sessionState: 'authenticated',
      profileUpdatedAt: '2026-03-28T00:26:07.228Z',
      profileGeneration: '1774657567188905',
      fakeMode: false,
    });

    mockedGetYouTubeQueueSnapshot
      .mockResolvedValueOnce({
        queueState: {
          ...buildInitialYouTubeQueueState(),
          blocked: true,
          blockerReason: 'browser_fallback_unavailable',
          blockerEpisodeId: 'episode-1',
          blockedAt: '2026-03-28T00:40:00.000Z',
          deferredYouTubeTaskCount: 1,
        },
        deferredCount: 1,
      })
      .mockResolvedValueOnce({
        queueState: {
          ...buildInitialYouTubeQueueState(),
          blocked: true,
          blockerReason: 'browser_fallback_unavailable',
          blockerEpisodeId: 'episode-1',
          blockedAt: '2026-03-28T00:40:00.000Z',
          deferredYouTubeTaskCount: 1,
        },
        deferredCount: 1,
      });

    mockedRecoverStaleYouTubeQueueProbe.mockResolvedValue({
      recovered: false,
      queueState: {
        ...buildInitialYouTubeQueueState(),
        blocked: true,
        blockerReason: 'browser_fallback_unavailable',
        blockerEpisodeId: 'episode-1',
        blockedAt: '2026-03-28T00:40:00.000Z',
        deferredYouTubeTaskCount: 1,
      },
      deferredCount: 1,
    });

    mockedBeginYouTubeQueueProbe.mockRejectedValue(
      Object.assign(new Error('A task with ID pa-f669e7ba-141dbb566dfd76b4 already exists'), {
        code: 'functions/task-already-exists',
      })
    );

    const result = await getYouTubeCookieStatus(database);

    expect(mockedBeginYouTubeQueueProbe).toHaveBeenCalledWith({
      database,
      ownerId: expect.stringMatching(/^browser-status:/),
      probeMode: 'browser_fallback',
      targetUri: expect.any(String),
    });
    expect(result).toMatchObject({
      hasCookies: true,
      youtubeQueueBlocked: true,
      blockerReason: 'browser_fallback_unavailable',
      browserFallbackConfigured: true,
      browserFallbackReachable: true,
      browserFallbackSessionState: 'authenticated',
      metadata: expect.objectContaining({
        cookieHash: '265428c85a803368',
      }),
    });
  });
});
