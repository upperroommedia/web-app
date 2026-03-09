import { HttpsError } from 'firebase-functions/v2/https';
import { buildSubsplashLockBusyError } from './contentionError';
import {
  claimOperation,
  completeOperation,
  getOperationResult,
  markOperationFailed,
} from './idempotencyStore';

const assertOperationKey = (operationKey: string): string => {
  const normalizedKey = operationKey?.trim();
  if (!normalizedKey) {
    throw new HttpsError('invalid-argument', 'operationKey is required.');
  }

  return normalizedKey;
};

export const withIdempotency = async <T>(
  operationKey: string,
  run: () => Promise<T>
): Promise<T> => {
  const normalizedKey = assertOperationKey(operationKey);
  const claim = await claimOperation(normalizedKey);

  if (claim.status === 'completed') {
    return claim.record.result as T;
  }

  if (claim.status === 'in_progress') {
    throw buildSubsplashLockBusyError({
      lockedKeys: [`operation:${normalizedKey}`],
      message: `Operation ${normalizedKey} is already in progress.`,
    });
  }

  try {
    const result = await run();
    await completeOperation(normalizedKey, result);
    return result;
  } catch (error) {
    await markOperationFailed(normalizedKey, error);
    throw error;
  }
};

export {
  claimOperation,
  completeOperation,
  getOperationResult,
  markOperationFailed,
};
