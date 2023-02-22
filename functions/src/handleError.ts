import { AxiosError, isAxiosError } from 'axios';
import { HttpsError } from 'firebase-functions/v2/https';

const handleError = (error: unknown): never => {
  if (error instanceof HttpsError) {
    throw error;
  }
  if (isAxiosError(error)) {
    const axiosError = error as AxiosError;
    throw new HttpsError('internal', axiosError.message, axiosError.toJSON());
  }
  if (error instanceof Error) {
    throw new HttpsError('internal', error.message);
  }
  throw new HttpsError('internal', 'Unknown error');
};

export default handleError;
