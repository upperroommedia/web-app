import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';
import { isSoundCloudReconnectRequiredError } from './soundcloudAuthErrors';
import { SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE } from '@upperroom/shared/shared/soundcloudAuth';

const reconnectAlertIds = new WeakMap<HttpsError, string>();

export const bindSoundCloudReconnectAlert = (error: HttpsError, incidentId: string): void => {
  reconnectAlertIds.set(error, incidentId);
};

export const emitSoundCloudReconnectAlertIfNeeded = async (input: {
  error: unknown;
  alertCode: string;
  summary: string;
  context?: Record<string, unknown>;
}): Promise<boolean> => {
  if (!(input.error instanceof HttpsError) || !isSoundCloudReconnectRequiredError(input.error)) {
    return false;
  }

  const details = input.error.details;
  if (details && typeof details === 'object' && 'alertHandled' in details && details.alertHandled === true) return true;

  const incidentId = reconnectAlertIds.get(input.error);
  try {
    await emitOperationalAlert({
      alertCode: input.alertCode,
      summary: input.summary,
      error: input.error,
      context: {
        ...(input.context ?? {}),
        soundCloudRecoveryCode: SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE,
      },
      ...(incidentId ? { idempotencyKey: `soundcloud-reconnect:${incidentId}` } : {}),
    });
    return true;
  } catch {
    logger.warn('SoundCloud reconnect alert could not be queued');
    return false;
  }
};
