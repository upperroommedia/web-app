import { randomUUID } from 'node:crypto';
import {
  DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCK_LEASE_TTL_MS,
  DEFAULT_LOCK_WAIT_POLL_INTERVAL_MS,
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  sortSubsplashLockKeys,
} from './lockTypes';
import { acquireWithWait, releaseLock, startHeartbeat } from './subsplashLockStore';
import { logLockReleaseFailure } from './releaseFailureSink';

export const sortLockKeys = (lockKeys: string[]): string[] => sortSubsplashLockKeys(lockKeys);

export interface WithSubsplashLocksOptions {
  ownerToken?: string;
  leaseTtlMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  operationKey?: string;
}

export const withSubsplashLocks = async <T>(
  lockKeys: string[],
  run: () => Promise<T>,
  options: WithSubsplashLocksOptions = {}
): Promise<T> => {
  const uniqueOrderedLockKeys = Array.from(new Set(sortLockKeys(lockKeys)));
  if (uniqueOrderedLockKeys.length === 0) {
    return run();
  }

  const ownerToken = options.ownerToken ?? randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LOCK_LEASE_TTL_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_LOCK_WAIT_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS;

  const acquiredLockKeys: string[] = [];
  const heartbeats: Array<{ stop: () => void }> = [];

  try {
    for (const lockKey of uniqueOrderedLockKeys) {
      await acquireWithWait(lockKey, {
        ownerToken,
        leaseTtlMs,
        waitTimeoutMs,
        pollIntervalMs,
        operationKey: options.operationKey,
      });

      acquiredLockKeys.push(lockKey);
      heartbeats.push(
        startHeartbeat(lockKey, {
          ownerToken,
          leaseTtlMs,
          intervalMs: heartbeatIntervalMs,
        })
      );
    }

    return await run();
  } finally {
    heartbeats.forEach((heartbeat) => heartbeat.stop());

    const releaseOrder = [...acquiredLockKeys].reverse();
    for (const lockKey of releaseOrder) {
      try {
        await releaseLock(lockKey, ownerToken);
      } catch (error) {
        await logLockReleaseFailure({
          lockKey,
          ownerToken,
          operationKey: options.operationKey,
          error,
        });
      }
    }
  }
};
