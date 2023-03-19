import axios, { AxiosRequestConfig } from 'axios';
import handleError from './handleError';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';

export interface UploadToSoundCloudInputType {
  audioStoragePath: string;
  imageStoragePath: string;
  title: string;
  speakers: string[];
  tags: string[];
  description: string;
}

export type UploadToSoundCloudReturnType = {
  soundCloudTrackId: string;
};

const uploadToSoundCloudCall = onCall(
  async (request: CallableRequest<UploadToSoundCloudInputType>): Promise<UploadToSoundCloudReturnType> => {
    logger.log('uploadToSoundCloud', request);
    if (request.auth?.token.role !== 'admin') {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const data = request.data;
    const reformatedTags = data.tags.map((tag) => `"${tag}"`).join(' ');
    const config: AxiosRequestConfig = {
      method: 'POST',
      url: 'https://hook.eu1.make.com/q1tpo6rfktqe3a8cexb79n70j6sq0y65',
      data: {
        title: data.title,
        audioStoragePath: data.audioStoragePath,
        imageStoragePath: data.imageStoragePath,
        tags: reformatedTags,
        description: data.description,
      },
    };
    try {
      const response = (await axios(config)).data;
      logger.log('SoundCloud response', response);
      return { soundCloudTrackId: response };
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default uploadToSoundCloudCall;
