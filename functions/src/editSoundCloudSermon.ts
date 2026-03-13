import handleError from './handleError';
import { normalizeSoundCloudApiError, updateTrack } from './soundcloudClient';
import { runWithSoundCloudAccessToken, soundcloudSecretsWithRuntimeAlerts } from './soundcloudSecrets';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { UploadToSoundCloudInputType } from './uploadToSoundCloud';
import { logger } from 'firebase-functions/v2';
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { canUserRolePublish } from '../../types/User';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';
import { emitSoundCloudReconnectAlertIfNeeded } from './soundcloudAuthAlerting';

export interface EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA
  extends Partial<Omit<UploadToSoundCloudInputType, 'audioStoragePath'>> {
  trackId: string;
}

export interface EditSoundCloudSermonReturnType {
  soundCloudTrackUrl?: string;
}

const editOnSoundCloud = onCall(
  { secrets: soundcloudSecretsWithRuntimeAlerts },
  async (request: CallableRequest<EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA>): Promise<EditSoundCloudSermonReturnType> => {
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('permission-denied', 'You do not have the correct permissions for this action.');
    }
    const data = request.data;
    const imageSource = data.imageSource ?? data.imageStoragePath;
    const bucket = imageSource ? firebaseAdmin.storage().bucket() : undefined;
    logger.log('editOnSoundCloud', { trackId: data.trackId });
    try {
      const updateResult = await runWithSoundCloudAccessToken((token) =>
        updateTrack(token, data.trackId, {
          ...(data.title != null && { title: data.title }),
          ...(data.description != null && { description: data.description }),
          ...(data.tags != null && { tags: data.tags }),
          ...(imageSource != null &&
            bucket != null && {
              imageSource,
              bucket,
            }),
        })
      );
      return {
        ...(updateResult?.permalinkUrl ? { soundCloudTrackUrl: updateResult.permalinkUrl } : {}),
      };
    } catch (error) {
      if (error instanceof HttpsError) {
        await emitSoundCloudReconnectAlertIfNeeded({
          error,
          alertCode: 'PUBLISH_SOUNDCLOUD_EDIT_RUNTIME_FAILURE',
          summary: 'editSoundCloudSermon callable requires SoundCloud re-authorization.',
          context: {
            functionName: 'editSoundCloudSermon',
            trackId: data.trackId,
          },
        });
        throw error;
      }

      await emitOperationalAlert({
        alertCode: 'PUBLISH_SOUNDCLOUD_EDIT_RUNTIME_FAILURE',
        summary: 'editSoundCloudSermon callable failed during publish edit flow.',
        error: (() => {
          try {
            normalizeSoundCloudApiError(error);
          } catch (normalizedError) {
            return normalizedError;
          }
          return error;
        })(),
        context: {
          functionName: 'editSoundCloudSermon',
          trackId: data.trackId,
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

export default editOnSoundCloud;
