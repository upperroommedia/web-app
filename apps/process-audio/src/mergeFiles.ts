import { uploadYouTubeRenderStream } from './temporal/hetzner-render-output';
import { CancelToken } from './CancelToken';
import { Bucket, File } from '@google-cloud/storage';
import { CustomMetadata } from './types';
import { convertStringToMilliseconds, createTempFile, getFFmpegPath, settleMediaBranches } from './utils';
import { writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { pipeline } from 'node:stream/promises';
import { createLoggerWithContext } from './WinstonLogger';
import { LogContext } from './context';
import { setProcessAudioProgress, type ProcessAudioProgressTarget } from './processAudioProgress';

// Parse ffmpeg stderr for progress
function parseFFmpegProgress(stderrLine: string): { time?: string } {
  const result: { time?: string } = {};

  // Parse time: time=00:01:23.45
  const timeMatch = stderrLine.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
  if (timeMatch) {
    result.time = timeMatch[1];
  }

  return result;
}

const mergeFiles = async (
  cancelToken: CancelToken,
  bucket: Bucket,
  filePaths: string[],
  outputFilePath: string,
  durationSeconds: number,
  tempFiles: Set<string>,
  realtimeDBref: ProcessAudioProgressTarget,
  customMetadata: CustomMetadata,
  ctx?: LogContext,
  outputIdentity?: Readonly<Record<string, string>>,
  authorizeOutputUpload?: () => Promise<void>,
  recordOutputGeneration?: (generation: string) => void
): Promise<File> => {
  const log = createLoggerWithContext(ctx);

  log.info('Starting file merge', { fileCount: filePaths.length, outputPath: outputFilePath });

  const listBase = `list-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`;
  const listFileName = createTempFile(listBase, tempFiles);
  const outputFile = bucket.file(outputFilePath);
  const contentDisposition = customMetadata.title
    ? `inline; filename="${customMetadata.title}.mp3"`
    : 'inline; filename="untitled.mp3"';

  // ffmpeg -f concat -i mylist.txt -c copy output
  // Escape single quotes in file paths to prevent ffmpeg concat format issues
  const filePathsForTxt = filePaths.map((filePath) => `file '${filePath.replace(/'/g, "'\\''")}'`);
  const fileNames = filePathsForTxt.join('\n');

  writeFileSync(listFileName, fileNames);

  // Build ffmpeg command
  const ffmpegPath = getFFmpegPath();
  const args = ['-f', 'concat', '-safe', '0', '-i', listFileName, '-c', 'copy', '-f', 'mp3', 'pipe:1'];

  const commandLine = `${ffmpegPath} ${args.join(' ')}`;
  log.info('FFmpeg command', { command: commandLine });

  cancelToken.signal.throwIfAborted();
  const proc = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cancelToken.trackProcess(proc);

  const nativeClose = new Promise<void>((resolve, reject) => {
    let spawnError: Error | undefined;
    proc.once('error', (error) => {
      spawnError = error;
    });
    proc.once('close', (code) => {
      if (spawnError) reject(spawnError);
      else if (code !== 0) reject(new Error(`FFmpeg process exited with code ${code}`));
      else resolve();
    });
  });
  let previousScaledPercent = -1;
  void setProcessAudioProgress(realtimeDBref, 98, 'finalizing', 'Finalizing audio').catch((error) => {
    log.error('Failed to set initial merge progress', { error });
  });

  proc.stderr.on('data', (data: Buffer) => {
    if (cancelToken.isCancellationRequested) return;
    const stderrLine = data.toString();
    const progress = parseFFmpegProgress(stderrLine);
    if (progress.time) {
      const timeMillis = convertStringToMilliseconds(progress.time);
      const durationMillis = durationSeconds * 1000;
      const percent = Math.round(Math.max(0, (timeMillis / durationMillis) * 100));
      // percent is a number between 0 - 100 but we want to scale it to be from 98 - 100
      // This continues from transcode (30-98%) for continuous progress: 0-100%
      const scaledPercent = Math.round(percent * 0.02 + 98);
      // Always log progress at info level so it's written in production (more frequent than DB updates)
      log.info('Merge progress', { percent: scaledPercent });
      // Only update DB when percent actually changes (less frequent than logs)
      if (scaledPercent > previousScaledPercent) {
        previousScaledPercent = scaledPercent;
        setProcessAudioProgress(
          realtimeDBref,
          scaledPercent,
          'finalizing',
          'Finalizing audio',
          percent > 0 ? Math.max(1, Math.round(percent)) : 0
        ).catch((err) => {
          log.error('Failed to update progress in realtimeDB', {
            error: err instanceof Error ? err.message : String(err),
            percent: scaledPercent,
          });
        });
      } else if (scaledPercent < previousScaledPercent) {
        // Log when we detect backwards progress but don't update DB
        log.debug('Skipping backwards merge progress update', {
          previousPercent: previousScaledPercent,
          newPercent: scaledPercent,
          timeMillis,
        });
      }
      // If scaledPercent === previousScaledPercent, we just log (already done above) but don't update DB
    }
  });

  // A failed upload must cancel FFmpeg. A failed FFmpeg must also settle the
  // upload before the caller can release ownership or retry.
  await settleMediaBranches(
    [
      () => nativeClose,
      async () => {
        if (authorizeOutputUpload) await authorizeOutputUpload();
        cancelToken.signal.throwIfAborted();
        const options = {
          contentType: 'audio/mpeg' as const,
          metadata: { contentDisposition, metadata: { ...customMetadata, ...outputIdentity } },
          ...(outputIdentity ? { preconditionOpts: { ifGenerationMatch: 0 } } : {}),
        };
        if (outputIdentity && recordOutputGeneration) {
          const { generation } = await uploadYouTubeRenderStream({
            bucket,
            path: outputFilePath,
            input: proc.stdout,
            options,
            identity: outputIdentity,
            signal: cancelToken.signal,
          });
          recordOutputGeneration(generation);
        } else {
          await pipeline(proc.stdout, outputFile.createWriteStream(options), { signal: cancelToken.signal });
        }
      },
    ] as const,
    cancelToken
  );
  cancelToken.signal.throwIfAborted();
  log.info('Merge completed successfully', { outputPath: outputFilePath });
  void setProcessAudioProgress(realtimeDBref, 100, 'completed', 'Completed').catch((error) => {
    log.error('Failed to set final merge progress', { error });
  });
  return outputFile;
};

export default mergeFiles;
