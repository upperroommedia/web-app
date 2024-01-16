import { logger } from 'firebase-functions/v2';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { path as ffprobeStatic } from 'ffprobe-static';
import path from 'path';
// import os from 'os';
// import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'fs';
import { unlink } from 'fs/promises';
import { Bucket, File } from '@google-cloud/storage';
import { AxiosError, isAxiosError } from 'axios';
import { sermonStatus, sermonStatusType, uploadStatus } from '../../types/SermonTypes';
import { firestoreAdminSermonConverter } from './firestoreDataConverter';
import { HttpsError } from 'firebase-functions/v2/https';
import { Reference } from 'firebase-admin/database';
// import { exec } from 'node:child_process';

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

// const createTempFile = (fileName: string, tempFiles: Set<string>) => {
//   try {
//     if (!existsSync(os.tmpdir())) {
//       mkdirSync(os.tmpdir());
//     }
//     const filePath = path.join(os.tmpdir(), fileName);
//     tempFiles.add(filePath);
//     return filePath;
//   } catch (err) {
//     throw new Error(`Error creating temp file: ${err}`);
//   }
// };
const convertStringToMilliseconds = (timeStr: string): number => {
  // '10:20:30:500'  Example time string
  const [hours, minutes, secondsAndMilliseconds] = timeStr.split(':');
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
        const percent = ((timeMillis * 0.97) / calculatedDuration) * 100; // go to 97% to leave room for the time it takes to Merge the files
        realtimeDBRef.set(percent && percent > 0 ? percent : 0);
      });
  });
};

const mergeFiles = (
  bucket: Bucket,
  contentFilePath: string,
  realtimeDBref: Reference,
  introFilePath?: string,
  outroFilePath?: string
): Promise<File> => {
  const introFile = introFilePath ? bucket.file(introFilePath).createReadStream() : null;
  const outroFile = outroFilePath ? bucket.file(outroFilePath).createReadStream() : null;
  const contentFile = bucket.file(contentFilePath).createReadStream();

  const merge = ffmpeg();

  if (introFile) {
    merge.input(introFile);
  }

  merge.input(contentFile);

  if (outroFile) {
    merge.input(outroFile);
  }

  const outputFilePath = `intro-outro-sermons/${contentFilePath}`;
  const outputFile = bucket.file(outputFilePath);

  merge
    .output(outputFile.createWriteStream())
    .outputOptions('-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1')
    .outputFormat('mp3');

  return new Promise((resolve, reject) => {
    merge
      .on('start', function (commandLine) {
        realtimeDBref.set(98);
        logger.log('MergeFiles Spawned Ffmpeg with command: ' + commandLine);
      })
      .on('end', async function () {
        realtimeDBref.set(98);
        resolve(outputFile);
      })
      .on('error', function (err) {
        logger.error('MergeFiles Error:', err);
        reject(err);
      })
      .run();
  });
};

// const uploadSermon = async (
//   inputFilePath: string,
//   destinationFilePath: string,
//   bucket: Bucket,
//   customMetadata?: { [key: string]: string }
// ) => {
//   logger.log('custom metadata', customMetadata);
//   await bucket.upload(inputFilePath, { destination: destinationFilePath });
//   await bucket.file(destinationFilePath).setMetadata({ contentType: 'audio/mpeg', metadata: customMetadata });
// };

const addIntroOutro = onObjectFinalized(
  {
    timeoutSeconds: 540,
    // memory: '1GiB', cpu: 1, concurrency: 1
  },
  async (storageEvent): Promise<void> => {
    const data = storageEvent.data;
    const filePath = data.name ? data.name : '';
    logger.log('Object Finalized', filePath);
    logger.log('USING STREAMING');
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
    const tempFiles = new Set<string>();
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
      const transcodedAudioFile = await trimAndTranscode(
        bucket,
        filePath,
        realtimeDB.ref(`addIntroOutro/${fileName}`),
        parseFloat(data.metadata?.startTime || ''),
        parseFloat(data.metadata?.duration || '')
      );
      // let durationSeconds = await getDurationSeconds(tempFilePaths.CONTENT);
      // await uploadSermon(tempFilePaths.CONTENT, `processed-sermons/${fileName}`, bucket, customMetadata);
      logger.log('Transcoded Audio File', transcodedAudioFile.name, transcodedAudioFile.metadata);
      if (audioFilesToMerge.INTRO || audioFilesToMerge.OUTRO) {
        await docRef.update({
          status: {
            ...sermonStatus,
            audioStatus: sermonStatusType.PROCESSING,
            message: 'Adding Intro and Outro',
          },
        });
        logger.log('Merging audio files', JSON.stringify(audioFilesToMerge));
        const outputFileName = `intro_outro-${fileName}`;

        //create merge array in order INTRO, CONTENT, OUTRO
        const filePathsArray: string[] = [];
        if (audioFilesToMerge.INTRO) filePathsArray.push(audioFilesToMerge.INTRO);
        filePathsArray.push(audioFilesToMerge.CONTENT);
        if (audioFilesToMerge.OUTRO) filePathsArray.push(audioFilesToMerge.OUTRO);

        //merge files
        logger.log('Merging files', filePathsArray, 'to', outputFileName, '...');
        const mergedAudioFile = await mergeFiles(
          bucket,
          audioFilesToMerge.CONTENT,
          realtimeDB.ref(`addIntroOutro/${fileName}`),
          audioFilesToMerge.INTRO,
          audioFilesToMerge.OUTRO
        );

        //upload merged file
        logger.log(
          'Uploading merged file',
          mergedAudioFile.name,
          'to intro-outro-sermons/',
          outputFileName,
          mergedAudioFile.metadata
        );
        // logger.log('Uploading merged file', tmpFilePath, 'to intro-outro-sermons/', fileName);
        // const destination = `intro-outro-sermons/${fileName}`;
        // durationSeconds = await getDurationSeconds(tmpFilePath);
        // await uploadSermon(tmpFilePath, destination, bucket);
      }
      logger.log('Updating status to PROCESSED');
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.PROCESSED,
        },
        // durationSeconds: durationSeconds,
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
    } finally {
      const promises: Promise<void>[] = [];
      tempFiles.forEach((file) => {
        logger.log('Deleting temp file', file);
        promises.push(unlink(file));
      });
      try {
        await Promise.all(promises);
        logger.log('All temp files deleted');
      } catch (err) {
        logger.warn('Error when deleting temporary files', err);
      }
    }
  }
);

export default addIntroOutro;
