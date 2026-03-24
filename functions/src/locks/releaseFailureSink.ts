import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';

export const LOCK_RELEASE_FAILURE_COLLECTION = 'lockReleaseFailures';

export interface LogLockReleaseFailureInput {
  lockKey: string;
  ownerToken: string;
  operationKey?: string;
  error: unknown;
}

interface SerializableError {
  message: string;
  name?: string;
  stack?: string;
  raw?: string;
}

const toSerializableError = (error: unknown): SerializableError => {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  if (typeof error === 'string') {
    return {
      message: error,
    };
  }

  try {
    return {
      message: 'Unknown lock release error',
      raw: JSON.stringify(error),
    };
  } catch {
    return {
      message: 'Unknown lock release error',
      raw: String(error),
    };
  }
};

export const logLockReleaseFailure = async (
  input: LogLockReleaseFailureInput
): Promise<void> => {
  const nowMs = Date.now();
  const serializedError = toSerializableError(input.error);

  logger.error('subsplash lock release failed', {
    lockKey: input.lockKey,
    ownerToken: input.ownerToken,
    operationKey: input.operationKey,
    occurredAtMs: nowMs,
    error: serializedError,
  });

  try {
    await firebaseAdmin.firestore().collection(LOCK_RELEASE_FAILURE_COLLECTION).add({
      lockKey: input.lockKey,
      ownerToken: input.ownerToken,
      operationKey: input.operationKey ?? null,
      occurredAtMs: nowMs,
      error: serializedError,
    });
  } catch (firestoreWriteError) {
    logger.error('failed to persist lock release failure document', {
      lockKey: input.lockKey,
      ownerToken: input.ownerToken,
      operationKey: input.operationKey,
      occurredAtMs: nowMs,
      error: toSerializableError(firestoreWriteError),
    });
  }
};
