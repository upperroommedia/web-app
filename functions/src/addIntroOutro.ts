import { logger } from 'firebase-functions/v2';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { adminFirestore, adminDatabase, adminStorage } from '../../firebase/initFirebaseAdmin';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import os from 'os';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'fs';
import { unlink } from 'fs/promises';
import { Bucket } from '@google-cloud/storage';
import axios, { AxiosError, isAxiosError } from 'axios';
import { sermonStatus, sermonStatusType, uploadStatus } from '../../types/SermonTypes';
import { firestoreAdminSermonConverter } from './firestoreDataConverter';
import { HttpsError } from 'firebase-functions/v2/https';
import { Reference } from 'firebase-admin/database';

type filePaths = {
  INTRO: string | undefined;
  CONTENT: string;
  OUTRO: string | undefined;
};

const createTempFile = (fileName: string, tempFiles: Set<string>) => {
  try {
    if (!existsSync(os.tmpdir())) {
      mkdirSync(os.tmpdir());
    }
    const filePath = path.join(os.tmpdir(), fileName);
    tempFiles.add(filePath);
    return filePath;
  } catch (err) {
    throw new Error(`Error creating temp file: ${err}`);
  }
};
const convertStringToMilliseconds = (timeStr: string): number => {
  // '10:20:30:500'  Example time string
  const [hours, minutes, secondsAndMilliseconds] = timeStr.split(':');
  const [seconds, milliseconds] = secondsAndMilliseconds.split('.');

  return (parseInt(hours) * 60 * 60 + parseInt(minutes) * 60 + parseInt(seconds)) * 1000 + parseInt(milliseconds);
};

const trimAndTranscode = (
  filePath: string,
  tempFiles: Set<string>,
  realtimeDBRef: Reference,
  startTime?: number,
  duration?: number
): Promise<string> => {
  const tmpFilePath = createTempFile(path.basename('temp-transcoded-file.mp3'), tempFiles);
  const proc = ffmpeg().format('mp3').input(filePath);
  if (startTime) proc.setStartTime(startTime);
  if (duration) proc.setDuration(duration);
  proc.audioCodec('libmp3lame').audioBitrate(128).audioChannels(2).audioFrequency(44100);
  let totalTimeMillis: number;
  return new Promise((resolve, reject) => {
    proc
      .on('start', function (commandLine) {
        logger.log('Trim And Transcode Spawned Ffmpeg with command: ' + commandLine);
      })
      .on('end', async () => {
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
      .on('progress', (progress) => {
        console.log('CurrentTimemark', progress.timemark);
        const timeMillis = convertStringToMilliseconds(progress.timemark);
        logger.log('Trimming and Transcoding: ' + timeMillis + 'ms done', totalTimeMillis);
        // AND HERE IS THE CALCULATION
        const calculatedDuration = duration
          ? duration * 1000
          : startTime
          ? totalTimeMillis - startTime * 1000
          : totalTimeMillis;
        const percent = ((timeMillis * 0.97) / calculatedDuration) * 100; // go to 97% to leave room for the time it takes to Merge the files
        realtimeDBRef.set(percent || 0);
        logger.log('Trimming and Transcoding: ' + percent + '% done');
      })
      .saveToFile(tmpFilePath);
  });
};

const mergeFiles = (
  filePaths: string[],
  outputFileName: string,
  tempFiles: Set<string>,
  realtimeDBref: Reference
): Promise<string> => {
  const tmpFilePath = createTempFile(outputFileName, tempFiles);
  const listFileName = createTempFile('list.txt', tempFiles);

  // ffmpeg -f concat -i mylist.txt -c copy output
  const filePathsForTxt = filePaths.map((filePath) => `file '${filePath}'`);
  const fileNames = filePathsForTxt.join('\n');

  logger.log('fileNames', fileNames);

  writeFileSync(listFileName, fileNames);

  const merge = ffmpeg();

  return new Promise((resolve, reject) => {
    merge
      .input(listFileName)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions('-c copy')
      .outputFormat('mp3')
      .on('start', function (commandLine) {
        realtimeDBref.set(98);
        logger.log('MergeFiles Spawned Ffmpeg with command: ' + commandLine);
      })
      .on('end', async function () {
        realtimeDBref.set(98);
        resolve(tmpFilePath);
      })
      .on('error', function (err) {
        logger.log('MergeFiles Error:', err);
        return reject(err);
      })
      .save(tmpFilePath);
  });
};

const uploadSermon = async (
  inputFilePath: string,
  destinationFilePath: string,
  bucket: Bucket,
  customMetadata?: { [key: string]: string }
) => {
  logger.log('custom metadata', JSON.stringify(customMetadata));
  await bucket.upload(inputFilePath, { destination: destinationFilePath });
  await bucket.file(destinationFilePath).setMetadata({ contentType: 'audio/mpeg', metadata: customMetadata });
};

const getDurationSeconds = (filePath: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
      }
      resolve(metadata.format.duration || 0);
    });
  });
};

async function downloadFile(fileUrl: string, outputLocationPath: string): Promise<void> {
  const writer = createWriteStream(outputLocationPath);

  return axios({
    method: 'get',
    url: fileUrl,
    responseType: 'stream',
  }).then((response) => {
    //ensure that the user can call `then()` only when the file has
    //been downloaded entirely.

    return new Promise((resolve, reject) => {
      response.data.pipe(writer);
      let error: unknown = null;
      writer.on('error', (err: unknown) => {
        error = err;
        writer.close();
        reject(err);
      });
      writer.on('close', () => {
        if (!error) {
          resolve();
        }
        //no need to call the reject here, as it will have been called in the
        //'error' stream;
      });
    });
  });
}

const downloadFiles = async (bucket: Bucket, filePaths: filePaths, tempFiles: Set<string>): Promise<filePaths> => {
  const tempFilePaths: filePaths = { CONTENT: '', INTRO: undefined, OUTRO: undefined };
  const promises: Promise<unknown>[] = [];
  // get key and value of filePaths
  for (const [key, filePath] of Object.entries(filePaths) as [keyof filePaths, string | undefined][]) {
    if (filePath) {
      tempFilePaths[key] = createTempFile(path.basename(filePath).split('?')[0], tempFiles);
      if (key === 'CONTENT') {
        promises.push(bucket.file(filePath).download({ destination: tempFilePaths[key] }));
      } else {
        promises.push(downloadFile(filePath, tempFilePaths[key] as string));
      }
      logger.log(`Downloading ${filePath} to ${tempFilePaths[key]}`);
    }
  }
  await Promise.all(promises);
  return tempFilePaths;
};

const addIntroOutro = onObjectFinalized(
  { timeoutSeconds: 300, memory: '1GiB', cpu: 1, concurrency: 1 },
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
    const bucket = adminStorage.bucket();
    const fileName = path.basename(filePath);
    const docRef = adminFirestore.collection('sermons').withConverter(firestoreAdminSermonConverter).doc(fileName);
    const sermonStatus: sermonStatus = {
      subsplash: uploadStatus.NOT_UPLOADED,
      soundCloud: uploadStatus.NOT_UPLOADED,
      audioStatus: sermonStatusType.PROCESSING,
    };
    const tempFiles = new Set<string>();
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
      logger.log('Audio File Download Paths', JSON.stringify(audioFilesToMerge));
      const tempFilePaths = await downloadFiles(bucket, audioFilesToMerge, tempFiles);
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.PROCESSING,
          message: 'Trimming and Transcoding',
        },
      });
      tempFilePaths.CONTENT = await trimAndTranscode(
        tempFilePaths.CONTENT,
        tempFiles,
        adminDatabase.ref(`addIntroOutro/${fileName}`),
        parseFloat(data.metadata?.startTime || ''),
        parseFloat(data.metadata?.duration || '')
      );
      let durationSeconds = await getDurationSeconds(tempFilePaths.CONTENT);
      await uploadSermon(tempFilePaths.CONTENT, `processed-sermons/${fileName}`, bucket, customMetadata);
      if (tempFilePaths.INTRO || tempFilePaths.OUTRO) {
        await docRef.update({
          status: {
            ...sermonStatus,
            audioStatus: sermonStatusType.PROCESSING,
            message: 'Adding Intro and Outro',
          },
        });
        logger.log('Merging audio files', JSON.stringify(tempFilePaths));
        const outputFileName = `intro_outro-${fileName}`;

        //create merge array in order INTRO, CONTENT, OUTRO
        const filePathsArray: string[] = [];
        if (tempFilePaths.INTRO) filePathsArray.push(tempFilePaths.INTRO);
        filePathsArray.push(tempFilePaths.CONTENT);
        if (tempFilePaths.OUTRO) filePathsArray.push(tempFilePaths.OUTRO);

        //merge files
        logger.log('Merging files', filePathsArray, 'to', outputFileName, '...');
        const tmpFilePath = await mergeFiles(
          filePathsArray,
          outputFileName,
          tempFiles,
          adminDatabase.ref(`addIntroOutro/${fileName}`)
        );

        //upload merged file
        logger.log('Uploading merged file', tmpFilePath, 'to intro-outro-sermons/', fileName);
        const destination = `intro-outro-sermons/${fileName}`;
        durationSeconds = await getDurationSeconds(tmpFilePath);
        await uploadSermon(tmpFilePath, destination, bucket);
      }
      logger.log('Updating status to PROCESSED');
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.PROCESSED,
        },
        durationSeconds: durationSeconds,
      });
      adminDatabase.ref(`addIntroOutro/${fileName}`).set(100);
      await adminDatabase.ref(`addIntroOutro/${fileName}`).remove();
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
