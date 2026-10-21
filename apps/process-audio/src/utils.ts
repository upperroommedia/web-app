import { pipeline, finished } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { CancelToken } from './CancelToken';
import os from 'os';
import path from 'path';
import { exec, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { stat, unlink } from 'fs/promises';
import { ProcessAudioInputType, AudioSource, CustomMetadata, FilePaths } from './types';
import { Bucket } from '@google-cloud/storage';
import axios from 'axios';
import logger, { createLoggerWithContext } from './WinstonLogger';
import { LogContext } from './context';

const SAFE_LOCAL_PATH_ROOTS = [path.resolve(os.tmpdir()), path.resolve(process.cwd(), '.tmp')];
const YOUTUBE_VIDEO_ID_PATTERN = /^[\w-]{11}$/;
const EMBEDDED_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

export const sanitizeTempFileName = (fileName: string): string => {
  let sanitized = path.basename(fileName).replace(/[^A-Za-z0-9._-]+/g, '_');
  while (sanitized.startsWith('_')) {
    sanitized = sanitized.slice(1);
  }
  while (sanitized.endsWith('_')) {
    sanitized = sanitized.slice(0, -1);
  }

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error(`Invalid temp file name: ${fileName}`);
  }

  return sanitized;
};

export const ensureSafeTempPath = (filePath: string): string => {
  if (!filePath?.trim()) {
    throw new Error('Temp file path must be a non-empty string');
  }

  const resolvedPath = path.resolve(filePath);
  const isWithinAllowedRoot = SAFE_LOCAL_PATH_ROOTS.some((rootPath) => {
    const relativePath = path.relative(rootPath, resolvedPath);
    return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
  });

  if (!isWithinAllowedRoot) {
    throw new Error(`Unsafe temp file path outside tmpdir: ${filePath}`);
  }

  return resolvedPath;
};

export const unlinkSafeTempFile = async (filePath: string, tempFiles?: Set<string>): Promise<void> => {
  const safePath = ensureSafeTempPath(filePath);
  await unlink(safePath);
  tempFiles?.delete(safePath);
};

export const isTrustedYouTubeLiveDvrManifestUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    if (parsed.hostname !== 'manifest.googlevideo.com') {
      return false;
    }

    return (
      parsed.search.includes('playlist_type/DVR') ||
      parsed.pathname.includes('/source/yt_live_broadcast') ||
      parsed.search.includes('/source/yt_live_broadcast')
    );
  } catch {
    return false;
  }
};

export const throwErrorOnSpecificStderr = (stderrLine: string) => {
  const errorMessages = ['Output file is empty'];
  for (const errorMessage of errorMessages) {
    if (stderrLine.includes(errorMessage)) {
      throw new Error(`Ffmpeg error: ${errorMessage} found in stderr: ${stderrLine}`);
    }
  }
};

const trimTrailingPunctuation = (value: string): string => value.replace(/[),.;]+$/u, '');

const extractYouTubeVideoIdFromUrl = (value: string): string | null => {
  try {
    const url = new URL(trimTrailingPunctuation(value));
    const host = url.hostname.replace(/^www\./u, '');

    let videoId: string | null = null;

    switch (host) {
      case 'youtube.com':
      case 'youtube-nocookie.com':
        if (url.pathname === '/watch') {
          videoId = url.searchParams.get('v');
        } else if (url.pathname.startsWith('/embed/')) {
          videoId = url.pathname.split('/embed/')[1];
        } else if (url.pathname.startsWith('/live/')) {
          videoId = url.pathname.split('/live/')[1];
        } else if (url.pathname.startsWith('/shorts/')) {
          videoId = url.pathname.split('/shorts/')[1];
        }
        break;

      case 'youtu.be':
        videoId = url.pathname.split('/')[1];
        break;

      default:
        return null;
    }

    videoId = videoId?.split('?')[0].split('&')[0].split('#')[0] ?? null;
    return videoId && YOUTUBE_VIDEO_ID_PATTERN.test(videoId) ? videoId : null;
  } catch {
    return null;
  }
};

export function normalizeYouTubeUrl(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  if (YOUTUBE_VIDEO_ID_PATTERN.test(value)) {
    return `https://www.youtube.com/watch?v=${value}`;
  }

  const embeddedUrls = value.match(EMBEDDED_URL_PATTERN) ?? [];
  for (const candidate of [value, ...embeddedUrls]) {
    const videoId = extractYouTubeVideoIdFromUrl(candidate);
    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
  }

  return null;
}

/**
 * Log process memory and optionally "our" /tmp usage (sum of tempFiles sizes).
 * Avoids scanning all of os.tmpdir(); when tempFiles is passed, satisfies GCP "calculate memory including /tmp".
 */
export const logMemoryUsage = async (message: string, ctx?: LogContext, tempFiles?: Set<string>): Promise<void> => {
  const log = createLoggerWithContext(ctx);
  const memoryUsage = process.memoryUsage();
  let tempDirMB = 0;

  if (tempFiles && tempFiles.size > 0) {
    for (const filePath of tempFiles) {
      try {
        const fileStats = await stat(ensureSafeTempPath(filePath));
        tempDirMB += fileStats.size;
      } catch {
        /* ignore missing or inaccessible */
      }
    }
    tempDirMB = parseFloat((tempDirMB / (1024 * 1024)).toFixed(2));
  }

  const memoryUsageInMB = {
    rss: parseFloat((memoryUsage.rss / (1024 * 1024)).toFixed(2)),
    heapTotal: parseFloat((memoryUsage.heapTotal / (1024 * 1024)).toFixed(2)),
    heapUsed: parseFloat((memoryUsage.heapUsed / (1024 * 1024)).toFixed(2)),
    external: parseFloat((memoryUsage.external / (1024 * 1024)).toFixed(2)),
    tempDir: tempDirMB,
  };

  log.debug(message, memoryUsageInMB);
};

export const createTempFile = (fileName: string, tempFiles: Set<string>) => {
  try {
    if (!existsSync(os.tmpdir())) {
      mkdirSync(os.tmpdir());
    }
    const filePath = ensureSafeTempPath(path.join(os.tmpdir(), sanitizeTempFileName(fileName)));
    tempFiles.add(filePath);
    return filePath;
  } catch (err) {
    throw new Error(`Error creating temp file: ${err}`);
  }
};

export const convertStringToMilliseconds = (timeStr: string): number => {
  // Example time string: '10:20:30.500' (HH:MM:SS.ms format from ffmpeg)
  if (!timeStr) {
    return 0;
  }
  const [hours, minutes, secondsAndMilliseconds] = timeStr.split(':');
  if (!secondsAndMilliseconds) {
    return 0;
  }
  const [seconds, milliseconds] = secondsAndMilliseconds.split('.');

  const h = parseInt(hours, 10);
  const m = parseInt(minutes, 10);
  const s = parseInt(seconds, 10);
  const ms = parseInt(milliseconds || '0', 10);

  // Validate parsed values to prevent NaN propagation
  if (isNaN(h) || isNaN(m) || isNaN(s) || isNaN(ms)) {
    logger.warn('Failed to parse time string', { timeStr, hours, minutes, seconds, milliseconds });
    return 0;
  }

  return (h * 60 * 60 + m * 60 + s) * 1000 + ms;
};

export function secondsToTimeFormat(durationSeconds: number) {
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds - hours * 3600) / 60);
  const seconds = durationSeconds - hours * 3600 - minutes * 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds
    .toFixed(3)
    .padStart(6, '0')}`;
}

function logFFMPEGVersion(ffmpegStaticPath: string) {
  exec(`${ffmpegStaticPath} -version`, (err, stdout) => {
    if (err) {
      logger.error('FFMPEG not installed', err);
    } else {
      logger.info('FFMPEG version', stdout);
    }
  });
}

export function getFFmpegPath(): string {
  // Check common ffmpeg locations in priority order
  const ffmpegPaths = [
    '/usr/local/bin/ffmpeg', // Linux/Docker (pinned bundled build)
    '/usr/bin/ffmpeg', // Linux/Docker (apt install)
    '/opt/homebrew/bin/ffmpeg', // macOS ARM (Homebrew)
  ];

  for (const ffmpegPath of ffmpegPaths) {
    if (existsSync(ffmpegPath)) {
      logFFMPEGVersion(ffmpegPath);
      logger.info('Using ffmpeg', { path: ffmpegPath });
      return ffmpegPath;
    }
  }

  throw new Error(`ffmpeg not found. Checked: ${ffmpegPaths.join(', ')}. Install via apt (Docker) or brew (macOS)`);
}

export function getFFprobePath(): string {
  // Check common ffprobe locations in priority order
  const ffprobePaths = [
    '/usr/local/bin/ffprobe', // Linux/Docker (pinned bundled build)
    '/usr/bin/ffprobe', // Linux/Docker (apt install)
    '/opt/homebrew/bin/ffprobe', // macOS ARM (Homebrew)
  ];

  for (const ffprobePath of ffprobePaths) {
    if (existsSync(ffprobePath)) {
      return ffprobePath;
    }
  }

  throw new Error(`ffprobe not found. Checked: ${ffprobePaths.join(', ')}. Install via apt (Docker) or brew (macOS)`);
}

export const uploadSermon = async (
  inputFilePath: string,
  destinationFilePath: string,
  bucket: Bucket,
  customMetadata: CustomMetadata
) => {
  logger.info('custom metadata', customMetadata);
  const contentDisposition = customMetadata.title
    ? `inline; filename="${customMetadata.title}.mp3"`
    : 'inline; filename="untitled.mp3"';
  await bucket.upload(inputFilePath, { destination: destinationFilePath });
  await bucket.file(destinationFilePath).setMetadata({
    contentType: 'audio/mpeg',
    contentDisposition,
    metadata: customMetadata,
  });
};

export const getDurationSeconds = (filePath: string, cancelToken?: CancelToken): Promise<number> => {
  return new Promise((resolve, reject) => {
    const ffprobePath = getFFprobePath();
    const proc = spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath]);
    cancelToken?.trackProcess(proc);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed with code ${code}: ${stderr}`));
        return;
      }

      try {
        const metadata = JSON.parse(stdout);
        const duration = parseFloat(metadata.format?.duration || '0');
        resolve(duration);
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output: ${err}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
};

/**
 * Rewrites emulator URLs to use the correct host when running in Docker.
 * URLs stored in Firestore may contain 127.0.0.1, but inside Docker,
 * we need to use host.docker.internal to reach the host machine.
 */
function rewriteEmulatorUrl(url: string): string {
  const isDevelopment = process.env.NODE_ENV === 'development';
  const emulatorHost = process.env.FIREBASE_EMULATOR_HOST;

  if (isDevelopment && emulatorHost && emulatorHost !== '127.0.0.1' && emulatorHost !== 'localhost') {
    // Replace 127.0.0.1 or localhost with the configured emulator host
    return url
      .replace(/http:\/\/127\.0\.0\.1:/g, `http://${emulatorHost}:`)
      .replace(/http:\/\/localhost:/g, `http://${emulatorHost}:`);
  }
  return url;
}

/** Request and both streams belong to this promise until pipeline CLOSE. */
export async function downloadFile(fileUrl: string, outputLocationPath: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const response = await axios({ method: 'get', url: rewriteEmulatorUrl(fileUrl), responseType: 'stream', signal });
  await writeOwnedMediaStream(() => response.data, outputLocationPath, signal);
}

/** Own setup failures too: if creating the destination throws, the original
 * input must still be destroyed and settled before its branch can reject. */
export async function writeOwnedMediaStream(
  source: () => Readable,
  destination: string,
  signal?: AbortSignal
): Promise<void> {
  const input = source();
  const inputClosed = finished(input, { cleanup: true }).catch(() => undefined);
  let output: ReturnType<typeof createWriteStream> | undefined;
  let outputClosed: Promise<unknown> | undefined;
  try {
    signal?.throwIfAborted();
    output = createWriteStream(destination);
    outputClosed = finished(output, { cleanup: true }).catch(() => undefined);
    await pipeline(input, output, { signal });
  } catch (error) {
    input.destroy();
    output?.destroy();
    await Promise.all([inputClosed, outputClosed]);
    throw error;
  }
}

/** A rejected parallel branch cannot release files, sermon locks or a future
 * physical host reservation while siblings still own streams/native children.
 * Request cancellation immediately, then retain every ORIGINAL branch promise.
 */
export async function settleMediaBranches<T extends readonly unknown[]>(
  branches: { [K in keyof T]: () => Promise<T[K]> },
  cancelToken: CancelToken
): Promise<T> {
  let failed = false;
  let originalFailure: unknown;
  const results = await Promise.allSettled(
    branches.map((branch) =>
      Promise.resolve()
        .then(branch)
        .catch((error) => {
          if (!failed) {
            failed = true;
            originalFailure = error;
            cancelToken.cancel();
          }
          throw error;
        })
    )
  );
  if (failed) throw originalFailure;
  return results.map((result) => {
    if (result.status !== 'fulfilled') throw result.reason;
    return result.value;
  }) as unknown as T;
}

export const downloadFiles = async (
  bucket: Bucket,
  filePaths: FilePaths,
  tempFiles: Set<string>,
  cancelToken?: CancelToken
): Promise<FilePaths> => {
  const tempFilePaths: FilePaths = { INTRO: undefined, OUTRO: undefined };
  const promises: (() => Promise<unknown>)[] = [];
  // get key and value of filePaths
  for (const [key, filePath] of Object.entries(filePaths) as [keyof FilePaths, string | undefined][]) {
    if (filePath) {
      promises.push(async () => {
        tempFilePaths[key] = createTempFile(path.basename(filePath).split('?')[0], tempFiles);
        await downloadFile(filePath, tempFilePaths[key] as string, cancelToken?.signal);
      });
    }
  }
  if (cancelToken) await settleMediaBranches(promises, cancelToken);
  else {
    const results = await Promise.allSettled(promises.map((run) => Promise.resolve().then(run)));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  return tempFilePaths;
};

export async function executeWithTimeout<T>(
  asyncFunc: () => Promise<T>,
  cancelFunc: () => void,
  delay: number
): Promise<T> {
  if (!Number.isSafeInteger(delay) || delay <= 0) throw new Error('Invalid media operation timeout');
  const wall = Date.now(),
    mono = performance.now();
  let expired = false;
  const failure = () => new Error(`Timeout of ${delay / 1000} seconds exceeded`);
  const cancel = () => {
    if (expired) return;
    expired = true;
    try {
      cancelFunc();
    } catch {
      // Cancellation failure never releases the original operation.
    }
  };
  const elapsed = () => expired || Date.now() < wall || Date.now() - wall >= delay || performance.now() - mono >= delay;
  const timer = setTimeout(cancel, delay);
  try {
    // A timer requests cancellation; it is not evidence of process settlement.
    // Never hand HTTP/task authority back while the original operation runs.
    const result = await asyncFunc();
    if (elapsed()) {
      cancel();
      throw failure();
    }
    return result;
  } catch (error) {
    if (elapsed()) {
      cancel();
      throw failure();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function validateAddIntroOutroData(data: unknown): data is ProcessAudioInputType {
  if (!(data instanceof Object)) return false;
  const inputData = data as Partial<ProcessAudioInputType>;

  // Validate id is a non-empty string
  if (typeof inputData.id !== 'string' || !inputData.id) {
    logger.error('Invalid Argument', 'id must be a non-empty string');
    return false;
  }

  // Validate startTime is a finite number (can be 0)
  if (typeof inputData.startTime !== 'number' || !Number.isFinite(inputData.startTime)) {
    logger.error('Invalid Argument', 'startTime must be a finite number');
    return false;
  }

  // Validate duration is a positive finite number
  if (typeof inputData.duration !== 'number' || !Number.isFinite(inputData.duration) || inputData.duration <= 0) {
    logger.error('Invalid Argument', 'duration must be a positive finite number');
    return false;
  }

  // Validate audio source (youtubeUrl or storageFilePath)
  if ('youtubeUrl' in inputData) {
    if (typeof inputData.youtubeUrl !== 'string' || !normalizeYouTubeUrl(inputData.youtubeUrl)) {
      logger.error('Invalid Argument', 'youtubeUrl must contain a valid YouTube URL or video ID');
      return false;
    }
  } else if ('storageFilePath' in inputData) {
    if (typeof inputData.storageFilePath !== 'string' || !inputData.storageFilePath) {
      logger.error('Invalid Argument', 'storageFilePath must be a non-empty string');
      return false;
    }
  } else {
    logger.error(
      'Invalid Argument',
      'inputData must contain either a valid youtubeUrl (string) or storageFilePath (string) properties'
    );
    return false;
  }

  // Validate optional fields if present
  if (inputData.introUrl !== undefined && (typeof inputData.introUrl !== 'string' || !inputData.introUrl)) {
    logger.error('Invalid Argument', 'introUrl must be a non-empty string if provided');
    return false;
  }

  if (inputData.outroUrl !== undefined && (typeof inputData.outroUrl !== 'string' || !inputData.outroUrl)) {
    logger.error('Invalid Argument', 'outroUrl must be a non-empty string if provided');
    return false;
  }

  return true;
}

function removeTimestampParam(urlString: string): string {
  try {
    const url = new URL(urlString);
    url.searchParams.delete('t'); // Remove the 't' query parameter
    return url.toString();
  } catch (error) {
    logger.error('Invalid URL:', error);
    return urlString; // Return the original URL if parsing fails
  }
}

export function getAudioSource(data: ProcessAudioInputType): AudioSource {
  if ('youtubeUrl' in data) {
    return {
      id: data.id,
      source: removeTimestampParam(normalizeYouTubeUrl(data.youtubeUrl) ?? data.youtubeUrl),
      type: 'YouTubeUrl',
    };
  } else {
    return {
      id: data.id,
      source: data.storageFilePath,
      type: 'StorageFilePath',
    };
  }
}
