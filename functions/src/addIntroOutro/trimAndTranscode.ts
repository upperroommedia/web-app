import { CancelToken } from './CancelToken';
import { Bucket, File } from '@google-cloud/storage';
import { Reference } from 'firebase-admin/database';
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { convertStringToMilliseconds, createTempFile, logMemoryUsage, throwErrorOnSpecificStderr } from './utils';
import { CustomMetadata, AudioSource } from './types';
import { unlink } from 'fs/promises';
import { Readable } from 'stream';
import { sermonStatus, sermonStatusType } from '../../../types/SermonTypes';
import ytdl from 'ytdl-core';
// import { HttpsProxyAgent } from 'https-proxy-agent';

const trimAndTranscode = async (
  ffmpeg: typeof import('fluent-ffmpeg'),
  cancelToken: CancelToken,
  bucket: Bucket,
  audioSource: AudioSource,
  outputFilePath: string,
  tempFiles: Set<string>,
  realtimeDBRef: Reference,
  docRef: FirebaseFirestore.DocumentReference,
  sermonStatus: sermonStatus,
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
  let inputSource: string | Readable;
  let transcodingStarted = false;
  const updateDownloadProgress = (progress: number) => {
    if (!transcodingStarted) {
      realtimeDBRef.set(progress);
    }
  };

  let inputSourceError: HttpsError;
  if (audioSource.type === 'YouTubeUrl') {
    // Process the audio source from YouTube
    logger.log('Streaming audio from youtube video:', audioSource.source);
    // Remove 'user:pass@' if you don't need to authenticate to your proxy.
    // const proxy = 'http://111.111.111.111:8080';
    // const agent = new HttpsProxyAgent(proxy);
    const ytdlOptions: ytdl.downloadOptions = {
      quality: 'highestaudio',
      filter: 'audioonly',
      // requestOptions: { agent },
    };
    // this doesn't seem consistent with live videos so leaving it out for now
    // if (startTime) {
    //   ytdlOptions['begin'] = `${startTime}s`;
    // }
    logger.debug('ytdlOptions:', ytdlOptions);
    inputSource = ytdl(audioSource.source, ytdlOptions);
    let perviousProgress = -1;
    let lastDownloaded = 0;
    let lastTimestamp = Date.now();
    let slowBandwidthCount = 0;
    inputSource
      .on('progress', (chunkLength, downloaded, total) => {
        const now = Date.now();
        const elapsed = (now - lastTimestamp) / 1000; // convert ms to s
        const bytesDownloaded = downloaded - lastDownloaded;
        const progress = Math.round((downloaded / total) * 100);
        const downloadRate = bytesDownloaded / elapsed / 1024 / 1024; // MB per second
        if (!transcodingStarted && downloadRate < 0.1) {
          slowBandwidthCount++;
          if (slowBandwidthCount > 5) {
            logger.error('Bandwidth too slow, aborting download');
            if (inputSource instanceof Readable) {
              inputSource.emit('end');
              inputSource.destroy();
            }
            inputSourceError = new HttpsError('resource-exhausted', 'Bandwidth too slow, aborting download');
            throw inputSourceError;
          }
        }
        if (progress !== perviousProgress) {
          perviousProgress = progress;
          updateDownloadProgress(progress);
          const totalMiB = total / 1024 / 1024;
          logger.log(`Youtube Download ${progress}% of ${totalMiB.toFixed(2)}MiB at ${downloadRate.toFixed(2)} MB/s`);
          lastDownloaded = downloaded;
          lastTimestamp = now;
        }
      })
      .on('error', (err) => {
        logger.error('ytdl Error:', err);
        if (inputSource instanceof Readable) {
          inputSource.emit('end');
          inputSource.destroy();
        }
        inputSourceError = new HttpsError('internal', 'getYoutubeStream error', err);
        throw inputSourceError;
      })
      .on('end', () => {
        logger.log('ytdl stream ended');
      });
  } else {
    // Process the audio source from storage
    const rawSourceFile = createTempFile(`raw-${audioSource.id}`, tempFiles);
    logger.log('Downloading raw audio source to', rawSourceFile);
    await bucket.file(audioSource.source).download({ destination: rawSourceFile });
    logger.log('Successfully downloaded raw audio source');
    inputSource = rawSourceFile;
  }

  // Download the raw audio source from storage

  const proc = ffmpeg().format('mp3').input(inputSource);
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
  const promiseResult = await new Promise<File>((resolve, reject) => {
    proc
      .on('start', async function (commandLine) {
        logger.log('Trim And Transcode Spawned Ffmpeg with command: ' + commandLine);
      })
      .on('end', async () => {
        logger.log('Finished Trim and Transcode');
        if (inputSource instanceof Readable) {
          logger.log('Ending ytdl stream');
          inputSource.emit('end');
          logger.log('Killing ytdlp process');
          inputSource.destroy(); // this sends a termination signal to the process
        }
        resolve(outputFile);
      })
      .on('error', (err) => {
        logger.error('Trim and Transcode Error:', err);
        if (inputSourceError) {
          reject(inputSourceError);
        } else {
          reject(err);
        }
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
          if (inputSourceError) {
            reject(inputSourceError);
          } else {
            reject(err);
          }
        }
      })
      .on('progress', async (progress) => {
        if (cancelToken.isCancellationRequested) {
          logger.log('Cancellation requested, killing ffmpeg process');
          proc.kill('SIGTERM'); // this sends a termination signal to the process
          if (inputSource instanceof Readable) {
            logger.log('Ending ytdl stream');
            inputSource.emit('end');
            logger.log('Killing ytdlp process');
            inputSource.destroy(); // this sends a termination signal to the process
          }
          reject(new HttpsError('aborted', 'Trim and Transcode operation was cancelled'));
        }
        if (!transcodingStarted) {
          transcodingStarted = true;
          await docRef.update({
            status: {
              ...sermonStatus,
              audioStatus: sermonStatusType.PROCESSING,
              message: 'Trimming and Transcoding',
            },
          });
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
  if (typeof inputSource === 'string') {
    // Delete raw audio from temp memory
    await logMemoryUsage('Before raw audio delete memory:');
    logger.log('Deleting raw audio temp file:', inputSource);
    await unlink(inputSource);
    tempFiles.delete(inputSource);
    logger.log('Successfully deleted raw audio temp file:', inputSource);
    await logMemoryUsage('After raw audio delete memory:');
  }

  return promiseResult;
};

export default trimAndTranscode;
