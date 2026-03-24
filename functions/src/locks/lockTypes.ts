export const SUBSPLASH_LOCK_BUSY_CODE = 'SUBSPLASH_LOCK_BUSY' as const;

export const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 10_000;
export const DEFAULT_LOCK_RETRY_AFTER_MS = 1_000;
export const DEFAULT_LOCK_LEASE_TTL_MS = 15_000;
export const DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS = 3_000;
export const DEFAULT_LOCK_WAIT_POLL_INTERVAL_MS = 200;

export const SUBSPLASH_LOCK_ENTITY_ORDER = [
  'series',
  'list',
  'media-item',
] as const;

export type SubsplashLockEntityType = typeof SUBSPLASH_LOCK_ENTITY_ORDER[number];
export type SubsplashLockKey = `${SubsplashLockEntityType}:${string}`;

export interface SubsplashLockRecord {
  lockKey: SubsplashLockKey;
  ownerToken: string;
  leaseExpiresAtMs: number;
  leaseTtlMs: number;
  heartbeatAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  operationKey?: string;
}

export interface SubsplashLockBusyDetails {
  code: typeof SUBSPLASH_LOCK_BUSY_CODE;
  locked_keys: string[];
  wait_ms: number;
  retry_after_ms: number;
}

export type IdempotencyRecordStatus = 'in_progress' | 'completed' | 'failed';

export interface IdempotencyRecord {
  operationKey: string;
  status: IdempotencyRecordStatus;
  result?: unknown;
  failure?: {
    message: string;
    code?: string;
    stack?: string;
  };
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  failedAtMs?: number;
}

const getEntityOrderIndex = (entityType: string): number => {
  const index = SUBSPLASH_LOCK_ENTITY_ORDER.indexOf(entityType as SubsplashLockEntityType);
  if (index >= 0) {
    return index;
  }
  return SUBSPLASH_LOCK_ENTITY_ORDER.length;
};

export const sortSubsplashLockKeys = (lockKeys: string[]): string[] => {
  return [...lockKeys].sort((a, b) => {
    const [entityTypeA = '', entityIdA = ''] = a.split(':');
    const [entityTypeB = '', entityIdB = ''] = b.split(':');

    const typeDelta = getEntityOrderIndex(entityTypeA) - getEntityOrderIndex(entityTypeB);
    if (typeDelta !== 0) {
      return typeDelta;
    }

    return entityIdA.localeCompare(entityIdB);
  });
};
