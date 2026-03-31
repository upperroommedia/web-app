import functions, { httpsCallable } from '../firebase/functions';

export const createFunction = <T = unknown, R = unknown>(name: string): ((data: T) => Promise<R>) => {
  const callable = httpsCallable<T, R>(functions, name);
  return async (data: T) => (await callable(data)).data;
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
    return (await callable(payload)).data;
  };
};
