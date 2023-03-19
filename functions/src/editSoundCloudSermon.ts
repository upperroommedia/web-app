import axios, { AxiosRequestConfig } from 'axios';
import handleError from './handleError';
import { UploadToSoundCloudInputType } from './uploadToSoundCloud';
import { https, logger } from 'firebase-functions';
import { HttpsError } from 'firebase-functions/v2/https';

export interface EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA
  extends Partial<Omit<UploadToSoundCloudInputType, 'audioStoragePath'>> {
  trackId: string;
}

function reformatedTags(tags: string[]) {
  return tags.map((tag) => `"${tag}"`).join(' ');
}

const editOnSoundCloud = https.onCall(
  async (data: EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA, context: https.CallableContext): Promise<void> => {
    if (context.auth?.token.role !== 'admin') {
      throw new HttpsError('permission-denied', 'You do not have the correct permissions for this action.');
    }
    if (process.env.EMAIL == undefined || process.env.PASSWORD == undefined) {
      throw new HttpsError('failed-precondition', 'Email or Password are not set in .env file');
    }

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: 'https://hook.eu1.make.com/o789j4wuq2vwl3ixpopysl88wky5ksnb',
      data: {
        trackId: data.trackId,
        ...(data.imageStoragePath && { imageStoragePath: data.imageStoragePath }),
        ...(data.title && { title: data.title }),
        ...(data.tags && { tags: reformatedTags(data.tags) }),
        ...(data.description && { description: data.description }),
      },
    };
    logger.log('editOnSoundCloud', config);
    try {
      await axios(config);
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default editOnSoundCloud;
