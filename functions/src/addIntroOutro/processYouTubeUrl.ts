import { CancelToken } from './CancelToken';
import { YouTubeUrl } from './types';
import { HttpsError } from 'firebase-functions/v2/https';
import { spawn } from 'node:child_process';
import { logger } from 'firebase-functions/v2';
import { Writable } from 'stream';

export const processYouTubeUrl = (
  ytdlpPath: string,
  url: YouTubeUrl,
  cancelToken: CancelToken,
  outputWritableStream: Writable,
  startTime?: number,
  duration?: number,
  ffmpegOptions?: string[]
): Promise<void> => {
  return new Promise((resolve, reject) => {
    logger.log('Streaming audio from youtube video:', url);
    if (cancelToken.isCancellationRequested) {
      reject(new HttpsError('aborted', 'getYouTubeStream operation was cancelled'));
    }
    let totalBytes = 0;
    //pipes output to stdout
    const args = ['-f', 'bestaudio', '-x', '--audio-format', 'mp3', '-o', '-'];
    if (startTime || duration) {
      args.push('--download-sections');
      const startTimeCommand = startTime || 0;
      const endTime = duration ? startTimeCommand + duration : 'inf';
      args.push(`*${startTime}-${endTime}`);
    }

    args.push(url);
    if (ffmpegOptions) {
      args.push(`"ffmpeg:${ffmpegOptions.map((option) => `-${option}`).join(' ')}`);
    }
    logger.log('ytdlp args:', args.join(' '));
    const ytdlp = spawn(ytdlpPath, args);

    ytdlp.on('error', (err) => {
      logger.error('ytdlp Error:', err);
      reject(new HttpsError('internal', 'getYoutubeStream error', err));
    });

    ytdlp.on('close', (code) => {
      logger.log('ytdlp spawn closed with code', code);
    });

    ytdlp.stdout.on('end', () => {
      logger.log('ytdlp stdout ended');
      logger.log('Number of MB streamed', totalBytes / (1024 * 1024));
      resolve();
    });

    ytdlp.stderr?.on('data', (data) => {
      logger.debug('ytdlp stderr:', data.toString());
    });

    ytdlp.stdout?.on('data', (data) => {
      totalBytes += data.length;
    });

    ytdlp.stdout.pipe(outputWritableStream);
  });
};
