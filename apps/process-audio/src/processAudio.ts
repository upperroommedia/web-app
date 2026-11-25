import { checkBacklogEditQueued, readBacklogDocument, transitionBacklogEdit, updateUnreservedAudioDocument, type BacklogEditDelivery } from './mosesBacklogRecovery';
import path from 'path';
import { Bucket } from '@google-cloud/storage';
import { Sermon, sermonStatus, sermonStatusType } from './types';
import { Database } from 'firebase-admin/database';
import { DocumentReference, type DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
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
import type { MosesBacklogStorage } from './mosesBacklogStorage';
import type { VerifiedMosesRecoveryDelivery } from './mosesGuestTaskIdentity';
import { beginMosesRecovery, createMosesRecoveryStatusWriter, holdUnconfirmedMosesRecovery, recordMosesRecoveryMediaCompletion } from './mosesDeferredRecovery';
import { hasMosesBacklogFence, markProcessAudioRequestRunning, withProcessAudioQueueClaim } from './processAudioQueueStore';
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
  staleTask?: true;
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
    const released = await lockRef.transaction((current) =>
      current === null || current?.requestId === requestId ? null : undefined, undefined, false);
    if (released.committed) {
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
  taskId?: string | null,
  verifiedMosesPilotIntentNonce?: string,
  recovery?: VerifiedMosesRecoveryDelivery,
  edit?: BacklogEditDelivery
): Promise<ProcessAudioResult> => {
  const fileName = audioSource.id;
  // Use provided context or create a new one with sermonId
  const contextWithSermonId = ctx ?? createContext(fileName, 'process-audio');
  const log = createLoggerWithContext(contextWithSermonId);
  const tempFiles = new Set<string>();
  const lockRequestId = contextWithSermonId.requestId;
  let lockAcquired = false;
  let staleTask = false;
  let recoveryStarted = false;
  let editStarted = false;
  let editCompleted = false;
  let backlogStorage: MosesBacklogStorage | undefined;
  let recoveryMediaRecorded = false;
  let stopLockHeartbeat: (() => void) | null = null;
  const buildResult = (alreadyProcessed = false): ProcessAudioResult => {
    if (edit && !editCompleted) throw new Error('Edited audio completion unconfirmed');
    return { alreadyProcessed, youtubeSuccessfulAcquisitionAuthority: contextWithSermonId.youtubeSuccessfulAcquisitionAuthority };
  };

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
  let observedDocument: DocumentSnapshot<Sermon> | undefined;
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
      observedDocument = doc;
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

  if (edit && (existingStatus?.audioStatus !== sermonStatusType.PENDING ||
      !observedDocument?.updateTime?.isEqual(edit.pendingWriteTime))) throw new Error('Edited audio pending generation changed');
  if (existingStatus?.audioStatus === sermonStatusType.PROCESSED) {
    log.info('Sermon already processed, skipping (idempotent)', { documentPath, fileName });
    return buildResult(true);
  }

  try {
    const acquire = () => acquireProcessAudioLock(realtimeDB, fileName, lockRequestId, log);
    const lockResult = recovery?.backlog ? await acquire() : await withProcessAudioQueueClaim(
      realtimeDB, fileName, 'audio-lock:' + lockRequestId,
      async () => {
        if (edit) {
          await checkBacklogEditQueued(realtimeDB, edit);
        } else if (await hasMosesBacklogFence(realtimeDB, fileName)) return null;
        return acquire();
      }
    );
    if (lockResult === null) {
      staleTask = true;
      return { alreadyProcessed: false, staleTask: true } satisfies ProcessAudioResult;
    }
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

    if (recovery) {
      if (!observedDocument) throw new Error('Missing deferred recovery source document');
      backlogStorage = await beginMosesRecovery(realtimeDB, recovery, lockRequestId, observedDocument, bucket);
      recoveryStarted = true;
    }
    if (edit) {
      await transitionBacklogEdit(realtimeDB, edit, lockRequestId, 'start');
      editStarted = true;
    }
    const admission = recovery ? true : edit ? false : await markProcessAudioRequestRunning({
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
      verifiedMosesPilotIntentNonce,
    });
    if (admission === 'stale') {
      staleTask = true;
      return { alreadyProcessed: false, staleTask: true } satisfies ProcessAudioResult;
    }

    if (cancelToken.isCancellationRequested) return buildResult();
    const initialStatus = {
      status: {
        ...(existingStatus ?? sermonStatus),
        audioStatus: sermonStatusType.PROCESSING,
        message: 'Getting Data',
      },
    };
    const backlogMirror = backlogStorage?.documentFence ?? edit?.documentFence;
    const verifySource = backlogMirror ? () => readBacklogDocument(docRef, backlogMirror) : undefined;
    const writeRecoveryStatus = recovery || edit ? createMosesRecoveryStatusWriter(docRef, observedDocument!.updateTime!, backlogMirror && (async previous => {
      const current = await readBacklogDocument(docRef, backlogMirror);
      if (!current.updateTime?.isEqual(previous)) {
        throw new Error('Backlog document generation changed');
      }
    })) : undefined;
    if (writeRecoveryStatus) {
      await writeRecoveryStatus(sermonStatusType.PROCESSING, 'Getting Data');
    } else {
      await updateUnreservedAudioDocument(docRef, initialStatus);
    }

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

    if (writeRecoveryStatus) {
      await writeRecoveryStatus(sermonStatusType.PROCESSING, trimMessage);
    } else {
      await updateUnreservedAudioDocument(docRef, {
        status: { ...sermonStatus, audioStatus: sermonStatusType.PROCESSING, message: trimMessage },
      });
    }

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
          trimCtx,
          admission,
          !!recovery || !!edit,
          backlogStorage,
          verifySource
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
    const tempFilePaths = backlogStorage ? await backlogStorage.downloadInputs(processedFilePath, tempFiles) : (await Promise.all([
      downloadFiles(bucket, audioFilesToMerge, tempFiles),
      bucket.file(processedStoragePath).download({ destination: processedFilePath }),
    ]))[0];

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
      if (writeRecoveryStatus) {
        await writeRecoveryStatus(sermonStatusType.PROCESSING, 'Adding Intro and Outro');
      } else {
        await updateUnreservedAudioDocument(docRef, {
          status: { ...sermonStatus, audioStatus: sermonStatusType.PROCESSING, message: 'Adding Intro and Outro' },
        });
      }
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
            mergeCtx,
            backlogStorage,
            verifySource
          )
      );
      log.info('Files merged successfully', { outputPath: mergedOutputFile.name });
      await logMemoryUsage('Memory Usage after merge', contextWithSermonId, tempFiles);
    } else {
      log.debug('No intro or outro, skipping merge');
    }

    if (cancelToken.isCancellationRequested) return buildResult();

    log.info('Updating status to PROCESSED');
    const finishedStatus = {
      status: {
        ...sermonStatus,
        audioStatus: sermonStatusType.PROCESSED,
      },
      durationSeconds: durationSeconds,
    };

    if (recovery) {
      const authority = trimCtx.youtubeSuccessfulAcquisitionAuthority;
      if (!writeRecoveryStatus || !authority || cancelToken.isCancellationRequested) throw new Error('Unconfirmed deferred media completion');
      const outputs = await backlogStorage?.verifyCurrent();
      if (cancelToken.isCancellationRequested) throw new Error('Cancelled backlog completion');
      const written = await writeRecoveryStatus(sermonStatusType.PROCESSED, undefined, durationSeconds);
      if (verifySource) await verifySource();
      await recordMosesRecoveryMediaCompletion(realtimeDB, recovery, lockRequestId, authority,
        trimCtx.mosesVerifiedTransfer === true, written.writeTime, outputs);
      recoveryMediaRecorded = true;
    } else if (edit && writeRecoveryStatus) {
      await writeRecoveryStatus(sermonStatusType.PROCESSED, undefined, durationSeconds);
      if (cancelToken.isCancellationRequested) throw new Error('Edited audio completion unconfirmed');
      await transitionBacklogEdit(realtimeDB, edit, lockRequestId, 'complete', trimCtx.youtubeSuccessfulAcquisitionAuthority);
      await readBacklogDocument(docRef, edit.documentFence);
      editCompleted = true;
    } else {
      await updateUnreservedAudioDocument(docRef, finishedStatus);
    }

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
    if (recovery && recoveryStarted && !recoveryMediaRecorded) {
      await holdUnconfirmedMosesRecovery(realtimeDB, recovery, lockRequestId)
        .catch(() => log.warn('Could not record held deferred recovery outcome'));
    }
    stopLockHeartbeat?.();
    if (lockAcquired) {
      await releaseProcessAudioLock(realtimeDB, fileName, lockRequestId, log);
    }
    if (!staleTask && (!recovery || recoveryStarted) && (!edit || editStarted)) await realtimeDB.ref(`addIntroOutro/${fileName}`).remove().catch((err) => {
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
