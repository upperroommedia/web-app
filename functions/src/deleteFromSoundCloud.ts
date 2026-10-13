import handleError from './handleError';
import { deleteTrack, normalizeSoundCloudApiError } from './soundcloudClient';
import { runWithSoundCloudAccessToken, soundcloudSecretsWithRuntimeAlerts } from './soundcloudSecrets';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';
import { isAxiosError } from 'axios';
import { emitSoundCloudReconnectAlertIfNeeded } from './soundcloudAuthAlerting';
import { startFunctionsSpan } from './sentry';

export interface DeleteFromSoundCloudInputType {
  soundCloudTrackId: string;
}

export type DeleteFromSoundCloudReturnType = void;

export const deleteFromSoundCloudDomain = async (
  request: Pick<CallableRequest<DeleteFromSoundCloudInputType>, 'data' | 'auth'>
): Promise<DeleteFromSoundCloudReturnType> => {
  if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  logger.log('deleteFromSoundCloud.start', {
    soundCloudTrackId: request.data.soundCloudTrackId,
  });
  try {
    await startFunctionsSpan(
      {
        name: 'deleteFromSoundCloud',
        op: 'soundcloud.delete',
      },
      () => runWithSoundCloudAccessToken((token) => deleteTrack(token, request.data.soundCloudTrackId))
    );
    logger.log('deleteFromSoundCloud.success', {
      soundCloudTrackId: request.data.soundCloudTrackId,
    });
  } catch (error) {
    if (error instanceof HttpsError) {
      await emitSoundCloudReconnectAlertIfNeeded({
        error,
        alertCode: 'PUBLISH_SOUNDCLOUD_DELETE_RUNTIME_FAILURE',
        summary: 'deleteFromSoundCloud callable requires SoundCloud re-authorization.',
        context: {
          functionName: 'deleteFromSoundCloud',
          soundCloudTrackId: request.data.soundCloudTrackId,
        },
      });
      throw error;
    }

    if (isAxiosError(error) && error.response?.status === 404) {
      logger.warn('deleteFromSoundCloud.notFound', {
        soundCloudTrackId: request.data.soundCloudTrackId,
      });
      return;
    }

    let normalizedError: unknown = error;
    try {
      normalizeSoundCloudApiError(error);
    } catch (caughtError) {
      normalizedError = caughtError;
    }

    logger.error(normalizedError);
    try {
      await emitOperationalAlert({
        alertCode: 'PUBLISH_SOUNDCLOUD_DELETE_RUNTIME_FAILURE',
        summary: 'deleteFromSoundCloud callable failed during publish delete flow.',
        error: normalizedError,
        context: {
          functionName: 'deleteFromSoundCloud',
          soundCloudTrackId: request.data.soundCloudTrackId,
        },
      });
    } catch (alertError) {
      logger.error('Failed to emit operational alert for deleteFromSoundCloud', {
        soundCloudTrackId: request.data.soundCloudTrackId,
        alertError,
      });
    }
    throw handleError(normalizedError);
  }
};

const deleteFromSoundCloud = onCall(
  { secrets: soundcloudSecretsWithRuntimeAlerts },
  async (request: CallableRequest<DeleteFromSoundCloudInputType>) => {
    if (!canUserRolePublish(request.auth?.token.role)) return deleteFromSoundCloudDomain(request);
    if (!request.data || typeof request.data.soundCloudTrackId !== 'string' || !request.data.soundCloudTrackId.trim()) throw new HttpsError('invalid-argument', 'A valid publishing request is required.');
    const { default: admin } = await import('@upperroom/shared/firebase/firebaseAdmin');
    const { withLegacyAdmissionLease } = await import('./temporal/legacyAdmissionLease');
    const projectId = admin.app().options.projectId ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) throw new HttpsError('failed-precondition', 'Firebase project is not configured.');
    return withLegacyAdmissionLease(admin.firestore(), { domain: 'publishing', actorUid: request.auth!.uid, projectId, operation: 'deleteFromSoundCloud' }, async lease => {
      await lease.markEffectsStarted();
      return deleteFromSoundCloudDomain(request);
    });
  }
);

export default deleteFromSoundCloud;
