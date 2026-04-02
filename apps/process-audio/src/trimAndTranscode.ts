import { CancelToken } from './CancelToken';
import { Bucket, File } from '@google-cloud/storage';
import { Database, Reference } from 'firebase-admin/database';
import {
  convertStringToMilliseconds,
  createTempFile,
  ensureSafeTempPath,
  isTrustedYouTubeLiveDvrManifestUrl,
  logMemoryUsage,
  throwErrorOnSpecificStderr,
  getFFmpegPath,
  getDurationSeconds,
  unlinkSafeTempFile,
  uploadSermon,
} from './utils';
import { CustomMetadata, AudioSource } from './types';
import {
  processYouTubeUrl,
  downloadYouTubeSection,
  downloadYouTubeAudioToFile,
  getYouTubeTrimRoutingDecision,
  YTDLP_HTTP_USER_AGENT,
  extractMediaUrlBindingDetails,
  logObservedOutboundNetworkIdentity,
} from './processYouTubeUrl';
import { PassThrough, Readable, finished } from 'stream';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { sermonStatus, sermonStatusType } from './types';
import { createLoggerWithContext } from './WinstonLogger';
import { LogContext } from './context';

// Parse ffmpeg stderr for progress and duration
function parseFFmpegProgress(stderrLine: string): { time?: string; duration?: string } {
  const result: { time?: string; duration?: string } = {};

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

  return result;
}

type YouTubeAcquisitionMode = 'section_download' | 'full_stream_file';

interface YouTubeAcquisitionResult {
  localFilePath: string;
  mode: YouTubeAcquisitionMode;
  acquiredStartTime: number;
  acquiredDuration?: number;
  attemptLabel: string;
}

class YouTubeTimestampVerificationError extends Error {
  readonly measuredStartOffsetErrorMs?: number;
  readonly measuredDurationErrorMs?: number;

  constructor(message: string, measuredStartOffsetErrorMs?: number, measuredDurationErrorMs?: number) {
    super(message);
    this.name = 'YouTubeTimestampVerificationError';
    this.measuredStartOffsetErrorMs = measuredStartOffsetErrorMs;
    this.measuredDurationErrorMs = measuredDurationErrorMs;
  }
}

interface YouTubeAcquisitionAttempt {
  mode: YouTubeAcquisitionMode;
  prePadSeconds: number;
  postPadSeconds: number;
  label: string;
}

const YOUTUBE_START_TOLERANCE_MS = 250;
const YOUTUBE_DURATION_TOLERANCE_MS = 250;
const YOUTUBE_ALIGNMENT_PROBE_SECONDS = 3;
const YOUTUBE_ALIGNMENT_SAMPLE_RATE = 8000;
const YOUTUBE_ALIGNMENT_CHANNELS = 1;
const YOUTUBE_ALIGNMENT_MIN_SCORE = 0.6;

function buildYouTubeAcquisitionAttempts(
  likelyDvr: boolean,
  startTime: number,
  duration: number,
  forceFullStreamFileOnly = false
): YouTubeAcquisitionAttempt[] {
  if (forceFullStreamFileOnly) {
    return [{ mode: 'full_stream_file', prePadSeconds: 0, postPadSeconds: 0, label: 'full_stream_file_forced' }];
  }
  const baseSectionAttempt: YouTubeAcquisitionAttempt = likelyDvr || startTime >= 60 * 30 || duration >= 10 * 60
    ? { mode: 'section_download', prePadSeconds: 20, postPadSeconds: 30, label: 'section_download_wide' }
    : { mode: 'section_download', prePadSeconds: 5, postPadSeconds: 10, label: 'section_download_narrow' };

  const expandedSectionAttempt: YouTubeAcquisitionAttempt = {
    mode: 'section_download',
    prePadSeconds: Math.max(baseSectionAttempt.prePadSeconds * 3, 30),
    postPadSeconds: Math.max(baseSectionAttempt.postPadSeconds * 3, 45),
    label: 'section_download_retry',
  };

  return [
    baseSectionAttempt,
    expandedSectionAttempt,
    { mode: 'full_stream_file', prePadSeconds: 0, postPadSeconds: 0, label: 'full_stream_file' },
  ];
}

async function runBinaryCapture(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => chunks.push(data));
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
        return;
      }
      reject(
        new Error(`${command} exited with code ${code}${signal ? ` (signal: ${signal})` : ''}. stderr: ${stderr.trim()}`)
      );
    });
  });
}

async function extractAudioPcmWindow(filePath: string, startSeconds: number, durationSeconds: number): Promise<Int16Array> {
  const ffmpegPath = getFFmpegPath();
  const args = ['-v', 'error'];
  if (startSeconds > 0) {
    args.push('-ss', startSeconds.toFixed(3));
  }
  args.push(
    '-i',
    filePath,
    '-t',
    durationSeconds.toFixed(3),
    '-ac',
    String(YOUTUBE_ALIGNMENT_CHANNELS),
    '-ar',
    String(YOUTUBE_ALIGNMENT_SAMPLE_RATE),
    '-f',
    's16le',
    '-'
  );
  const pcm = await runBinaryCapture(ffmpegPath, args);
  return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / Int16Array.BYTES_PER_ELEMENT));
}

function computeNormalizedCorrelation(
  sourceSamples: Int16Array,
  outputSamples: Int16Array,
  searchStartIndex: number,
  searchLength: number
): { bestScore: number; bestIndex: number } {
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestIndex = searchStartIndex;

  for (let index = searchStartIndex; index <= searchStartIndex + searchLength; index += 1) {
    let sourceEnergy = 0;
    let outputEnergy = 0;
    let dot = 0;
    for (let sampleIndex = 0; sampleIndex < outputSamples.length; sampleIndex += 1) {
      const sourceValue = sourceSamples[index + sampleIndex];
      const outputValue = outputSamples[sampleIndex];
      dot += sourceValue * outputValue;
      sourceEnergy += sourceValue * sourceValue;
      outputEnergy += outputValue * outputValue;
    }

    if (sourceEnergy === 0 || outputEnergy === 0) {
      continue;
    }

    const score = dot / Math.sqrt(sourceEnergy * outputEnergy);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return { bestScore, bestIndex };
}

async function verifyYouTubeClipAlignment(
  acquiredSourcePath: string,
  outputFilePath: string,
  expectedLocalStartSeconds: number,
  requestedDurationSeconds: number,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<void> {
  const searchWindowSeconds = 2;
  const sourceWindowStartSeconds = Math.max(0, expectedLocalStartSeconds - searchWindowSeconds);
  const outputProbeDurationSeconds = Math.min(
    YOUTUBE_ALIGNMENT_PROBE_SECONDS,
    Math.max(1, requestedDurationSeconds)
  );
  const sourceProbeDurationSeconds = outputProbeDurationSeconds + searchWindowSeconds * 2;

  const [sourceSamples, outputSamples, outputDurationSeconds] = await Promise.all([
    extractAudioPcmWindow(acquiredSourcePath, sourceWindowStartSeconds, sourceProbeDurationSeconds),
    extractAudioPcmWindow(outputFilePath, 0, outputProbeDurationSeconds),
    getDurationSeconds(outputFilePath),
  ]);

  if (outputSamples.length === 0 || sourceSamples.length < outputSamples.length) {
    throw new YouTubeTimestampVerificationError('Unable to verify YouTube clip alignment from extracted PCM windows.');
  }

  const searchLength = sourceSamples.length - outputSamples.length;
  const { bestScore, bestIndex } = computeNormalizedCorrelation(sourceSamples, outputSamples, 0, searchLength);
  if (!Number.isFinite(bestScore) || bestScore < YOUTUBE_ALIGNMENT_MIN_SCORE) {
    throw new YouTubeTimestampVerificationError(
      `Unable to verify YouTube clip alignment with sufficient confidence (score=${bestScore.toFixed(3)}).`
    );
  }

  const measuredLocalStartSeconds = sourceWindowStartSeconds + bestIndex / YOUTUBE_ALIGNMENT_SAMPLE_RATE;
  const measuredStartOffsetErrorMs = (measuredLocalStartSeconds - expectedLocalStartSeconds) * 1000;
  const measuredDurationErrorMs = (outputDurationSeconds - requestedDurationSeconds) * 1000;

  log.info('Verified YouTube clip alignment', {
    expectedLocalStartSeconds,
    measuredLocalStartSeconds,
    measuredStartOffsetErrorMs,
    requestedDurationSeconds,
    outputDurationSeconds,
    measuredDurationErrorMs,
    verificationScore: bestScore,
  });

  if (Math.abs(measuredStartOffsetErrorMs) > YOUTUBE_START_TOLERANCE_MS) {
    throw new YouTubeTimestampVerificationError(
      `YouTube clip start offset verification failed (${measuredStartOffsetErrorMs.toFixed(1)}ms).`,
      measuredStartOffsetErrorMs,
      measuredDurationErrorMs
    );
  }

  if (Math.abs(measuredDurationErrorMs) > YOUTUBE_DURATION_TOLERANCE_MS) {
    throw new YouTubeTimestampVerificationError(
      `YouTube clip duration verification failed (${measuredDurationErrorMs.toFixed(1)}ms).`,
      measuredStartOffsetErrorMs,
      measuredDurationErrorMs
    );
  }
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
  let writeStream:
    | ReturnType<typeof outputFile.createWriteStream>
    | undefined;
  let inputSource: string | Readable | undefined;
  let ytdlp: ChildProcessWithoutNullStreams | undefined;
  let proc: ReturnType<typeof spawn> | undefined;
  let transcodingStarted = false;
  let usedYtdlpSectionDownload = false;
  let usedDirectUrlWithSeeking = false; // NEW: Track if using direct URL + FFmpeg seeking approach
  let directUrlHttpHeaders: Record<string, string> | undefined;
  let directUrlRequestUserAgent: string | null = null;
  let observedDirectUrlOutboundIdentity:
    | Awaited<ReturnType<typeof logObservedOutboundNetworkIdentity>>
    | undefined;
  let directUrlMediaBindingDetails: ReturnType<typeof extractMediaUrlBindingDetails> | undefined;
  let ffmpegStderrBuffer = '';
  const MAX_FFMPEG_STDERR_BUFFER = 20_000;
  let youtubeAcquisitionResult: YouTubeAcquisitionResult | undefined;
  let finalOutputTempFile: string | undefined;

  // Duration verification state - used to determine if secondary trim is needed
  // Secondary trim uses the KNOWN user-specified duration, NOT arbitrary values
  let secondaryTrimNeeded = false;
  let secondaryTrimDuration: number | undefined;

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

  try {
    if (audioSource.type === 'YouTubeUrl') {
      log.info('Processing YouTube URL', { url: audioSource.source });

      if (startTime !== undefined && startTime !== null) {
        let routingDecision:
          | Awaited<ReturnType<typeof getYouTubeTrimRoutingDecision>>
          | {
              strategy: 'direct_url';
              reason: string;
              hasFragments: false;
              likelyDvr: false;
            };
        try {
          routingDecision = await getYouTubeTrimRoutingDecision(ytdlpPath, audioSource.source, realtimeDB, ctx);
        } catch (routingError) {
          routingDecision = {
            strategy: 'direct_url',
            reason: 'routing_preflight_failed_default_direct',
            hasFragments: false,
            likelyDvr: false,
          };
          log.warn('YouTube routing preflight failed; defaulting to direct URL extraction', {
            error: routingError instanceof Error ? routingError.message : String(routingError),
          });
        }

        log.info('Deterministic YouTube trim routing decision', {
          startTime,
          duration,
          strategy: routingDecision.strategy,
          reason: routingDecision.reason,
          hasFragments: routingDecision.hasFragments,
          likelyDvr: routingDecision.likelyDvr,
          formatId: 'formatId' in routingDecision ? routingDecision.formatId : undefined,
          fragmentCount: 'fragmentCount' in routingDecision ? routingDecision.fragmentCount : undefined,
          protocol: 'protocol' in routingDecision ? routingDecision.protocol : undefined,
        });

        const acquisitionAttempts = buildYouTubeAcquisitionAttempts(
          routingDecision.likelyDvr,
          startTime,
          duration ?? 0,
          ctx?.youtubeAcquisitionRetryStage === 'full_stream_file'
        );
        let lastAcquisitionError: Error | undefined;

        for (const attempt of acquisitionAttempts) {
          const ytdlpOutputFileBase = `ytdlp-${audioSource.id}-${attempt.label}`;
          const ytdlpOutputFile = createTempFile(ytdlpOutputFileBase, tempFiles);
          try {
            if (attempt.mode === 'section_download') {
              const paddedStart = Math.max(0, startTime - attempt.prePadSeconds);
              const leadingPad = startTime - paddedStart;
              const paddedDuration = leadingPad + (duration ?? 0) + attempt.postPadSeconds;
              const downloadedFile = await downloadYouTubeSection(
                ytdlpPath,
                audioSource.source,
                ytdlpOutputFile,
                cancelToken,
                updateDownloadProgress,
                realtimeDB,
                paddedStart,
                paddedDuration,
                ctx
              );
              if (downloadedFile !== ytdlpOutputFile) {
                tempFiles.delete(ytdlpOutputFile);
                tempFiles.add(ensureSafeTempPath(downloadedFile));
              }
              youtubeAcquisitionResult = {
                localFilePath: downloadedFile,
                mode: 'section_download',
                acquiredStartTime: paddedStart,
                acquiredDuration: paddedDuration,
                attemptLabel: attempt.label,
              };
            } else {
              const downloadedFile = await downloadYouTubeAudioToFile(
                ytdlpPath,
                audioSource.source,
                ytdlpOutputFile,
                cancelToken,
                updateDownloadProgress,
                realtimeDB,
                ctx
              );
              if (downloadedFile !== ytdlpOutputFile) {
                tempFiles.delete(ytdlpOutputFile);
                tempFiles.add(ensureSafeTempPath(downloadedFile));
              }
              youtubeAcquisitionResult = {
                localFilePath: downloadedFile,
                mode: 'full_stream_file',
                acquiredStartTime: 0,
                attemptLabel: attempt.label,
              };
            }

            inputSource = youtubeAcquisitionResult.localFilePath;
            usedYtdlpSectionDownload = false;
            usedDirectUrlWithSeeking = false;
            updateDownloadProgress(100);
            log.info('Prepared local YouTube acquisition artifact for canonical trim', {
              acquisitionMode: youtubeAcquisitionResult.mode,
              acquisitionAttempt: youtubeAcquisitionResult.attemptLabel,
              acquiredStartTime: youtubeAcquisitionResult.acquiredStartTime,
              acquiredDuration: youtubeAcquisitionResult.acquiredDuration ?? null,
              localFilePath: youtubeAcquisitionResult.localFilePath,
            });
            break;
          } catch (error) {
            lastAcquisitionError = error instanceof Error ? error : new Error(String(error));
            log.warn('YouTube acquisition attempt failed', {
              acquisitionMode: attempt.mode,
              acquisitionAttempt: attempt.label,
              error: lastAcquisitionError.message,
            });
          }
        }

        if (!youtubeAcquisitionResult || !inputSource) {
          throw lastAcquisitionError ?? new Error('Unable to acquire a local YouTube source artifact.');
        }
      } else {
        // No startTime - use the old streaming approach
        const passThrough = new PassThrough();
        ytdlp = await processYouTubeUrl(
          ytdlpPath,
          audioSource.source,
          cancelToken,
          passThrough,
          updateDownloadProgress,
          realtimeDB,
          undefined,
          undefined,
          ctx
        );
        inputSource = passThrough;
      }
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

    const effectiveStartTime =
      youtubeAcquisitionResult && startTime !== undefined && startTime !== null
        ? Math.max(0, startTime - youtubeAcquisitionResult.acquiredStartTime)
        : startTime;
    const shouldVerifyYouTubeTiming =
      audioSource.type === 'YouTubeUrl' &&
      youtubeAcquisitionResult !== undefined &&
      startTime !== undefined &&
      startTime !== null &&
      duration !== undefined;
    if (shouldVerifyYouTubeTiming) {
      finalOutputTempFile = createTempFile(
        `processed-${audioSource.id}-${youtubeAcquisitionResult!.attemptLabel}.mp3`,
        tempFiles
      );
    }

    // Build ffmpeg command
    const ffmpegPath = getFFmpegPath();
    const args: string[] = [];

    // Input options
    // Three scenarios:
    // 1. Direct URL with seeking (usedDirectUrlWithSeeking): Use -ss BEFORE -i for input seeking on HTTP URL
    // 2. yt-dlp section download fallback (usedYtdlpSectionDownload): File already has exact cuts, no seeking
    // 3. Other sources: Apply -ss/-t as needed
    const usingYtdlpSectionDownload =
      audioSource.type === 'YouTubeUrl' && startTime !== undefined && startTime !== null && usedYtdlpSectionDownload;

    if (usedDirectUrlWithSeeking && typeof inputSource === 'string' && inputSource.startsWith('http')) {
      observedDirectUrlOutboundIdentity = await logObservedOutboundNetworkIdentity(log, 'before_ffmpeg_direct_url_fetch');
      directUrlMediaBindingDetails = extractMediaUrlBindingDetails(inputSource);
      const ffmpegRequestUserAgent = directUrlHttpHeaders?.['User-Agent'] || directUrlHttpHeaders?.['user-agent'] || null;
      directUrlRequestUserAgent = ffmpegRequestUserAgent || YTDLP_HTTP_USER_AGENT;
      const propagatedHeaders = directUrlHttpHeaders
        ? Object.entries(directUrlHttpHeaders).filter(
            ([name]) => name.toLowerCase() !== 'user-agent' && name.toLowerCase() !== 'accept-encoding'
          )
        : [];
      const ffmpegHeaders = propagatedHeaders.length > 0 ? propagatedHeaders.map(([name, value]) => `${name}: ${value}`).join('\r\n') : null;

      // DIRECT URL APPROACH:
      // Most URLs work best with fast input seeking (-ss before -i).
      // For YouTube live DVR manifests, prefer output seeking (-ss after -i) for timestamp accuracy.
      const isYouTubeLiveDvrManifest = isTrustedYouTubeLiveDvrManifestUrl(inputSource);

      args.push('-user_agent', directUrlRequestUserAgent);
      if (ffmpegHeaders) {
        args.push('-headers', `${ffmpegHeaders}\r\n`);
      }

      if (startTime) {
        if (isYouTubeLiveDvrManifest) {
          args.push('-i', inputSource, '-ss', startTime.toString());
          log.info('Using output seeking on YouTube DVR manifest for timestamp accuracy', {
            startTime,
            seekMode: 'output_seek',
            dvrManifestDetected: true,
            note: 'For live DVR manifests, output seeking is slower but more precise than input seeking',
          });
        } else {
          // Treat -ss as an actual timestamp when input start time is non-zero.
          args.push('-seek_timestamp', '1', '-ss', startTime.toString(), '-i', inputSource);
          log.info('Using input seeking on HTTP URL', {
            startTime,
            seekMode: 'input_seek',
            dvrManifestDetected: false,
            note: 'FFmpeg will use HTTP range requests to seek efficiently; -seek_timestamp handles non-zero start times',
          });
        }
      } else {
        args.push('-i', inputSource);
      }

      // Always apply duration limit for direct URL approach.
      if (duration) {
        args.push('-t', duration.toString());
        log.info('Applying duration limit to FFmpeg', {
          duration,
          seekMode: isYouTubeLiveDvrManifest ? 'output_seek' : 'input_seek',
          note: 'Duration applied during direct URL transcode',
        });
      }
    } else if (typeof inputSource === 'string') {
      // File input (including yt-dlp section download fallback)
      if (!usingYtdlpSectionDownload && effectiveStartTime) {
        // For regular files (not yt-dlp precise section), use input seeking for efficiency
        args.push('-ss', effectiveStartTime.toString());
      }
      // For yt-dlp section: no seeking needed - file has exact cuts from --force-keyframes-at-cuts
      args.push('-i', inputSource);

      // Duration handling for file inputs:
      // 1. For non-yt-dlp sources: always use -t with user-specified duration
      // 2. For yt-dlp section download: only add -t if secondary trim is needed
      if (duration && !usingYtdlpSectionDownload) {
        args.push('-t', duration.toString());
      } else if (usingYtdlpSectionDownload && secondaryTrimNeeded && secondaryTrimDuration !== undefined) {
        // Apply secondary trim using the KNOWN user-specified duration
        args.push('-t', secondaryTrimDuration.toString());
        log.info('Applying secondary trim with user-specified duration', {
          duration: secondaryTrimDuration,
          reason: 'Downloaded file exceeded expected duration beyond tolerance',
          note: 'Using KNOWN duration value from user input - not arbitrary trimming',
        });
      }
    } else {
      // Stream/pipe input - must use stdin
      args.push('-i', 'pipe:0');
      // Only add -ss if NOT using yt-dlp section download (yt-dlp already handled cutting)
      if (effectiveStartTime && !usingYtdlpSectionDownload) {
        // Use -ss after -i for pipe inputs (output seeking)
        args.push('-ss', effectiveStartTime.toString());
        log.info('Using output seeking for pipe input', {
          startTime: effectiveStartTime,
          note: 'Output seeking required for pipes - ffmpeg will decode then discard frames until startTime',
        });
      }
      // Duration for pipe inputs
      if (duration && !usingYtdlpSectionDownload) {
        args.push('-t', duration.toString());
      }
    }

    // Audio codec and filters - ALWAYS applied to ensure consistent audio processing
    // These filters normalize, denoise, and adjust loudness regardless of input source
    const audioFilters =
      'dynaudnorm=g=21:m=40:c=1:b=0,afftdn,pan=stereo|c0<c0+c1|c1<c0+c1,loudnorm=I=-16:LRA=11:TP=-1.5';
    args.push('-acodec', 'libmp3lame', '-b:a', '128k', '-ac', '2', '-ar', '44100', '-af', audioFilters, '-f', 'mp3');

    if (usedDirectUrlWithSeeking) {
      const isYouTubeLiveDvrManifest =
        typeof inputSource === 'string' && isTrustedYouTubeLiveDvrManifestUrl(inputSource);
      const seekMode = isYouTubeLiveDvrManifest ? 'output_seek' : 'input_seek';
      log.info('Transcoding from direct URL with seeking', {
        filters: audioFilters,
        approach: 'direct_url_with_input_seeking',
        seekMode,
        dvrManifestDetected: isYouTubeLiveDvrManifest,
        startTime: effectiveStartTime,
        duration,
        httpHeaderKeys: directUrlHttpHeaders ? Object.keys(directUrlHttpHeaders) : [],
        userAgentHeader: directUrlRequestUserAgent,
        observedIpv4: observedDirectUrlOutboundIdentity?.ipv4 || null,
        observedIpv6: observedDirectUrlOutboundIdentity?.ipv6 || null,
        mediaHost: directUrlMediaBindingDetails?.host || null,
        mediaBoundIp: directUrlMediaBindingDetails?.boundIp || null,
        mediaBoundIpFamily: directUrlMediaBindingDetails?.boundIpFamily || null,
        note: isYouTubeLiveDvrManifest
          ? 'Using FFmpeg output seeking (-ss after -i) for YouTube DVR manifest timestamp accuracy'
          : 'Using FFmpeg input seeking (-ss before -i) for efficient HTTP range-based seeking with yt-dlp-provided request headers',
      });
    } else if (usingYtdlpSectionDownload) {
      log.info('Transcoding yt-dlp section (fallback) and applying audio filters', {
        filters: audioFilters,
        secondaryTrimApplied: secondaryTrimNeeded,
        secondaryTrimDuration: secondaryTrimNeeded ? secondaryTrimDuration : undefined,
        note: secondaryTrimNeeded
          ? `Applying secondary trim to ${secondaryTrimDuration}s using KNOWN user-specified duration`
          : 'File has exact cuts from --force-keyframes-at-cuts, no secondary trim needed',
      });
    }

    const useLocalOutputFile = !!finalOutputTempFile;
    if (useLocalOutputFile) {
      args.push(ensureSafeTempPath(finalOutputTempFile!));
    } else {
      writeStream = outputFile.createWriteStream({
        contentType: 'audio/mpeg',
        metadata: { contentDisposition, metadata: customMetadata },
        timeout: 30 * 60 * 1000,
      });
      args.push('pipe:1');
    }

    const commandLine = `${ffmpegPath} ${args.join(' ')}`;
    const usesDvrManifestOutputSeek =
      usedDirectUrlWithSeeking &&
      typeof inputSource === 'string' &&
      isTrustedYouTubeLiveDvrManifestUrl(inputSource);
    log.info('FFmpeg command', {
      command: commandLine,
      inputType: usedDirectUrlWithSeeking ? 'http_url' : typeof inputSource === 'string' ? 'file' : 'pipe',
      args: args.join(' '),
      trimParameters: {
        startTime: effectiveStartTime,
        requestedDuration: duration,
        approach: usedDirectUrlWithSeeking
          ? 'direct_url_with_input_seeking'
          : usingYtdlpSectionDownload
          ? 'yt-dlp_section_fallback'
          : 'standard',
        usingDirectUrlWithSeeking: usedDirectUrlWithSeeking,
        usingYtdlpSectionDownload,
        seekMode: usedDirectUrlWithSeeking ? (usesDvrManifestOutputSeek ? 'output_seek' : 'input_seek') : 'n/a',
        dvrManifestDetected: usesDvrManifestOutputSeek,
        secondaryTrimNeeded,
        secondaryTrimDuration: secondaryTrimNeeded ? secondaryTrimDuration : undefined,
        effectiveDuration: usedDirectUrlWithSeeking
          ? duration
          : secondaryTrimNeeded
          ? secondaryTrimDuration
          : usingYtdlpSectionDownload
          ? 'handled by yt-dlp'
          : duration,
      },
    });

    proc = spawn(ffmpegPath, args, {
      stdio:
        typeof inputSource === 'string'
          ? ['ignore', useLocalOutputFile ? 'ignore' : 'pipe', 'pipe']
          : ['pipe', useLocalOutputFile ? 'ignore' : 'pipe', 'pipe'],
    });

    // Pipe input if it's a stream
    if (typeof inputSource !== 'string') {
      if (!proc || !proc.stdin) {
        throw new Error('FFmpeg process or stdin is null but input is a stream');
      }
      inputSource.pipe(proc.stdin, { end: false });
      const procForErrorHandler = proc; // Capture for error handler

      // Handle EPIPE errors gracefully - they occur when ffmpeg closes stdin early (e.g., during seeking)
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') {
          log.debug('FFmpeg stdin closed (EPIPE) - this is normal when seeking or process completes', {
            code: err.code,
          });
          // Don't kill the process - EPIPE is expected when the reader closes the pipe
        } else {
          log.error('FFmpeg stdin error', { error: err, code: err.code });
          procForErrorHandler.kill('SIGTERM');
        }
      });

      inputSource.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') {
          log.debug('Input stream EPIPE - ffmpeg may have closed stdin', { code: err.code });
          // EPIPE is expected when the destination closes the pipe
        } else {
          log.error('Input stream error', { error: err, code: err.code });
          procForErrorHandler.kill('SIGTERM');
        }
      });
    }

    // Pipe output
    if (!useLocalOutputFile) {
      if (!proc.stdout || !writeStream) {
        throw new Error('FFmpeg stdout/write stream is null');
      }
      proc.stdout.pipe(writeStream);

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
    }

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
    const writeStreamDone = useLocalOutputFile
      ? Promise.resolve()
      : new Promise<void>((resolveWrite, rejectWrite) => {
          if (!writeStream) {
            rejectWrite(new Error('GCS write stream not initialized'));
            return;
          }
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

        // FFmpeg succeeded - verify/upload local output or wait for streamed GCS upload.
        try {
          await writeStreamDone;
          if (useLocalOutputFile && finalOutputTempFile) {
            if (shouldVerifyYouTubeTiming && youtubeAcquisitionResult && duration !== undefined) {
              await verifyYouTubeClipAlignment(
                youtubeAcquisitionResult.localFilePath,
                finalOutputTempFile,
                Math.max(0, (startTime ?? 0) - youtubeAcquisitionResult.acquiredStartTime),
                duration,
                log
              );
            }

            await uploadSermon(finalOutputTempFile, outputFilePath, bucket, customMetadata);
          }

          log.info('Trim and transcode completed successfully', {
            outputPath: outputFilePath,
            sourceType: audioSource.type,
            approach: usedDirectUrlWithSeeking
              ? 'direct_url_with_input_seeking'
              : usedYtdlpSectionDownload
              ? 'yt-dlp_section_fallback'
              : youtubeAcquisitionResult?.mode || 'standard',
            usedDirectUrlWithSeeking,
            usedYtdlpSectionDownload,
            secondaryTrimApplied: secondaryTrimNeeded,
            trimDecision: {
              startTime: effectiveStartTime,
              requestedDuration: duration,
              secondaryTrimDuration: secondaryTrimNeeded ? secondaryTrimDuration : undefined,
              note: usedDirectUrlWithSeeking
                ? 'Used FFmpeg input seeking on HTTP URL - most reliable approach'
                : secondaryTrimNeeded
                ? 'Applied secondary trim using KNOWN user-specified duration'
                : 'No secondary trim needed',
            },
            youtubeAcquisitionMode: youtubeAcquisitionResult?.mode || null,
            youtubeAcquisitionAttempt: youtubeAcquisitionResult?.attemptLabel || null,
          });
          if (ytdlp) {
            log.debug('Terminating yt-dlp process');
            ytdlp.kill('SIGTERM');
          }
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
            if (ytdlp) {
              ytdlp.kill('SIGTERM');
            }
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
            });
          }
        }
      });
    });

    // Delete raw audio from temp memory - but NOT if using direct URL (URL is not a local file)
    if (typeof inputSource === 'string' && !usedDirectUrlWithSeeking) {
      await logMemoryUsage('Before raw audio delete', ctx, tempFiles);
      log.debug('Deleting raw audio temp file', { file: inputSource });
      await unlinkSafeTempFile(inputSource, tempFiles);
      await logMemoryUsage('After raw audio delete', ctx, tempFiles);
    } else if (usedDirectUrlWithSeeking) {
      log.debug('Skipping temp file deletion - input was direct URL, not local file');
    }

    if (finalOutputTempFile) {
      await unlinkSafeTempFile(finalOutputTempFile, tempFiles).catch((unlinkError) => {
        log.warn('Failed to delete final output temp file after upload', {
          file: finalOutputTempFile,
          error: unlinkError instanceof Error ? unlinkError.message : String(unlinkError),
        });
      });
    }

    return promiseResult;
  } catch (error) {
    if (
      error instanceof YouTubeTimestampVerificationError &&
      audioSource.type === 'YouTubeUrl' &&
      startTime !== undefined &&
      startTime !== null &&
      duration !== undefined &&
      youtubeAcquisitionResult?.mode === 'section_download' &&
      ctx?.youtubeAcquisitionRetryStage !== 'full_stream_file'
    ) {
      log.warn('Timestamp verification failed for section download; retrying with full stream file acquisition', {
        acquisitionAttempt: youtubeAcquisitionResult.attemptLabel,
        measuredStartOffsetErrorMs: error.measuredStartOffsetErrorMs ?? null,
        measuredDurationErrorMs: error.measuredDurationErrorMs ?? null,
      });

      if (inputSource && typeof inputSource === 'string' && !usedDirectUrlWithSeeking) {
        await unlinkSafeTempFile(inputSource, tempFiles).catch(() => {});
      }
      if (finalOutputTempFile) {
        await unlinkSafeTempFile(finalOutputTempFile, tempFiles).catch(() => {});
      }

      return trimAndTranscode(
        ytdlpPath,
        cancelToken,
        bucket,
        audioSource,
        outputFilePath,
        tempFiles,
        realtimeDBRef,
        realtimeDB,
        docRef,
        sermonStatus,
        customMetadata,
        startTime,
        duration,
        {
          ...(ctx ?? {}),
          ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
          youtubeAcquisitionRetryStage: 'full_stream_file',
        } as LogContext
      );
    }

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
    if (ytdlp) {
      try {
        log.debug('Terminating YouTube download process due to error');
        ytdlp.kill('SIGTERM');
      } catch (killError) {
        log.warn('Failed to kill yt-dlp process', { error: killError });
      }
    }

    // Cleanup: delete temp files - but NOT if using direct URL (URL is not a local file)
    if (inputSource && typeof inputSource === 'string' && !usedDirectUrlWithSeeking) {
      try {
        await unlinkSafeTempFile(inputSource, tempFiles);
      } catch (unlinkError) {
        log.warn('Failed to delete temporary file during error cleanup', { file: inputSource, error: unlinkError });
      }
    }

    if (finalOutputTempFile) {
      try {
        await unlinkSafeTempFile(finalOutputTempFile, tempFiles);
      } catch (unlinkError) {
        log.warn('Failed to delete final output temp file during error cleanup', {
          file: finalOutputTempFile,
          error: unlinkError instanceof Error ? unlinkError.message : String(unlinkError),
        });
      }
    }

    throw error; // Bubble up the error
  } finally {
    await logMemoryUsage('After trim and transcode', ctx, tempFiles);
  }
};

export default trimAndTranscode;
