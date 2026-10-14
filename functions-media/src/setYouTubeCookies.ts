import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type { SetYouTubeCookiesInput, SetYouTubeCookiesOutputType } from '@upperroom/contracts/setYouTubeCookies';
import { isUserRoleAdmin, type UserRoleType } from '@upperroom/shared/types/User';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { withAdministrativeCredentialSetupLease } from '../../functions/src/temporal/legacyAdmissionLease';
import handleError from '../../functions/src/handleError';
import { getYouTubeCookieStatus, writeYouTubeCookies, validateYouTubeCookiesInput } from './youtubeCookieStore';

const getAdminActor = (request: CallableRequest<unknown>): { uid: string; email?: string } => {
  const uid = request.auth?.uid;
  const role = request.auth?.token.role as UserRoleType | undefined;
  if (!uid || !role || !isUserRoleAdmin(role)) {
    throw new HttpsError('permission-denied', 'Only admins can update YouTube cookies.');
  }

  const email =
    typeof request.auth?.token.email === 'string' ? request.auth.token.email.trim().toLowerCase() : undefined;
  return { uid, email };
};

const setyoutubecookies = onCall(
  { invoker: 'public' },
  async (request: CallableRequest<SetYouTubeCookiesInput>): Promise<SetYouTubeCookiesOutputType> => {
    const actor = getAdminActor(request);

    try {
      validateYouTubeCookiesInput(request.data);
      const database = firebaseAdmin.database();
      const projectId = firebaseAdmin.app().options.projectId;
      if (!projectId) throw new HttpsError('failed-precondition', 'Firebase project is required.');
      await withAdministrativeCredentialSetupLease(
        firebaseAdmin.firestore(),
        { projectId, actorUid: actor.uid, actorRole: String(request.auth!.token.role), operation: 'setYouTubeCookies' },
        async (lease) => {
          await lease.markEffectsStarted();
          await writeYouTubeCookies(database, request.data, actor);
        }
      );
      return await getYouTubeCookieStatus(database);
    } catch (error) {
      if (error instanceof HttpsError) throw error;

      logger.error('Failed to update YouTube cookies', {
        error,
        actorUid: actor.uid,
      });

      throw handleError(error, {
        request,
        alertCode: 'YOUTUBE_COOKIE_UPLOAD_RUNTIME_FAILURE',
        summary: 'setyoutubecookies failed while updating YouTube cookie state.',
        context: {
          functionName: 'setyoutubecookies',
          actorUid: actor.uid,
          actorEmail: actor.email ?? null,
        },
      });
    }
  }
);

export default setyoutubecookies;
