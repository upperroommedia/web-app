import { AxiosError, isAxiosError } from 'axios';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { emitOperationalAlert, hasOperationalAlertBeenEmitted } from './notifications/emitOperationalAlert';

type TriggeringUserContext = {
  uid: string;
  email?: string;
  displayName?: string;
  role?: unknown;
};

export interface HandleErrorOptions {
  alertCode?: string;
  summary?: string;
  context?: Record<string, unknown>;
  request?: CallableRequest<unknown>;
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

const getTriggeringUserContext = (request?: CallableRequest<unknown>): TriggeringUserContext | undefined => {
  if (!request?.auth?.uid) {
    return undefined;
  }

  const email = typeof request.auth.token.email === 'string' ? request.auth.token.email.trim().toLowerCase() : undefined;
  const displayName = typeof request.auth.token.name === 'string' ? request.auth.token.name.trim() : undefined;
  const role = request.auth.token.role;

  return {
    uid: request.auth.uid,
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
    ...(typeof role !== 'undefined' ? { role } : {}),
  };
};

const handleError = (error: unknown, options: HandleErrorOptions = {}): HttpsError => {
  const httpsError = toHttpsError(error);
  const triggeringUser = getTriggeringUserContext(options.request);
  const context = {
    normalizedErrorCode: httpsError.code,
    ...(triggeringUser && typeof options.context?.triggeringUser === 'undefined' ? { triggeringUser } : {}),
    ...(options.context ?? {}),
  };

  if (!hasOperationalAlertBeenEmitted(error)) {
    void emitOperationalAlert({
      alertCode: options.alertCode ?? 'UNHANDLED_RUNTIME_ERROR',
      summary: options.summary ?? 'A Firebase function failed and was normalized by handleError.',
      error,
      context,
    });
  }

  return httpsError;
};

export default handleError;
