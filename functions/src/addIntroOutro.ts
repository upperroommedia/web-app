import { logger } from 'firebase-functions/v2';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { storage, firestore } from 'firebase-admin';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import os from 'os';
import fs from 'fs';

const mergeAndUploadAudioFiles = (inputs: string[], outputFileName: string): Promise<string> => {
  const tmpFilePath = path.join(os.tmpdir(), outputFileName);
  if (!fs.existsSync(os.tmpdir())) {
    fs.mkdirSync(os.tmpdir());
  }
  const proc = ffmpeg();
  inputs.forEach((input) => {
    proc.input(input);
  });
  return new Promise((resolve, reject) => {
    proc.mergeToFile(tmpFilePath);
    proc
      .on('end', async function () {
        resolve(tmpFilePath);
      })
      .on('error', function (err) {
        return reject(err);
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
  const fileName = path.basename(filePath);
  logger.info('Processing file: ' + fileName);
  const bucket = storage().bucket();
  const db = firestore();
  try {
    logger.log(data.metadata);
    logger.log('introURL', data.metadata?.introUrl);
    logger.log('herherherherh');
    if (data.metadata && data.mediaLink) {
      logger.log('testing logging');
      const audioFilesToMerge = [];
      if (data.metadata.introUrl) {
        audioFilesToMerge.push(data.metadata.introUrl);
        logger.log('introUrl', data.metadata.introUrl);
      }
      audioFilesToMerge.push(data.mediaLink);
      if (data.metadata.outroUrl) {
        audioFilesToMerge.push(data.metadata.outroUrl);
        logger.log('outroUrl', data.metadata.outroUrl);
      }
      if (audioFilesToMerge.length > 1) {
        logger.log('Merging audio files', audioFilesToMerge);
        const outputFileName = 'intro_outro-' + fileName + '.mp3';
        const tmpFilePath = await mergeAndUploadAudioFiles(audioFilesToMerge, outputFileName);
        await bucket.upload(tmpFilePath, {
          destination: `processed-sermons/${fileName}`,
        });
        await db.collection('sermons').doc(fileName).update({ processed: true });
        fs.unlinkSync(tmpFilePath);
        logger.log('Files have been merged succesfully');
      }
    }
  } catch (e) {
    logger.error(e);
  }
});

export default addIntroOutro;
