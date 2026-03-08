type RequiredEnvVar = 'ROLE_REQUEST_RECIPIENTS' | 'RUNTIME_ALERT_RECIPIENTS' | 'ADMIN_BASE_URL';

export type AppEnv = {
  roleRequestRecipients: string[];
  runtimeAlertRecipients: string[];
  adminBaseUrl: string;
};

let cachedEnv: AppEnv | null = null;

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const readRequiredEnvVar = (name: RequiredEnvVar): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `[env] Missing required environment variable: ${name}. ` +
        'Run `pnpm run setup:env` and then update `.env` with real values.'
    );
  }

  return value;
};

const parseRecipientList = (rawValue: string, name: RequiredEnvVar): string[] => {
  const normalize = (values: string[]): string[] =>
    Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));

  try {
    const parsed = JSON.parse(rawValue);
    if (Array.isArray(parsed)) {
      const recipients = normalize(parsed.filter((entry): entry is string => typeof entry === 'string'));
      if (recipients.length > 0) {
        return recipients;
      }
    }
  } catch {
    // Fall back to comma-delimited parsing.
  }

  const recipients = normalize(rawValue.split(','));
  if (recipients.length === 0) {
    throw new Error(`[env] ${name} must contain at least one recipient (comma-delimited or JSON array).`);
  }

  return recipients;
};

export const getEnv = (): AppEnv => {
  if (cachedEnv) {
    return cachedEnv;
  }

  const roleRecipientsRaw = readRequiredEnvVar('ROLE_REQUEST_RECIPIENTS');
  const runtimeRecipientsRaw = readRequiredEnvVar('RUNTIME_ALERT_RECIPIENTS');
  const adminBaseUrlRaw = readRequiredEnvVar('ADMIN_BASE_URL');

  cachedEnv = {
    roleRequestRecipients: parseRecipientList(roleRecipientsRaw, 'ROLE_REQUEST_RECIPIENTS'),
    runtimeAlertRecipients: parseRecipientList(runtimeRecipientsRaw, 'RUNTIME_ALERT_RECIPIENTS'),
    adminBaseUrl: trimTrailingSlash(adminBaseUrlRaw),
  };

  return cachedEnv;
};
