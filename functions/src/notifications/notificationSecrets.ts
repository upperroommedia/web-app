import { defineSecret } from 'firebase-functions/params';

export const adminRequestRecipientsSecret = defineSecret('ADMIN_REQUEST_RECIPIENTS');
export const runtimeAlertRecipientsSecret = defineSecret('RUNTIME_ALERT_RECIPIENTS');
export const adminBaseUrlSecret = defineSecret('ADMIN_BASE_URL');

export const adminBaseUrlSecretsWithRuntimeAlerts = [adminBaseUrlSecret, runtimeAlertRecipientsSecret];
export const adminRequestSecretsWithRuntimeAlerts = [
  adminRequestRecipientsSecret,
  runtimeAlertRecipientsSecret,
  adminBaseUrlSecret,
];
