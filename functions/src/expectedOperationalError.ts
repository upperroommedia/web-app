import { SUBSPLASH_LOCK_BUSY_CODE } from './locks/lockTypes';

export const SUBSPLASH_SERIES_OWNERSHIP_MISMATCH_CODE = 'SUBSPLASH_SERIES_OWNERSHIP_MISMATCH';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isExpectedOperationalError = (error: unknown): boolean => {
  if (!isRecord(error) || !isRecord(error.details)) {
    return false;
  }

  return (
    (error.code === 'aborted' && error.details.code === SUBSPLASH_LOCK_BUSY_CODE) ||
    (
      error.code === 'failed-precondition' &&
      error.details.code === SUBSPLASH_SERIES_OWNERSHIP_MISMATCH_CODE
    )
  );
};
