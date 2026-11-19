import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { getSoundCloudAuthStatus, soundcloudOAuthSecrets, type SoundCloudAuthStatus } from './soundcloudSecrets';
import type {
  GetSoundCloudAuthStatusInput,
  SoundCloudPublishingAuthStatus,
} from '@upperroom/contracts/getSoundCloudAuthStatus';
import { canUserRolePublish, isUserRoleAdmin } from '@upperroom/shared/types/User';

export type { GetSoundCloudAuthStatusInput };
export type GetSoundCloudAuthStatusReturnType = SoundCloudAuthStatus;

const getSoundCloudAuthStatusCall = onCall(
  { secrets: soundcloudOAuthSecrets },
  async (
    request: CallableRequest<GetSoundCloudAuthStatusInput>
  ): Promise<GetSoundCloudAuthStatusReturnType | SoundCloudPublishingAuthStatus> => {
    const role = request.auth?.token.role;
    if (request.data?.view === 'publish' && role && canUserRolePublish(role)) {
      const status = await getSoundCloudAuthStatus();
      return { connected: status.connected, ...(status.reconnectRequired ? { reconnectRequired: true } : {}) };
    }
    if (!role || !isUserRoleAdmin(role)) {
      throw new HttpsError('permission-denied', 'Only admins can view SoundCloud auth status.');
    }

    return getSoundCloudAuthStatus();
  }
);

export default getSoundCloudAuthStatusCall;
