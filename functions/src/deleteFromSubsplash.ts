import {assertSynchronousProviderMutationCompleted} from './temporal/publishing/providerMutationCompletion';
import axios, { isAxiosError } from 'axios';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, FunctionsErrorCode, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import handleError from './handleError';
import { withIdempotency } from './locks/withIdempotency';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';

export interface DeleteFromSubsplashInputType {
  operationKey: string;
  subsplashId: string;
}

export type DeleteFromSubsplashReturnType = void;

export const deleteFromSubsplashDomain = async (
  request: Pick<CallableRequest<DeleteFromSubsplashInputType>, 'data' | 'auth'>,
  trustedOptions?: {bearerToken?:string;onResponse?:(response:{status:number})=>void}
): Promise<DeleteFromSubsplashReturnType> => {
  logger.info('deleteFromSubsplash.start', { mediaItemId: request.data?.subsplashId });

  // Authentication check
  if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }

  // Input validation
  if (!request.data || typeof request.data !== 'object' || !request.data.subsplashId || request.data.subsplashId.trim() === '') {
    throw new HttpsError('invalid-argument', 'The function must be called with a valid media item ID.');
  }
  if (!request.data.operationKey || request.data.operationKey.trim() === '') {
    throw new HttpsError('invalid-argument', 'operationKey is required.');
  }

  // Environment validation
  if (process.env.SUBSPLASH_EMAIL == undefined || process.env.SUBSPLASH_PASSWORD == undefined) {
    throw new HttpsError('failed-precondition', 'SUBSPLASH_EMAIL or SUBSPLASH_PASSWORD is not set.');
  }

  const mediaItemId = request.data.subsplashId.trim();
  const operationKey = request.data.operationKey.trim();
  console.log('Attempting to delete mediaItemId', mediaItemId);
  const url = `https://core.subsplash.com/media/v1/media-items/${mediaItemId}`;
  logger.log(`Attempting to delete media item: ${mediaItemId} from "${url}"`);

  try {
    return await withIdempotency(operationKey, async () =>
      withSubsplashLocks(
        [`media-item:${mediaItemId}`],
        async () => {
          const bearerToken = trustedOptions?.bearerToken ?? await authenticateSubsplash();
          const config = createAxiosConfig(url, bearerToken, 'DELETE');
          logger.debug('deleteFromSubsplash.request', { mediaItemId });

          const response = await axios(config);
          assertSynchronousProviderMutationCompleted(response);
          trustedOptions?.onResponse?.({status:response.status});
          logger.log('Successfully deleted media item', { mediaItemId, status: response.status });
          return;
        },
        { operationKey }
      )
    );
  } catch (error) {
    logger.error('Error deleting from Subsplash', { mediaItemId, status: isAxiosError(error) ? error.response?.status : undefined });

    // Idempotency: deleting an already-deleted media item should succeed.
    if (isAxiosError(error) && [404,410].includes(error.response?.status ?? 0)) {
      trustedOptions?.onResponse?.({status:error.response!.status});
      logger.warn(`Media item not found (already deleted): ${mediaItemId}`);
      return;
    }

    try {
      await emitOperationalAlert({
        alertCode: 'PUBLISH_SUBSPLASH_DELETE_RUNTIME_FAILURE',
        summary: 'deleteFromSubsplash callable failed during publish delete flow.',
        error,
        context: {
          functionName: 'deleteFromSubsplash',
          operationKey,
          subsplashId: mediaItemId,
        },
      });
    } catch (alertError) {
      logger.error('Failed to emit operational alert for deleteFromSubsplash', {
        mediaItemId,
        alertError,
      });
    }

    // Handle specific Subsplash API errors
    if (isAxiosError(error) && error.response?.data?.errors) {
      const subsplashError = error.response.data.errors[0];
      let code: FunctionsErrorCode = 'internal';

      if (subsplashError?.code === 'resource_not_found') {
        code = 'not-found';
        logger.warn(`Media item not found: ${mediaItemId}`);
      } else if (subsplashError?.code === 'unauthorized') {
        code = 'unauthenticated';
      } else if (subsplashError?.code === 'forbidden') {
        code = 'permission-denied';
      }

      const httpsError = new HttpsError(
        code,
        subsplashError?.detail || error.message || 'Failed to delete from Subsplash',
        subsplashError
      );
      throw httpsError;
    }

    // Use the standard error handler for all other errors
    throw handleError(error);
  }
};

const deleteFromSubsplash = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<DeleteFromSubsplashInputType>) => {
    if (!canUserRolePublish(request.auth?.token.role)) return deleteFromSubsplashDomain(request);
    if (!request.data || typeof request.data.operationKey !== 'string' || !request.data.operationKey.trim() || typeof request.data.subsplashId !== 'string' || !request.data.subsplashId.trim()) throw new HttpsError('invalid-argument', 'A valid publishing request is required.');
    const { default: admin } = await import('@upperroom/shared/firebase/firebaseAdmin');
    const { withLegacyAdmissionLease } = await import('./temporal/legacyAdmissionLease');
    const projectId = admin.app().options.projectId ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) throw new HttpsError('failed-precondition', 'Firebase project is not configured.');
    return withLegacyAdmissionLease(admin.firestore(), { domain: 'publishing', actorUid: request.auth!.uid, projectId, operation: 'deleteFromSubsplash' }, async lease => {
      await lease.markEffectsStarted();
      return deleteFromSubsplashDomain(request);
    });
  }
);

export default deleteFromSubsplash;
