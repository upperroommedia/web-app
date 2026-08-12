import * as Sentry from '@sentry/nextjs';
import functions, { httpsCallable } from '../firebase/functions';
import { SUBSPLASH_MEDIA_ITEM_NOT_FOUND_CODE } from '@upperroom/contracts/addToList';

const getErrorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim().length > 0 ? code.trim() : null;
};

const getErrorMessage = (error: unknown): string | null => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.trim().length > 0 ? message.trim() : null;
};

const getErrorDetailsCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const details = (error as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    return null;
  }

  const code = (details as { code?: unknown }).code;
  return typeof code === 'string' && code.trim().length > 0 ? code.trim() : null;
};

const RETRYABLE_READ_CALLABLES = new Set(['generatesecuredapikey', 'getusersbyids']);
const CALLABLE_RETRY_DELAYS_MS = [250, 1_000] as const;

export const isRetryableCallableTransportError = (error: unknown): boolean => {
  const errorCode = getErrorCode(error);
  if (errorCode === 'functions/deadline-exceeded' || errorCode === 'functions/unavailable') {
    return true;
  }

  return errorCode === 'functions/internal' && getErrorDetailsCode(error) === null;
};

const hasOperationKey = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { operationKey?: unknown }).operationKey === 'string' &&
  Boolean((value as { operationKey: string }).operationKey.trim());

const waitForRetry = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

const invokeCallableWithRetry = async <T, R>(
  callable: (data: T) => Promise<{ data: R }>,
  payload: T,
  canRetry: boolean
): Promise<R> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await callable(payload)).data;
    } catch (error) {
      const retryDelayMs = CALLABLE_RETRY_DELAYS_MS[attempt];
      if (!canRetry || typeof retryDelayMs === 'undefined' || !isRetryableCallableTransportError(error)) {
        throw error;
      }
      await waitForRetry(retryDelayMs);
    }
  }
};

export const isExpectedCallableClientError = (name: string, error: unknown): boolean => {
  const errorCode = getErrorCode(error);
  const errorMessage = getErrorMessage(error);
  const detailsCode = getErrorDetailsCode(error);

  return (
    (
      name === 'bulkaddtoseries' &&
      errorCode === 'functions/failed-precondition' &&
      errorMessage === 'Published membership changed in Subsplash. Refresh the series and retry with a fresh snapshot hash.'
    ) ||
    (
      errorCode === 'functions/aborted' &&
      detailsCode === 'SUBSPLASH_LOCK_BUSY'
    ) ||
    (
      name === 'getusersbyids' &&
      errorCode === 'functions/deadline-exceeded'
    ) ||
    (
      name === 'generatesecuredapikey' &&
      errorCode === 'functions/unauthenticated'
    ) ||
    (
      (name === 'uploadtosoundcloud' || name === 'uploadToSubsplash') &&
      errorCode === 'functions/unavailable'
    ) ||
    (
      name === 'addtolist' &&
      errorCode === 'functions/not-found' &&
      detailsCode === SUBSPLASH_MEDIA_ITEM_NOT_FOUND_CODE
    )
  );
};

const captureCallableException = (name: string, error: unknown): void => {
  if (isExpectedCallableClientError(name, error)) {
    return;
  }

  Sentry.withScope((scope) => {
    scope.setTag('callable.name', name);
    scope.setTag('error.surface', 'firebase-callable');

    const errorCode = getErrorCode(error);
    if (errorCode) {
      scope.setTag('firebase.error_code', errorCode);
    }

    scope.setLevel('error');
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
  });
};

export const createFunction = <T = unknown, R = unknown>(name: string): ((data: T) => Promise<R>) => {
  const callable = httpsCallable<T, R>(functions, name);
  return async (data: T) =>
    Sentry.startSpan({ name: `firebase.callable.${name}`, op: 'firebase.callable' }, async () => {
      try {
        return await invokeCallableWithRetry(callable, data, RETRYABLE_READ_CALLABLES.has(name));
      } catch (error) {
        captureCallableException(name, error);
        throw error;
      }
    });
};

export interface CallableMutationMetadata {
  operationKey?: string;
  lockKey?: string;
}

export interface CallableCallOptions<M extends object = CallableMutationMetadata> {
  metadata?: M;
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const mergeCallableDataWithMetadata = <T, M extends object>(
  data: T,
  options?: CallableCallOptions<M>
): T => {
  if (!options?.metadata || !isObjectRecord(options.metadata) || !isObjectRecord(data)) {
    return data;
  }

  return {
    ...data,
    ...options.metadata,
  } as T;
};

export const createFunctionV2 = <T = unknown, R = unknown, M extends object = CallableMutationMetadata>(
  name: string
): ((data: T, options?: CallableCallOptions<M>) => Promise<R>) => {
  const callable = httpsCallable<T, R>(functions, name);
  return async (data: T, options?: CallableCallOptions<M>) => {
    const payload = mergeCallableDataWithMetadata(data, options);
    return Sentry.startSpan({ name: `firebase.callable.${name}`, op: 'firebase.callable' }, async () => {
      try {
        return await invokeCallableWithRetry(callable, payload, hasOperationKey(payload));
      } catch (error) {
        captureCallableException(name, error);
        throw error;
      }
    });
  };
};
