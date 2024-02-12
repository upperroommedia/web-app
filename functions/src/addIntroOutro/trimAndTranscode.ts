import { CancelToken } from './CancelToken';
import path from 'path';
import { Reference } from 'firebase-admin/database';
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { File } from '@google-cloud/storage';
import { convertStringToMilliseconds, createTempFile } from './utils';
import { YouTubeUrl } from './types';
import { Readable } from 'node:stream';
import { processYouTubeUrl } from './processYouTubeUrl';

const ytdlpPath = path.join(__dirname, '../../..', '..', 'bin', 'yt-dlp');
logger.log(ytdlpPath);

const trimAndTranscode = (
  ffmpeg: typeof import('fluent-ffmpeg'),
  cancelToken: CancelToken,
  source: File | YouTubeUrl,
  tempFiles: Set<string>,
  realtimeDBRef: Reference,
  startTime?: number,
  duration?: number
): Promise<string> => {
  const tmpFilePath = createTempFile(path.basename('temp-transcoded-file.mp3'), tempFiles);
  let inputStream: Readable | null;
  const ffmpegOptions = [
    '-acodec libmp3lame',
    '-b:a 128k',
    '-ac 2',
    '-ar 44100',
    '-filter:a dynaudnorm=g=21:m=40:c=1:b=1,afftdn,pan=stereo|c0<c0+c1|c1<c0+c1',
  ];
  if (source instanceof File) {
    inputStream = source.createReadStream();
    const proc = ffmpeg().format('mp3').input(inputStream);
    if (startTime) proc.setStartTime(startTime);
    if (duration) proc.setDuration(duration);
    proc.outputOptions(ffmpegOptions);
    let totalTimeMillis: number;
    let previousPercent = -1;
    return new Promise((resolve, reject) => {
      proc
        .on('start', function (commandLine) {
          logger.log('Trim And Transcode Spawned Ffmpeg with command: ' + commandLine);
        })
        .on('end', async () => {
          logger.log('Finished Trim and Transcode');
          resolve(tmpFilePath);
        })
        .on('error', (err) => {
          logger.error('Trim and Transcode Error:', err);
          reject(err);
        })
        .on('codecData', (data) => {
          // HERE YOU GET THE TOTAL TIME
          console.log('Total duration: ' + data.duration);
          totalTimeMillis = convertStringToMilliseconds(data.duration);
        })
        .on('progress', async (progress) => {
          if (cancelToken.isCancellationRequested) {
            logger.log('Cancellation requested, killing ffmpeg process');
            proc.kill('SIGTERM'); // this sends a termination signal to the process
            reject(new HttpsError('aborted', 'Trim and Transcode operation was cancelled'));
          }
          const timeMillis = convertStringToMilliseconds(progress.timemark);
          const calculatedDuration = duration
            ? duration * 1000
            : startTime
            ? totalTimeMillis - startTime * 1000
            : totalTimeMillis;
          const percent = Math.round(Math.max(0, ((timeMillis * 0.95) / calculatedDuration) * 100)); // go to 95% to leave room for the time it takes to Merge the files
          if (percent !== previousPercent) {
            previousPercent = percent;
            logger.log('Trim and Transcode Progress:', percent);
            realtimeDBRef.set(percent);
          }
        })
        .saveToFile(tmpFilePath);
    });
  } else {
    return processYouTubeUrl(ytdlpPath, source, cancelToken, tmpFilePath, startTime, duration, ffmpegOptions);
  }
};

export default trimAndTranscode;
