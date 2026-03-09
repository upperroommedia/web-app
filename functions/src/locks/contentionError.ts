import { HttpsError } from 'firebase-functions/v2/https';
import {
  DEFAULT_LOCK_RETRY_AFTER_MS,
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  SUBSPLASH_LOCK_BUSY_CODE,
  SubsplashLockBusyDetails,
} from './lockTypes';

interface BuildSubsplashLockBusyErrorInput {
  lockedKeys: string[];
  waitMs?: number;
  retryAfterMs?: number;
  message?: string;
}

export const buildSubsplashLockBusyError = (
  input: BuildSubsplashLockBusyErrorInput
): HttpsError => {
  const details: SubsplashLockBusyDetails = {
    code: SUBSPLASH_LOCK_BUSY_CODE,
    locked_keys: input.lockedKeys,
    wait_ms: input.waitMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS,
    retry_after_ms: input.retryAfterMs ?? DEFAULT_LOCK_RETRY_AFTER_MS,
  };

  return new HttpsError(
    'aborted',
    input.message ?? 'Subsplash lock contention prevented this mutation.',
    details
  );
};
