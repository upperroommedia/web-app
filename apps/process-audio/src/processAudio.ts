import path from 'path';
import { Bucket } from '@google-cloud/storage';
import { Sermon, sermonStatus, sermonStatusType } from './types';
import { Database } from 'firebase-admin/database';
import { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { CustomMetadata, FilePaths, AudioSource } from './types';
import { CancelToken } from './CancelToken';
import {
  logMemoryUsage,
  secondsToTimeFormat,
  downloadFiles,
  getDurationSeconds,
  createTempFile,
  unlinkSafeTempFile,
} from './utils';
import trimAndTranscode from './trimAndTranscode';
import mergeFiles from './mergeFiles';
import { PROCESSED_SERMONS_BUCKET } from './consts';
import trim from './trim';
import { createLoggerWithContext } from './WinstonLogger';
import { LogContext, createChildContext, createContext } from './context';
import { markProcessAudioRequestRunning } from './processAudioQueueStore';
import { setProcessAudioProgress } from './processAudioProgress';
import { Sentry } from './instrument';

const DEFAULT_PROCESS_AUDIO_LOCK_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PROCESS_AUDIO_LOCK_HEARTBEAT_INTERVAL_MS = 30 * 1000;

type ProcessAudioLockState = {
  requestId?: string;
  acquiredAt?: number;
  acquiredAtIso?: string;
  lastHeartbeatAt?: number;
  lastHeartbeatAtIso?: string;
};

function parsePositiveIntegerEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getProcessAudioLockTtlMs(): number {
  return parsePositiveIntegerEnv('PROCESS_AUDIO_LOCK_TTL_MS') ?? DEFAULT_PROCESS_AUDIO_LOCK_TTL_MS;
}

function getProcessAudioLockHeartbeatIntervalMs(): number {
  const configured = parsePositiveIntegerEnv('PROCESS_AUDIO_LOCK_HEARTBEAT_INTERVAL_MS');
  if (configured) {
    return configured;
  }

  return Math.min(DEFAULT_PROCESS_AUDIO_LOCK_HEARTBEAT_INTERVAL_MS, Math.max(1000, getProcessAudioLockTtlMs() / 3));
}

export class MissingSermonDocumentError extends Error {
  readonly sermonId: string;
  readonly documentPath: string;

  constructor(sermonId: string, documentPath: string) {
    super(`Sermon Document ${sermonId} Not Found at path: ${documentPath}`);
    this.name = 'MissingSermonDocumentError';
    this.sermonId = sermonId;
    this.documentPath = documentPath;
  }
}

export const isMissingSermonDocumentError = (error: unknown): error is MissingSermonDocumentError => {
  return error instanceof MissingSermonDocumentError;
};

export class ProcessAudioAlreadyRunningError extends Error {
  readonly sermonId: string;
  readonly activeRequestId: string | null;
  readonly lockAgeMs: number | null;

  constructor(args: { sermonId: string; activeRequestId: string | null; lockAgeMs: number | null }) {
    super(`A process-audio request is already running for sermon ${args.sermonId}`);
    this.name = 'ProcessAudioAlreadyRunningError';
    this.sermonId = args.sermonId;
    this.activeRequestId = args.activeRequestId;
    this.lockAgeMs = args.lockAgeMs;
  }
}

export const isProcessAudioAlreadyRunningError = (error: unknown): error is ProcessAudioAlreadyRunningError => {
  return error instanceof ProcessAudioAlreadyRunningError;
};

export interface ProcessAudioResult {
  alreadyProcessed: boolean;
  youtubeSuccessfulAcquisitionAuthority?: LogContext['youtubeSuccessfulAcquisitionAuthority'];
}

async function acquireProcessAudioLock(
  realtimeDB: Database,
  sermonId: string,
  requestId: string,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<{ acquired: boolean; currentLock: ProcessAudioLockState | null }> {
  const lockRef = realtimeDB.ref(`processAudioLocks/${sermonId}`);
  const now = Date.now();
  const lockTtlMs = getProcessAudioLockTtlMs();

  const result = await lockRef.transaction((current) => {
    if (current && typeof current === 'object') {
      const lockState = current as ProcessAudioLockState;
      const existingRequestId = typeof lockState.requestId === 'string' ? lockState.requestId : undefined;
      const lastHeartbeatAt =
        typeof lockState.lastHeartbeatAt === 'number'
          ? lockState.lastHeartbeatAt
          : typeof lockState.acquiredAt === 'number'
          ? lockState.acquiredAt
          : 0;
      const expired = !lastHeartbeatAt || now - lastHeartbeatAt > lockTtlMs;
      if (existingRequestId && !expired && existingRequestId !== requestId) {
        return;
      }
    }

    return {
      requestId,
      acquiredAt: now,
      acquiredAtIso: new Date(now).toISOString(),
      lastHeartbeatAt: now,
      lastHeartbeatAtIso: new Date(now).toISOString(),
    };
  });

  const currentLock = (result.snapshot?.val() as ProcessAudioLockState | null) ?? null;
  const acquired = !!result.committed && currentLock?.requestId === requestId;
  if (!acquired) {
    const lastHeartbeatAt =
      typeof currentLock?.lastHeartbeatAt === 'number'
        ? currentLock.lastHeartbeatAt
        : typeof currentLock?.acquiredAt === 'number'
        ? currentLock.acquiredAt
        : null;
    log.warn('Another process-audio request already holds the sermon lock', {
      sermonId,
      requestId,
      activeRequestId: currentLock?.requestId ?? null,
      lockAgeMs: lastHeartbeatAt ? now - lastHeartbeatAt : null,
    });
  }
  return {
    acquired,
    currentLock,
  };
}

function startProcessAudioLockHeartbeat(
  realtimeDB: Database,
  sermonId: string,
  requestId: string,
  log: ReturnType<typeof createLoggerWithContext>
): () => void {
  const lockRef = realtimeDB.ref(`processAudioLocks/${sermonId}`);
  const intervalMs = getProcessAudioLockHeartbeatIntervalMs();
  let stopped = false;
  let heartbeatInFlight = false;

  const interval = setInterval(() => {
    if (stopped || heartbeatInFlight) {
      return;
    }

    heartbeatInFlight = true;
    const heartbeatAt = Date.now();
    lockRef.transaction((current) => {
      if (!current || typeof current !== 'object') {
        return current;
      }

      const lockState = current as ProcessAudioLockState;
      if (lockState.requestId !== requestId) {
        return current;
      }

      return {
        ...lockState,
        acquiredAt: typeof lockState.acquiredAt === 'number' ? lockState.acquiredAt : heartbeatAt,
        acquiredAtIso:
          typeof lockState.acquiredAtIso === 'string' && lockState.acquiredAtIso
            ? lockState.acquiredAtIso
            : new Date(heartbeatAt).toISOString(),
        lastHeartbeatAt: heartbeatAt,
        lastHeartbeatAtIso: new Date(heartbeatAt).toISOString(),
      } satisfies ProcessAudioLockState;
    })
      .then((result) => {
        const currentLock = (result.snapshot?.val() as ProcessAudioLockState | null) ?? null;
        if (!result.committed || currentLock?.requestId !== requestId) {
          log.warn('Lost ownership of process-audio sermon lock heartbeat', {
            sermonId,
            requestId,
            activeRequestId: currentLock?.requestId ?? null,
          });
        }
      })
      .catch((error) => {
        log.warn('Failed to renew process-audio sermon lock heartbeat', {
          sermonId,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, intervalMs);

  interval.unref?.();

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

async function releaseProcessAudioLock(
  realtimeDB: Database,
  sermonId: string,
  requestId: string,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<void> {
  const lockRef = realtimeDB.ref(`processAudioLocks/${sermonId}`);
  try {
    const snapshot = await lockRef.get();
    const current = snapshot.val();
    if (current?.requestId === requestId) {
      await lockRef.remove();
      log.debug('Released process-audio sermon lock', { sermonId, requestId });
    }
  } catch (error) {
    log.warn('Failed to release process-audio sermon lock', {
      sermonId,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const processAudio = async (
  ytdlpPath: string,
  cancelToken: CancelToken,
  bucket: Bucket,
  realtimeDB: Database,
  db: Firestore,
  audioSource: AudioSource,
  docRef: DocumentReference<Sermon>,
  sermonStatus: sermonStatus,
  startTime: number,
  duration: number,
  deleteOriginal?: boolean,
  skipTranscode?: boolean,
  introUrl?: string,
  outroUrl?: string,
  ctx?: LogContext,
  taskId?: string | null
): Promise<ProcessAudioResult> => {
  const fileName = audioSource.id;
  // Use provided context or create a new one with sermonId
  const contextWithSermonId = ctx ?? createContext(fileName, 'process-audio');
  const log = createLoggerWithContext(contextWithSermonId);
  const tempFiles = new Set<string>();
  const lockRequestId = contextWithSermonId.requestId;
  let lockAcquired = false;
  let stopLockHeartbeat: (() => void) | null = null;
  const buildResult = (alreadyProcessed = false): ProcessAudioResult => ({
    alreadyProcessed,
    youtubeSuccessfulAcquisitionAuthority: contextWithSermonId.youtubeSuccessfulAcquisitionAuthority,
  });

  return Sentry.startSpan(
    {
      name: 'process-audio.run',
      op: 'process_audio.run',
      attributes: {
        'process_audio.sermon_id': fileName,
        'process_audio.audio_source_type': audioSource.type,
        'process_audio.skip_transcode': Boolean(skipTranscode),
        'process_audio.has_intro': Boolean(introUrl),
        'process_audio.has_outro': Boolean(outroUrl),
        'process_audio.task_id': taskId ?? 'none',
      },
    },
    async () => {
  log.info('Starting audio processing', {
    fileName,
    startTime,
    duration,
    sourceType: audioSource.type,
    skipTranscode: !!skipTranscode,
    hasIntro: !!introUrl,
    hasOutro: !!outroUrl,
  });

  await logMemoryUsage('Initial Memory Usage', contextWithSermonId, tempFiles);

  // Log Firestore connection details
  const isDevelopment = process.env.NODE_ENV === 'development';
  const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  const documentPath = docRef.path;

  log.info('Attempting to access Firestore document', {
    documentPath,
    isDevelopment,
    firestoreEmulatorHost: firestoreEmulatorHost || 'production',
    firestoreUrl: firestoreEmulatorHost ? `http://${firestoreEmulatorHost}` : 'https://firestore.googleapis.com',
  });

  // the document may not exist yet, if it doesn't wait 5 seconds and try again do this for a max of 3 times before throwing an error
  const maxTries = 3;
  let currentTry = 0;
  let docFound = false;
  let title = 'untitled';
  let existingStatus: sermonStatus | undefined;
  while (currentTry < maxTries) {
    currentTry++;
    log.debug('Checking if document exists', {
      attempt: currentTry,
      maxTries,
      documentPath,
      firestoreEmulatorHost: firestoreEmulatorHost || 'production',
    });

    const doc = await docRef.get();

    if (doc.exists) {
      docFound = true;
      const d = doc.data();
      title = d?.title || 'No title found';
      existingStatus = d?.status as sermonStatus | undefined;
      log.info('Document found', { documentPath, title, attempt: currentTry });
      break;
    }

    if (currentTry < maxTries) {
      log.debug('No document exists, retrying', {
        attempt: currentTry,
        maxTries,
        documentPath,
        nextRetryIn: '5 seconds',
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  if (!docFound) {
    log.error('Sermon document not found after retries', {
      fileName,
      attempts: maxTries,
      documentPath,
      firestoreEmulatorHost: firestoreEmulatorHost || 'production',
      firestoreUrl: firestoreEmulatorHost ? `http://${firestoreEmulatorHost}` : 'https://firestore.googleapis.com',
    });
    throw new MissingSermonDocumentError(fileName, documentPath);
  }

  if (existingStatus?.audioStatus === sermonStatusType.PROCESSED) {
    log.info('Sermon already processed, skipping (idempotent)', { documentPath, fileName });
    return buildResult(true);
  }

  try {
    const lockResult = await acquireProcessAudioLock(realtimeDB, fileName, lockRequestId, log);
    lockAcquired = lockResult.acquired;
    if (!lockAcquired) {
      const currentLock = lockResult.currentLock;
      const lastHeartbeatAt =
        typeof currentLock?.lastHeartbeatAt === 'number'
          ? currentLock.lastHeartbeatAt
          : typeof currentLock?.acquiredAt === 'number'
          ? currentLock.acquiredAt
          : null;
      throw new ProcessAudioAlreadyRunningError({
        sermonId: fileName,
        activeRequestId: currentLock?.requestId ?? null,
        lockAgeMs: lastHeartbeatAt ? Date.now() - lastHeartbeatAt : null,
      });
    }
    stopLockHeartbeat = startProcessAudioLockHeartbeat(realtimeDB, fileName, lockRequestId, log);

    await markProcessAudioRequestRunning({
      database: realtimeDB,
      payload: audioSource.type === 'YouTubeUrl'
        ? {
            id: audioSource.id,
            youtubeUrl: audioSource.source,
            startTime,
            duration,
            deleteOriginal,
            skipTranscode,
            introUrl,
            outroUrl,
          }
        : {
            id: audioSource.id,
            storageFilePath: audioSource.source,
            startTime,
            duration,
            deleteOriginal,
            skipTranscode,
            introUrl,
            outroUrl,
          },
      requestId: lockRequestId,
      taskId: taskId ?? null,
      ctx: contextWithSermonId,
    });

    if (cancelToken.isCancellationRequested) return buildResult();
    await docRef.update({
      status: {
        ...(existingStatus ?? sermonStatus),
        audioStatus: sermonStatusType.PROCESSING,
        message: 'Getting Data',
      },
    });
    const processedStoragePath = `${PROCESSED_SERMONS_BUCKET}/${fileName}`;
    const audioFilesToMerge: FilePaths = { INTRO: undefined, OUTRO: undefined };
    const customMetadata: CustomMetadata = { duration, title };
    if (introUrl) {
      audioFilesToMerge.INTRO = introUrl;
      customMetadata.introUrl = introUrl;
    }
    if (outroUrl) {
      audioFilesToMerge.OUTRO = outroUrl;
      customMetadata.outroUrl = outroUrl;
    }
    if (cancelToken.isCancellationRequested) return buildResult();

    const trimMessage = skipTranscode
      ? 'Trimming'
      : audioSource.type === 'StorageFilePath'
      ? 'Trimming and Transcoding'
      : 'Downloading YouTube Audio';

    log.info('Starting audio processing step', { step: trimMessage });

    await docRef.update({
      status: {
        ...sermonStatus,
        audioStatus: sermonStatusType.PROCESSING,
        message: trimMessage,
      },
    });

    // Ensure sermonId is always included in context
    // Ensure sermonId is preserved in child context
    const trimCtx = createChildContext(contextWithSermonId, 'trim');

    await Sentry.startSpan(
      {
        name: trimMessage,
        op: skipTranscode ? 'media.trim' : audioSource.type === 'StorageFilePath' ? 'media.transcode' : 'media.download',
        attributes: {
          'process_audio.sermon_id': fileName,
          'process_audio.audio_source_type': audioSource.type,
        },
      },
      async () => {
        if (skipTranscode) {
          if (audioSource.type !== 'StorageFilePath') {
            log.error('Invalid audio source for skipTranscode', { sourceType: audioSource.type });
            throw new Error('Audio source must be a file from processed-sermons in order to trim without transcoding');
          }
          await trim(
            cancelToken,
            bucket,
            audioSource.source,
            processedStoragePath,
            tempFiles,
            realtimeDB.ref(`addIntroOutro/${fileName}`),
            customMetadata,
            startTime,
            duration,
            trimCtx
          );
          return;
        }

        await trimAndTranscode(
          ytdlpPath,
          cancelToken,
          bucket,
          audioSource,
          processedStoragePath,
          tempFiles,
          realtimeDB.ref(`addIntroOutro/${fileName}`),
          realtimeDB,
          docRef,
          sermonStatus,
          customMetadata,
          startTime,
          duration,
          trimCtx
        );
      }
    );

    if (trimCtx.youtubeSuccessfulAcquisitionAuthority) {
      contextWithSermonId.youtubeSuccessfulAcquisitionAuthority = trimCtx.youtubeSuccessfulAcquisitionAuthority;
    }

    log.info('Audio processing step completed', { step: trimMessage });

    // download processed audio for merging
    const processedFilePath = createTempFile(`processed-${fileName}`, tempFiles);
    log.debug('Downloading processed audio and intro/outro files');
    const [tempFilePaths] = await Promise.all([
      downloadFiles(bucket, audioFilesToMerge, tempFiles),
      bucket.file(processedStoragePath).download({ destination: processedFilePath }),
    ]);

    //create merge array in order INTRO, CONTENT, OUTRO
    const filePathsArray: string[] = [];
    if (tempFilePaths.INTRO) filePathsArray.push(tempFilePaths.INTRO);
    filePathsArray.push(processedFilePath);
    if (tempFilePaths.OUTRO) filePathsArray.push(tempFilePaths.OUTRO);

    // use reduce to sum up all the durations of the files from filepaths
    const durationSeconds = (
      await Promise.all(
        [tempFilePaths.INTRO, tempFilePaths.OUTRO].map(async (path) => (path ? await getDurationSeconds(path) : 0))
      )
    ).reduce((accumulator, currentValue) => accumulator + currentValue, duration);

    customMetadata.duration = durationSeconds;
    log.info('Calculated total duration', { durationSeconds, formatted: secondsToTimeFormat(durationSeconds) });

    // if there is an intro or outro, merge the files
    if (filePathsArray.length > 1) {
      log.info('Merging files with intro/outro', { fileCount: filePathsArray.length });
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.PROCESSING,
          message: 'Adding Intro and Outro',
        },
      });
      const outputFilePath = `intro-outro-sermons/${path.basename(fileName)}`;

      // Ensure sermonId is preserved in child context
      const mergeCtx = createChildContext(contextWithSermonId, 'merge');
      const mergedOutputFile = await Sentry.startSpan(
        {
          name: 'process-audio.merge-intro-outro',
          op: 'media.merge',
          attributes: {
            'process_audio.sermon_id': fileName,
            'process_audio.merge_file_count': filePathsArray.length,
          },
        },
        () =>
          mergeFiles(
            cancelToken,
            bucket,
            filePathsArray,
            outputFilePath,
            durationSeconds,
            tempFiles,
            realtimeDB.ref(`addIntroOutro/${fileName}`),
            customMetadata,
            mergeCtx
          )
      );
      log.info('Files merged successfully', { outputPath: mergedOutputFile.name });
      await logMemoryUsage('Memory Usage after merge', contextWithSermonId, tempFiles);
    } else {
      log.debug('No intro or outro, skipping merge');
    }

    if (cancelToken.isCancellationRequested) return buildResult();

    log.info('Updating status to PROCESSED');
    await docRef.update({
      status: {
        ...sermonStatus,
        audioStatus: sermonStatusType.PROCESSED,
      },
      durationSeconds: durationSeconds,
    });

    if (cancelToken.isCancellationRequested) return buildResult();
    await setProcessAudioProgress(realtimeDB.ref(`addIntroOutro/${fileName}`), 100, 'completed', 'Completed').catch((err) => {
      log.error('Failed to set final progress to 100%', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // delete original audio file
    if (cancelToken.isCancellationRequested) return buildResult();
    log.info('Audio processing completed successfully');
    return buildResult();
  } catch (error) {
    log.error('Audio processing failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  } finally {
    stopLockHeartbeat?.();
    if (lockAcquired) {
      await releaseProcessAudioLock(realtimeDB, fileName, lockRequestId, log);
    }
    await realtimeDB.ref(`addIntroOutro/${fileName}`).remove().catch((err) => {
      log.error('Failed to remove progress reference from realtimeDB', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    const promises: Promise<void>[] = [];
    tempFiles.forEach((file) => {
      promises.push(
        unlinkSafeTempFile(file, tempFiles).catch((err) => {
          log.warn('Failed to delete temp file', { file, error: err });
        })
      );
    });
    try {
      await Promise.all(promises);
      log.debug('Cleanup completed', { tempFilesDeleted: tempFiles.size });
    } catch (err) {
      log.error('Error during cleanup', { error: err });
    }
  }
    }
  );
};
