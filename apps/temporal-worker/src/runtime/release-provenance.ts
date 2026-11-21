import { createHash } from 'node:crypto';

/** Matches the operator proof format at the native snapshot boundary. This is
 * intentionally separate from application receipt hashing. */
export function releaseProvenanceDigest(value: any): string {
  const canonical = (v: any): any => {
    if (v === undefined) return null;
    if (v && typeof v.toDate === 'function' && Number.isInteger(v.seconds))
      return { seconds: v.seconds, nanoseconds: v.nanoseconds };
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, canonical(v[k])])
      );
    return v;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
