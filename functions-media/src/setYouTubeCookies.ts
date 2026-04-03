import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type { SetYouTubeCookiesInput, SetYouTubeCookiesOutputType } from '@upperroom/contracts/setYouTubeCookies';
import { isUserRoleAdmin, type UserRoleType } from '@upperroom/shared/types/User';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import handleError from '../../functions/src/handleError';
import { beginYouTubeQueueProbe } from './processAudioQueueStore';
import { getProcessAudioTargetUri } from './processAudioService';
import { getYouTubeCookieStatus, writeYouTubeCookies } from './youtubeCookieStore';

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
  { invoker: 'public' },
  async (request: CallableRequest<SetYouTubeCookiesInput>): Promise<SetYouTubeCookiesOutputType> => {
    const actor = getAdminActor(request);

    try {
      const database = firebaseAdmin.database();
      await writeYouTubeCookies(database, request.data, actor);
      try {
        await beginYouTubeQueueProbe({
          database,
          targetUri: getProcessAudioTargetUri('youtube'),
          ownerId: `cookie-upload:${actor.uid}:${Date.now()}`,
          probeMode: 'cookie_provider',
        });
      } catch (probeError) {
        logger.error('Failed to schedule YouTube queue probe after cookie upload', {
          probeError,
          actorUid: actor.uid,
        });
      }
      return await getYouTubeCookieStatus(database);
    } catch (error) {
      if (
        error instanceof HttpsError &&
        (error.code === 'invalid-argument' || error.code === 'permission-denied')
      ) {
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
