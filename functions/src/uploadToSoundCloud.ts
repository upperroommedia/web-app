import handleError from './handleError';
import { normalizeSoundCloudApiError, uploadTrack } from './soundcloudClient';
import { getSoundCloudAccessToken, soundcloudSecretsWithRuntimeAlerts } from './soundcloudSecrets';
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
  imageSource?: string;
  imageStoragePath?: string;
}

export type UploadToSoundCloudReturnType = {
  soundCloudTrackId: string;
  soundCloudTrackUrl?: string;
};

const uploadToSoundCloudCall = onCall(
  { secrets: soundcloudSecretsWithRuntimeAlerts },
  async (request: CallableRequest<UploadToSoundCloudInputType>): Promise<UploadToSoundCloudReturnType> => {
    logger.log('uploadToSoundCloud', request);
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const token = getSoundCloudAccessToken();
    const data = request.data;
    const bucket = firebaseAdmin.storage().bucket();
    try {
      const uploadResult = await uploadTrack(token, {
        bucket,
        audioStoragePath: data.audioStoragePath,
        imageSource: data.imageSource ?? data.imageStoragePath,
        title: data.title,
        tags: data.tags,
        description: data.description,
      });
      const soundCloudTrackId = uploadResult.trackIdentifier;
      logger.log('SoundCloud upload response track id', soundCloudTrackId);
      return {
        soundCloudTrackId,
        ...(uploadResult.permalinkUrl ? { soundCloudTrackUrl: uploadResult.permalinkUrl } : {}),
      };
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }

      await emitOperationalAlert({
        alertCode: 'PUBLISH_SOUNDCLOUD_UPLOAD_RUNTIME_FAILURE',
        summary: 'uploadToSoundCloud callable failed during publish upload flow.',
        error: (() => {
          try {
            normalizeSoundCloudApiError(error);
          } catch (normalizedError) {
            return normalizedError;
          }
          return error;
        })(),
        context: {
          functionName: 'uploadToSoundCloud',
          audioStoragePath: data.audioStoragePath,
        },
      });
      try {
        normalizeSoundCloudApiError(error);
      } catch (normalizedError) {
        throw handleError(normalizedError);
      }
      throw handleError(error);
    }
  }
);

export default uploadToSoundCloudCall;
