import { CancelToken } from './CancelToken';
import { Bucket, File } from '@google-cloud/storage';
import { Database, Reference } from 'firebase-admin/database';
import {
  convertStringToMilliseconds,
  createTempFile,
  logMemoryUsage,
  throwErrorOnSpecificStderr,
  getFFmpegPath,
  unlinkSafeTempFile,
} from './utils';
import { CustomMetadata, AudioSource } from './types';
import { downloadYouTubeAudioToFile } from './processYouTubeUrl';
import { finished } from 'stream';
import { spawn } from 'child_process';
import { sermonStatus, sermonStatusType } from './types';
import { createLoggerWithContext } from './WinstonLogger';
import { LogContext } from './context';
import { ffmpegSemaphore, ytDlpDownloadSemaphore } from './concurrency';

// Parse ffmpeg stderr for progress and duration
function parseFFmpegProgress(stderrLine: string): { time?: string; duration?: string; speed?: string; bitrate?: string } {
  const result: { time?: string; duration?: string; speed?: string; bitrate?: string } = {};

  // Parse time: time=00:01:23.45
  const timeMatch = stderrLine.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
  if (timeMatch) {
    result.time = timeMatch[1];
  }

  // Parse duration: Duration: 00:05:30.12
  const durationMatch = stderrLine.match(/Duration:\s*(\d{2}:\d{2}:\d{2}\.\d{2})/);
  if (durationMatch) {
    result.duration = durationMatch[1];
  }

  const speedMatch = stderrLine.match(/speed=\s*([^\s]+)/);
  if (speedMatch) {
    result.speed = speedMatch[1];
  }

  const bitrateMatch = stderrLine.match(/bitrate=\s*([^\s]+)/);
  if (bitrateMatch) {
    result.bitrate = bitrateMatch[1];
  }

  return result;
}

const trimAndTranscode = async (
  ytdlpPath: string,
  cancelToken: CancelToken,
  bucket: Bucket,
  audioSource: AudioSource,
  outputFilePath: string,
  tempFiles: Set<string>,
  realtimeDBRef: Reference,
  realtimeDB: Database,
  docRef: FirebaseFirestore.DocumentReference,
  sermonStatus: sermonStatus,
  customMetadata: CustomMetadata,
  startTime?: number,
  duration?: number,
  ctx?: LogContext
): Promise<File> => {
  const log = createLoggerWithContext(ctx);
  const outputFile = bucket.file(outputFilePath);
  const contentDisposition = customMetadata.title
    ? `inline; filename="${customMetadata.title}.mp3"`
    : 'inline; filename="untitled.mp3"';
  const writeStream = outputFile.createWriteStream({
    contentType: 'audio/mpeg',
    metadata: { contentDisposition, metadata: customMetadata },
    timeout: 30 * 60 * 1000, // 30 minutes in milliseconds
  });
  let inputSource: string | undefined;
  let proc: ReturnType<typeof spawn> | undefined;
  let releaseFfmpegSlot: (() => void) | undefined;
  let transcodingStarted = false;
  let ffmpegStderrBuffer = '';
  const MAX_FFMPEG_STDERR_BUFFER = 20_000;

  log.info('Starting trim and transcode', {
    sourceType: audioSource.type,
    startTime,
    duration,
    outputPath: outputFilePath,
  });

  // Calculate dynamic percentage ranges based on trimming parameters
  // Download is 5x faster than transcoding
  const DOWNLOAD_SPEED_MULTIPLIER = 5;

  /**
   * Calculates dynamic percentage ranges for download and transcode phases
   * @param startTime - Start time in seconds (undefined if no trimming)
   * @param duration - Duration in seconds (undefined if no trimming)
   * @param totalDuration - Total audio duration in seconds (optional, for better accuracy)
   * @returns Object with downloadEndPercent and transcodeStartPercent
   */
  const calculateProgressRanges = (
    startTime?: number,
    duration?: number,
    totalDuration?: number
  ): { downloadEndPercent: number; transcodeStartPercent: number } => {
    // Scenario 1: No trimming - transcoding starts immediately
    if (!startTime && !duration) {
      // Download is minimal since we start transcoding right away
      // Give download a tiny range (0-2%) for initial buffering
      return { downloadEndPercent: 2, transcodeStartPercent: 0 };
    }

    // Scenario 2 & 3: We have trimming parameters
    // Calculate time ranges
    const downloadTime = startTime || 0; // Time we need to download before transcoding

    // If we don't have duration but have startTime, we'll transcode from startTime to end
    // In this case, use a reasonable estimate or default
    const actualTranscodeTime = duration || (totalDuration ? totalDuration - downloadTime : 1000); // Default to large number if unknown

    // Total time we're processing: download time + transcode time
    const totalProcessingTime = downloadTime + actualTranscodeTime;

    // Calculate percentage ranges (0-98% for download+transcode, 98-100% for merge)
    // Formula: (downloadTime / totalProcessingTime) / 5 * 98
    // This accounts for download being 5x faster than transcoding
    // Example: 100 min audio, transcode 40-60: (40/60)/5 * 98 = 13.3%
    const downloadEndPercent =
      totalProcessingTime > 0
        ? Math.min(98, Math.round((downloadTime / totalProcessingTime / DOWNLOAD_SPEED_MULTIPLIER) * 98))
        : 0;

    // Transcode starts where download ends
    const transcodeStartPercent = downloadEndPercent;

    return { downloadEndPercent, transcodeStartPercent };
  };

  // Calculate ranges (will be updated if we get totalDuration later)
  let progressRanges = calculateProgressRanges(startTime, duration);

  log.info('Progress ranges calculated', {
    startTime,
    duration,
    downloadEndPercent: progressRanges.downloadEndPercent,
    transcodeStartPercent: progressRanges.transcodeStartPercent,
  });

  let maxDownloadProgress = -1;
  let lastLoggedProgress = -1; // Track last logged progress for console output
  const updateDownloadProgress = (progress: number) => {
    if (!transcodingStarted) {
      // Scale yt-dlp progress (0-100%) to 0-downloadEndPercent range
      const scaledProgress = Math.round(progress * (progressRanges.downloadEndPercent / 100));

      // Log progress to console more frequently (every 10% of raw progress)
      const progressDecile = Math.floor(progress / 10);
      if (progressDecile > lastLoggedProgress) {
        lastLoggedProgress = progressDecile;
        log.info('Download progress', {
          rawProgress: Math.round(progress),
          scaledProgress,
          downloadEndPercent: progressRanges.downloadEndPercent,
          phase: 'download',
        });
      }

      // Only update database if progress has increased (prevent backwards jumps)
      if (scaledProgress > maxDownloadProgress) {
        maxDownloadProgress = scaledProgress;
        realtimeDBRef.set(scaledProgress).catch((err) => {
          log.error('Failed to update download progress', {
            error: err instanceof Error ? err.message : String(err),
            scaledProgress,
          });
        });
      }
    }
  };

  const acquireSemaphoreSlot = async (
    action: string,
    semaphore: { name: string; acquire: () => Promise<() => void>; snapshot: () => { active: number; waiting: number; limit: number } }
  ): Promise<() => void> => {
    const before = semaphore.snapshot();
    log.info('Waiting for process-audio concurrency slot', {
      action,
      semaphore: semaphore.name,
      active: before.active,
      waiting: before.waiting,
      limit: before.limit,
    });

    const release = await semaphore.acquire();

    const after = semaphore.snapshot();
    log.info('Acquired process-audio concurrency slot', {
      action,
      semaphore: semaphore.name,
      active: after.active,
      waiting: after.waiting,
      limit: after.limit,
    });

    return () => {
      release();
      const released = semaphore.snapshot();
      log.info('Released process-audio concurrency slot', {
        action,
        semaphore: semaphore.name,
        active: released.active,
        waiting: released.waiting,
        limit: released.limit,
      });
    };
  };

  try {
    if (audioSource.type === 'YouTubeUrl') {
      const youtubeSourceFileBase = createTempFile(`youtube-${audioSource.id}`, tempFiles);
      log.info('Processing YouTube URL with yt-dlp local download', {
        url: audioSource.source,
        startTime,
        duration,
        outputBase: youtubeSourceFileBase,
      });
      const releaseYtDlpSlot = await acquireSemaphoreSlot('youtube_download', ytDlpDownloadSemaphore);
      let downloadedFile: string;
      try {
        downloadedFile = await downloadYouTubeAudioToFile(
          ytdlpPath,
          audioSource.source,
          youtubeSourceFileBase,
          cancelToken,
          updateDownloadProgress,
          realtimeDB,
          ctx
        );
      } finally {
        releaseYtDlpSlot();
      }
      if (downloadedFile !== youtubeSourceFileBase) {
        tempFiles.delete(youtubeSourceFileBase);
        tempFiles.add(downloadedFile);
      }
      inputSource = downloadedFile;
    } else {
      // Process the audio source from storage
      const rawSourceFile = createTempFile(`raw-${audioSource.id}`, tempFiles);
      log.debug('Downloading raw audio source', { source: audioSource.source, destination: rawSourceFile });
      await bucket.file(audioSource.source).download({ destination: rawSourceFile });
      inputSource = rawSourceFile;
    }

    if (!inputSource) {
      throw new Error('No input source available for ffmpeg processing');
    }

    releaseFfmpegSlot = await acquireSemaphoreSlot('ffmpeg_transcode', ffmpegSemaphore);

    // Build ffmpeg command
    const ffmpegPath = getFFmpegPath();
    const args: string[] = [];

    // Input options
    if (startTime !== undefined && startTime !== null) {
      args.push('-ss', startTime.toString());
    }
    args.push('-i', inputSource);
    if (duration !== undefined && duration !== null) {
      args.push('-t', duration.toString());
    }

    // Audio codec and filters - ALWAYS applied to ensure consistent audio processing
    // These filters normalize, denoise, and adjust loudness regardless of input source
    const audioFilters =
      'dynaudnorm=g=21:m=40:c=1:b=0,afftdn,pan=stereo|c0<c0+c1|c1<c0+c1,loudnorm=I=-16:LRA=11:TP=-1.5';
    args.push('-acodec', 'libmp3lame', '-b:a', '128k', '-ac', '2', '-ar', '44100', '-af', audioFilters, '-f', 'mp3');

    if (audioSource.type === 'YouTubeUrl') {
      log.info('Transcoding downloaded YouTube audio and applying audio filters', {
        filters: audioFilters,
        approach: 'ytdlp_download_to_file_then_ffmpeg',
        startTime,
        duration,
      });
    }

    // Output to pipe
    args.push('pipe:1');

    const commandLine = `${ffmpegPath} ${args.join(' ')}`;
    log.info('FFmpeg command', {
      command: commandLine,
      inputType: 'file',
      args: args.join(' '),
      trimParameters: {
        startTime,
        requestedDuration: duration,
        approach: audioSource.type === 'YouTubeUrl' ? 'ytdlp_download_to_file_then_ffmpeg' : 'standard',
        seekMode: 'input_seek',
        effectiveDuration: duration,
      },
    });

    proc = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Pipe output
    if (!proc.stdout) {
      throw new Error('FFmpeg stdout is null');
    }
    proc.stdout.pipe(writeStream);

    // Handle EPIPE on write stream (can occur if storage write fails or is cancelled)
    writeStream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        log.warn('Write stream EPIPE - storage may have closed connection', { code: err.code });
      } else {
        log.error('Write stream error', { error: err, code: err.code });
      }
      if (proc) {
        proc.kill('SIGTERM');
      }
    });

    proc.stdout.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        log.debug('FFmpeg stdout EPIPE - write stream may have closed', { code: err.code });
      } else {
        log.error('FFmpeg stdout error', { error: err, code: err.code });
      }
    });

    let totalTimeMillis: number | undefined;
    let loggedDurationWarning = false;
    let previousPercent = -1;
    let actualTranscodeStartPercent: number | undefined; // Fixed starting point for transcode phase

    if (!proc) {
      throw new Error('FFmpeg process not initialized');
    }

    // Capture proc in const for use in promise callbacks
    const ffmpegProc = proc;

    // Use Node.js stream.finished() to properly wait for GCS upload completion
    // This handles 'finish', 'error', and premature 'close' events correctly
    const writeStreamDone = new Promise<void>((resolveWrite, rejectWrite) => {
      finished(writeStream, (err) => {
        if (err) {
          log.error('GCS write stream error', { error: err.message, code: (err as NodeJS.ErrnoException).code });
          rejectWrite(err);
        } else {
          log.debug('GCS write stream finished - upload complete');
          resolveWrite();
        }
      });
    });

    const promiseResult = await new Promise<File>((resolve, reject) => {
      ffmpegProc.on('error', (err) => {
        log.error('FFmpeg spawn error', { error: err });
        reject(err);
      });

      ffmpegProc.on('close', async (code, signal) => {
        log.debug('FFmpeg process closed', { exitCode: code, signal });

        if (code !== 0) {
          log.error('FFmpeg process failed', {
            exitCode: code,
            signal,
            ffmpegStderrTail: ffmpegStderrBuffer.trim() || null,
          });
          // Catch writeStreamDone rejection to avoid unhandled promise rejection.
          // If GCS write stream errored (which may have triggered this FFmpeg failure),
          // writeStreamDone will reject. We must handle it even though we're already
          // rejecting due to FFmpeg failure.
          writeStreamDone.catch((writeErr) => {
            log.debug('Write stream also failed (expected if it caused FFmpeg termination)', {
              error: writeErr instanceof Error ? writeErr.message : String(writeErr),
            });
          });
          reject(new Error(`FFmpeg process exited with code ${code}`));
          return;
        }

        // FFmpeg succeeded - now wait for GCS upload to complete
        try {
          await writeStreamDone;
          log.info('Trim and transcode completed successfully', {
            outputPath: outputFilePath,
            sourceType: audioSource.type,
            approach: audioSource.type === 'YouTubeUrl' ? 'ytdlp_download_to_file_then_ffmpeg' : 'standard',
            trimDecision: {
              startTime,
              requestedDuration: duration,
              note:
                audioSource.type === 'YouTubeUrl'
                  ? 'Used downloaded yt-dlp input file with FFmpeg input seeking for precise trims'
                  : 'Processed local file input',
            },
          });
          resolve(outputFile);
        } catch (uploadErr) {
          log.error('GCS upload failed after FFmpeg completed', { error: uploadErr });
          reject(new Error(`GCS upload failed: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`));
        }
      });

      if (!ffmpegProc.stderr) {
        reject(new Error('FFmpeg stderr is null'));
        return;
      }

      ffmpegProc.stderr.on('data', async (data: Buffer) => {
        const stderrLine = data.toString();
        ffmpegStderrBuffer += stderrLine;
        if (ffmpegStderrBuffer.length > MAX_FFMPEG_STDERR_BUFFER) {
          ffmpegStderrBuffer = ffmpegStderrBuffer.slice(-MAX_FFMPEG_STDERR_BUFFER);
        }

        try {
          throwErrorOnSpecificStderr(stderrLine);
        } catch (err) {
          log.error('FFmpeg error detected in stderr', {
            stderrLine,
            ffmpegStderrTail: ffmpegStderrBuffer.trim() || null,
            error: err,
          });
          ffmpegProc.kill('SIGTERM');
          reject(err);
          return;
        }

        // Parse progress and duration
        const progress = parseFFmpegProgress(stderrLine);

        if (progress.duration && !totalTimeMillis) {
          totalTimeMillis = convertStringToMilliseconds(progress.duration);
          log.info('Detected input duration', { duration: progress.duration, milliseconds: totalTimeMillis });
          // Recalculate progress ranges with actual total duration for better accuracy
          const totalDurationSeconds = totalTimeMillis / 1000;
          progressRanges = calculateProgressRanges(startTime, duration, totalDurationSeconds);
          log.info('Recalculated progress ranges with total duration', {
            totalDurationSeconds,
            downloadEndPercent: progressRanges.downloadEndPercent,
            transcodeStartPercent: progressRanges.transcodeStartPercent,
          });
        } else if (progress.time && !totalTimeMillis && !duration && !loggedDurationWarning) {
          // Log once when we start seeing time updates but no duration yet (helps debug pipe input issues)
          loggedDurationWarning = true;
          log.debug('Processing started but duration not yet detected from ffmpeg', {
            time: progress.time,
            note: 'Will use duration parameter if available, otherwise will log time elapsed only',
          });
        }

        if (progress.time) {
          if (cancelToken.isCancellationRequested) {
            log.warn('Cancellation requested, terminating processes');
            ffmpegProc.kill('SIGTERM');
            reject(new Error('Trim and Transcode operation was cancelled'));
            return;
          }

          if (!transcodingStarted) {
            transcodingStarted = true;
            // Use the current download progress as the starting point for transcoding
            // This ensures no jump - transcoding continues from where download left off
            // The download progress should have reached at least some value, use that as the starting point
            const initialTranscodePercent =
              maxDownloadProgress >= 0 ? maxDownloadProgress : progressRanges.transcodeStartPercent;
            // Store the fixed starting point for the entire transcode phase
            actualTranscodeStartPercent = initialTranscodePercent;
            log.info('Transcoding started', {
              downloadEndPercent: progressRanges.downloadEndPercent,
              transcodeStartPercent: progressRanges.transcodeStartPercent,
              currentDownloadProgress: maxDownloadProgress,
              initialTranscodePercent,
            });
            realtimeDBRef.set(initialTranscodePercent).catch((err) => {
              log.error('Failed to set initial transcode progress', { error: err });
            });
            previousPercent = initialTranscodePercent; // Start transcode progress tracking at current progress
            await docRef
              .update({
                status: {
                  ...sermonStatus,
                  audioStatus: sermonStatusType.PROCESSING,
                  message: 'Trimming and Transcoding',
                },
              })
              .catch((err) => log.error('Failed to update document status', { error: err }));
          }

          // Calculate progress - use duration parameter as fallback if totalTimeMillis isn't available
          const timeMillis = convertStringToMilliseconds(progress.time);
          let calculatedDuration: number | undefined;

          if (totalTimeMillis) {
            // Use detected duration from ffmpeg
            calculatedDuration = duration
              ? duration * 1000
              : startTime
              ? totalTimeMillis - startTime * 1000
              : totalTimeMillis;
          } else if (duration) {
            // Fallback to duration parameter if ffmpeg hasn't detected duration yet
            calculatedDuration = duration * 1000;
            log.debug('Using duration parameter for progress calculation', {
              duration,
              calculatedDuration,
              timeMillis,
            });
          }

          if (calculatedDuration && calculatedDuration > 0) {
            // Calculate percentage (0-100%) then scale to actualTranscodeStartPercent-98% range for trim/transcode phase
            // This continues from download for continuous progress: 0-100%
            // Use the fixed starting point captured when transcoding began
            const startPercent = actualTranscodeStartPercent ?? progressRanges.transcodeStartPercent;

            const rawPercent = Math.min(100, Math.max(0, (timeMillis / calculatedDuration) * 100));

            // Scale: 0-100% raw -> startPercent-98% final
            // Linear interpolation: startPercent + (rawPercent / 100) * (98 - startPercent)
            const transcodeRange = 98 - startPercent;
            const calculatedPercent = startPercent + (rawPercent / 100) * transcodeRange;
            const percent = Math.round(Math.max(startPercent, Math.min(98, calculatedPercent)));

            if (percent > previousPercent) {
              previousPercent = percent;
              log.debug('Processing progress', {
                percent,
                timeMillis,
                calculatedDuration,
                rawPercent: rawPercent.toFixed(2),
                hasTotalTimeMillis: !!totalTimeMillis,
                transcodeStartPercent: progressRanges.transcodeStartPercent,
                actualStartPercent: startPercent,
                ffmpegSpeed: progress.speed ?? null,
                ffmpegBitrate: progress.bitrate ?? null,
              });
              realtimeDBRef.set(percent).catch((err) => {
                log.error('Failed to update progress in realtimeDB', {
                  error: err instanceof Error ? err.message : String(err),
                  percent,
                });
              });
            } else if (percent < previousPercent) {
              log.debug('Skipping backwards progress update', {
                previousPercent,
                newPercent: percent,
                timeMillis,
                rawPercent: rawPercent.toFixed(2),
              });
            }
            // If percent === previousPercent, we don't update DB (avoid redundant writes)
          } else {
            // Log time elapsed even if we can't calculate percentage
            log.debug('Processing (duration unknown)', {
              timeMillis,
              timeElapsed: progress.time,
              ffmpegSpeed: progress.speed ?? null,
              ffmpegBitrate: progress.bitrate ?? null,
            });
          }
        }
      });
    });

    if (typeof inputSource === 'string') {
      await logMemoryUsage('Before raw audio delete', ctx, tempFiles);
      log.debug('Deleting raw audio temp file', { file: inputSource });
      await unlinkSafeTempFile(inputSource, tempFiles);
      await logMemoryUsage('After raw audio delete', ctx, tempFiles);
    }

    return promiseResult;
  } catch (error) {
    log.error('Trim and transcode failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Cleanup: kill processes if they exist
    if (proc) {
      try {
        log.debug('Terminating FFmpeg process due to error');
        proc.kill('SIGTERM');
      } catch (killError) {
        log.warn('Failed to kill FFmpeg process', { error: killError });
      }
    }
    if (inputSource) {
      try {
        await unlinkSafeTempFile(inputSource, tempFiles);
      } catch (unlinkError) {
        log.warn('Failed to delete temporary file during error cleanup', { file: inputSource, error: unlinkError });
      }
    }

    throw error; // Bubble up the error
  } finally {
    if (releaseFfmpegSlot) {
      releaseFfmpegSlot();
    }
    await logMemoryUsage('After trim and transcode', ctx, tempFiles);
  }
};

export default trimAndTranscode;
