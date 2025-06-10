import axios, { isAxiosError } from 'axios';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, FunctionsErrorCode, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { canUserRolePublish } from '../../types/User';
import handleError from './handleError';

const deleteFromSubsplash = onCall(async (request: CallableRequest<string>): Promise<string | number> => {
  logger.log('deleteFromSubsplash', request);

  // Authentication check
  if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }

  // Input validation
  if (!request.data || typeof request.data !== 'string' || request.data.trim() === '') {
    throw new HttpsError('invalid-argument', 'The function must be called with a valid media item ID.');
  }

  // Environment validation
  if (process.env.EMAIL == undefined || process.env.PASSWORD == undefined) {
    throw new HttpsError('failed-precondition', 'Email or Password are not set in .env file');
  }

  const mediaItemId = request.data.trim();
  const url = `https://core.subsplash.com/media/v1/media-items/${mediaItemId}`;
  logger.log(`Attempting to delete media item: ${mediaItemId} from "${url}"`);

  try {
    const bearerToken = await authenticateSubsplash();
    const config = createAxiosConfig(url, bearerToken, 'DELETE');
    logger.debug('config', config);

    const response = await axios(config);
    logger.log('Successfully deleted media item', { mediaItemId, status: response.status });
    return 1;
  } catch (error) {
    logger.error('Error deleting from Subsplash', { mediaItemId, error });

    // Handle specific Subsplash API errors
    if (isAxiosError(error) && error.response?.data?.errors) {
      const subsplashError = error.response.data.errors[0];
      let code: FunctionsErrorCode = 'internal';

      if (subsplashError?.code === 'resource_not_found') {
        code = 'not-found';
        logger.warn(`Media item not found: ${mediaItemId}`);
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
