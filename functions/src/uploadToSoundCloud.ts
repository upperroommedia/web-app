import handleError from './handleError';
import { randomUUID } from 'node:crypto';
import { executeProviderCreate } from './temporal/publishing/providerReceipts';
import {
  normalizeSoundCloudApiError,
  prepareMultipartUpload,
  PreparedSoundCloudUpload,
  getAuthenticatedSoundCloudAccountId,
} from './soundcloudClient';
import { runWithSoundCloudAccessToken, soundcloudSecretsWithRuntimeAlerts } from './soundcloudSecrets';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { AxiosError, isAxiosError } from 'axios';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';
import { emitSoundCloudReconnectAlertIfNeeded } from './soundcloudAuthAlerting';
import { startFunctionsSpan } from './sentry';

export interface UploadToSoundCloudInputType {
  operationKey?: string;
  audioStoragePath: string;
  title: string;
  speakers: string[];
  tags: string[];
  description: string;
  imageSource?: string;
  imageStoragePath?: string;
  providerMetadata?: Record<string, string | boolean | number>;
}

export type UploadToSoundCloudReturnType = {
  soundCloudTrackId: string;
  soundCloudTrackUrl?: string;
};

const isTransientUpstreamError = (error: unknown): error is AxiosError =>
  isAxiosError(error) &&
  typeof error.response?.status === 'number' &&
  error.response.status >= 500 &&
  error.response.status < 600;

const uploadToSoundCloudCall = onCall(
  {
    // Production OOMs occurred at 258-272 MiB while streaming multipart uploads.
    memory: '512MiB',
    timeoutSeconds: 540,
    secrets: soundcloudSecretsWithRuntimeAlerts,
  },
  async (request: CallableRequest<UploadToSoundCloudInputType>): Promise<UploadToSoundCloudReturnType> => {
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    if (
      !request.data ||
      typeof request.data.audioStoragePath !== 'string' ||
      !request.data.audioStoragePath.trim() ||
      typeof request.data.title !== 'string' ||
      !Array.isArray(request.data.speakers) ||
      !Array.isArray(request.data.tags)
    )
      throw new HttpsError('invalid-argument', 'A valid publishing request is required.');
    const { default: admin } = await import('@upperroom/shared/firebase/firebaseAdmin');
    const { withLegacyAdmissionLease } = await import('./temporal/legacyAdmissionLease');
    const projectId = admin.app().options.projectId ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) throw new HttpsError('failed-precondition', 'Firebase project is not configured.');
    return withLegacyAdmissionLease(
      admin.firestore(),
      { domain: 'publishing', actorUid: request.auth!.uid, projectId, operation: 'uploadToSoundCloud' },
      async (lease) => {
        await lease.markEffectsStarted();
        return uploadToSoundCloudDomain(request.data);
      }
    );
  }
);

export const uploadToSoundCloudDomain = async (
  data: UploadToSoundCloudInputType,
  trustedOptions: {expectedProviderAccount?:string} = {}
): Promise<UploadToSoundCloudReturnType> => {
  const bucket = firebaseAdmin.storage().bucket();
  logger.log('uploadToSoundCloud.start', {
    audioStoragePath: data.audioStoragePath,
    hasImageSource: Boolean(data.imageSource ?? data.imageStoragePath),
    speakerCount: data.speakers.length,
    tagCount: data.tags.length,
    titleLength: data.title.length,
  });
  try {
    const uploadResult = await startFunctionsSpan(
      {
        name: 'uploadToSoundCloud',
        op: 'soundcloud.upload',
        attributes: {
          hasImageSource: Boolean(data.imageSource ?? data.imageStoragePath),
          speakerCount: data.speakers.length,
          tagCount: data.tags.length,
        },
      },
      () =>
        runWithSoundCloudAccessToken(async (token) => {
          let prepared: PreparedSoundCloudUpload | undefined;
          let originalAccount: string | undefined;
          try {
            return await executeProviderCreate({
              operationKey: data.operationKey?.trim() || `soundcloud-legacy:${randomUUID()}`,
              step: 'soundcloud-track',
              payload: data,
              prepare: async () => {
                originalAccount = await getAuthenticatedSoundCloudAccountId(token);
                if(trustedOptions.expectedProviderAccount && originalAccount!==trustedOptions.expectedProviderAccount)throw Object.assign(new Error('Original SoundCloud account changed'),{code:'PUBLISHING_PROVIDER_REPAIR_REQUIRED'});
                prepared = await prepareMultipartUpload({
                  bucket,
                  audioStoragePath: data.audioStoragePath,
                  imageSource: data.imageSource ?? data.imageStoragePath,
                  title: data.title,
                  tags: data.tags,
                  description: data.description,
                  ...(data.providerMetadata ? { providerMetadata: data.providerMetadata } : {}),
                });
              },
              getProviderAccount: () =>
                originalAccount ? { provider: 'soundcloud', account: originalAccount } : undefined,
              execute: () => {
                if (!prepared) throw new Error('SoundCloud upload preparation was not completed.');
                return prepared.post(token);
              },
            });
          } finally {
            prepared?.dispose();
          }
        })
    );
    const soundCloudTrackId = uploadResult.trackIdentifier;
    logger.log('uploadToSoundCloud.success', {
      audioStoragePath: data.audioStoragePath,
      soundCloudTrackId,
    });
    return {
      soundCloudTrackId,
      ...(uploadResult.permalinkUrl ? { soundCloudTrackUrl: uploadResult.permalinkUrl } : {}),
    };
  } catch (error) {
    if (error instanceof HttpsError) {
      await emitSoundCloudReconnectAlertIfNeeded({
        error,
        alertCode: 'PUBLISH_SOUNDCLOUD_UPLOAD_RUNTIME_FAILURE',
        summary: 'uploadToSoundCloud callable requires SoundCloud re-authorization.',
        context: {
          functionName: 'uploadToSoundCloud',
          audioStoragePath: data.audioStoragePath,
        },
      });
      throw error;
    }

    if (isTransientUpstreamError(error)) {
      logger.warn('uploadToSoundCloud transient upstream failure', {
        status: error.response?.status,
        audioStoragePath: data.audioStoragePath,
      });
      throw handleError(error, {
        suppressReporting: true,
        context: {
          functionName: 'uploadToSoundCloud',
          audioStoragePath: data.audioStoragePath,
        },
      });
    }

    await emitOperationalAlert({
      alertCode: 'PUBLISH_SOUNDCLOUD_UPLOAD_RUNTIME_FAILURE',
      summary: 'uploadToSoundCloud callable failed during publish upload flow.',
      error: (() => {
        try {
          normalizeSoundCloudApiError(error);
        } catch (normalizedError) {
          return normalizedError;
        }
        return error;
      })(),
      context: {
        functionName: 'uploadToSoundCloud',
        audioStoragePath: data.audioStoragePath,
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

export default uploadToSoundCloudCall;
