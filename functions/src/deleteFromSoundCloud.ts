import axios, { AxiosRequestConfig } from 'axios';
import FormData from 'form-data';
import handleError from './handleError';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';

export interface DeleteFromSoundCloudInputType {
  soundCloudTrackId: string;
}

export type DeleteFromSoundCloudReturnType = void;

const deleteFromSoundCloudHelper = async (soundCloudTrackId: string) => {
  const formData = new FormData();
  console.log('soundCloudTrackId', soundCloudTrackId);
  formData.append('trackId', soundCloudTrackId);
  const config: AxiosRequestConfig = {
    method: 'POST',
    url: 'https://hook.eu1.make.com/c7mnio0orvi8teayuo11nlrdocvwmsoj',
    headers: {
      ...formData.getHeaders(),
    },
    data: formData,
  };
  try {
    console.log('Config', config);
    const response = await axios(config);
    logger.log('response status', response.status);
    logger.log('response data', response.data);
    if (response.status !== 200) {
      throw new HttpsError('internal', response.data);
    }
  } catch (error) {
    throw handleError(error);
  }
};

const deleteFromSoundCloud = onCall(
  async (request: CallableRequest<DeleteFromSoundCloudInputType>): Promise<DeleteFromSoundCloudReturnType> => {
    logger.log('deleteFromSoundCloud', request);
    if (request.auth?.token.role !== 'admin') {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    try {
      logger.log('Attempting to delete from SoundCloud', request.data);
      await deleteFromSoundCloudHelper(request.data.soundCloudTrackId);
      logger.log('Track deleted from SoundCloud');
    } catch (error) {
      logger.error(error);
      throw handleError(error);
    }
  }
);

export default deleteFromSoundCloud;
