import handleError from './handleError';
import { isSoundCloudTrackNotFoundError, normalizeSoundCloudApiError, updateTrack } from './soundcloudClient';
import { runWithSoundCloudAccessToken, soundcloudSecretsWithRuntimeAlerts } from './soundcloudSecrets';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { UploadToSoundCloudInputType } from './uploadToSoundCloud';
import { logger } from 'firebase-functions/v2';
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';
import { emitSoundCloudReconnectAlertIfNeeded } from './soundcloudAuthAlerting';
import { startFunctionsSpan } from './sentry';

export interface EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA
  extends Partial<Omit<UploadToSoundCloudInputType, 'audioStoragePath'>> {
  trackId: string;
}

export interface EditSoundCloudSermonReturnType {
  soundCloudTrackUrl?: string;
  soundCloudTrackMissing?: boolean;
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
    logger.log('editSoundCloudSermon.start', {
      trackId: data.trackId,
      hasImageSource: Boolean(imageSource),
      hasTitle: typeof data.title === 'string',
      hasDescription: typeof data.description === 'string',
      hasTags: Array.isArray(data.tags) && data.tags.length > 0,
    });
    try {
      const updateResult = await startFunctionsSpan(
        {
          name: 'editSoundCloudSermon',
          op: 'soundcloud.update',
          attributes: {
            hasImageSource: Boolean(imageSource),
            hasTitle: typeof data.title === 'string',
            hasDescription: typeof data.description === 'string',
            hasTags: Array.isArray(data.tags) && data.tags.length > 0,
          },
        },
        () =>
          runWithSoundCloudAccessToken((token) =>
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
          )
      );
      logger.log('editSoundCloudSermon.success', {
        trackId: data.trackId,
      });
      return {
        ...(updateResult?.permalinkUrl ? { soundCloudTrackUrl: updateResult.permalinkUrl } : {}),
      };
    } catch (error) {
      if (isSoundCloudTrackNotFoundError(error)) {
        logger.warn('editSoundCloudSermon.trackMissing', {
          trackId: data.trackId,
        });
        return {
          soundCloudTrackMissing: true,
        };
      }

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
