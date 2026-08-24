import {
  sentryEnabled,
  sentryEnvironment,
  sentryLogsEnabled,
  sentryRelease,
  sentryTracesSampleRate,
} from './instrument';
import express, { Request } from 'express';
import { spawnSync } from 'node:child_process';
import * as Sentry from '@sentry/node';
import { executeWithTimeout, getAudioSource, getFFmpegPath, logMemoryUsage, validateAddIntroOutroData } from './utils';
import { ProcessAudioInputType, sermonStatusType, uploadStatus, sermonStatus } from './types';
import { isAxiosError } from 'axios';
import { isMissingSermonDocumentError, isProcessAudioAlreadyRunningError, processAudio } from './processAudio';
import { CancelToken } from './CancelToken';
import { firestoreAdminSermonConverter } from './firestoreAdminDataConverter';
import { TIMEOUT_SECONDS } from './consts';
import firebaseAdmin from './firebaseAdmin';
import logger, { createLoggerWithContext, sentryLogLevels } from './WinstonLogger';
import { createContext } from './context';
import { emitOperationalAlertEmail } from './operationalAlerts';
import { getYouTubeBrowserAuthHealth } from './processYouTubeUrl';
import { toYouTubeAlertCode, type YouTubeFailureClass } from './youtubeExtractionPolicy';
import {
  cleanupDeletedSermonProcessAudioState,
  completeProcessAudioFailure,
  completeProcessAudioSuccess,
  deferYouTubeRequestForAuthentication,
  deferPostLiveArchiveYouTubeRequest,
  extractCloudTaskId,
  getYouTubeQueueScopeDiagnostics,
  resumeDeferredYouTubeQueueOnStartup,
} from './processAudioQueueStore';
import type { BrowserFallbackErrorResponse } from '@upperroom/contracts/browserFallback';
import { getProcessAudioConcurrencyConfig } from './concurrency';
import {
  getYouTubeFailureDisposition,
  type StoredProcessAudioRequestState,
  type YouTubeAcquisitionEvidence,
} from '@upperroom/contracts/processAudioQueue';
import {
  buildYouTubeReadinessSnapshot,
  type YouTubeMediaByteCanaryDiagnostic,
  type YouTubeProviderDiagnostic,
} from './youtubeReadiness';

const app = express();
app.use(express.json());
const localBrowserProfileDir = process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR?.trim() || '';
const localBrowserProfileBrowser = process.env.PROCESS_AUDIO_BROWSER_PROFILE_BROWSER?.trim() || 'chromium';
const runtimeProfile = process.env.PROCESS_AUDIO_RUNTIME_PROFILE?.trim().toLowerCase() || 'hetzner';
const runtimeHost = process.env.PROCESS_AUDIO_RUNTIME_HOST?.trim() || 'cloud-run';
const runtimeEnv = process.env.PROCESS_AUDIO_RUNTIME_ENV?.trim() || process.env.NODE_ENV || 'unknown';
const youtubeProcessingEnabled = runtimeProfile !== 'cloudrun';
const ytdlpPath = youtubeProcessingEnabled ? 'yt-dlp' : null;
const configuredYtDlpJsRuntime = youtubeProcessingEnabled ? process.env.YTDLP_JS_RUNTIME?.trim() || 'deno' : null;
const configuredPoTokenProviderBaseUrl = youtubeProcessingEnabled
  ? process.env.YTDLP_POT_PROVIDER_BASE_URL?.trim() || null
  : null;

function resolveBinaryVersion(binary: string, args: string[] = ['--version']): string {
  const result = spawnSync(binary, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return 'unknown';
  }
  return (result.stdout || result.stderr || '').trim().split('\n')[0] || 'unknown';
}

function validateConfiguredYtDlpJsRuntime(): { runtime: string; version: string } {
  if (!configuredYtDlpJsRuntime) {
    throw new Error('yt-dlp JavaScript runtime validation is only available when YouTube processing is enabled.');
  }
  const primaryRuntime = configuredYtDlpJsRuntime.split(',')[0]?.trim().split(':')[0]?.trim() || 'deno';
  const result = spawnSync(primaryRuntime, ['--version'], { encoding: 'utf8' });

  if (result.error) {
    throw new Error(
      `Configured yt-dlp JavaScript runtime "${primaryRuntime}" is not available on PATH: ${result.error.message}`
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `Configured yt-dlp JavaScript runtime "${primaryRuntime}" failed validation with exit code ${result.status}: ${
        (result.stderr || result.stdout || '').trim() || 'no output'
      }`
    );
  }

  return {
    runtime: primaryRuntime,
    version: (result.stdout || result.stderr || '').trim().split('\n')[0] || 'unknown',
  };
}

const ytDlpJsRuntimeInfo = youtubeProcessingEnabled ? validateConfiguredYtDlpJsRuntime() : null;
const ytDlpVersion = ytdlpPath ? resolveBinaryVersion(ytdlpPath) : null;
const poTokenProviderPluginVersion = configuredPoTokenProviderBaseUrl
  ? resolveBinaryVersion('python3', [
      '-c',
      "from importlib.metadata import version; print(version('bgutil-ytdlp-pot-provider'))",
    ])
  : null;
const ffmpegVersion = resolveBinaryVersion(getFFmpegPath(), ['-version'])
  .replace(/^ffmpeg version\s+/i, '')
  .trim();
const configuredExternalDownloader = youtubeProcessingEnabled
  ? process.env.YTDLP_EXTERNAL_DOWNLOADER?.trim() || null
  : null;
const externalDownloaderVersion = configuredExternalDownloader
  ? resolveBinaryVersion(configuredExternalDownloader, ['--version']).split('\n')[0].trim()
  : null;
const concurrencyConfig = getProcessAudioConcurrencyConfig();
const ytDlpSleepRequestsSeconds = youtubeProcessingEnabled
  ? process.env.YTDLP_SLEEP_REQUESTS_SECONDS?.trim() || null
  : null;
const ytDlpSleepIntervalSeconds = youtubeProcessingEnabled
  ? process.env.YTDLP_SLEEP_INTERVAL_SECONDS?.trim() || null
  : null;
const ytDlpMaxSleepIntervalSeconds = youtubeProcessingEnabled
  ? process.env.YTDLP_MAX_SLEEP_INTERVAL_SECONDS?.trim() || null
  : null;
const ytDlpForceIpv4 = youtubeProcessingEnabled ? process.env.YOUTUBE_FORCE_IPV4?.trim() || 'false' : null;
const browserFallbackExplicit = youtubeProcessingEnabled
  ? process.env.YOUTUBE_BROWSER_FALLBACK_ENABLED?.trim().toLowerCase() || ''
  : '';
const inProcessBrowserFallbackConfigured = !!(
  youtubeProcessingEnabled &&
  (localBrowserProfileDir ||
    process.env.BROWSER_FALLBACK_PROFILE_BUCKET?.trim() ||
    process.env.FIREBASE_STORAGE_BUCKET?.trim())
);
const finalBrowserFallbackConfigured =
  youtubeProcessingEnabled && !!process.env.YOUTUBE_FINAL_BROWSER_FALLBACK_URL?.trim();
const browserFallbackEnabled =
  youtubeProcessingEnabled &&
  !['0', 'false', 'no'].includes(browserFallbackExplicit) &&
  (inProcessBrowserFallbackConfigured ||
    finalBrowserFallbackConfigured ||
    !!process.env.YOUTUBE_BROWSER_FALLBACK_URL?.trim());
const browserFallbackConfigured = browserFallbackEnabled || finalBrowserFallbackConfigured;

logger.info('Service initializing', {
  runtimeProfile,
  youtubeProcessingEnabled,
  ytdlpPath,
  configuredYtDlpJsRuntime,
  ytDlpJsRuntime: ytDlpJsRuntimeInfo?.runtime ?? null,
  ytDlpJsRuntimeVersion: ytDlpJsRuntimeInfo?.version ?? null,
  ytDlpUseCookiesForPublicVideos: youtubeProcessingEnabled
    ? process.env.YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS || 'false'
    : null,
  ytDlpConcurrentFragments: youtubeProcessingEnabled ? process.env.YTDLP_CONCURRENT_FRAGMENTS || '1' : null,
  ytDlpSleepRequestsSeconds,
  ytDlpSleepIntervalSeconds,
  ytDlpMaxSleepIntervalSeconds,
  ytDlpForceIpv4,
  browserFallbackConfigured,
  browserFallbackEnabled,
  inProcessBrowserFallbackConfigured,
  localBrowserProfileDir: localBrowserProfileDir || null,
  localBrowserProfileBrowser: localBrowserProfileDir ? localBrowserProfileBrowser : null,
  runtimeHost,
  runtimeEnv,
  sentryEnabled,
  sentryEnvironment,
  sentryRelease,
  ytDlpVersion,
  ffmpegVersion,
  externalDownloader: configuredExternalDownloader,
  externalDownloaderVersion,
  finalBrowserFallbackConfigured,
  poTokenProviderConfigured: youtubeProcessingEnabled && !!process.env.YTDLP_POT_PROVIDER_BASE_URL,
  concurrency: concurrencyConfig,
});

logger.info('Loading storage, realtimeDB and firestore');
const bucket = firebaseAdmin.storage().bucket();
const realtimeDB = firebaseAdmin.database();
const db = firebaseAdmin.firestore();

function shouldRecoverOrphanedHetznerStateOnStartup(): boolean {
  if (runtimeProfile !== 'hetzner') {
    return false;
  }

  const explicit = process.env.PROCESS_AUDIO_RECOVER_ORPHANED_STATE_ON_STARTUP?.trim().toLowerCase();
  return !['0', 'false', 'no'].includes(explicit || '');
}

function startDeferredYouTubeAuthReconciler(): void {
  if (!youtubeProcessingEnabled || runtimeProfile !== 'hetzner') {
    return;
  }

  const configuredInterval = Number.parseInt(
    process.env.PROCESS_AUDIO_YOUTUBE_AUTH_RECONCILE_INTERVAL_MS || `${5 * 60 * 1000}`,
    10
  );
  const intervalMs =
    Number.isFinite(configuredInterval) && configuredInterval > 0
      ? Math.max(30_000, configuredInterval)
      : 5 * 60 * 1000;
  const interval = setInterval(() => {
    void resumeDeferredYouTubeQueueOnStartup({
      database: realtimeDB,
      ctx: createContext(undefined, 'youtube-auth-reconciliation'),
    }).catch((error) => {
      logger.error('Failed to reconcile deferred authenticated YouTube requests', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, intervalMs);
  interval.unref?.();
}

async function recoverOrphanedHetznerProcessAudioStateOnStartup(): Promise<void> {
  if (!shouldRecoverOrphanedHetznerStateOnStartup()) {
    return;
  }

  const startupLogger = createLoggerWithContext(createContext(undefined, 'startup-recovery'));
  startupLogger.info('Scanning for orphaned process-audio state after worker startup');

  const [locksSnapshot, requestsSnapshot, progressSnapshot] = await Promise.all([
    realtimeDB.ref('processAudioLocks').get(),
    realtimeDB.ref('processAudioRequests').get(),
    realtimeDB.ref('addIntroOutro').get(),
  ]);

  const lockEntries = (locksSnapshot.val() as Record<string, unknown> | null) ?? {};
  const requestEntries = (requestsSnapshot.val() as Record<string, StoredProcessAudioRequestState> | null) ?? {};
  const progressEntries = (progressSnapshot.val() as Record<string, unknown> | null) ?? {};
  const sermonIds = new Set<string>([
    ...Object.keys(lockEntries),
    ...Object.keys(requestEntries),
    ...Object.keys(progressEntries),
  ]);

  if (sermonIds.size === 0) {
    startupLogger.info('No orphaned process-audio state found on startup');
    return;
  }

  let recoveredCount = 0;

  for (const sermonId of sermonIds) {
    const requestState = requestEntries[sermonId];
    const hasRunningRequest = !!requestState?.runningRequestId;
    const hasLock = sermonId in lockEntries;
    const hasProgress = sermonId in progressEntries;

    if (!hasRunningRequest && !hasLock && !hasProgress) {
      continue;
    }

    recoveredCount += 1;
    startupLogger.warn('Recovering orphaned process-audio state after restart', {
      sermonId,
      runningRequestId: requestState?.runningRequestId ?? null,
      runningTaskId: requestState?.runningTaskId ?? null,
      runningAt: requestState?.runningAt ?? null,
      hasLock,
      hasProgress,
    });

    const updates: Array<Promise<unknown>> = [
      realtimeDB
        .ref(`processAudioLocks/${sermonId}`)
        .remove()
        .catch((error) => {
          startupLogger.error('Failed to remove orphaned process-audio lock', {
            sermonId,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      realtimeDB
        .ref(`addIntroOutro/${sermonId}`)
        .remove()
        .catch((error) => {
          startupLogger.error('Failed to remove orphaned process progress node', {
            sermonId,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    ];

    if (requestState) {
      updates.push(
        realtimeDB
          .ref(`processAudioRequests/${sermonId}`)
          .set({
            ...requestState,
            runningRequestId: null,
            runningTaskId: null,
            runningRequestVersion: null,
            runningAt: null,
            updatedAt: new Date().toISOString(),
          } satisfies StoredProcessAudioRequestState)
          .catch((error) => {
            startupLogger.error('Failed to clear orphaned process-audio request state', {
              sermonId,
              error: error instanceof Error ? error.message : String(error),
            });
          })
      );
    }

    updates.push(
      db
        .collection('sermons')
        .withConverter(firestoreAdminSermonConverter)
        .doc(sermonId)
        .get()
        .then(async (snapshot) => {
          if (!snapshot.exists) {
            return;
          }
          const sermon = snapshot.data();
          if (sermon?.status?.audioStatus !== sermonStatusType.PROCESSING) {
            return;
          }
          await snapshot.ref.update({
            status: {
              ...sermon.status,
              audioStatus: sermonStatusType.ERROR,
              message: 'Audio processing was interrupted during worker restart. Retry required.',
            },
          });
        })
        .catch((error) => {
          startupLogger.error('Failed to mark sermon as interrupted after startup recovery', {
            sermonId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
    );

    await Promise.all(updates);
  }

  const deferredQueueRecovery = await resumeDeferredYouTubeQueueOnStartup({
    database: realtimeDB,
    ctx: createContext(undefined, 'startup-recovery'),
    force: true,
  });

  startupLogger.info('Completed orphaned process-audio startup recovery', {
    recoveredCount,
    deferredQueueResumed: deferredQueueRecovery.resumed,
    deferredQueueNextProbeSermonId: deferredQueueRecovery.nextProbeSermonId,
    deferredQueueRemaining: deferredQueueRecovery.deferredRemaining,
  });
}

// Log Firestore connection details after initialization
const isDevelopment = process.env.NODE_ENV === 'development';
if (isDevelopment) {
  const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  logger.info('Firestore initialized', {
    isDevelopment,
    firestoreEmulatorHost: firestoreEmulatorHost || 'not set (using production)',
    firestoreUrl: firestoreEmulatorHost ? `http://${firestoreEmulatorHost}` : 'https://firestore.googleapis.com',
  });

  // Test Firestore connection asynchronously (non-blocking)
  (async () => {
    try {
      const testRef = db.collection('_test_connection').doc('_test');
      await testRef.set({ test: true, timestamp: Date.now() });
      await testRef.delete();
      logger.info('Firestore emulator connection test successful');
    } catch (error) {
      logger.error('Firestore emulator connection test failed', {
        error: error instanceof Error ? error.message : String(error),
        firestoreEmulatorHost,
        hint: 'Make sure the emulator is running on 0.0.0.0 (not 127.0.0.1) and accessible from Docker',
      });
    }
  })();
}

logger.info('Initializing ffmpeg');
getFFmpegPath(); // Initialize and verify ffmpeg is available

void recoverOrphanedHetznerProcessAudioStateOnStartup()
  .then(() => {
    logger.info('Service ready');
  })
  .catch((error) => {
    logger.error('Failed to recover orphaned process-audio state on startup', {
      error: error instanceof Error ? error.message : String(error),
    });
    logger.info('Service ready');
  })
  .finally(() => {
    startDeferredYouTubeAuthReconciler();
  });

app.get('/', (req, res) => {
  const VERSION = '1.1.0';
  res.send(`
  Process Audio Running version ${VERSION}
  Post to /process-audio with data in the format of
  {
    id (string),
    startTime (number),
    duration (number),
    youtubeUrl (string) || storageFilePath (string),
    introUrl (string),
    outroUrl (string)
  }
  `);
});

app.get('/healthz', async (req, res) => {
  const youtubeBrowserAuthHealth = youtubeProcessingEnabled ? await getYouTubeBrowserAuthHealth() : null;

  res.status(200).json({
    ok: true,
    service: 'process-audio',
    revision: process.env.K_REVISION || 'local',
    runtimeProfile,
    youtubeProcessingEnabled,
    sentryEnabled,
    sentryEnvironment,
    sentryRelease: sentryRelease ?? null,
    sentryLogsEnabled,
    sentryLogLevels,
    sentryTracesSampleRate,
    browserFallbackConfigured,
    browserFallbackEnabled,
    inProcessBrowserFallbackConfigured,
    localBrowserProfileDir: localBrowserProfileDir || null,
    youtubeBrowserAuthHealth,
    finalBrowserFallbackConfigured,
    poTokenProviderConfigured: youtubeProcessingEnabled && !!process.env.YTDLP_POT_PROVIDER_BASE_URL,
    ytDlpJsRuntime: ytDlpJsRuntimeInfo?.runtime ?? null,
    ytDlpUseCookiesForPublicVideos: youtubeProcessingEnabled
      ? process.env.YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS || 'false'
      : null,
    ytDlpSleepRequestsSeconds,
    ytDlpSleepIntervalSeconds,
    ytDlpMaxSleepIntervalSeconds,
    ytDlpForceIpv4,
    ytDlpVersion,
    ffmpegVersion,
    externalDownloader: configuredExternalDownloader,
    externalDownloaderVersion,
    concurrency: getProcessAudioConcurrencyConfig(),
  });
});

const parseReadinessDurationMs = (name: string, fallbackMs: number): number => {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
};

async function getYouTubeProviderDiagnostic(): Promise<YouTubeProviderDiagnostic> {
  if (!configuredPoTokenProviderBaseUrl) {
    return {
      configured: false,
      discovered: null,
      version: null,
      reachable: null,
      lastCheckedAt: null,
    };
  }

  const lastCheckedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  let reachable = false;

  try {
    const response = await fetch(`${configuredPoTokenProviderBaseUrl.replace(/\/$/, '')}/ping`, {
      signal: controller.signal,
    });
    reachable = response.ok;
  } catch {
    reachable = false;
  } finally {
    clearTimeout(timeout);
  }

  const discoveredVersion =
    poTokenProviderPluginVersion && poTokenProviderPluginVersion !== 'unknown' ? poTokenProviderPluginVersion : null;
  return {
    configured: true,
    discovered: discoveredVersion !== null,
    version: discoveredVersion,
    reachable,
    lastCheckedAt,
  };
}

const getLatestProbeCanary = (probe: {
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  lastFailureClass: string | null;
}): YouTubeMediaByteCanaryDiagnostic => {
  const lastSucceededAtMs = probe.lastSucceededAt ? Date.parse(probe.lastSucceededAt) : Number.NaN;
  const lastFailedAtMs = probe.lastFailedAt ? Date.parse(probe.lastFailedAt) : Number.NaN;

  if (Number.isFinite(lastSucceededAtMs) && (!Number.isFinite(lastFailedAtMs) || lastSucceededAtMs > lastFailedAtMs)) {
    return {
      checkedAt: probe.lastSucceededAt,
      succeeded: true,
      // A completed production probe necessarily acquired media; one byte is the conservative known lower bound.
      bytesDownloaded: 1,
      failureClass: null,
    };
  }

  if (Number.isFinite(lastFailedAtMs)) {
    return {
      checkedAt: probe.lastFailedAt,
      succeeded: false,
      bytesDownloaded: 0,
      failureClass: probe.lastFailureClass,
    };
  }

  return {
    checkedAt: null,
    succeeded: null,
    bytesDownloaded: null,
    failureClass: null,
  };
};

app.get('/readyz', async (req, res) => {
  try {
    const disabledQueue = {
      guest: { blocked: false as const, blockerReason: null, depth: 0 as const, oldestDeferredAt: null },
      authenticated: { blocked: false, blockerReason: null, depth: 0, oldestDeferredAt: null },
      probe: {
        status: 'idle' as const,
        lastSucceededAt: null,
        lastFailedAt: null,
        lastFailureClass: null,
      },
    };
    const [provider, browserAuthHealth, queue] = youtubeProcessingEnabled
      ? await Promise.all([
          getYouTubeProviderDiagnostic(),
          getYouTubeBrowserAuthHealth(),
          getYouTubeQueueScopeDiagnostics(realtimeDB),
        ])
      : [
          {
            configured: false,
            discovered: null,
            version: null,
            reachable: null,
            lastCheckedAt: null,
          } satisfies YouTubeProviderDiagnostic,
          null,
          disabledQueue,
        ];
    const authenticatedCanary = getLatestProbeCanary(queue.probe);
    const authenticatedSessionConfigured = inProcessBrowserFallbackConfigured || browserFallbackConfigured;
    const authenticatedSessionHealthy =
      authenticatedCanary.succeeded ??
      (authenticatedSessionConfigured && browserAuthHealth?.profileDirConfigured && !browserAuthHealth.cookiesDb.exists
        ? false
        : null);
    const snapshot = buildYouTubeReadinessSnapshot({
      checkedAtMs: Date.now(),
      youtubeProcessingEnabled,
      provider,
      guest: {
        mediaByteCanary: {
          checkedAt: null,
          succeeded: null,
          bytesDownloaded: null,
          failureClass: null,
        },
        queue: queue.guest,
      },
      authenticatedSession: {
        configured: authenticatedSessionConfigured,
        healthy: authenticatedSessionHealthy,
        lastCheckedAt: authenticatedCanary.checkedAt,
        mediaByteCanary: authenticatedCanary,
        queue: queue.authenticated,
      },
      limits: {
        mediaByteCanaryMaxAgeMs: parseReadinessDurationMs(
          'PROCESS_AUDIO_YOUTUBE_MEDIA_CANARY_MAX_AGE_MS',
          15 * 60 * 1000
        ),
        queueOldestMaxAgeMs: parseReadinessDurationMs(
          'PROCESS_AUDIO_YOUTUBE_QUEUE_OLDEST_MAX_AGE_MS',
          6 * 60 * 60 * 1000
        ),
      },
    });

    res.status(snapshot.serviceReadiness.ready ? 200 : 503).json({
      service: 'process-audio',
      revision: process.env.K_REVISION || 'local',
      ...snapshot,
    });
  } catch (error) {
    logger.error('Failed to build YouTube readiness snapshot', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(503).json({
      service: 'process-audio',
      revision: process.env.K_REVISION || 'local',
      serviceReadiness: {
        ready: false,
        reasonCodes: ['READINESS_CHECK_FAILED'],
        degradedScopes: ['youtube_guest', 'youtube_authenticated'],
      },
    });
  }
});

app.post('/process-audio', async (request: Request<{}, {}, { data: ProcessAudioInputType }>, res) => {
  const timeoutMillis = (TIMEOUT_SECONDS - 30) * 1000; // 30s less than timeoutSeconds
  const data = request.body?.data;

  // Create context for this request
  const ctx = createContext(data?.id, 'process-audio');
  const log = createLoggerWithContext(ctx);

  log.info('Request received', {
    hasData: !!data,
    sourceType: 'youtubeUrl' in (data || {}) ? 'youtube' : 'storageFilePath' in (data || {}) ? 'storage' : 'unknown',
  });

  // data checks
  if (!data || !validateAddIntroOutroData(data)) {
    log.warn('Invalid request data');
    res.status(400).send(
      `Invalid body: body must be an object with the following field: 
         id (string),
         startTime (number),
         duration (number),
         youtubeUrl (string) || storageFilePath (string),
         introUrl (string),
         outroUrl (string)`
    );
    return;
  }

  const audioSource = getAudioSource(data);
  const taskId = extractCloudTaskId(request.headers['x-cloudtasks-taskname']);
  const docRef = db.collection('sermons').withConverter(firestoreAdminSermonConverter).doc(data.id);
  const sermonStatus: sermonStatus = {
    subsplash: uploadStatus.NOT_UPLOADED,
    soundCloud: uploadStatus.NOT_UPLOADED,
    audioStatus: sermonStatusType.PROCESSING,
  };

  if (audioSource.type === 'YouTubeUrl' && !youtubeProcessingEnabled) {
    const message = 'This process-audio runtime only supports storage-backed audio processing.';
    log.error('Rejected unsupported YouTube request for storage-only runtime', {
      runtimeProfile,
      runtimeHost,
      runtimeEnv,
      taskId,
    });

    try {
      await completeProcessAudioFailure({
        database: realtimeDB,
        payload: data,
        requestId: ctx.requestId,
        taskId,
      });
    } catch (queueStateError) {
      log.error('Failed to update process-audio queue state after unsupported request rejection', {
        error: queueStateError instanceof Error ? queueStateError.message : String(queueStateError),
      });
    }

    try {
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.ERROR,
          message,
        },
      });
    } catch (updateError) {
      log.error('Failed to update document status after unsupported request rejection', { error: updateError });
    }

    res.status(409).json({ error: message });
    return;
  }

  try {
    const cancelToken = new CancelToken();
    await executeWithTimeout(
      () =>
        processAudio(
          ytdlpPath ?? 'yt-dlp',
          cancelToken,
          bucket,
          realtimeDB,
          db,
          audioSource,
          docRef,
          sermonStatus,
          data.startTime,
          data.duration,
          data.deleteOriginal,
          data.skipTranscode,
          data.introUrl,
          data.outroUrl,
          ctx,
          taskId
        ),
      cancelToken.cancel,
      timeoutMillis
    );
    await completeProcessAudioSuccess({
      database: realtimeDB,
      payload: data,
      requestId: ctx.requestId,
      taskId,
      ctx,
    });
    log.info('Request completed successfully');
    res.status(200).send();
  } catch (e) {
    let message = 'Something Went Wrong';
    if (isAxiosError(e)) {
      // Check Axios errors first since AxiosError extends Error
      message = e.message;
    } else if (e instanceof Error) {
      message = e.message;
    }

    if (isMissingSermonDocumentError(e)) {
      log.warn(
        'Sermon document disappeared before audio processing could begin; clearing queue state and skipping task',
        {
          sermonId: data.id,
          documentPath: e.documentPath,
          taskId,
        }
      );

      try {
        await cleanupDeletedSermonProcessAudioState({
          database: realtimeDB,
          payload: data,
          requestId: ctx.requestId,
          taskId,
          ctx,
        });
      } catch (cleanupError) {
        log.error('Failed to clear process-audio queue state for deleted sermon', {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          sermonId: data.id,
          taskId,
        });
        res.status(500).json({ error: message });
        return;
      }

      res.status(200).json({ skipped: true, reason: 'sermon_deleted' });
      return;
    }

    if (isProcessAudioAlreadyRunningError(e)) {
      log.info('Duplicate process-audio request detected while another request is already running', {
        sermonId: data.id,
        activeRequestId: e.activeRequestId,
        lockAgeMs: e.lockAgeMs,
        taskId,
      });
      res.status(202).json({
        active: true,
        reason: 'already_running',
        activeRequestId: e.activeRequestId,
      });
      return;
    }

    Sentry.withScope((scope) => {
      scope.setTag('route', 'process-audio');
      scope.setTag('runtimeHost', runtimeHost);
      scope.setTag('runtimeEnv', runtimeEnv);
      scope.setTag('audioSourceType', audioSource.type);
      scope.setContext('processAudio', {
        sermonId: data.id,
        requestId: ctx.requestId,
        taskId: taskId ?? null,
        audioSource: audioSource.source,
        youtubeProcessingEnabled,
        browserFallbackConfigured,
        browserFallbackEnabled,
        ytDlpVersion: ytDlpVersion ?? null,
        poTokenProviderConfigured: youtubeProcessingEnabled && !!process.env.YTDLP_POT_PROVIDER_BASE_URL,
      });

      if (request.auth?.email) {
        scope.setUser({
          email: request.auth.email,
          id: request.auth.sub,
          username: request.auth.name,
        });
      }

      Sentry.captureException(e);
    });

    const browserFallbackError = (e as Error & { browserFallbackError?: Partial<BrowserFallbackErrorResponse> })
      ?.browserFallbackError;
    const reportedAcquisitionEvidence = (e as Error & { youtubeAcquisitionEvidence?: YouTubeAcquisitionEvidence })
      ?.youtubeAcquisitionEvidence;
    const browserFallbackUnavailable =
      browserFallbackError?.code === 'auth_required' || browserFallbackError?.code === 'session_unhealthy';
    const youtubeAcquisitionEvidence =
      audioSource.type === 'YouTubeUrl'
        ? reportedAcquisitionEvidence ??
          (browserFallbackUnavailable
            ? {
                attemptedModes: ['public_provider', 'cookie_provider'],
                authenticatedFailureClass: 'browser_fallback_failed',
                requiresAuthenticationRecovery: true,
              }
            : undefined)
        : undefined;
    const youtubeFailureDisposition = youtubeAcquisitionEvidence
      ? getYouTubeFailureDisposition(youtubeAcquisitionEvidence)
      : undefined;
    const youtubeFailureClass = youtubeAcquisitionEvidence?.requiresAuthenticationRecovery
      ? youtubeAcquisitionEvidence.authenticatedFailureClass
      : youtubeAcquisitionEvidence?.guestFailureClass;
    const youtubeAlertCode = youtubeFailureClass
      ? toYouTubeAlertCode(youtubeFailureClass as YouTubeFailureClass)
      : null;

    log.error('Request failed', {
      error: message,
      errorType: e?.constructor?.name,
      stack: e instanceof Error ? e.stack : undefined,
      serviceRevision: process.env.K_REVISION || 'local',
      browserFallbackConfigured,
      browserFallbackEnabled,
      poTokenProviderBaseUrl: process.env.YTDLP_POT_PROVIDER_BASE_URL || null,
      youtubeAcquisitionEvidence: youtubeAcquisitionEvidence ?? null,
      browserFallbackError: browserFallbackError ?? null,
      ytDlpSleepRequestsSeconds,
      ytDlpSleepIntervalSeconds,
      ytDlpMaxSleepIntervalSeconds,
    });

    if (youtubeAcquisitionEvidence) {
      log.warn('Analyzed YouTube extraction failure', {
        ...youtubeAcquisitionEvidence,
        failureDisposition: youtubeFailureDisposition,
        browserFallbackError: browserFallbackError ?? null,
        browserFallbackConfigured,
        browserFallbackEnabled,
        poTokenProviderBaseUrl: process.env.YTDLP_POT_PROVIDER_BASE_URL || null,
        ytDlpSleepRequestsSeconds,
        ytDlpSleepIntervalSeconds,
        ytDlpMaxSleepIntervalSeconds,
      });
    }

    const cookieRefreshFailed =
      audioSource.type === 'YouTubeUrl' &&
      youtubeFailureClass === 'cookie_session_stale_or_challenged' &&
      ctx.youtubeCookieRefreshAttempted === true &&
      ctx.youtubeCookieRefreshSucceeded === false;
    const alertCode = cookieRefreshFailed
      ? 'YOUTUBE_COOKIE_REFRESH_STACK_DOWN'
      : youtubeAlertCode ?? 'PROCESS_AUDIO_RUNTIME_FAILURE';
    const alertSummary = cookieRefreshFailed
      ? 'process-audio deferred a YouTube request because the shared browser refresh stack could not recover the authenticated session.'
      : youtubeFailureClass && alertCode !== 'youtube_runtime_failure'
      ? `process-audio Cloud Run request failed during YouTube extraction (${alertCode}).`
      : 'process-audio Cloud Run request failed while processing sermon audio.';

    if (audioSource.type === 'YouTubeUrl' && youtubeFailureDisposition?.action === 'post_live_retry') {
      const postLiveResult = await deferPostLiveArchiveYouTubeRequest({
        database: realtimeDB,
        payload: data,
        requestId: ctx.requestId,
        taskId,
        failureClass: youtubeFailureClass ?? 'post_live_archive_not_ready',
        failureMessage: message,
      });

      if (postLiveResult.scheduled) {
        try {
          await docRef.update({
            status: {
              ...sermonStatus,
              audioStatus: sermonStatusType.PENDING,
              message: 'Waiting for YouTube to finish processing the livestream archive before retrying.',
            },
          });
        } catch (updateError) {
          log.error('Failed to update document status after post-live archive defer', { error: updateError });
        }

        log.info('Deferred post-live YouTube archive processing until the VOD is ready', {
          sermonId: data.id,
          requestId: ctx.requestId,
          scheduledTaskId: postLiveResult.scheduledTaskId,
          scheduledFor: postLiveResult.scheduledFor,
          retryCount: postLiveResult.retryCount,
          maxRetryCount: postLiveResult.maxRetryCount,
        });

        res.status(202).json({
          deferred: true,
          reason: youtubeFailureClass,
          retryCount: postLiveResult.retryCount,
          scheduledFor: postLiveResult.scheduledFor,
        });
        return;
      }

      log.warn('Post-live YouTube archive retry budget exhausted; treating as process-audio failure', {
        sermonId: data.id,
        requestId: ctx.requestId,
        retryCount: postLiveResult.retryCount,
        maxRetryCount: postLiveResult.maxRetryCount,
      });
    }

    if (audioSource.type === 'YouTubeUrl' && youtubeFailureDisposition?.action === 'defer') {
      await deferYouTubeRequestForAuthentication({
        database: realtimeDB,
        payload: data,
        requestId: ctx.requestId,
        failureClass: youtubeFailureClass ?? 'authentication_recovery_required',
        failureMessage: message,
        probeMode: browserFallbackUnavailable ? 'browser_fallback' : 'cookie_provider',
      });

      try {
        await docRef.update({
          status: {
            ...sermonStatus,
            audioStatus: sermonStatusType.PENDING,
            message: `${youtubeFailureDisposition.code}: Waiting for the authenticated YouTube session to recover before retrying.`,
          },
        });
      } catch (updateError) {
        log.error('Failed to update document status after authenticated YouTube defer', { error: updateError });
      }

      try {
        await emitOperationalAlertEmail({
          alertCode: browserFallbackUnavailable ? 'browser_fallback_failed' : alertCode,
          summary:
            'process-audio deferred one YouTube request while the authenticated session recovers; guest-capable requests remain active.',
          error: e,
          sermonId: data?.id,
          context: {
            requestId: ctx.requestId,
            operation: ctx.operation,
            audioSourceType: audioSource.type,
            audioSource: audioSource.source,
            youtubeAcquisitionEvidence,
            dependencyScope: youtubeFailureDisposition.dependencyScope,
            browserFallbackError: browserFallbackError ?? null,
          },
        });
      } catch (alertError) {
        log.error('Failed to queue operational alert email', {
          error: alertError instanceof Error ? alertError.message : String(alertError),
        });
      }

      res.status(202).json({
        deferred: true,
        reason: youtubeFailureDisposition.code,
        dependencyScope: youtubeFailureDisposition.dependencyScope,
      });
      return;
    }

    try {
      await completeProcessAudioFailure({
        database: realtimeDB,
        payload: data,
        requestId: ctx.requestId,
        taskId,
      });
    } catch (queueStateError) {
      log.error('Failed to update process-audio queue state after failure', {
        error: queueStateError instanceof Error ? queueStateError.message : String(queueStateError),
      });
    }

    try {
      await emitOperationalAlertEmail({
        alertCode,
        summary: alertSummary,
        error: e,
        sermonId: data?.id,
        context: {
          requestId: ctx.requestId,
          operation: ctx.operation,
          audioSourceType: audioSource.type,
          audioSource: audioSource.source,
          serviceRevision: process.env.K_REVISION || 'local',
          runtimeHost,
          runtimeEnv,
          ytDlpVersion,
          browserFallbackConfigured,
          browserFallbackEnabled,
          localBrowserProfileBrowser: localBrowserProfileDir ? localBrowserProfileBrowser : null,
          poTokenProviderBaseUrl: process.env.YTDLP_POT_PROVIDER_BASE_URL || null,
          youtubeFailureClass: youtubeFailureClass ?? null,
          youtubeAcquisitionEvidence: youtubeAcquisitionEvidence ?? null,
          youtubeFailureDisposition: youtubeFailureDisposition ?? null,
          cookieRefreshAttempted: ctx.youtubeCookieRefreshAttempted ?? false,
          cookieRefreshSucceeded: ctx.youtubeCookieRefreshSucceeded ?? false,
          requesterEmail: request.auth?.email ?? null,
          requesterUid: request.auth?.sub ?? null,
          requesterName: request.auth?.name ?? null,
        },
      });
    } catch (alertError) {
      log.error('Failed to queue operational alert email', {
        error: alertError instanceof Error ? alertError.message : String(alertError),
      });
    }

    try {
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.ERROR,
          message: message,
        },
      });
    } catch (updateError) {
      log.error('Failed to update document status', { error: updateError });
    }
    res.status(500).json({ error: message });
  } finally {
    await logMemoryUsage('Final Memory Usage', ctx);
  }
});

Sentry.setupExpressErrorHandler(app);

const port = parseInt(process.env.PORT ?? '') || 8080;
app.listen(port, () => {
  logger.info('Service started', { port });
});
