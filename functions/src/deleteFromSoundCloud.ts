import handleError from './handleError';
import { deleteTrack, normalizeSoundCloudApiError } from './soundcloudClient';
import { runWithSoundCloudAccessToken, soundcloudSecretsWithRuntimeAlerts } from './soundcloudSecrets';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { canUserRolePublish } from '../../types/User';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';
import { isAxiosError } from 'axios';
import { emitSoundCloudReconnectAlertIfNeeded } from './soundcloudAuthAlerting';

export interface DeleteFromSoundCloudInputType {
  soundCloudTrackId: string;
}

export type DeleteFromSoundCloudReturnType = void;

const deleteFromSoundCloud = onCall(
  { secrets: soundcloudSecretsWithRuntimeAlerts },
  async (request: CallableRequest<DeleteFromSoundCloudInputType>): Promise<DeleteFromSoundCloudReturnType> => {
    logger.log('deleteFromSoundCloud', request);
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    try {
      logger.log('Attempting to delete from SoundCloud', request.data);
      await runWithSoundCloudAccessToken((token) => deleteTrack(token, request.data.soundCloudTrackId));
      logger.log('Track deleted from SoundCloud');
    } catch (error) {
      if (error instanceof HttpsError) {
        await emitSoundCloudReconnectAlertIfNeeded({
          error,
          alertCode: 'PUBLISH_SOUNDCLOUD_DELETE_RUNTIME_FAILURE',
          summary: 'deleteFromSoundCloud callable requires SoundCloud re-authorization.',
          context: {
            functionName: 'deleteFromSoundCloud',
            soundCloudTrackId: request.data.soundCloudTrackId,
          },
        });
        throw error;
      }

      if (isAxiosError(error) && error.response?.status === 404) {
        logger.warn(`SoundCloud track not found (already deleted): ${request.data.soundCloudTrackId}`);
        return;
      }

      let normalizedError: unknown = error;
      try {
        normalizeSoundCloudApiError(error);
      } catch (caughtError) {
        normalizedError = caughtError;
      }

      logger.error(normalizedError);
      try {
        await emitOperationalAlert({
          alertCode: 'PUBLISH_SOUNDCLOUD_DELETE_RUNTIME_FAILURE',
          summary: 'deleteFromSoundCloud callable failed during publish delete flow.',
          error: normalizedError,
          context: {
            functionName: 'deleteFromSoundCloud',
            soundCloudTrackId: request.data.soundCloudTrackId,
          },
        });
      } catch (alertError) {
        logger.error('Failed to emit operational alert for deleteFromSoundCloud', {
          soundCloudTrackId: request.data.soundCloudTrackId,
          alertError,
        });
      }
      throw handleError(normalizedError);
    }
  }
);

export default deleteFromSoundCloud;
