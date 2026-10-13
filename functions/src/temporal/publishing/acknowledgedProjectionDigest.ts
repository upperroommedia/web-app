import { createHash } from 'node:crypto';

// This leaf is shared by immutable source plans and repair candidates. It must
// not import workflow/provider modules, whose initialization depends on it.
function fail(): never {
  throw Object.assign(new Error('Original acknowledged projection proof is required'), {
    code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED',
  });
}
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
export function normalizeAcknowledgedProjectionValue(value: unknown, depth = 0): unknown {
  if (depth > 20) fail();
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) fail();
    return value.getTime();
  }
  if (value && typeof value === 'object' && 'toMillis' in value && typeof value.toMillis === 'function') {
    const millis = value.toMillis();
    if (typeof millis !== 'number' || !Number.isFinite(millis)) fail();
    return millis;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeAcknowledgedProjectionValue(item, depth + 1));
  if (plain(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalizeAcknowledgedProjectionValue(item, depth + 1)])
    );
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  return fail();
}
export const acknowledgedProjectionDigest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(normalizeAcknowledgedProjectionValue(value)))
    .digest('hex');
