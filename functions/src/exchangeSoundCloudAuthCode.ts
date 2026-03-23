import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { isUserRoleAdmin } from '@upperroom/shared/types/User';
import {
  exchangeSoundCloudAuthorizationCode,
  soundcloudOAuthSecrets,
  type ExchangeSoundCloudAuthorizationCodeInput,
  type ExchangeSoundCloudAuthorizationCodeResult,
} from './soundcloudSecrets';

export type ExchangeSoundCloudAuthCodeInput = {
  code: string;
  state: string;
};

export type ExchangeSoundCloudAuthCodeReturnType = ExchangeSoundCloudAuthorizationCodeResult;

const exchangeSoundCloudAuthCode = onCall(
  { secrets: soundcloudOAuthSecrets },
  async (request: CallableRequest<ExchangeSoundCloudAuthCodeInput>): Promise<ExchangeSoundCloudAuthCodeReturnType> => {
    const role = request.auth?.token.role;
    if (!role || !isUserRoleAdmin(role)) {
      throw new HttpsError('permission-denied', 'Only admins can connect SoundCloud.');
    }

    const input: ExchangeSoundCloudAuthorizationCodeInput = {
      code: request.data.code,
      state: request.data.state,
      connectedByUid: request.auth?.uid,
      connectedByEmail: typeof request.auth?.token.email === 'string' ? request.auth.token.email : undefined,
    };

    return exchangeSoundCloudAuthorizationCode(input);
  }
);

export default exchangeSoundCloudAuthCode;
