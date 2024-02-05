import { CancelToken } from './CancelToken';
import path from 'path';
import { Reference } from 'firebase-admin/database';
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { File } from '@google-cloud/storage';
import { convertStringToMilliseconds, createTempFile } from './utils';

const trimAndTranscode = (
  ffmpeg: typeof import('fluent-ffmpeg'),
  cancelToken: CancelToken,
  contentFile: File,
  tempFiles: Set<string>,
  realtimeDBRef: Reference,
  startTime?: number,
  duration?: number
): Promise<string> => {
  const tmpFilePath = createTempFile(path.basename('temp-transcoded-file.mp3'), tempFiles);
  const inputStream = contentFile.createReadStream();
  const proc = ffmpeg().format('mp3').input(inputStream);
  if (startTime) proc.setStartTime(startTime);
  if (duration) proc.setDuration(duration);
  proc
    .audioCodec('libmp3lame')
    .audioFilters(['dynaudnorm=g=21:m=40:c=1:b=1', 'afftdn', 'pan=stereo|c0<c0+c1|c1<c0+c1']) // Dynamiaclly adjust volume and remove background noise and balance left right audio
    .audioBitrate(128)
    .audioChannels(2)
    .audioFrequency(44100);
  let totalTimeMillis: number;
  let previousPercent = -1;
  return new Promise((resolve, reject) => {
    inputStream.on('error', (error) => {
      logger.error('Trim and Transcode input stream error:', error);
      reject(error);
    });
    inputStream.on('end', () => {
      logger.log('Trim and Transcode end of input stream');
    });
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
};

export default trimAndTranscode;
