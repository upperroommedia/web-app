import axios, { isAxiosError } from 'axios';
import { logger, https } from 'firebase-functions';
import { HttpsError, FunctionsErrorCode } from 'firebase-functions/v2/https';
import { authenticateSubsplashV2, createAxiosConfig } from './subsplashUtils';
import { canUserRolePublish } from '../../types/User';
const deleteFromSubsplash = https.onCall(async (data: string, context): Promise<HttpsError | string | number> => {
  if (!context.auth || !canUserRolePublish(context.auth?.token.role)) {
    return 'Not Authorized';
  }
  if (process.env.EMAIL == undefined || process.env.PASSWORD == undefined) {
    return 'Email or Password are not set in .env file';
  }
  const url = `https://core.subsplash.com/media/v1/media-items/${data}`;
  logger.log(`Calling delete on "${url}"`);
  try {
    const bearerToken = await authenticateSubsplashV2(context.auth.uid);
    const config = createAxiosConfig(url, bearerToken, 'DELETE');
    logger.debug('config', config);
    await axios(config);
    return 1;
  } catch (error) {
    //TODO[1]: Handle errors better
    let httpsError = new HttpsError('unknown', 'Unknown error');
    if (isAxiosError(error)) {
      const response = error.response?.data.errors[0];
      let code: FunctionsErrorCode = 'unknown';
      if (response.code === 'resource_not_found') {
        code = 'not-found';
      }
      httpsError = new HttpsError(code, error.message, response.detail);
    }
    logger.error(httpsError);
    throw httpsError;
  }
});
export default deleteFromSubsplash;
