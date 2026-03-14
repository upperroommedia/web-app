import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { getSoundCloudAuthStatus, soundcloudOAuthSecrets, type SoundCloudAuthStatus } from './soundcloudSecrets';
import { isUserRoleAdmin } from '@upperroom/shared/types/User';

export type GetSoundCloudAuthStatusInput = Record<string, never>;
export type GetSoundCloudAuthStatusReturnType = SoundCloudAuthStatus;

const getSoundCloudAuthStatusCall = onCall(
  { secrets: soundcloudOAuthSecrets },
  async (request: CallableRequest<GetSoundCloudAuthStatusInput>): Promise<GetSoundCloudAuthStatusReturnType> => {
    const role = request.auth?.token.role;
    if (!role || !isUserRoleAdmin(role)) {
      throw new HttpsError('permission-denied', 'Only admins can view SoundCloud auth status.');
    }

    return getSoundCloudAuthStatus();
  }
);

export default getSoundCloudAuthStatusCall;
