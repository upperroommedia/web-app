/**
 * SoundCloud secrets for Firebase Callable functions.
 * Create SOUNDCLOUD_CLIENT_SECRET in Firebase Secret Manager (or Google Cloud Secret Manager).
 * Obtain the token via a one-time SoundCloud OAuth Authorization Code flow.
 */
import { defineSecret } from 'firebase-functions/params';
import { runtimeAlertRecipientsSecret } from './notifications/notificationSecrets';

export const soundcloudAccessToken = defineSecret('SOUNDCLOUD_CLIENT_SECRET');
export const soundcloudSecretsWithRuntimeAlerts = [soundcloudAccessToken, runtimeAlertRecipientsSecret];
