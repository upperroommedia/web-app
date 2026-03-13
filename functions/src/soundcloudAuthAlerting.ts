import { HttpsError } from 'firebase-functions/v2/https';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';
import { isSoundCloudReconnectRequiredError } from './soundcloudAuthErrors';
import { SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE } from '../../shared/soundcloudAuth';

export const emitSoundCloudReconnectAlertIfNeeded = async (input: {
  error: unknown;
  alertCode: string;
  summary: string;
  context?: Record<string, unknown>;
}): Promise<boolean> => {
  if (!(input.error instanceof HttpsError) || !isSoundCloudReconnectRequiredError(input.error)) {
    return false;
  }

  await emitOperationalAlert({
    alertCode: input.alertCode,
    summary: input.summary,
    error: input.error,
    context: {
      ...(input.context ?? {}),
      soundCloudRecoveryCode: SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE,
    },
  });

  return true;
};
