import { logger } from 'firebase-functions/v2';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { path as ffprobeStatic } from 'ffprobe-static';
import path from 'path';
import { Bucket, File, Storage } from '@google-cloud/storage';
import { AxiosError, isAxiosError } from 'axios';
import { sermonStatus, sermonStatusType, uploadStatus } from '../../types/SermonTypes';
import { firestoreAdminSermonConverter } from './firestoreDataConverter';
import { HttpsError } from 'firebase-functions/v2/https';
import { Reference } from 'firebase-admin/database';
import { Readable } from 'stream';

const storage = new Storage();

type filePaths = {
  INTRO: string | undefined;
  CONTENT: string;
  OUTRO: string | undefined;
};

if (!ffmpegStatic) {
  logger.error('ffmpeg-static not found');
} else {
  logger.log('ffmpeg-static found', ffmpegStatic);
  ffmpeg.setFfmpegPath(ffmpegStatic);
  logger.log('ffprobe-static found', ffprobeStatic);
  ffmpeg.setFfprobePath(ffprobeStatic);
}

const convertStringToMilliseconds = (timeStr: string): number => {
  // '10:20:30:500'  Example time string
  if (!timeStr) {
    return 0;
  }
  const [hours, minutes, secondsAndMilliseconds] = timeStr.split(':');
  if (!secondsAndMilliseconds) {
    return 0;
  }
  const [seconds, milliseconds] = secondsAndMilliseconds.split('.');

  return (parseInt(hours) * 60 * 60 + parseInt(minutes) * 60 + parseInt(seconds)) * 1000 + parseInt(milliseconds);
};

const trimAndTranscode = (
  bucket: Bucket,
  filePath: string,
  realtimeDBRef: Reference,
  startTime?: number,
  duration?: number
): Promise<File> => {
  const inputFile = bucket.file(filePath);
  const outputFile = bucket.file(`processed-sermons/${path.basename(filePath)}`);

  const proc = ffmpeg().format('mp3').input(inputFile.createReadStream());
  if (startTime) proc.setStartTime(startTime);
  if (duration) proc.setDuration(duration);
  proc
    .audioCodec('libmp3lame')
    .audioFilters(['dynaudnorm=g=21:m=40:c=1:b=1', 'afftdn', 'pan=stereo|c0<c0+c1|c1<c0+c1']) // Dynamiaclly adjust volume and remove background noise and balance left right audio
    .audioBitrate(128)
    .audioChannels(2)
    .audioFrequency(44100)
    .pipe(outputFile.createWriteStream({ contentType: 'audio/mpeg' }));
  let totalTimeMillis: number;
  return new Promise((resolve, reject) => {
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
        console.log('Total duration: ' + data.duration);
        totalTimeMillis = convertStringToMilliseconds(data.duration);
      })
      .on('progress', (progress) => {
        const timeMillis = convertStringToMilliseconds(progress.timemark);
        const calculatedDuration = duration
          ? duration * 1000
          : startTime
          ? totalTimeMillis - startTime * 1000
          : totalTimeMillis;
        const percent = ((timeMillis * 0.96) / calculatedDuration) * 100; // go to 96% to leave room for the time it takes to Merge the files
        logger.log('Trim and Transcode Progress:', percent);
        // const memoryUsage = process.memoryUsage();
        // const memoryUsageInMB = {
        //   rss: (memoryUsage.rss / (1024 * 1024)).toFixed(2), // Resident Set Size
        //   heapTotal: (memoryUsage.heapTotal / (1024 * 1024)).toFixed(2), // Total size of the allocated heap
        //   heapUsed: (memoryUsage.heapUsed / (1024 * 1024)).toFixed(2), // Actual memory used
        //   external: (memoryUsage.external / (1024 * 1024)).toFixed(2), // Memory used by C++ objects bound to JavaScript objects
        // };

        // console.log('Memory usage:', memoryUsageInMB);
        realtimeDBRef.set(percent && percent > 0 ? percent : 0);
      });
  });
};

function parseGcsUrl(url: URL): { bucket: string; filePath: string } {
  /* eslint-disable no-useless-escape */
  const regex = /http.*:\/\/.*\/v0\/b\/([^\/]+)\/o\/([^?]+)\?.*/;
  /* eslint-disable no-useless-escape */
  const matches = url.toString().match(regex);

  if (matches && matches.length === 3) {
    return {
      bucket: matches[1],
      filePath: decodeURIComponent(matches[2]),
    };
  }

  throw new Error('Invalid Google Cloud Storage URL');
}

function getDurationSeconds(outputAudioFile: File): number {
  const fileSize = outputAudioFile.metadata.size || 0;
  const fileSizeInBits = fileSize * 8;
  const duration = fileSizeInBits / 128000; // Duration in seconds
  logger.log(outputAudioFile.name, 'is ', fileSizeInBits, 'bits long and', duration, 'seconds');
  return duration;
}

const mergeFiles = async (
  bucket: Bucket,
  contentFile: File,
  realtimeDBref: Reference,
  introUrl?: URL,
  outroUrl?: URL
): Promise<File> => {
  const outputFilePath = `intro-outro-sermons/${path.basename(contentFile.name)}`;
  const outputFile = bucket.file(outputFilePath);
  logger.log('Merging files to:', outputFilePath);
  const streams: Readable[] = [];

  // Add intro
  if (introUrl) {
    const { bucket: introBucket, filePath: introFilePath } = parseGcsUrl(introUrl);
    logger.log('Intro - introBucket:', introBucket, 'introFilePath', introFilePath);
    const introFileStream = storage.bucket(introBucket).file(introFilePath).createReadStream();
    streams.push(introFileStream);
  }
  // Add content
  const contentFileStream = contentFile.createReadStream();
  streams.push(contentFileStream);

  // Add outro
  if (outroUrl) {
    const { bucket: outroBucket, filePath: outroFilePath } = parseGcsUrl(outroUrl);
    logger.log('Outro - outroBucket:', outroBucket, 'outroFilePath', outroFilePath);
    const outroFileStream = storage.bucket(outroBucket).file(outroFilePath).createReadStream();
    streams.push(outroFileStream);
  }
  // Create a write stream to the output file
  const writeStream = outputFile.createWriteStream();

  function pipeStreams(i: number) {
    if (i < streams.length) {
      streams[i].pipe(writeStream, { end: false });
      streams[i].on('end', () => {
        const percent = 99 - streams.length + i + 1;
        logger.log('Merge Files percent:', percent);
        realtimeDBref.set(percent);
        pipeStreams(i + 1);
      });
      streams[i].on('error', function (err) {
        logger.error('MergeFiles Error:', err);
        throw err;
      });
    } else {
      writeStream.end();
    }
  }
  // Start piping the streams
  pipeStreams(0);

  // Return a promise that resolves with the output file when the write stream finishes
  return new Promise((resolve, reject) => {
    writeStream.on('finish', () => resolve(outputFile));
    writeStream.on('error', (err) => {
      logger.error('MergeFiles Error:', err);
      reject(err);
    });
  });
};

const addIntroOutro = onObjectFinalized(
  {
    timeoutSeconds: 540,
    // memory: '1GiB', cpu: 1, concurrency: 1
  },
  async (storageEvent): Promise<void> => {
    const data = storageEvent.data;
    const filePath = data.name ? data.name : '';
    logger.log('Object Finalized', filePath);
    if (!filePath.startsWith('sermons/') || filePath.endsWith('sermon/')) {
      // Not a sermon
      return logger.log('Not a sermon');
    }
    if (!data.mediaLink) {
      // This is not a media file
      return logger.log('Not a media file');
    }

    // exec(`${ffmpegStatic} -version`, (err, stdout) => {
    //   if (err) {
    //     logger.error('FFMPEG not installed', err);
    //   } else {
    //     logger.log('FFMPEG version', stdout);
    //   }
    // });
    const bucket = firebaseAdmin.storage().bucket();
    const realtimeDB = firebaseAdmin.database();
    const db = firebaseAdmin.firestore();
    const fileName = path.basename(filePath);
    const docRef = db.collection('sermons').withConverter(firestoreAdminSermonConverter).doc(fileName);
    const sermonStatus: sermonStatus = {
      subsplash: uploadStatus.NOT_UPLOADED,
      soundCloud: uploadStatus.NOT_UPLOADED,
      audioStatus: sermonStatusType.PROCESSING,
    };
    // the document may not exist yet, if it deosnt wait 5 seconds and try again do this for a max of 3 times before throwing an error
    const maxTries = 3;
    let currentTry = 0;
    let docFound = false;
    while (currentTry < maxTries) {
      logger.log(`Checking if document exists attempt: ${currentTry + 1}/${maxTries}`);
      logger.log('Document Reference', docRef.path);
      try {
        const doc = await docRef.get();
        logger.log('Document', doc);
        if (doc.exists) {
          docFound = true;
          logger.log('Document exists');
          break;
        }
        logger.log(`Document does not exist attempt: ${currentTry + 1}/${maxTries}`);
        currentTry++;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } catch (e) {
        logger.error('Error getting document', e);
      }
    }
    if (!docFound) {
      throw new HttpsError('not-found', `Sermon Document ${fileName} Not Found`);
    }

    try {
      logger.log('Adding intro outro is using streaming to reduce function memory requirments');
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.PROCESSING,
          message: 'Getting Data',
        },
      });
      logger.log(data.metadata);
      const audioFilesToMerge: filePaths = { CONTENT: filePath, INTRO: undefined, OUTRO: undefined };
      const customMetadata: { introUrl?: string; outroUrl?: string } = {};
      if (data.metadata?.introUrl) {
        audioFilesToMerge.INTRO = data.metadata.introUrl;
        customMetadata.introUrl = data.metadata.introUrl;
      }
      if (data.metadata?.outroUrl) {
        audioFilesToMerge.OUTRO = data.metadata.outroUrl;
        customMetadata.outroUrl = data.metadata.outroUrl;
      }
      // logger.log('Audio File Download Paths', JSON.stringify(audioFilesToMerge));
      // const tempFilePaths = await downloadFiles(bucket, audioFilesToMerge, tempFiles);
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.PROCESSING,
          message: 'Trimming and Transcoding',
        },
      });

      logger.log('Trimming and Transcoding');
      let outputAudioFile = await trimAndTranscode(
        bucket,
        filePath,
        realtimeDB.ref(`addIntroOutro/${fileName}`),
        parseFloat(data.metadata?.startTime || ''),
        parseFloat(data.metadata?.duration || '')
      );
      // let durationSeconds = await getDurationSeconds(tempFilePaths.CONTENT);
      // await uploadSermon(tempFilePaths.CONTENT, `processed-sermons/${fileName}`, bucket, customMetadata);
      logger.log('Transcoded Audio File', outputAudioFile.name, outputAudioFile.metadata);
      if (audioFilesToMerge.INTRO || audioFilesToMerge.OUTRO) {
        await docRef.update({
          status: {
            ...sermonStatus,
            audioStatus: sermonStatusType.PROCESSING,
            message: 'Adding Intro and Outro',
          },
        });

        //merge files
        outputAudioFile = await mergeFiles(
          bucket,
          outputAudioFile,
          realtimeDB.ref(`addIntroOutro/${fileName}`),
          audioFilesToMerge.INTRO ? new URL(audioFilesToMerge.INTRO) : undefined,
          audioFilesToMerge.OUTRO ? new URL(audioFilesToMerge.OUTRO) : undefined
        );
      }

      logger.log('Updating status to PROCESSED');
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.PROCESSED,
        },
        durationSeconds: getDurationSeconds(outputAudioFile),
      });
      realtimeDB.ref(`addIntroOutro/${fileName}`).set(100);
      await realtimeDB.ref(`addIntroOutro/${fileName}`).remove();

      // delete original audio file
      logger.log('Deleting original audio file', filePath);
      await bucket.file(filePath).delete();
      logger.log('Original audio file deleted');

      return logger.log('Files have been merged succesfully');
    } catch (e) {
      let message = 'Something Went Wrong';
      if (e instanceof HttpsError) {
        message = e.message;
      } else if (isAxiosError(e)) {
        const axiosError = e as AxiosError;
        message = axiosError.message;
      } else if (e instanceof Error) {
        message = e.message;
      }
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.ERROR,
          message: message,
        },
      });
      return logger.error('Error', e);
    }
  }
);

export default addIntroOutro;
