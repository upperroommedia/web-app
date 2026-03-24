const SUBSPLASH_LOCK_BUSY_CODE = 'SUBSPLASH_LOCK_BUSY' as const;

type LooseObject = Record<string, unknown>;

export interface LockBusyDetails {
  code: typeof SUBSPLASH_LOCK_BUSY_CODE;
  locked_keys: string[];
  wait_ms: number;
  retry_after_ms: number;
}

const isRecord = (value: unknown): value is LooseObject => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const normalizeSegment = (value: string, fallback: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
};

const createUuid = (): string => {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const randomValue = Math.floor(Math.random() * 16);
    const value = char === 'x' ? randomValue : (randomValue & 0x3) | 0x8;
    return value.toString(16);
  });
};

const normalizeNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export const createOperationKey = (scope: string, entityId: string): string => {
  const normalizedScope = normalizeSegment(scope, 'mutation');
  const normalizedEntityId = normalizeSegment(entityId, 'entity');
  return `${normalizedScope}:${normalizedEntityId}:${createUuid()}`;
};

const hashIntentFingerprint = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const createRetryIntentKey = (
  scope: string,
  entityId: string,
  intentFingerprint: string
): string => {
  const normalizedScope = normalizeSegment(scope, 'mutation');
  const normalizedEntityId = normalizeSegment(entityId, 'entity');
  const normalizedIntentFingerprint = intentFingerprint.trim();
  if (!normalizedIntentFingerprint) {
    throw new Error('intentFingerprint is required.');
  }

  return `${normalizedScope}:${normalizedEntityId}:retry-${hashIntentFingerprint(normalizedIntentFingerprint)}`;
};

export const createPublishedMembershipHash = (mediaItemIds: string[]): string => {
  const normalizedIds = Array.from(new Set(mediaItemIds.map((mediaItemId) => mediaItemId.trim()).filter(Boolean))).sort();
  return normalizedIds.length > 0 ? normalizedIds.join('|') : 'empty';
};

export const parseLockBusyDetails = (error: unknown): LockBusyDetails | null => {
  const details = isRecord(error) && isRecord(error.details) ? error.details : null;
  if (!details || details.code !== SUBSPLASH_LOCK_BUSY_CODE) {
    return null;
  }

  const lockedKeys = details.locked_keys;
  const waitMs = normalizeNumber(details.wait_ms);
  const retryAfterMs = normalizeNumber(details.retry_after_ms);

  if (!Array.isArray(lockedKeys) || lockedKeys.some((key) => typeof key !== 'string')) {
    return null;
  }
  if (waitMs === null || retryAfterMs === null) {
    return null;
  }

  return {
    code: SUBSPLASH_LOCK_BUSY_CODE,
    locked_keys: lockedKeys,
    wait_ms: waitMs,
    retry_after_ms: retryAfterMs,
  };
};

export const formatLockBusyRetryMessage = (fallbackMessage: string, details: LockBusyDetails): string => {
  const retryInSeconds = Math.max(1, Math.ceil(details.retry_after_ms / 1000));
  const lockedKeysSuffix = details.locked_keys.length > 0
    ? ` Locked keys: ${details.locked_keys.join(', ')}.`
    : '';
  return `${fallbackMessage} Another publishing action is in progress.${lockedKeysSuffix} Retry in about ${retryInSeconds}s.`;
};
