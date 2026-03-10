type RequiredEnvVar = 'ROLE_REQUEST_RECIPIENTS' | 'RUNTIME_ALERT_RECIPIENTS' | 'ADMIN_BASE_URL';
const STAGING_PROJECT_ID = 'urm-app-staging';
const STAGING_ADMIN_BASE_URL = 'https://staging.uploader.upperroommedia.org';

export type AppEnv = {
  roleRequestRecipients: string[];
  runtimeAlertRecipients: string[];
  adminBaseUrl: string;
};

let cachedEnv: AppEnv | null = null;
let cachedRoleRequestRecipients: string[] | null = null;
let cachedRuntimeAlertRecipients: string[] | null = null;
let cachedAdminBaseUrl: string | null = null;

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const getProjectId = (): string =>
  process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || '';

const isStagingProject = (): boolean => getProjectId() === STAGING_PROJECT_ID;

const readRequiredEnvVar = (name: RequiredEnvVar): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    if (name === 'ADMIN_BASE_URL' && isStagingProject()) {
      return STAGING_ADMIN_BASE_URL;
    }
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

  cachedEnv = {
    roleRequestRecipients: getRoleRequestRecipientsEnv(),
    runtimeAlertRecipients: getRuntimeAlertRecipientsEnv(),
    adminBaseUrl: getAdminBaseUrlEnv(),
  };

  return cachedEnv;
};

export const getRoleRequestRecipientsEnv = (): string[] => {
  if (cachedRoleRequestRecipients) {
    return cachedRoleRequestRecipients;
  }

  const roleRecipientsRaw = readRequiredEnvVar('ROLE_REQUEST_RECIPIENTS');
  cachedRoleRequestRecipients = parseRecipientList(roleRecipientsRaw, 'ROLE_REQUEST_RECIPIENTS');
  return cachedRoleRequestRecipients;
};

export const getRuntimeAlertRecipientsEnv = (): string[] => {
  if (cachedRuntimeAlertRecipients) {
    return cachedRuntimeAlertRecipients;
  }

  const runtimeRecipientsRaw = readRequiredEnvVar('RUNTIME_ALERT_RECIPIENTS');
  cachedRuntimeAlertRecipients = parseRecipientList(runtimeRecipientsRaw, 'RUNTIME_ALERT_RECIPIENTS');
  return cachedRuntimeAlertRecipients;
};

export const getAdminBaseUrlEnv = (): string => {
  if (cachedAdminBaseUrl) {
    return cachedAdminBaseUrl;
  }

  const adminBaseUrlRaw = readRequiredEnvVar('ADMIN_BASE_URL');
  cachedAdminBaseUrl = trimTrailingSlash(adminBaseUrlRaw);
  return cachedAdminBaseUrl;
};
