import {runPublishingProviderMutation,markPublishingCritical,isDurablePublishingOperation} from './temporal/publishing/durableOperationContext';
import handleError from './handleError';
import { isSoundCloudTrackNotFoundError, normalizeSoundCloudApiError, updateTrack } from './soundcloudClient';
import { runWithSoundCloudAccessToken, soundcloudSecretsWithRuntimeAlerts } from './soundcloudSecrets';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { UploadToSoundCloudInputType } from './uploadToSoundCloud';
import { logger } from 'firebase-functions/v2';
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';
import { emitSoundCloudReconnectAlertIfNeeded } from './soundcloudAuthAlerting';
import { startFunctionsSpan } from './sentry';

export interface EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA
  extends Partial<Omit<UploadToSoundCloudInputType, 'audioStoragePath'>> {
  trackId: string;
}

export interface EditSoundCloudSermonReturnType {
  soundCloudTrackUrl?: string;
  soundCloudTrackMissing?: boolean;
}

export const editSoundCloudSermonDomain = async (
  request: Pick<CallableRequest<EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA>, 'data' | 'auth'>,
  trustedOptions:{providerMutationOperation?:string;accessToken?:string;providerAccount?:string}={}
): Promise<EditSoundCloudSermonReturnType> => {
  if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('permission-denied', 'You do not have the correct permissions for this action.');
  }
  const data = request.data;
  const imageSource = data.imageSource ?? data.imageStoragePath;
  const bucket = imageSource ? firebaseAdmin.storage().bucket() : undefined;
  logger.log('editSoundCloudSermon.start', {
    trackId: data.trackId,
    hasImageSource: Boolean(imageSource),
    hasTitle: typeof data.title === 'string',
    hasDescription: typeof data.description === 'string',
    hasTags: Array.isArray(data.tags) && data.tags.length > 0,
  });
  try {
    const updateResult = await startFunctionsSpan(
      {
        name: 'editSoundCloudSermon',
        op: 'soundcloud.update',
        attributes: {
          hasImageSource: Boolean(imageSource),
          hasTitle: typeof data.title === 'string',
          hasDescription: typeof data.description === 'string',
          hasTags: Array.isArray(data.tags) && data.tags.length > 0,
        },
      },
      async () => {
        if(isDurablePublishingOperation()&&(!trustedOptions.providerMutationOperation||!trustedOptions.accessToken||!trustedOptions.providerAccount))throw new Error('PROVIDER_MUTATION_PLAN_CONTEXT_REQUIRED');
        const send=async(token:string)=>updateTrack(token,data.trackId,{
            ...(data.title != null && { title: data.title }),
            ...(data.description != null && { description: data.description }),
            ...(data.tags != null && { tags: data.tags }),
            ...(imageSource != null &&
              bucket != null && {
                imageSource,
                bucket,
              }),
          });
        if(trustedOptions.providerMutationOperation){
          await markPublishingCritical('PUBLISHING_METADATA_CRITICAL',{provider:'soundcloud',resourceType:'track',resourceId:data.trackId,accountId:trustedOptions.providerAccount!,method:'PUT'});
          return runPublishingProviderMutation({operation:trustedOptions.providerMutationOperation,target:{provider:'soundcloud',account:trustedOptions.providerAccount!,resourceType:'track',resourceId:data.trackId},step:'soundcloud-metadata',method:'PUT',payload:data,send:async()=>({completion:'acknowledged',result:(await send(trustedOptions.accessToken!))??{trackIdentifier:data.trackId}})});
        }
        return runWithSoundCloudAccessToken(send);
      }
    );
    logger.log('editSoundCloudSermon.success', {
      trackId: data.trackId,
    });
    return {
      ...(updateResult?.permalinkUrl ? { soundCloudTrackUrl: updateResult.permalinkUrl } : {}),
    };
  } catch (error) {
    if (isSoundCloudTrackNotFoundError(error)) {
      logger.warn('editSoundCloudSermon.trackMissing', {
        trackId: data.trackId,
      });
      return {
        soundCloudTrackMissing: true,
      };
    }

    if (error instanceof HttpsError) {
      await emitSoundCloudReconnectAlertIfNeeded({
        error,
        alertCode: 'PUBLISH_SOUNDCLOUD_EDIT_RUNTIME_FAILURE',
        summary: 'editSoundCloudSermon callable requires SoundCloud re-authorization.',
        context: {
          functionName: 'editSoundCloudSermon',
          trackId: data.trackId,
        },
      });
      throw error;
    }

    await emitOperationalAlert({
      alertCode: 'PUBLISH_SOUNDCLOUD_EDIT_RUNTIME_FAILURE',
      summary: 'editSoundCloudSermon callable failed during publish edit flow.',
      error: (() => {
        try {
          normalizeSoundCloudApiError(error);
        } catch (normalizedError) {
          return normalizedError;
        }
        return error;
      })(),
      context: {
        functionName: 'editSoundCloudSermon',
        trackId: data.trackId,
      },
    });
    try {
      normalizeSoundCloudApiError(error);
    } catch (normalizedError) {
      throw handleError(normalizedError);
    }
    throw handleError(error);
  }
};

const editOnSoundCloud = onCall(
  { secrets: soundcloudSecretsWithRuntimeAlerts },
  async (request: CallableRequest<EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA>) => {
    if (!canUserRolePublish(request.auth?.token.role)) return editSoundCloudSermonDomain(request);
    if (!request.data || typeof request.data.trackId !== 'string' || !request.data.trackId.trim()) throw new HttpsError('invalid-argument', 'A valid publishing request is required.');
    const { default: admin } = await import('@upperroom/shared/firebase/firebaseAdmin');
    const { withLegacyAdmissionLease } = await import('./temporal/legacyAdmissionLease');
    const projectId = admin.app().options.projectId ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) throw new HttpsError('failed-precondition', 'Firebase project is not configured.');
    return withLegacyAdmissionLease(admin.firestore(), { domain: 'publishing', actorUid: request.auth!.uid, projectId, operation: 'editSoundCloudSermon' }, async lease => {
      await lease.markEffectsStarted();
      return editSoundCloudSermonDomain(request);
    });
  }
);

export default editOnSoundCloud;
