import { HttpsError } from 'firebase-functions/v2/https';
import {
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  sortSubsplashLockKeys,
} from '../../locks/lockTypes';
import { buildSubsplashLockBusyError } from '../../locks/contentionError';

describe('buildSubsplashLockBusyError', () => {
  it('includes busy payload fields for lock contention', () => {
    const error = buildSubsplashLockBusyError({
      lockedKeys: ['list:beta', 'series:alpha'],
      waitMs: 4_200,
      retryAfterMs: 1_500,
    });

    expect(error).toBeInstanceOf(HttpsError);
    expect(error.code).toBe('aborted');
    expect(error.details).toEqual({
      code: 'SUBSPLASH_LOCK_BUSY',
      locked_keys: ['list:beta', 'series:alpha'],
      wait_ms: 4_200,
      retry_after_ms: 1_500,
    });
  });

  it('sorts entity lock keys in deterministic global order', () => {
    expect(
      sortSubsplashLockKeys([
        'media-item:z',
        'series:b',
        'list:a',
        'series:a',
        'media-item:a',
      ])
    ).toEqual([
      'series:a',
      'series:b',
      'list:a',
      'media-item:a',
      'media-item:z',
    ]);
  });

  it('uses a default lock wait timeout of exactly 10,000ms', () => {
    const error = buildSubsplashLockBusyError({
      lockedKeys: ['series:alpha'],
      retryAfterMs: 900,
    });

    expect(DEFAULT_LOCK_WAIT_TIMEOUT_MS).toBe(10_000);
    expect(error.details).toMatchObject({
      wait_ms: 10_000,
    });
  });
});
