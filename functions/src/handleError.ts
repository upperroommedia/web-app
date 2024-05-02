import { AxiosError, isAxiosError } from 'axios';
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';

const handleError = (error: unknown): HttpsError => {
  logger.error(error);
  if (error instanceof HttpsError) {
    return error;
  }
  if (isAxiosError(error)) {
    const axiosError = error as AxiosError;
    return new HttpsError('internal', axiosError.message, error.response?.data || axiosError.toJSON());
  }
  if (error instanceof Error) {
    return new HttpsError('internal', error.message);
  }
  return new HttpsError('internal', 'Unknown error');
};

export default handleError;
