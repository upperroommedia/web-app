import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type { SetYouTubeCookiesInput, SetYouTubeCookiesOutputType } from '@upperroom/contracts/setYouTubeCookies';
import { isUserRoleAdmin, type UserRoleType } from '@upperroom/shared/types/User';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import handleError from '../../functions/src/handleError';
import { writeYouTubeCookies } from './youtubeCookieStore';

const getAdminActor = (request: CallableRequest<unknown>): { uid: string; email?: string } => {
  const uid = request.auth?.uid;
  const role = request.auth?.token.role as UserRoleType | undefined;
  if (!uid || !role || !isUserRoleAdmin(role)) {
    throw new HttpsError('permission-denied', 'Only admins can update YouTube cookies.');
  }

  const email = typeof request.auth?.token.email === 'string' ? request.auth.token.email.trim().toLowerCase() : undefined;
  return { uid, email };
};

const setyoutubecookies = onCall(
  async (request: CallableRequest<SetYouTubeCookiesInput>): Promise<SetYouTubeCookiesOutputType> => {
    const actor = getAdminActor(request);

    try {
      return await writeYouTubeCookies(firebaseAdmin.database(), request.data, actor);
    } catch (error) {
      if (error instanceof HttpsError && (error.code === 'invalid-argument' || error.code === 'permission-denied')) {
        throw error;
      }

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
