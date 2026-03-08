import handleError from './handleError';
import { uploadTrack } from './soundcloudClient';
import { soundcloudAccessToken } from './soundcloudSecrets';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { canUserRolePublish } from '../../types/User';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';

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
  { secrets: [soundcloudAccessToken] },
  async (request: CallableRequest<UploadToSoundCloudInputType>): Promise<UploadToSoundCloudReturnType> => {
    logger.log('uploadToSoundCloud', request);
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const token = soundcloudAccessToken.value();
    if (!token) {
      throw new HttpsError('failed-precondition', 'SOUNDCLOUD_ACCESS_TOKEN is not set.');
    }
    const data = request.data;
    const bucket = firebaseAdmin.storage().bucket();
    try {
      const soundCloudTrackId = await uploadTrack(token, {
        bucket,
        audioStoragePath: data.audioStoragePath,
        imageStoragePath: data.imageStoragePath,
        title: data.title,
        tags: data.tags,
        description: data.description,
      });
      logger.log('SoundCloud upload response track id', soundCloudTrackId);
      return { soundCloudTrackId };
    } catch (error) {
      await emitOperationalAlert({
        alertCode: 'PUBLISH_SOUNDCLOUD_UPLOAD_RUNTIME_FAILURE',
        summary: 'uploadToSoundCloud callable failed during publish upload flow.',
        error,
        context: {
          functionName: 'uploadToSoundCloud',
          audioStoragePath: data.audioStoragePath,
        },
      });
      throw handleError(error);
    }
  }
);

export default uploadToSoundCloudCall;
