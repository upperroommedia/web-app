import { logger } from 'firebase-functions/v2';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { storage, firestore } from 'firebase-admin';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { Bucket } from '@google-cloud/storage';

const createTempFile = (fileName: string) => {
  if (!fs.existsSync(os.tmpdir())) {
    fs.mkdirSync(os.tmpdir());
  }
  return path.join(os.tmpdir(), fileName);
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

const mergeAndUploadAudioFiles = (inputs: string[], outputFileName: string): Promise<string> => {
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
  logger.log('custom metadata', customMetadata);
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
const addIntroOutro = onObjectFinalized(async (storageEvent) => {
  const data = storageEvent.data;
  const filePath = data.name ? data.name : '';
  if (!filePath.startsWith('sermons/')) {
    // Not a sermon
    return;
  }
  if (filePath.endsWith('sermons/')) {
    // This is a folder
    return;
  }
  const bucket = storage().bucket();
  const db = firestore();
  const fileName = path.basename(filePath);
  const tempFiles: string[] = [];
  logger.info('Processing file: ' + fileName);
  try {
    logger.log(data.metadata);
    logger.log('contentType', data.contentType);
    if (data.mediaLink) {
      const processedSermonPath = await trimAndTranscode(
        data.mediaLink,
        parseFloat(data.metadata?.startTime || ''),
        parseFloat(data.metadata?.duration || '')
      );
      const audioFilesToMerge = [];
      const customMetadata: { [key: string]: string } = {};
      if (data.metadata?.introUrl) {
        audioFilesToMerge.push(data.metadata.introUrl);
        customMetadata.introUrl = data.metadata.introUrl;
        logger.log('introUrl', data.metadata.introUrl);
      }
      audioFilesToMerge.push(processedSermonPath);
      if (data.metadata?.outroUrl) {
        audioFilesToMerge.push(data.metadata.outroUrl);
        customMetadata.outroUrl = data.metadata.outroUrl;
        logger.log('outroUrl', data.metadata.outroUrl);
      }
      let durationSeconds = await getDurationSeconds(processedSermonPath);
      if (data.metadata?.introUrl) {
        customMetadata.introUrl = data.metadata.introUrl;
      }
      await uploadSermon(processedSermonPath, `processed-sermons/${fileName}`, bucket, customMetadata);
      tempFiles.push(processedSermonPath);
      if (audioFilesToMerge.length > 1) {
        logger.log('Merging audio files', audioFilesToMerge);
        const outputFileName = 'intro_outro-' + fileName;
        const tmpFilePath = await mergeAndUploadAudioFiles(audioFilesToMerge, outputFileName);
        const destination = `intro-outro-sermons/${fileName}`;
        durationSeconds = await getDurationSeconds(tmpFilePath);
        await uploadSermon(tmpFilePath, destination, bucket);
        tempFiles.push(tmpFilePath);
      }
      console.log('Duration Seconds:', durationSeconds);
      await db.collection('sermons').doc(fileName).update({ processed: true, durationSeconds: durationSeconds });
      logger.log('Files have been merged succesfully');
    }
  } catch (e) {
    logger.error(e);
  } finally {
    tempFiles.forEach((file) => {
      try {
        logger.log('Deleting file: ' + file);
        fs.unlinkSync(file);
      } catch (error) {
        logger.error(error);
      }
    });
  }
});

export default addIntroOutro;
