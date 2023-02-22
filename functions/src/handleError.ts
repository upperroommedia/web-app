import { AxiosError, isAxiosError } from 'axios';
import { HttpsError } from 'firebase-functions/v2/https';

const handleError = (error: unknown): HttpsError => {
  if (error instanceof HttpsError) {
    return error;
  }
  if (isAxiosError(error)) {
    const axiosError = error as AxiosError;
    console.log('HERE', error.response?.data);
    return new HttpsError('internal', axiosError.message, error.response?.data || axiosError.toJSON());
  }
  if (error instanceof Error) {
    return new HttpsError('internal', error.message);
  }
  return new HttpsError('internal', 'Unknown error');
};

export default handleError;
