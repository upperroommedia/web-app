import axios, { AxiosRequestConfig } from 'axios';
import handleError from './handleError';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { canUserRolePublish } from '../../types/User';

export interface UploadToSoundCloudInputType {
  audioStoragePath: string;
  title: string;
  speakers: string[];
  tags: string[];
  description: string;
  imageStoragePath?: string;
}

export type UploadToSoundCloudReturnType = {
  soundCloudTrackId: string;
};

const uploadToSoundCloudCall = onCall(
  async (request: CallableRequest<UploadToSoundCloudInputType>): Promise<UploadToSoundCloudReturnType> => {
    logger.log('uploadToSoundCloud', request);
    if (!canUserRolePublish(request.auth?.token.role)) {
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
        ...(data.imageStoragePath && { imageStoragePath: data.imageStoragePath }),
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
