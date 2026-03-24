import { HttpsError } from 'firebase-functions/v2/https';
import { SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE } from '@upperroom/shared/shared/soundcloudAuth';

type ErrorDetailsRecord = Record<string, unknown>;

export const createSoundCloudReconnectRequiredError = (message: string, details?: unknown): HttpsError =>
  new HttpsError('failed-precondition', message, {
    code: SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE,
    ...(typeof details !== 'undefined' ? { cause: details } : {}),
  });

export const isSoundCloudReconnectRequiredError = (error: unknown): boolean => {
  if (!(error instanceof HttpsError)) {
    return false;
  }

  const details = error.details;
  if (typeof details === 'string') {
    return details === SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE;
  }

  if (typeof details === 'object' && details !== null) {
    return (details as ErrorDetailsRecord).code === SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE;
  }

  return false;
};
