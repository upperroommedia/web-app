import axios from 'axios';
import { logger, https } from 'firebase-functions';
import { HttpsError, FunctionsErrorCode } from 'firebase-functions/v2/https';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
const deleteFromSubsplash = https.onCall(async (data: string, context): Promise<HttpsError | string | number> => {
  if (context.auth?.token.role !== 'admin') {
    return 'Not Authorized';
  }
  if (process.env.EMAIL == undefined || process.env.PASSWORD == undefined) {
    return 'Email or Password are not set in .env file';
  }
  const url = `https://core.subsplash.com/media/v1/media-items/${data}`;
  logger.log(`Calling delete on "${url}"`);
  try {
    const bearerToken = await authenticateSubsplash();
    const config = createAxiosConfig(url, bearerToken, 'DELETE');
    logger.debug('config', config);
    await axios(config);
    return 1;
  } catch (error) {
    //TODO[1]: Handle errors better
    let httpsError = new HttpsError('unknown', 'Unknown error');
    if (axios.isAxiosError(error)) {
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
