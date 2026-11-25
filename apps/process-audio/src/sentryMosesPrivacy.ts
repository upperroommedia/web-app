import { createHash } from 'node:crypto';

// Sentry emits request headers as both HTTP names and underscored trace attribute names.
const INTENT_HEADER = 'x-urm-moses-pilot-intent';
const UUID_V4 = /[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/gu;
const pilotCode = /(?:mosesGuest(?:TaskIdentity|Audio)|readVerifiedMosesPilotIntentNonce)/u;
const filtered = '[Filtered]';
let consumedNonceDigest: string | undefined;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

// One deployment selects exactly one new sermon/intent. Remember its digest so
// a later batched log or span can be scrubbed even after the request has ended.
export function rememberConsumedMosesPilotNonce(value: string): void {
  consumedNonceDigest = digest(value);
}

function httpHeaderName(key: string): string {
  return key.toLowerCase().replaceAll('_', '-').replace(/^http\.(?:request|response)\.header\./u, '');
}

// Run on the serialized envelope payload shape, after Sentry has attached headers,
// spans, exception locals and log attributes. SDK metadata and application objects
// are never mutated. A non-serializable item must not escape through the transport.
export function scrubMosesSentryPayload<T>(payload: T, guestBearer: string | undefined): T {
  const secrets = new Set<string>();
  if (guestBearer && /^[A-Za-z0-9_-]{43}$/u.test(guestBearer)) secrets.add(guestBearer);
  let hasPilotData = false;

  function rememberHeader(name: string, value: unknown): void {
    // Streamed span/log attributes use { type, value }. Node also represents
    // repeated headers as an array or a comma-joined string.
    const data = value && typeof value === 'object' && 'value' in value ? value.value : value;
    for (const entry of Array.isArray(data) ? data : [data]) {
      if (typeof entry !== 'string') continue;
      if (name === 'authorization') {
        for (const match of entry.matchAll(/\bBearer ([A-Za-z0-9._~+\/-]{16,}={0,2})/giu)) secrets.add(match[1]);
      } else {
        for (const nonce of entry.match(UUID_V4) ?? []) secrets.add(nonce);
      }
    }
    if (name !== 'authorization') hasPilotData = true;
  }

  const ancestors: object[] = [];
  const json = JSON.stringify(payload, function (key, value: unknown) {
    const header = httpHeaderName(key);
    if (header === INTENT_HEADER || header === 'authorization') {
      rememberHeader(header, value);
      return undefined;
    }
    if (key === 'intentNonce' || key === 'verifiedMosesPilotIntentNonce' ||
        (key === 'nonce' && typeof value === 'string' && value.length === 36 && value.match(UUID_V4))) {
      rememberHeader(INTENT_HEADER, value);
      return undefined;
    }
    if (key === 'rawHeaders' && Array.isArray(value)) {
      const remaining: unknown[] = [];
      for (let index = 0; index < value.length; index += 2) {
        const name = typeof value[index] === 'string' ? httpHeaderName(value[index]) : '';
        if (name === INTENT_HEADER || name === 'authorization') rememberHeader(name, value[index + 1]);
        else remaining.push(value[index], value[index + 1]);
      }
      return remaining;
    }
    if (typeof value === 'string' && /x[-_]urm[-_]moses[-_]pilot[-_]intent/iu.test(value)) {
      rememberHeader(INTENT_HEADER, value);
      return filtered;
    }
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object') {
      while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
      if (ancestors.includes(value)) return '[Circular]';
      ancestors.push(value);
    }
    return value;
  });

  // Headers can be repeated as free text in error messages or log attributes.
  // Drop inspector locals on just the affected exception; V8 can abbreviate a
  // credential held under an unrelated name before Sentry ever sees the frame.
  const hideLocals = hasPilotData || (!!guestBearer && (pilotCode.test(json) || json.includes(guestBearer)));
  let sanitized = json;
  for (const secret of secrets) sanitized = sanitized.replaceAll(secret, filtered);
  if (consumedNonceDigest) {
    sanitized = sanitized.replace(UUID_V4, value => digest(value) === consumedNonceDigest ? filtered : value);
  }
  return JSON.parse(sanitized, (key, value) => key === 'vars' && hideLocals ? undefined : value);
}
