import { CancelToken } from './CancelToken';
import path from 'path';
import { Reference } from 'firebase-admin/database';
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { convertStringToMilliseconds, createTempFile } from './utils';

const trimAndTranscode = (
  ffmpeg: typeof import('fluent-ffmpeg'),
  cancelToken: CancelToken,
  filePath: string,
  tempFiles: Set<string>,
  realtimeDBRef: Reference,
  startTime?: number,
  duration?: number
): Promise<string> => {
  const tmpFilePath = createTempFile(path.basename('temp-transcoded-file.mp3'), tempFiles);
  const proc = ffmpeg().input(filePath);
  if (startTime) proc.setStartTime(startTime);
  if (duration) proc.setDuration(duration);
  proc.outputOption('-c copy');
  let totalTimeMillis: number;
  let previousPercent = -1;
  return new Promise((resolve, reject) => {
    proc
      .on('start', function (commandLine) {
        logger.log('Trim Spawned Ffmpeg with command: ' + commandLine);
      })
      .on('end', async () => {
        logger.log('Finished Trim');
        resolve(tmpFilePath);
      })
      .on('error', (err) => {
        logger.error('Trim Error:', err);
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
          reject(new HttpsError('aborted', 'Trim operation was cancelled'));
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
          logger.log('Trim Progress:', percent);
          realtimeDBRef.set(percent);
        }
      })
      .saveToFile(tmpFilePath);
  });
};

export default trimAndTranscode;
