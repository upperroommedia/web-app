import { logger } from 'firebase-functions/v2';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { storage, firestore } from 'firebase-admin';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import os from 'os';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { unlink } from 'fs/promises';
import { Bucket } from '@google-cloud/storage';
import axios, { AxiosError, isAxiosError } from 'axios';
import { sermonStatus, sermonStatusType, uploadStatus } from '../../types/SermonTypes';
import { firestoreAdminSermonConverter } from './firestoreDataConverter';
import { HttpsError } from 'firebase-functions/v2/https';

const tempFiles = new Set<string>();

type filePaths = {
  INTRO: string | undefined;
  CONTENT: string;
  OUTRO: string | undefined;
};

const createTempFile = (fileName: string) => {
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

const trimAndTranscode = (filePath: string, startTime?: number, duration?: number): Promise<string> => {
  const tmpFilePath = createTempFile(path.basename('temp-transcoded-file.mp3'));
  const proc = ffmpeg().format('mp3').input(filePath);
  if (startTime) proc.setStartTime(startTime);
  if (duration) proc.setDuration(duration);
  return new Promise((resolve, reject) => {
    proc
      .on('end', () => {
        resolve(tmpFilePath);
      })
      .on('error', (err) => {
        reject(err);
      })
      .saveToFile(tmpFilePath);
  });
};

const mergeFiles = (inputs: string[], outputFileName: string): Promise<string> => {
  const tmpFilePath = createTempFile(outputFileName);
  const proc = ffmpeg().format('mp3');
  inputs.forEach((input) => {
    proc.input(input);
  });
  return new Promise((resolve, reject) => {
    proc
      .on('end', async function () {
        resolve(tmpFilePath);
      })
      .on('error', function (err) {
        return reject(err);
      })
      .mergeToFile(tmpFilePath);
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

const downloadFiles = async (bucket: Bucket, filePaths: filePaths): Promise<filePaths> => {
  const tempFilePaths: filePaths = { CONTENT: '', INTRO: undefined, OUTRO: undefined };
  const promises: Promise<unknown>[] = [];
  // get key and value of filePaths
  for (const [key, filePath] of Object.entries(filePaths) as [keyof filePaths, string | undefined][]) {
    if (filePath) {
      tempFilePaths[key] = createTempFile(path.basename(filePath).split('?')[0]);
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
  { timeoutSeconds: 300, memory: '256MiB', cpu: 1 },
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
    const bucket = storage().bucket();
    const db = firestore();
    const fileName = path.basename(filePath);
    const docRef = db.collection('sermons').withConverter(firestoreAdminSermonConverter).doc(fileName);
    const sermonStatus: sermonStatus = {
      subsplash: uploadStatus.NOT_UPLOADED,
      soundCloud: uploadStatus.NOT_UPLOADED,
      audioStatus: sermonStatusType.PROCESSING,
    };
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
      const tempFilePaths = await downloadFiles(bucket, audioFilesToMerge);
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.PROCESSING,
          message: 'Trimming and Transcoding',
        },
      });
      tempFilePaths.CONTENT = await trimAndTranscode(
        tempFilePaths.CONTENT,
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
        const outputFileName = 'intro_outro-' + fileName;

        //create merge array in order INTRO, CONTENT, OUTRO
        const filePathsArray: string[] = [];
        if (tempFilePaths.INTRO) filePathsArray.push(tempFilePaths.INTRO);
        filePathsArray.push(tempFilePaths.CONTENT);
        if (tempFilePaths.OUTRO) filePathsArray.push(tempFilePaths.OUTRO);

        //merge files
        logger.log('Merging files', filePathsArray, 'to', outputFileName, '...');
        const tmpFilePath = await mergeFiles(filePathsArray, outputFileName);

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
      await Promise.all(promises);
      logger.log('Temp files deleted');
    }
  }
);

export default addIntroOutro;
