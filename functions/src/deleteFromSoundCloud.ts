import handleError from './handleError';
import { deleteTrack } from './soundcloudClient';
import { soundcloudAccessToken } from './soundcloudSecrets';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { canUserRolePublish } from '../../types/User';

export interface DeleteFromSoundCloudInputType {
  soundCloudTrackId: string;
}

export type DeleteFromSoundCloudReturnType = void;

const deleteFromSoundCloud = onCall(
  { secrets: [soundcloudAccessToken] },
  async (request: CallableRequest<DeleteFromSoundCloudInputType>): Promise<DeleteFromSoundCloudReturnType> => {
    logger.log('deleteFromSoundCloud', request);
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const token = soundcloudAccessToken.value();
    if (!token) {
      throw new HttpsError('failed-precondition', 'SOUNDCLOUD_ACCESS_TOKEN is not set.');
    }
    try {
      logger.log('Attempting to delete from SoundCloud', request.data);
      await deleteTrack(token, request.data.soundCloudTrackId);
      logger.log('Track deleted from SoundCloud');
    } catch (error) {
      logger.error(error);
      throw handleError(error);
    }
  }
);

export default deleteFromSoundCloud;
