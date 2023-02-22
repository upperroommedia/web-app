import axios, { AxiosRequestConfig } from 'axios';
import FormData from 'form-data';
import handleError from './handleError';
import { UploadToSoundCloudInputType } from './uploadToSoundCloud';
import { https, logger } from 'firebase-functions';
import { HttpsError } from 'firebase-functions/v2/https';

export interface EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA extends Partial<Omit<UploadToSoundCloudInputType, 'audioUrl'>> {
  trackId: string;
}

const editOnSoundCloud = https.onCall(
  async (data: EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA, context: https.CallableContext): Promise<void> => {
    if (context.auth?.token.role !== 'admin') {
      throw new HttpsError('permission-denied', 'You do not have the correct permissions for this action.');
    }
    if (process.env.EMAIL == undefined || process.env.PASSWORD == undefined) {
      throw new HttpsError('failed-precondition', 'Email or Password are not set in .env file');
    }
    logger.log('data', data);
    const formData = new FormData();

    formData.append('trackId', data.trackId);

    if (data.speakers && data.title) {
      const titleWithSpeakers = `${data.title} (${data.speakers.join(', ')})`;
      formData.append('title', titleWithSpeakers);
    }

    if (data.imageUrl) {
      const config: AxiosRequestConfig = { responseType: 'arraybuffer' };
      const response = await axios.get(data.imageUrl, config);
      const imageFile = Buffer.from(response.data);
      formData.append('image', imageFile, { filename: 'image.jpg' });
    }
    if (data.tags) {
      const reformatedTags = data.tags.map((tag) => `"${tag}"`).join(' ');
      formData.append('tags', reformatedTags);
    }
    if (data.description) {
      formData.append('description', data.description);
    }

    logger.log('formData Headers', formData.getHeaders());
    const config: AxiosRequestConfig = {
      method: 'POST',
      url: 'https://hook.eu1.make.com/o789j4wuq2vwl3ixpopysl88wky5ksnb',
      headers: {
        ...formData.getHeaders(),
      },
      data: formData,
    };
    try {
      await axios(config);
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default editOnSoundCloud;
