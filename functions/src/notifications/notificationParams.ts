import { defineList, defineString } from 'firebase-functions/params';

// const ROLE_REQUEST_RECIPIENT_DEFAULTS = ['youssef.a.asaad@gmail.com', 'contact@upperroommedia.org'] as const;
// const RUNTIME_ALERT_RECIPIENT_DEFAULTS = ['youssef.a.asaad@gmail.com', 'contact@upperroommedia.org'] as const;
// const ADMIN_BASE_URL_DEFAULT = 'https://uploader.upperroommedia.org';
const ROLE_REQUEST_RECIPIENT_DEFAULTS = ['youssef.a.asaad@gmail.com'] as const;
const RUNTIME_ALERT_RECIPIENT_DEFAULTS = ['youssef.a.asaad@gmail.com'] as const;
const ADMIN_BASE_URL_DEFAULT = 'http://localhost:3000';

const normalizeRecipientList = (rawRecipients: readonly string[]): string[] => {
  const cleaned = rawRecipients.map((recipient) => recipient.trim()).filter((recipient) => recipient.length > 0);
  return Array.from(new Set(cleaned));
};

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const parseRecipientEnvValue = (rawValue: string | undefined): string[] => {
  if (!rawValue) {
    return [];
  }

  const trimmed = rawValue.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === 'string');
    }
  } catch {
    // Fall back to comma-delimited values if JSON parsing fails.
  }

  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const readListParam = (
  param: { value: () => readonly string[] },
  envName: string,
  defaults: readonly string[]
): string[] => {
  try {
    return normalizeRecipientList(param.value());
  } catch {
    const envRecipients = parseRecipientEnvValue(process.env[envName]);
    return normalizeRecipientList(envRecipients.length > 0 ? envRecipients : defaults);
  }
};

const readStringParam = (param: { value: () => string }, envName: string, defaultValue: string): string => {
  try {
    return trimTrailingSlash(param.value());
  } catch {
    const envValue = process.env[envName]?.trim();
    return trimTrailingSlash(envValue && envValue.length > 0 ? envValue : defaultValue);
  }
};

export const roleRequestRecipients = defineList('ROLE_REQUEST_RECIPIENTS', {
  default: [...ROLE_REQUEST_RECIPIENT_DEFAULTS],
  description: 'Recipients for role-request notifications. Production defaults are required by policy.',
});

export const runtimeAlertRecipients = defineList('RUNTIME_ALERT_RECIPIENTS', {
  default: [...RUNTIME_ALERT_RECIPIENT_DEFAULTS],
  description: 'Recipients for runtime operational alerts. Alerts are emitted for every caught occurrence.',
});

export const adminBaseUrl = defineString('ADMIN_BASE_URL', {
  default: ADMIN_BASE_URL_DEFAULT,
  description: 'Base URL used for admin links in operational notifications.',
});

export const getRoleRequestRecipients = (): string[] =>
  readListParam(roleRequestRecipients, 'ROLE_REQUEST_RECIPIENTS', ROLE_REQUEST_RECIPIENT_DEFAULTS);

export const getRuntimeAlertRecipients = (): string[] =>
  readListParam(runtimeAlertRecipients, 'RUNTIME_ALERT_RECIPIENTS', RUNTIME_ALERT_RECIPIENT_DEFAULTS);

export const getAdminBaseUrl = (): string => readStringParam(adminBaseUrl, 'ADMIN_BASE_URL', ADMIN_BASE_URL_DEFAULT);
