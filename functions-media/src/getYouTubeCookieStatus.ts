import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type { GetYouTubeCookieStatusInput, GetYouTubeCookieStatusOutputType } from '@upperroom/contracts/getYouTubeCookieStatus';
import { isUserRoleAdmin, type UserRoleType } from '@upperroom/shared/types/User';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import handleError from '../../functions/src/handleError';
import { getYouTubeCookieStatus } from './youtubeCookieStore';

const assertAdmin = (request: CallableRequest<unknown>): void => {
  const role = request.auth?.token.role as UserRoleType | undefined;
  if (!role || !isUserRoleAdmin(role)) {
    throw new HttpsError('permission-denied', 'Only admins can view YouTube cookie status.');
  }
};

const getyoutubecookiestatus = onCall(
  async (request: CallableRequest<GetYouTubeCookieStatusInput>): Promise<GetYouTubeCookieStatusOutputType> => {
    assertAdmin(request);

    try {
      return await getYouTubeCookieStatus(firebaseAdmin.database());
    } catch (error) {
      if (error instanceof HttpsError && error.code === 'permission-denied') {
        throw error;
      }

      logger.error('Failed to read YouTube cookie status', {
        error,
      });

      throw handleError(error, {
        request,
        alertCode: 'YOUTUBE_COOKIE_STATUS_RUNTIME_FAILURE',
        summary: 'getyoutubecookiestatus failed while reading YouTube cookie state.',
        context: {
          functionName: 'getyoutubecookiestatus',
        },
      });
    }
  }
);

export default getyoutubecookiestatus;
