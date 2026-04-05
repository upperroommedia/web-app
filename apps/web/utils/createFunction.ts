import * as Sentry from '@sentry/nextjs';
import functions, { httpsCallable } from '../firebase/functions';

const getErrorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim().length > 0 ? code.trim() : null;
};

const captureCallableException = (name: string, error: unknown): void => {
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
        return (await callable(data)).data;
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
        return (await callable(payload)).data;
      } catch (error) {
        captureCallableException(name, error);
        throw error;
      }
    });
  };
};
