import { defineSecret } from 'firebase-functions/params';
import { runtimeAlertRecipientsSecret } from './notifications/notificationSecrets';
import { functionsSentryDsnSecret } from './sentry';

export const subsplashEmailSecret = defineSecret('SUBSPLASH_EMAIL');
export const subsplashPasswordSecret = defineSecret('SUBSPLASH_PASSWORD');

export const subsplashSecrets = [subsplashEmailSecret, subsplashPasswordSecret];
export const subsplashSecretsWithRuntimeAlerts = [
  ...subsplashSecrets,
  runtimeAlertRecipientsSecret,
  functionsSentryDsnSecret,
];
