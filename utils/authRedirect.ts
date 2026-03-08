const DEFAULT_AUTH_DESTINATION = '/';
const SAFE_REDIRECT_ORIGIN = 'https://urm.local';

const hasControlCharacters = (value: string): boolean => /[\u0000-\u001F\u007F]/.test(value);

const decodeOnce = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const isSafeInternalCallbackDestination = (value: string): boolean => {
  if (!value.startsWith('/')) {
    return false;
  }

  if (value.startsWith('//')) {
    return false;
  }

  if (value.includes('\\')) {
    return false;
  }

  if (hasControlCharacters(value)) {
    return false;
  }

  const normalized = value.toLowerCase();
  if (normalized.startsWith('/login')) {
    return false;
  }

  return true;
};

const normalizeRawCallback = (raw: string): string => {
  const trimmed = decodeOnce(raw.trim());

  if (trimmed.length === 0) {
    return DEFAULT_AUTH_DESTINATION;
  }

  if (trimmed.startsWith('//')) {
    return DEFAULT_AUTH_DESTINATION;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return DEFAULT_AUTH_DESTINATION;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed, SAFE_REDIRECT_ORIGIN);
  } catch {
    return DEFAULT_AUTH_DESTINATION;
  }

  if (parsed.origin !== SAFE_REDIRECT_ORIGIN) {
    return DEFAULT_AUTH_DESTINATION;
  }

  const destination = `${parsed.pathname}${parsed.search}${parsed.hash}`;

  return isSafeInternalCallbackDestination(destination) ? destination : DEFAULT_AUTH_DESTINATION;
};

export const resolveAuthCallbackDestination = (
  callbackurl: unknown,
  callbackUrl: unknown
): string => {
  const rawValue = [callbackurl, callbackUrl].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );

  if (!rawValue) {
    return DEFAULT_AUTH_DESTINATION;
  }

  return normalizeRawCallback(rawValue);
};

