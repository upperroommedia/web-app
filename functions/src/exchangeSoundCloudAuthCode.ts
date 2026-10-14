import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { withAdministrativeCredentialSetupLease } from './temporal/legacyAdmissionLease';
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
  { secrets: soundcloudOAuthSecrets, timeoutSeconds: 60 },
  async (request: CallableRequest<ExchangeSoundCloudAuthCodeInput>): Promise<ExchangeSoundCloudAuthCodeReturnType> => {
    const role = request.auth?.token.role;
    const uid = request.auth?.uid;
    if (!uid || !role || !isUserRoleAdmin(role)) {
      throw new HttpsError('permission-denied', 'Only admins can connect SoundCloud.');
    }

    if (
      typeof request.data?.code !== 'string' ||
      !request.data.code.trim() ||
      typeof request.data?.state !== 'string' ||
      !request.data.state.trim()
    )
      throw new HttpsError('invalid-argument', 'SoundCloud authorization code and state are required.');

    const input: ExchangeSoundCloudAuthorizationCodeInput = {
      code: request.data.code,
      state: request.data.state,
      connectedByUid: request.auth?.uid,
      connectedByEmail: typeof request.auth?.token.email === 'string' ? request.auth.token.email : undefined,
    };

    return withAdministrativeCredentialSetupLease(
      firebaseAdmin.firestore(),
      {
        actorUid: uid,
        actorRole: role,
        operation: 'exchangeSoundCloudAuthCode',
        projectId: firebaseAdmin.app().options.projectId || '',
      },
      async (lease) => {
        return exchangeSoundCloudAuthorizationCode(input, () => lease.markEffectsStarted(), {
          admissionLeaseId: lease.leaseId,
        });
      }
    );
  }
);

export default exchangeSoundCloudAuthCode;
