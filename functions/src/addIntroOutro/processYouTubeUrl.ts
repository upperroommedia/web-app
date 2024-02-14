import { CancelToken } from './CancelToken';
import { YouTubeUrl } from './types';
import { HttpsError } from 'firebase-functions/v2/https';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { logger } from 'firebase-functions/v2';
import { Writable } from 'stream';

function extractPercent(line: string): number | null {
  const percentMatch = line.match(/(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)%/);
  return percentMatch ? parseFloat(percentMatch[1]) : null;
}

export const processYouTubeUrl = (
  ytdlpPath: string,
  url: YouTubeUrl,
  cancelToken: CancelToken,
  passThrough: Writable,
  updateProgressCallback: (progress: number) => void
): ChildProcessWithoutNullStreams => {
  logger.log('Streaming audio from youtube video:', url);
  if (cancelToken.isCancellationRequested) {
    throw new HttpsError('aborted', 'getYouTubeStream operation was cancelled');
  }
  let totalBytes = 0;
  //pipes output to stdout
  const args = ['-f', 'bestaudio', '-x', '--audio-format', 'mp3', '-N 4', '-o', '-'];
  args.push(url);

  // Log the actual command
  const command = `${ytdlpPath} ${args.join(' ')}`;
  logger.log('Executing command:', JSON.stringify(command));
  const ytdlp = spawn(ytdlpPath, args);

  ytdlp.on('error', (err) => {
    logger.error('ytdlp Error:', err);
    throw new HttpsError('internal', 'getYoutubeStream error', err);
  });

  ytdlp.on('close', (code) => {
    logger.log('ytdlp spawn closed with code', code);
    if (code && code !== 0) {
      logger.error('Spawn closed with non-zero code of:', code);
      throw new HttpsError(
        'internal',
        'Spawn closed with non-zero error code. Please check logs for more information.'
      );
    }
  });

  ytdlp.on('exit', () => {
    logger.log('ytdlp spawn exited');
  });

  ytdlp.stdout.on('end', () => {
    logger.log('ytdlp stdout ended');
    logger.log('Number of MB streamed', totalBytes / (1024 * 1024));
  });

  ytdlp.stderr?.on('error', (err) => {
    logger.error('ytdlp stderr Error:', err);
    throw new HttpsError('internal', 'getYoutubeStream error', err);
  });

  ytdlp.stderr?.on('data', (data) => {
    if (cancelToken.isCancellationRequested) {
      throw new HttpsError('aborted', 'getYouTubeStream operation was cancelled');
    }
    if (data.includes('download')) {
      const percent = extractPercent(data.toString());
      if (percent) {
        // update progress only when transcoding has not started
        updateProgressCallback(percent);
      }
    }
    logger.debug('ytdlp stderr:', data.toString());
  });

  ytdlp.stdout?.on('data', (data) => {
    totalBytes += data.length;
  });

  ytdlp.stdout.pipe(passThrough);

  return ytdlp;
};
