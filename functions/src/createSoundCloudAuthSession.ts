import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { withAdministrativeCredentialSetupLease } from './temporal/legacyAdmissionLease';
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
  { secrets: soundcloudOAuthSecrets, timeoutSeconds: 60 },
  async (
    request: CallableRequest<CreateSoundCloudAuthSessionInput>
  ): Promise<CreateSoundCloudAuthSessionReturnType> => {
    const role = request.auth?.token.role;
    const uid = request.auth?.uid;
    if (!role || !uid || !isUserRoleAdmin(role)) {
      throw new HttpsError('permission-denied', 'Only admins can connect SoundCloud.');
    }

    if (typeof request.data?.redirectUri !== 'string' || !request.data.redirectUri.trim())
      throw new HttpsError('invalid-argument', 'A redirect URI is required.');

    return withAdministrativeCredentialSetupLease(
      firebaseAdmin.firestore(),
      {
        actorUid: uid,
        actorRole: role,
        operation: 'createSoundCloudAuthSession',
        projectId: firebaseAdmin.app().options.projectId || '',
      },
      async (lease) => {
        return createSoundCloudAuthorizationSession(
          {
            adminUid: uid,
            redirectUri: request.data.redirectUri,
          },
          () => lease.markEffectsStarted()
        );
      }
    );
  }
);

export default createSoundCloudAuthSession;
