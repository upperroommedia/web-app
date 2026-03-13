/**
 * SoundCloud secrets for Firebase callable functions.
 *
 * The runtime credential used by the SoundCloud API is an OAuth access token,
 * not the OAuth client secret. We keep a legacy fallback to
 * `SOUNDCLOUD_CLIENT_SECRET` so existing deployments continue to work while the
 * secret is renamed to the more accurate `SOUNDCLOUD_ACCESS_TOKEN`.
 */
import { defineSecret } from 'firebase-functions/params';
import { HttpsError } from 'firebase-functions/v2/https';
import { runtimeAlertRecipientsSecret } from './notifications/notificationSecrets';

const soundcloudAccessTokenSecret = defineSecret('SOUNDCLOUD_ACCESS_TOKEN');
const legacySoundcloudAccessTokenSecret = defineSecret('SOUNDCLOUD_CLIENT_SECRET');

const readSecretValue = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const getSoundCloudAccessToken = (): string => {
  const accessToken = readSecretValue(soundcloudAccessTokenSecret.value());
  if (accessToken) {
    return accessToken;
  }

  const legacyAccessToken = readSecretValue(legacySoundcloudAccessTokenSecret.value());
  if (legacyAccessToken) {
    return legacyAccessToken;
  }

  throw new HttpsError(
    'failed-precondition',
    'Missing SoundCloud credential. Set SOUNDCLOUD_ACCESS_TOKEN in Firebase Secret Manager. ' +
      'SOUNDCLOUD_CLIENT_SECRET is only a temporary legacy fallback.'
  );
};

export const soundcloudSecretsWithRuntimeAlerts = [
  soundcloudAccessTokenSecret,
  legacySoundcloudAccessTokenSecret,
  runtimeAlertRecipientsSecret,
];
