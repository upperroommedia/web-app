import { defineSecret } from 'firebase-functions/params';
import { functionsSentryDsnSecret } from '../sentry';

export const adminRequestRecipientsSecret = defineSecret('ADMIN_REQUEST_RECIPIENTS');
export const runtimeAlertRecipientsSecret = defineSecret('RUNTIME_ALERT_RECIPIENTS');
export const adminBaseUrlSecret = defineSecret('ADMIN_BASE_URL');

export const adminBaseUrlSecretsWithRuntimeAlerts = [
  adminBaseUrlSecret,
  runtimeAlertRecipientsSecret,
  functionsSentryDsnSecret,
];
export const adminRequestSecretsWithRuntimeAlerts = [
  adminRequestRecipientsSecret,
  runtimeAlertRecipientsSecret,
  adminBaseUrlSecret,
  functionsSentryDsnSecret,
];
