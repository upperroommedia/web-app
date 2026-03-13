import { AxiosError, isAxiosError } from 'axios';
import { HttpsError } from 'firebase-functions/v2/https';
import { emitOperationalAlert, hasOperationalAlertBeenEmitted } from './notifications/emitOperationalAlert';

export interface HandleErrorOptions {
  alertCode?: string;
  summary?: string;
  context?: Record<string, unknown>;
}

const toHttpsError = (error: unknown): HttpsError => {
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

const handleError = (error: unknown, options: HandleErrorOptions = {}): HttpsError => {
  const httpsError = toHttpsError(error);

  if (!hasOperationalAlertBeenEmitted(error)) {
    void emitOperationalAlert({
      alertCode: options.alertCode ?? 'UNHANDLED_RUNTIME_ERROR',
      summary: options.summary ?? 'A Firebase function failed and was normalized by handleError.',
      error,
      context: {
        normalizedErrorCode: httpsError.code,
        ...(options.context ?? {}),
      },
    });
  }

  return httpsError;
};

export default handleError;
