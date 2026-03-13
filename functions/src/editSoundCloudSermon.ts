import handleError from './handleError';
import { updateTrack } from './soundcloudClient';
import { soundcloudAccessToken, soundcloudSecretsWithRuntimeAlerts } from './soundcloudSecrets';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { UploadToSoundCloudInputType } from './uploadToSoundCloud';
import { logger } from 'firebase-functions/v2';
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { canUserRolePublish } from '../../types/User';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';

export interface EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA
  extends Partial<Omit<UploadToSoundCloudInputType, 'audioStoragePath'>> {
  trackId: string;
}

const editOnSoundCloud = onCall(
  { secrets: soundcloudSecretsWithRuntimeAlerts },
  async (request: CallableRequest<EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA>): Promise<void> => {
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('permission-denied', 'You do not have the correct permissions for this action.');
    }
    const token = soundcloudAccessToken.value();
    if (!token) {
      throw new HttpsError('failed-precondition', 'SOUNDCLOUD_CLIENT_SECRET is not set.');
    }
    const data = request.data;
    const imageSource = data.imageSource ?? data.imageStoragePath;
    const bucket = imageSource ? firebaseAdmin.storage().bucket() : undefined;
    logger.log('editOnSoundCloud', { trackId: data.trackId });
    try {
      await updateTrack(token, data.trackId, {
        ...(data.title != null && { title: data.title }),
        ...(data.description != null && { description: data.description }),
        ...(data.tags != null && { tags: data.tags }),
        ...(imageSource != null &&
          bucket != null && {
            imageSource,
            bucket,
          }),
      });
    } catch (error) {
      await emitOperationalAlert({
        alertCode: 'PUBLISH_SOUNDCLOUD_EDIT_RUNTIME_FAILURE',
        summary: 'editSoundCloudSermon callable failed during publish edit flow.',
        error,
        context: {
          functionName: 'editSoundCloudSermon',
          trackId: data.trackId,
        },
      });
      throw handleError(error);
    }
  }
);

export default editOnSoundCloud;
