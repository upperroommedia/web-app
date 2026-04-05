import handleError from './handleError';
import { normalizeSoundCloudApiError, uploadTrack } from './soundcloudClient';
import { runWithSoundCloudAccessToken, soundcloudSecretsWithRuntimeAlerts } from './soundcloudSecrets';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';
import { emitSoundCloudReconnectAlertIfNeeded } from './soundcloudAuthAlerting';
import { startFunctionsSpan } from './sentry';

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
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const data = request.data;
    const bucket = firebaseAdmin.storage().bucket();
    logger.log('uploadToSoundCloud.start', {
      audioStoragePath: data.audioStoragePath,
      hasImageSource: Boolean(data.imageSource ?? data.imageStoragePath),
      speakerCount: data.speakers.length,
      tagCount: data.tags.length,
      titleLength: data.title.length,
    });
    try {
      const uploadResult = await startFunctionsSpan(
        {
          name: 'uploadToSoundCloud',
          op: 'soundcloud.upload',
          attributes: {
            hasImageSource: Boolean(data.imageSource ?? data.imageStoragePath),
            speakerCount: data.speakers.length,
            tagCount: data.tags.length,
          },
        },
        () =>
          runWithSoundCloudAccessToken((token) =>
            uploadTrack(token, {
              bucket,
              audioStoragePath: data.audioStoragePath,
              imageSource: data.imageSource ?? data.imageStoragePath,
              title: data.title,
              tags: data.tags,
              description: data.description,
            })
          )
      );
      const soundCloudTrackId = uploadResult.trackIdentifier;
      logger.log('uploadToSoundCloud.success', {
        audioStoragePath: data.audioStoragePath,
        soundCloudTrackId,
      });
      return {
        soundCloudTrackId,
        ...(uploadResult.permalinkUrl ? { soundCloudTrackUrl: uploadResult.permalinkUrl } : {}),
      };
    } catch (error) {
      if (error instanceof HttpsError) {
        await emitSoundCloudReconnectAlertIfNeeded({
          error,
          alertCode: 'PUBLISH_SOUNDCLOUD_UPLOAD_RUNTIME_FAILURE',
          summary: 'uploadToSoundCloud callable requires SoundCloud re-authorization.',
          context: {
            functionName: 'uploadToSoundCloud',
            audioStoragePath: data.audioStoragePath,
          },
        });
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
