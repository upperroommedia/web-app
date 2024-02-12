import { CancelToken } from './CancelToken';
import path from 'path';
import { Bucket, File } from '@google-cloud/storage';
import { Reference } from 'firebase-admin/database';
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { convertStringToMilliseconds, createTempFile, logMemoryUsage, throwErrorOnSpecificStderr } from './utils';
import { CustomMetadata, AudioSource } from './types';
import { processYouTubeUrl } from './processYouTubeUrl';
import { unlink } from 'fs/promises';

const ytdlpPath = path.join(__dirname, '../../..', '..', 'bin', 'yt-dlp');
logger.log(ytdlpPath);

const trimAndTranscode = async (
  ffmpeg: typeof import('fluent-ffmpeg'),
  cancelToken: CancelToken,
  bucket: Bucket,
  audioSource: AudioSource,
  outputFilePath: string,
  tempFiles: Set<string>,
  realtimeDBRef: Reference,
  customMetadata: CustomMetadata,
  startTime?: number,
  duration?: number
): Promise<File> => {
  const outputFile = bucket.file(outputFilePath);
  const contentDisposition = customMetadata.title
    ? `inline; filename="${customMetadata.title}.mp3"`
    : 'inline; filename="untitled.mp3"';
  const writeStream = outputFile.createWriteStream({
    contentType: 'audio/mpeg',
    metadata: { contentDisposition, metadata: customMetadata },
  });
  const ffmpegOptions = [
    '-acodec libmp3lame',
    '-b:a 128k',
    '-ac 2',
    '-ar 44100',
    '-filter:a dynaudnorm=g=21:m=40:c=1:b=1,afftdn,pan=stereo|c0<c0+c1|c1<c0+c1',
  ];
  if (audioSource.type === 'YouTubeUrl') {
    await processYouTubeUrl(
      ytdlpPath,
      audioSource.source,
      cancelToken,
      writeStream,
      startTime,
      duration,
      ffmpegOptions
    );
    return outputFile;
  }
  // Process the audio source from storage

  // Download the raw audio source from storage
  const rawSourceFile = createTempFile(`raw-${audioSource.id}`, tempFiles);
  logger.log('Downloading raw audio source to', rawSourceFile);
  await bucket.file(audioSource.source).download({ destination: rawSourceFile });
  logger.log('Successfully downloaded raw audio source');
  const proc = ffmpeg().format('mp3').input(rawSourceFile);

  if (startTime) proc.setStartTime(startTime);
  if (duration) proc.setDuration(duration);
  proc.addOptions(ffmpegOptions);
  let totalTimeMillis: number;
  let previousPercent = -1;
  const promiseResult = await new Promise<File>((resolve, reject) => {
    proc
      .on('start', function (commandLine) {
        logger.log('Trim And Transcode Spawned Ffmpeg with command: ' + commandLine);
      })
      .on('end', async () => {
        logger.log('Finished Trim and Transcode');
        resolve(outputFile);
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
      .on('stderr', (stderrLine) => {
        logger.debug('Ffmpeg stdout:', stderrLine);
        try {
          throwErrorOnSpecificStderr(stderrLine);
        } catch (err) {
          reject(err);
        }
      })
      .on('progress', async (progress) => {
        logger.debug('Trim and Transcode progress:', progress);
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
      .pipe(writeStream);
  });

  // Delete raw audio from temp memory
  await logMemoryUsage('Before raw audio delete memory:');
  logger.log('Deleting raw audio temp file:', rawSourceFile);
  await unlink(rawSourceFile);
  tempFiles.delete(rawSourceFile);
  logger.log('Successfully deleted raw audio temp file:', rawSourceFile);
  await logMemoryUsage('After raw audio delete memory:');

  return promiseResult;
};

export default trimAndTranscode;
