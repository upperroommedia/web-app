import { AxiosError, isAxiosError } from 'axios';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { emitOperationalAlert, hasOperationalAlertBeenEmitted } from './notifications/emitOperationalAlert';
import { captureFunctionsExceptionAndFlush } from './sentry';
import { isExpectedOperationalError } from './expectedOperationalError';

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
  suppressReporting?: boolean;
}

type RetryAfterDetails = {
  retry_after_ms?: number;
  retry_after_seconds?: number;
};

const getAxiosStatus = (error: AxiosError): number | undefined => error.response?.status;

const parseRetryAfter = (value: unknown): RetryAfterDetails => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return {
      retry_after_seconds: value,
      retry_after_ms: Math.max(0, Math.round(value * 1000)),
    };
  }

  if (typeof value !== 'string') {
    return {};
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }

  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds)) {
    return {
      retry_after_seconds: asSeconds,
      retry_after_ms: Math.max(0, Math.round(asSeconds * 1000)),
    };
  }

  const retryDateMs = Date.parse(trimmed);
  if (!Number.isFinite(retryDateMs)) {
    return {};
  }

  return {
    retry_after_ms: Math.max(0, retryDateMs - Date.now()),
  };
};

const toHttpsError = (error: unknown): HttpsError => {
  if (error instanceof HttpsError) {
    return error;
  }
  if (isAxiosError(error)) {
    const axiosError = error as AxiosError;
    const status = getAxiosStatus(axiosError);
    const retryAfter = parseRetryAfter(axiosError.response?.headers?.['retry-after']);
    const upstream = error.response?.data || axiosError.toJSON();

    if (status === 429) {
      return new HttpsError('resource-exhausted', axiosError.message, {
        code: 'UPSTREAM_RATE_LIMITED',
        upstream_status: status,
        ...retryAfter,
        upstream,
      });
    }

    if (status === 401) {
      return new HttpsError('unauthenticated', axiosError.message, {
        code: 'UPSTREAM_UNAUTHENTICATED',
        upstream_status: status,
        upstream,
      });
    }

    if (status === 403) {
      return new HttpsError('permission-denied', axiosError.message, {
        code: 'UPSTREAM_PERMISSION_DENIED',
        upstream_status: status,
        upstream,
      });
    }

    if (typeof status === 'number' && status >= 500 && status < 600) {
      return new HttpsError('unavailable', axiosError.message, {
        code: 'UPSTREAM_UNAVAILABLE',
        upstream_status: status,
        ...retryAfter,
        upstream,
      });
    }

    return new HttpsError('internal', axiosError.message, upstream);
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

  if (options.suppressReporting || isExpectedOperationalError(httpsError)) {
    return httpsError;
  }

  if (!hasOperationalAlertBeenEmitted(error)) {
    void captureFunctionsExceptionAndFlush(error, {
      tags: {
        normalizedErrorCode: httpsError.code,
      },
      extra: context,
    });
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
