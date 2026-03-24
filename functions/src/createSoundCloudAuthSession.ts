import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { isUserRoleAdmin } from '@upperroom/shared/types/User';
import {
  createSoundCloudAuthorizationSession,
  soundcloudOAuthSecrets,
  type CreateSoundCloudAuthorizationSessionResult,
} from './soundcloudSecrets';

export type CreateSoundCloudAuthSessionInput = {
  redirectUri: string;
};

export type CreateSoundCloudAuthSessionReturnType = CreateSoundCloudAuthorizationSessionResult;

const createSoundCloudAuthSession = onCall(
  { secrets: soundcloudOAuthSecrets },
  async (
    request: CallableRequest<CreateSoundCloudAuthSessionInput>
  ): Promise<CreateSoundCloudAuthSessionReturnType> => {
    const role = request.auth?.token.role;
    const uid = request.auth?.uid;
    if (!role || !uid || !isUserRoleAdmin(role)) {
      throw new HttpsError('permission-denied', 'Only admins can connect SoundCloud.');
    }

    return createSoundCloudAuthorizationSession({
      adminUid: uid,
      redirectUri: request.data.redirectUri,
    });
  }
);

export default createSoundCloudAuthSession;
