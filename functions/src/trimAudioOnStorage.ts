import { GetSignedUrlConfig } from '@google-cloud/storage';
import { storage } from 'firebase-functions';
import { storage as adminStorage } from 'firebase-admin';
import logger from 'firebase-functions/logger';
import transcodeAudio from './Dolby/transcodeAudio';
import getOutputUrl from './getOutputUrl';

const trimAudioOnStorage = storage.object().onFinalize(async (object) => {
  const fileBucket = object.bucket;
  const fileName = object.name;
  if (fileName == undefined) return logger.error('FileName is undefined');
  if (process.env.DOLBYIO_API_KEY == undefined) return logger.error('DOLBYIO_API_KEY is undefined');
  if (!fileName.startsWith('sermons/')) {
    return logger.error('Object is not a sermon');
  }
  const transcodeTo = 'mp4';
  // These options will allow temporary read access to the file
  const inputOptions: GetSignedUrlConfig = {
    version: 'v4',
    action: 'read',
    expires: Date.now() + 15 * 60 * 1000, // 15 minutes
  };
  const [inputUrl] = await adminStorage().bucket(fileBucket).file(fileName).getSignedUrl(inputOptions);

  const outputUrl = await getOutputUrl(fileBucket, fileName.split('/')[1].split('.')[0], transcodeTo);
  transcodeAudio(inputUrl, outputUrl, transcodeTo);
});

export default trimAudioOnStorage;
