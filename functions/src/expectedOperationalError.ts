import { SUBSPLASH_LOCK_BUSY_CODE } from './locks/lockTypes';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isExpectedOperationalError = (error: unknown): boolean =>
  isRecord(error) &&
  error.code === 'aborted' &&
  isRecord(error.details) &&
  error.details.code === SUBSPLASH_LOCK_BUSY_CODE;
