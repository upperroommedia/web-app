import { Readable } from 'node:stream';
import { CancelToken } from './CancelToken';
import { YouTubeUrl } from './types';
import { HttpsError } from 'firebase-functions/v2/https';
import { spawn } from 'node:child_process';
import { logger } from 'firebase-functions/v2';

export const getYouTubeStream = (
  ytdlpPath: string,
  url: YouTubeUrl,
  cancelToken: CancelToken,
  startTime?: number,
  duration?: number
): Readable => {
  logger.log('In getYouTubeStream');
  if (cancelToken.isCancellationRequested) {
    throw new HttpsError('aborted', 'getYouTubeStream operation was cancelled');
  }

  //pipes output to stdout
  const args = ['-f', 'bestaudio', '-x', '--audio-format', 'mp3', '-o', '-'];

  if (startTime || duration) {
    args.push('--download-sections');
    const startTimeCommand = startTime || 0;
    const endTime = duration ? duration - startTimeCommand : 'inf';
    args.push(`*${startTime}-${endTime}`);
  }

  args.push(url);
  const ytdlp = spawn(ytdlpPath, args);

  ytdlp.on('error', (err) => {
    logger.error('ytdlp Error:', err);
    throw new HttpsError('internal', 'getYoutubeStream error', err);
  });

  // ytdlp.stderr?.on('data', (data) => {
  //   logger.log('ytdlp stderr:', data.length);
  // });

  // ytdlp.stdout?.on('data', (data) => {
  //   logger.log('ytdlp stdout:', data.length);
  // });

  return ytdlp.stdout || new Readable();
};
