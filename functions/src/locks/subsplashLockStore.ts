import { randomUUID } from 'node:crypto';
import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { buildSubsplashLockBusyError } from './contentionError';
import {
  DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCK_LEASE_TTL_MS,
  DEFAULT_LOCK_WAIT_POLL_INTERVAL_MS,
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  SubsplashLockKey,
  SubsplashLockRecord,
} from './lockTypes';

const LOCK_ROOT_PATH = 'subsplashLocks';

const sleep = async (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const getLockRef = (lockKey: string): ReturnType<ReturnType<typeof firebaseAdmin.database>['ref']> => {
  return firebaseAdmin.database().ref(`${LOCK_ROOT_PATH}/${encodeURIComponent(lockKey)}`);
};

const parseLockRecord = (lockKey: string, value: unknown): SubsplashLockRecord | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<SubsplashLockRecord>;
  if (typeof record.ownerToken !== 'string' || typeof record.leaseExpiresAtMs !== 'number') {
    return null;
  }

  const now = Date.now();
  return {
    lockKey: lockKey as SubsplashLockKey,
    ownerToken: record.ownerToken,
    leaseExpiresAtMs: record.leaseExpiresAtMs,
    leaseTtlMs: typeof record.leaseTtlMs === 'number' ? record.leaseTtlMs : DEFAULT_LOCK_LEASE_TTL_MS,
    heartbeatAtMs: typeof record.heartbeatAtMs === 'number' ? record.heartbeatAtMs : now,
    createdAtMs: typeof record.createdAtMs === 'number' ? record.createdAtMs : now,
    updatedAtMs: typeof record.updatedAtMs === 'number' ? record.updatedAtMs : now,
    operationKey: typeof record.operationKey === 'string' ? record.operationKey : undefined,
  };
};

const buildLockRecord = (
  lockKey: string,
  ownerToken: string,
  leaseTtlMs: number,
  nowMs: number,
  previous?: SubsplashLockRecord | null,
  operationKey?: string
): SubsplashLockRecord => ({
  lockKey: lockKey as SubsplashLockKey,
  ownerToken,
  leaseExpiresAtMs: nowMs + leaseTtlMs,
  leaseTtlMs,
  heartbeatAtMs: nowMs,
  createdAtMs: previous?.createdAtMs ?? nowMs,
  updatedAtMs: nowMs,
  ...(operationKey || previous?.operationKey ? { operationKey: operationKey ?? previous?.operationKey } : {}),
});

const tryAcquireLock = async (
  lockKey: string,
  ownerToken: string,
  leaseTtlMs: number,
  operationKey?: string
): Promise<{ acquired: boolean; record: SubsplashLockRecord | null }> => {
  const ref = getLockRef(lockKey);
  const nowMs = Date.now();

  const tx = await ref.transaction((currentValue) => {
    const currentRecord = parseLockRecord(lockKey, currentValue);
    const isExpired = !currentRecord || currentRecord.leaseExpiresAtMs <= nowMs;
    const isOwnedByCaller = currentRecord?.ownerToken === ownerToken;

    if (!isExpired && !isOwnedByCaller) {
      return;
    }

    return buildLockRecord(lockKey, ownerToken, leaseTtlMs, nowMs, currentRecord, operationKey);
  });

  if (tx.committed) {
    return {
      acquired: true,
      record: parseLockRecord(lockKey, tx.snapshot.val()),
    };
  }

  return {
    acquired: false,
    record: parseLockRecord(lockKey, tx.snapshot.val()),
  };
};

export interface AcquireWithWaitOptions {
  ownerToken?: string;
  leaseTtlMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  operationKey?: string;
}

export interface AcquiredLockLease {
  lockKey: string;
  ownerToken: string;
  leaseTtlMs: number;
  acquiredAtMs: number;
}

export const acquireWithWait = async (
  lockKey: string,
  options: AcquireWithWaitOptions = {}
): Promise<AcquiredLockLease> => {
  const ownerToken = options.ownerToken ?? randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LOCK_LEASE_TTL_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_LOCK_WAIT_POLL_INTERVAL_MS;
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + waitTimeoutMs;

  while (true) {
    const attempt = await tryAcquireLock(lockKey, ownerToken, leaseTtlMs, options.operationKey);
    if (attempt.acquired) {
      return {
        lockKey,
        ownerToken,
        leaseTtlMs,
        acquiredAtMs: Date.now(),
      };
    }

    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw buildSubsplashLockBusyError({
        lockedKeys: [attempt.record?.lockKey ?? lockKey],
        waitMs: waitTimeoutMs,
        retryAfterMs: pollIntervalMs,
      });
    }

    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
};

export interface HeartbeatOptions {
  ownerToken: string;
  leaseTtlMs?: number;
  intervalMs?: number;
}

export interface HeartbeatHandle {
  stop: () => void;
}

export const startHeartbeat = (
  lockKey: string,
  options: HeartbeatOptions
): HeartbeatHandle => {
  const intervalMs = options.intervalMs ?? DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS;
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LOCK_LEASE_TTL_MS;
  const ref = getLockRef(lockKey);
  let stopped = false;

  const refreshLease = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    const nowMs = Date.now();
    try {
      await ref.transaction((currentValue) => {
        const currentRecord = parseLockRecord(lockKey, currentValue);
        if (!currentRecord || currentRecord.ownerToken !== options.ownerToken) {
          return currentValue;
        }

        return buildLockRecord(lockKey, options.ownerToken, leaseTtlMs, nowMs, currentRecord);
      });
    } catch (error) {
      logger.warn('subsplash lock heartbeat failed', {
        lockKey,
        ownerToken: options.ownerToken,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const interval = setInterval(() => {
    void refreshLease();
  }, intervalMs);
  interval.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
};

export const releaseLock = async (
  lockKey: string,
  ownerToken: string
): Promise<void> => {
  const ref = getLockRef(lockKey);

  const tx = await ref.transaction((currentValue) => {
    const currentRecord = parseLockRecord(lockKey, currentValue);
    if (!currentRecord) {
      return null;
    }

    if (currentRecord.ownerToken !== ownerToken) {
      return;
    }

    return null;
  });

  if (!tx.committed && tx.snapshot.exists()) {
    throw new Error(`Cannot release lock ${lockKey}; ownership mismatch.`);
  }
};
