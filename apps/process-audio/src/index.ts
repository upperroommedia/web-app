import express, { Request } from 'express';
import { spawnSync } from 'node:child_process';
import { executeWithTimeout, getAudioSource, getFFmpegPath, logMemoryUsage, validateAddIntroOutroData } from './utils';
import { ProcessAudioInputType, sermonStatusType, uploadStatus, sermonStatus } from './types';
import { isAxiosError } from 'axios';
import { isMissingSermonDocumentError, processAudio } from './processAudio';
import { CancelToken } from './CancelToken';
import { firestoreAdminSermonConverter } from './firestoreAdminDataConverter';
import { TIMEOUT_SECONDS } from './consts';
import firebaseAdmin from './firebaseAdmin';
import logger, { createLoggerWithContext } from './WinstonLogger';
import { createContext } from './context';
import { emitOperationalAlertEmail } from './operationalAlerts';
import { analyzeYouTubeFailure } from './youtubeExtractionPolicy';
import {
  cleanupDeletedSermonProcessAudioState,
  completeProcessAudioFailure,
  completeProcessAudioSuccess,
  deferStaleYouTubeRequest,
  extractCloudTaskId,
} from './processAudioQueueStore';
import type { BrowserFallbackErrorResponse } from '@upperroom/contracts/browserFallback';

const YOUTUBE_BROWSER_FALLBACK_BLOCKER_REASON = 'browser_fallback_unavailable';

const app = express();
app.use(express.json());
// get the path to the yt-dlp binary
const ytdlpPath = 'yt-dlp';
const configuredYtDlpJsRuntime = process.env.YTDLP_JS_RUNTIME?.trim() || 'deno';
const localBrowserProfileDir = process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR?.trim() || '';
const localBrowserProfileBrowser = process.env.PROCESS_AUDIO_BROWSER_PROFILE_BROWSER?.trim() || 'chromium';
const runtimeHost = process.env.PROCESS_AUDIO_RUNTIME_HOST?.trim() || 'cloud-run';
const runtimeEnv = process.env.PROCESS_AUDIO_RUNTIME_ENV?.trim() || process.env.NODE_ENV || 'unknown';
const ytDlpVersion = process.env.PROCESS_AUDIO_YT_DLP_VERSION?.trim() || 'unknown';

function validateConfiguredYtDlpJsRuntime(): { runtime: string; version: string } {
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

const ytDlpJsRuntimeInfo = validateConfiguredYtDlpJsRuntime();
const ytDlpSleepRequestsSeconds = process.env.YTDLP_SLEEP_REQUESTS_SECONDS?.trim() || null;
const ytDlpSleepIntervalSeconds = process.env.YTDLP_SLEEP_INTERVAL_SECONDS?.trim() || null;
const ytDlpMaxSleepIntervalSeconds = process.env.YTDLP_MAX_SLEEP_INTERVAL_SECONDS?.trim() || null;
const ytDlpForceIpv4 = process.env.YOUTUBE_FORCE_IPV4?.trim() || 'false';
const browserFallbackExplicit = process.env.YOUTUBE_BROWSER_FALLBACK_ENABLED?.trim().toLowerCase() || '';
const inProcessBrowserFallbackConfigured = !!(
  localBrowserProfileDir ||
  process.env.BROWSER_FALLBACK_PROFILE_BUCKET?.trim() || process.env.FIREBASE_STORAGE_BUCKET?.trim()
);
const finalBrowserFallbackConfigured = !!process.env.YOUTUBE_FINAL_BROWSER_FALLBACK_URL?.trim();
const browserFallbackEnabled =
  !['0', 'false', 'no'].includes(browserFallbackExplicit) &&
  (inProcessBrowserFallbackConfigured || finalBrowserFallbackConfigured || !!process.env.YOUTUBE_BROWSER_FALLBACK_URL?.trim());
const browserFallbackConfigured = browserFallbackEnabled || finalBrowserFallbackConfigured;

logger.info('Service initializing', {
  ytdlpPath,
  configuredYtDlpJsRuntime,
  ytDlpJsRuntime: ytDlpJsRuntimeInfo.runtime,
  ytDlpJsRuntimeVersion: ytDlpJsRuntimeInfo.version,
  ytDlpUseCookiesForPublicVideos: process.env.YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS || 'false',
  ytDlpConcurrentFragments: process.env.YTDLP_CONCURRENT_FRAGMENTS || '1',
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
  ytDlpVersion,
  finalBrowserFallbackConfigured,
  poTokenProviderConfigured: !!process.env.YTDLP_POT_PROVIDER_BASE_URL,
});

logger.info('Loading storage, realtimeDB and firestore');
const bucket = firebaseAdmin.storage().bucket();
const realtimeDB = firebaseAdmin.database();
const db = firebaseAdmin.firestore();

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
logger.info('Service ready');

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

app.get('/healthz', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'process-audio-cloud-run',
    revision: process.env.K_REVISION || 'local',
    browserFallbackConfigured,
    browserFallbackEnabled,
    inProcessBrowserFallbackConfigured,
    localBrowserProfileDir: localBrowserProfileDir || null,
    finalBrowserFallbackConfigured,
    poTokenProviderConfigured: !!process.env.YTDLP_POT_PROVIDER_BASE_URL,
    ytDlpJsRuntime: ytDlpJsRuntimeInfo.runtime,
    ytDlpUseCookiesForPublicVideos: process.env.YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS || 'false',
    ytDlpSleepRequestsSeconds,
    ytDlpSleepIntervalSeconds,
    ytDlpMaxSleepIntervalSeconds,
    ytDlpForceIpv4,
  });
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

  try {
    const cancelToken = new CancelToken();
    await executeWithTimeout(
      () =>
        processAudio(
          ytdlpPath,
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
      log.warn('Sermon document disappeared before audio processing could begin; clearing queue state and skipping task', {
        sermonId: data.id,
        documentPath: e.documentPath,
        taskId,
      });

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

    const youtubeFailureAnalysis =
      audioSource.type === 'YouTubeUrl' ? analyzeYouTubeFailure(message, 'public_provider') : undefined;
    const browserFallbackError = (e as Error & { browserFallbackError?: Partial<BrowserFallbackErrorResponse> })
      ?.browserFallbackError;

    log.error('Request failed', {
      error: message,
      errorType: e?.constructor?.name,
      stack: e instanceof Error ? e.stack : undefined,
      serviceRevision: process.env.K_REVISION || 'local',
      browserFallbackConfigured,
      browserFallbackEnabled,
      poTokenProviderBaseUrl: process.env.YTDLP_POT_PROVIDER_BASE_URL || null,
      youtubeFailureAnalysis: youtubeFailureAnalysis ?? null,
      browserFallbackError: browserFallbackError ?? null,
      ytDlpSleepRequestsSeconds,
      ytDlpSleepIntervalSeconds,
      ytDlpMaxSleepIntervalSeconds,
    });

    if (youtubeFailureAnalysis) {
      log.warn('Analyzed YouTube extraction failure', {
        ...youtubeFailureAnalysis,
        browserFallbackError: browserFallbackError ?? null,
        browserFallbackConfigured,
        browserFallbackEnabled,
        poTokenProviderBaseUrl: process.env.YTDLP_POT_PROVIDER_BASE_URL || null,
        ytDlpSleepRequestsSeconds,
        ytDlpSleepIntervalSeconds,
        ytDlpMaxSleepIntervalSeconds,
      });
    }

    const youtubeFailureClass = youtubeFailureAnalysis?.failureClass;
    const browserFallbackUnavailable =
      browserFallbackError?.code === 'auth_required' || browserFallbackError?.code === 'session_unhealthy';
    const alertCode = youtubeFailureAnalysis?.alertCode ?? 'PROCESS_AUDIO_RUNTIME_FAILURE';
    const alertSummary =
      youtubeFailureClass && alertCode !== 'youtube_runtime_failure'
        ? `process-audio Cloud Run request failed during YouTube extraction (${alertCode}).`
        : 'process-audio Cloud Run request failed while processing sermon audio.';

    if (audioSource.type === 'YouTubeUrl' && youtubeFailureClass === 'cookie_session_stale_or_challenged') {
      const staleResult = await deferStaleYouTubeRequest({
        database: realtimeDB,
        payload: data,
        requestId: ctx.requestId,
        failureClass: youtubeFailureClass,
        failureMessage: message,
      });

      if (staleResult.shouldAlert) {
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
              youtubeFailureStage: youtubeFailureAnalysis?.stage ?? null,
              youtubeFailureSignals: youtubeFailureAnalysis ?? null,
              cookieRefreshAttempted: ctx.youtubeCookieRefreshAttempted ?? false,
              cookieRefreshSucceeded: ctx.youtubeCookieRefreshSucceeded ?? false,
              blockerEpisodeId: staleResult.blockerEpisodeId,
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
      }

      try {
        await docRef.update({
          status: {
            ...sermonStatus,
            audioStatus: sermonStatusType.PENDING,
            message: 'Waiting for refreshed YouTube cookies before retrying.',
          },
        });
      } catch (updateError) {
        log.error('Failed to update document status after stale cookie defer', { error: updateError });
      }

      res.status(202).json({ deferred: true, reason: youtubeFailureClass });
      return;
    }

    if (audioSource.type === 'YouTubeUrl' && browserFallbackUnavailable) {
      const browserFallbackResult = await deferStaleYouTubeRequest({
        database: realtimeDB,
        payload: data,
        requestId: ctx.requestId,
        failureClass: YOUTUBE_BROWSER_FALLBACK_BLOCKER_REASON,
        failureMessage: message,
        probeMode: 'browser_fallback',
      });

      if (browserFallbackResult.shouldAlert) {
        try {
          await emitOperationalAlertEmail({
            alertCode: 'browser_fallback_failed',
            summary: 'process-audio deferred a YouTube request because the browser fallback worker is unavailable or unhealthy.',
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
              youtubeFailureStage: youtubeFailureAnalysis?.stage ?? null,
              youtubeFailureSignals: youtubeFailureAnalysis ?? null,
              cookieRefreshAttempted: ctx.youtubeCookieRefreshAttempted ?? false,
              cookieRefreshSucceeded: ctx.youtubeCookieRefreshSucceeded ?? false,
              browserFallbackError: browserFallbackError ?? null,
              blockerEpisodeId: browserFallbackResult.blockerEpisodeId,
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
      }

      try {
        await docRef.update({
          status: {
            ...sermonStatus,
            audioStatus: sermonStatusType.PENDING,
            message: 'Waiting for the browser fallback worker to become healthy before retrying.',
          },
        });
      } catch (updateError) {
        log.error('Failed to update document status after browser fallback defer', { error: updateError });
      }

      res.status(202).json({ deferred: true, reason: YOUTUBE_BROWSER_FALLBACK_BLOCKER_REASON });
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
          youtubeFailureStage: youtubeFailureAnalysis?.stage ?? null,
          youtubeFailureSignals: youtubeFailureAnalysis ?? null,
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

const port = parseInt(process.env.PORT ?? '') || 8080;
app.listen(port, () => {
  logger.info('Service started', { port });
});
