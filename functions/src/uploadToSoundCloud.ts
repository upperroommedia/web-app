import axios, { AxiosRequestConfig } from 'axios';
import FormData from 'form-data';
import handleError from './handleError';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';

export interface UploadToSoundCloudInputType {
  audioUrl: string;
  imageUrl?: string;
  title: string;
  speakers: string[];
  tags: string[];
  description: string;
}

export type UploadToSoundCloudReturnType = {
  soundCloudTrackId: string;
};

const uploadToSoundCloud = async ({
  audioUrl,
  imageUrl,
  title,
  speakers,
  tags,
  description,
}: UploadToSoundCloudInputType): Promise<string> => {
  const formData = new FormData();
  const titleWithSpeakers = `${title} (${speakers.join(', ')})`;
  const reformatedTags = tags.map((tag) => `"${tag}"`).join(' ');
  const audioImageFiles = await Promise.all(
    [audioUrl, imageUrl].map(async (url) => {
      if (!url) {
        return null;
      }
      const config: AxiosRequestConfig = { responseType: 'arraybuffer' };
      const response = await axios.get(url, config);
      return Buffer.from(response.data);
    })
  );

  formData.append('title', titleWithSpeakers);
  audioImageFiles[0] && formData.append('audio', audioImageFiles[0], { filename: 'audio.mp3' });
  audioImageFiles[1] && formData.append('image', audioImageFiles[1], { filename: 'image.jpg' });
  formData.append('tags', reformatedTags);
  formData.append('description', description);
  logger.log('formData Headers', JSON.stringify(formData.getHeaders()));
  const config: AxiosRequestConfig = {
    method: 'POST',
    url: 'https://hook.eu1.make.com/q1tpo6rfktqe3a8cexb79n70j6sq0y65',
    headers: {
      ...formData.getHeaders(),
    },
    data: formData,
  };
  try {
    return (await axios(config)).data;
  } catch (error) {
    throw handleError(error);
  }
};

const uploadToSoundCloudCall = onCall(
  async (request: CallableRequest<UploadToSoundCloudInputType>): Promise<UploadToSoundCloudReturnType> => {
    logger.log('uploadToSoundCloud', request);
    if (request.auth?.token.role !== 'admin') {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    try {
      logger.log('Attempting to upload to SoundCloud', request.data);
      const response = await uploadToSoundCloud(request.data);
      logger.log('SoundCloud response', response);
      return { soundCloudTrackId: response };
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default uploadToSoundCloudCall;
