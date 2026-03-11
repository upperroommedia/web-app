import axios, { isAxiosError } from 'axios';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, FunctionsErrorCode, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { canUserRolePublish } from '../../types/User';
import handleError from './handleError';
import { withIdempotency } from './locks/withIdempotency';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';

export interface DeleteFromSubsplashInputType {
  operationKey: string;
  subsplashId: string;
}

export type DeleteFromSubsplashReturnType = void;

const deleteFromSubsplash = onCall(async (request: CallableRequest<DeleteFromSubsplashInputType>): Promise<DeleteFromSubsplashReturnType> => {
  logger.log('deleteFromSubsplash', request);

  // Authentication check
  if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }

  // Input validation
  if (!request.data || typeof request.data !== 'object' || !request.data.subsplashId || request.data.subsplashId.trim() === '') {
    throw new HttpsError('invalid-argument', 'The function must be called with a valid media item ID.');
  }
  if (!request.data.operationKey || request.data.operationKey.trim() === '') {
    throw new HttpsError('invalid-argument', 'operationKey is required.');
  }

  // Environment validation
  if (process.env.SUBSPLASH_EMAIL == undefined || process.env.SUBSPLASH_PASSWORD == undefined) {
    throw new HttpsError('failed-precondition', 'SUBSPLASH_EMAIL or SUBSPLASH_PASSWORD is not set.');
  }

  const mediaItemId = request.data.subsplashId.trim();
  const operationKey = request.data.operationKey.trim();
  console.log('Attempting to delete mediaItemId', mediaItemId);
  const url = `https://core.subsplash.com/media/v1/media-items/${mediaItemId}`;
  logger.log(`Attempting to delete media item: ${mediaItemId} from "${url}"`);

  try {
    return await withIdempotency(operationKey, async () =>
      withSubsplashLocks(
        [`media-item:${mediaItemId}`],
        async () => {
          const bearerToken = await authenticateSubsplash();
          const config = createAxiosConfig(url, bearerToken, 'DELETE');
          logger.debug('config', config);

          const response = await axios(config);
          logger.log('Successfully deleted media item', { mediaItemId, status: response.status });
          return;
        },
        { operationKey }
      )
    );
  } catch (error) {
    logger.error('Error deleting from Subsplash', { mediaItemId, error });

    // Idempotency: deleting an already-deleted media item should succeed.
    if (isAxiosError(error) && error.response?.status === 404) {
      logger.warn(`Media item not found (already deleted): ${mediaItemId}`);
      return;
    }

    try {
      await emitOperationalAlert({
        alertCode: 'PUBLISH_SUBSPLASH_DELETE_RUNTIME_FAILURE',
        summary: 'deleteFromSubsplash callable failed during publish delete flow.',
        error,
        context: {
          functionName: 'deleteFromSubsplash',
          operationKey,
          subsplashId: mediaItemId,
        },
      });
    } catch (alertError) {
      logger.error('Failed to emit operational alert for deleteFromSubsplash', {
        mediaItemId,
        alertError,
      });
    }

    // Handle specific Subsplash API errors
    if (isAxiosError(error) && error.response?.data?.errors) {
      const subsplashError = error.response.data.errors[0];
      let code: FunctionsErrorCode = 'internal';

      if (subsplashError?.code === 'resource_not_found') {
        code = 'not-found';
        logger.warn(`Media item not found: ${mediaItemId}`);
        return;
      } else if (subsplashError?.code === 'unauthorized') {
        code = 'unauthenticated';
      } else if (subsplashError?.code === 'forbidden') {
        code = 'permission-denied';
      }

      const httpsError = new HttpsError(
        code,
        subsplashError?.detail || error.message || 'Failed to delete from Subsplash',
        subsplashError
      );
      throw httpsError;
    }

    // Use the standard error handler for all other errors
    throw handleError(error);
  }
});

export default deleteFromSubsplash;
