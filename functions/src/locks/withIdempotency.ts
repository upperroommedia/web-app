import { HttpsError } from 'firebase-functions/v2/https';
import { buildSubsplashLockBusyError } from './contentionError';
import {
  claimOperation,
  completeOperation,
  getOperationResult,
  markOperationFailed,
} from './idempotencyStore';
import { isDurablePublishingOperation } from '../temporal/publishing/durableOperationContext';

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
  // Durable activities use provider-step receipts and fresh resource-state checks.
  // Legacy whole-call in_progress markers cannot recover after process death, and
  // cached partial results prevent corrected desired-state operations from resuming.
  // Shared resource locks remain active inside run(); this context is worker-only.
  if (isDurablePublishingOperation()) return run();
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
