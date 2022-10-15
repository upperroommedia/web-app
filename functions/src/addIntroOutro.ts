import { logger } from 'firebase-functions/v2';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { storage, firestore } from 'firebase-admin';
import { Bucket } from '@google-cloud/storage';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import os from 'os';
import fs from 'fs';

const mergeAndUploadAudioFiles = (inputs: string[], outputFileName: string, bucket: Bucket) => {
  const tmpFilePath = path.join(os.tmpdir(), outputFileName);
  if (!fs.existsSync(os.tmpdir())) {
    fs.mkdirSync(os.tmpdir());
  }
  const proc = ffmpeg();
  inputs.forEach((input) => {
    proc.input(input);
  });
  proc.mergeToFile(tmpFilePath);
  proc
    .on('end', async function () {
      logger.log('files have been merged succesfully');
      const outputFilePath = `processed-sermons/${outputFileName}`;
      await bucket.upload(tmpFilePath, {
        destination: outputFilePath,
      });
      fs.unlinkSync(tmpFilePath);
    })
    .on('error', function (err) {
      logger.log('an error happened: ' + err.message);
    });
};

const addIntroOutro = onObjectFinalized(async (storageEvent) => {
  const data = storageEvent.data;
  const fileName = data.name ? data.name : '';
  if (!fileName.startsWith('sermons/')) {
    // Not a sermon
    return;
  }
  if (fileName.endsWith('sermons/')) {
    // This is a folder
    return;
  }
  const bucket = storage().bucket();
  try {
    const sermonMetadataSnapshot = await firestore().collection('sermons/').doc(path.basename(fileName)).get();
    const sermonMetadata = sermonMetadataSnapshot.data();
    if (!sermonMetadata) {
      logger.error('Sermon metadata not found');
      return;
    }
    const category = sermonMetadata.subtitle ? sermonMetadata.subtitle : '';
    const [introMetaData] = await bucket.file(`intros/${category}_intro.m4a`).getMetadata();
    const [outroMetaData] = await bucket.file(`outros/${category}_outro.m4a`).getMetadata();
    if (data.mediaLink) {
      const outputFileName = 'intro_outro-' + path.basename(fileName);
      mergeAndUploadAudioFiles(
        [introMetaData.mediaLink, data.mediaLink, outroMetaData.mediaLink],
        outputFileName,
        bucket
      );
    }
  } catch (e) {
    logger.error(e);
  }
});

export default addIntroOutro;
