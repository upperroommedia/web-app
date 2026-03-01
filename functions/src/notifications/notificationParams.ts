import { defineList, defineString } from 'firebase-functions/params';

const normalizeRecipientList = (rawRecipients: readonly string[]): string[] => {
  const cleaned = rawRecipients.map((recipient) => recipient.trim()).filter((recipient) => recipient.length > 0);
  return Array.from(new Set(cleaned));
};

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

export const roleRequestRecipients = defineList('ROLE_REQUEST_RECIPIENTS', {
  default: ['youssef.a.asaad@gmail.com', 'contact@upperroommedia.org'],
  description: 'Recipients for role-request notifications. Production defaults are required by policy.',
});

export const runtimeAlertRecipients = defineList('RUNTIME_ALERT_RECIPIENTS', {
  default: ['youssef.a.asaad@gmail.com', 'contact@upperroommedia.org'],
  description: 'Recipients for runtime operational alerts. Alerts are emitted for every caught occurrence.',
});

export const adminBaseUrl = defineString('ADMIN_BASE_URL', {
  default: 'https://www.upperroommedia.org',
  description: 'Base URL used for admin links in operational notifications.',
});

export const getRoleRequestRecipients = (): string[] => normalizeRecipientList(roleRequestRecipients.value());

export const getRuntimeAlertRecipients = (): string[] => normalizeRecipientList(runtimeAlertRecipients.value());

export const getAdminBaseUrl = (): string => trimTrailingSlash(adminBaseUrl.value());
