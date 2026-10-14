import { logger } from 'firebase-functions/v2';
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import axios from './providerSandbox/http';
import { currentSandboxProfile } from './providerSandbox/http';
import { AxiosError, AxiosResponse, isAxiosError } from 'axios';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { ISpeaker } from '@upperroom/shared/types/Speaker';
import { ImageType } from '@upperroom/shared/types/Image';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import handleError from './handleError';
import { executeProviderCreate, providerReceiptId } from './temporal/publishing/providerReceipts';
import { reserveDurableProviderBindings } from './temporal/publishing/durableOperationContext';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { repairMismatchedSubsplashImageRefs } from './helpers/subsplashImageRefs';

export interface UPLOAD_TO_SUBSPLASH_INCOMING_DATA {
  operationKey: string;
  lockKey: string;
  title: string;
  subtitle: string;
  speakers: ISpeaker[];
  autoPublish: boolean;
  audioTitle: string;
  audioUrl: string;
  topics?: string[];
  description?: string;
  images: ImageType[];
  date: Date;
}

const createAudioRef = async (title: string, bearerToken: string): Promise<string> => {
  const data = { app_key: '9XTSHD', title: title };
  const axiosConfig = createAxiosConfig(' https://core.subsplash.com/files/v1/audios', bearerToken, 'POST', data);
  const id = (await axios({ ...axiosConfig, ...{ skipSubsplashEdgeRetry: true } })).data?.id;
  if (typeof id !== 'string' || !id.trim()) throw new Error('Missing audio ID');
  return id;
};

const transcodeAudio = async (audioSrc: string, audioId: string, bearerToken: string): Promise<AxiosResponse> => {
  const data = {
    app_key: '9XTSHD',
    file_name: audioSrc,
    _embedded: {
      audio: {
        id: audioId,
      },
      source: {
        id: '1c2eb938-c8a9-4be3-9ad9-6cded7e63b59',
      },
    },
  };
  const axiosConfig = createAxiosConfig('https://core.subsplash.com/transcoder/v1/jobs', bearerToken, 'POST', data);
  return await axios({ ...axiosConfig, ...{ skipSubsplashEdgeRetry: true } });
};

const isTransientUpstreamError = (error: unknown): error is AxiosError =>
  isAxiosError(error) &&
  typeof error.response?.status === 'number' &&
  error.response.status >= 500 &&
  error.response.status < 600;

const uploadToSubsplash = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<UPLOAD_TO_SUBSPLASH_INCOMING_DATA>): Promise<unknown> => {
    logger.log('uploadToSubsplash called');
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError(
        'unauthenticated',
        'The function must be called while authenticated with publish permissions.'
      );
    }
    if (
      !currentSandboxProfile() &&
      (process.env.SUBSPLASH_EMAIL == undefined || process.env.SUBSPLASH_PASSWORD == undefined)
    ) {
      throw new HttpsError('failed-precondition', 'SUBSPLASH_EMAIL or SUBSPLASH_PASSWORD is not set.');
    }

    if (
      !request.data ||
      typeof request.data.operationKey !== 'string' ||
      !request.data.operationKey.trim() ||
      typeof request.data.lockKey !== 'string' ||
      !request.data.lockKey.trim() ||
      (Array.isArray(request.data.speakers) && request.data.speakers.length > 3) ||
      (Array.isArray(request.data.topics) && request.data.topics.length > 10)
    )
      throw new HttpsError('invalid-argument', 'A valid publishing request is required.');
    const { default: admin } = await import('@upperroom/shared/firebase/firebaseAdmin');
    const { withLegacyAdmissionLease } = await import('./temporal/legacyAdmissionLease');
    const projectId = admin.app().options.projectId ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) throw new HttpsError('failed-precondition', 'Firebase project is not configured.');
    return withLegacyAdmissionLease(
      admin.firestore(),
      { domain: 'publishing', actorUid: request.auth!.uid, projectId, operation: 'uploadToSubsplash' },
      async (lease) => {
        await lease.markEffectsStarted();
        return uploadToSubsplashDomain(request.data);
      }
    );
  }
);

export interface SubsplashCreatedMedia {
  id: string;
  [key: string]: unknown;
}
/** Server-only callbacks: the callable transport never accepts or forwards these hooks. */
export interface TrustedSubsplashUploadCallbacks {
  readExistingMedia(): Promise<string | undefined>;
  beforeCreateMedia?(): Promise<void>;
  commitCreatedMedia(result: SubsplashCreatedMedia): Promise<void>;
}
export const uploadToSubsplashDomain = async (
  data: UPLOAD_TO_SUBSPLASH_INCOMING_DATA,
  options?: TrustedSubsplashUploadCallbacks
): Promise<unknown> => {
  if (!data || typeof data !== 'object') {
    throw new HttpsError('invalid-argument', 'Request data is required.');
  }
  if (!data.operationKey || !data.operationKey.trim()) {
    throw new HttpsError('invalid-argument', 'operationKey is required.');
  }
  if (!data.lockKey || !data.lockKey.trim()) {
    throw new HttpsError('invalid-argument', 'lockKey is required.');
  }
  const operationKey = data.operationKey.trim();
  const lockKey = data.lockKey.trim();
  try {
    return await withSubsplashLocks(
      [`media-item:${lockKey}`],
      async () => {
        const existingMediaId = await options?.readExistingMedia();
        if (existingMediaId) {
          if (typeof existingMediaId !== 'string' || !existingMediaId.trim())
            throw new HttpsError('failed-precondition', 'The canonical provider identity is invalid.');
          return { id: existingMediaId };
        }
        await options?.beforeCreateMedia?.();
        const bearerToken = await authenticateSubsplash();
        // create media item with title
        let tags: string[] = [];
        if (Array.isArray(data.speakers)) {
          if (data.speakers.length > 3) {
            throw new Error('Too many speakers: Max 3 speakers allowed');
          }
          tags = tags.concat(data.speakers.map((speaker) => `speaker:${speaker.name}`));
        }
        if (Array.isArray(data.topics)) {
          if (data.topics.length > 10) {
            throw new Error('Too many topics: Max 10 topics allowed');
          }
          tags = tags.concat(data.topics.map((topic: string) => `topic:${topic}`));
        }
        // Post the audio and retrieve the audio id
        const audioId = await executeProviderCreate({
          operationKey,
          step: 'subsplash-audio',
          payload: data,
          execute: () => createAudioRef(data.audioTitle, bearerToken),
        });
        logger.info(`Audio ID: ${audioId}`);
        // transcode the audio from a public url tagged to the audio id
        const transcodeResponse = await executeProviderCreate({
          operationKey,
          step: 'subsplash-transcode',
          payload: data,
          prepare: () =>
            reserveDurableProviderBindings(
              [{ provider: 'subsplash', account: 'app:9XTSHD', remoteId: audioId }],
              `${operationKey}:transcode-audio`,
              { targetReceiptId: providerReceiptId(operationKey, 'subsplash-transcode') }
            ),
          execute: async () => (await transcodeAudio(data.audioUrl, audioId, bearerToken)).data,
        });
        logger.info(`Transcode Statues: ${transcodeResponse.status}`);
        // uploadToSubsplash with the audio id
        const repairedImages = await repairMismatchedSubsplashImageRefs(data.images, bearerToken, operationKey);

        const requestData = JSON.stringify({
          app_key: '9XTSHD',
          scriptures: [],
          tags: tags,
          title: data.title,
          subtitle: data.subtitle,
          summary: data.description,
          date: data.date,
          auto_publish: data.autoPublish ?? false,
          _embedded: {
            images: repairedImages
              .map((image) => {
                const remoteImageId = image.subsplashId || image.id;
                if (!remoteImageId) {
                  return undefined;
                }

                return {
                  id: remoteImageId,
                  type: image.type,
                };
              })
              .filter((image): image is { id: string; type: ImageType['type'] } => image !== undefined),
            audio: { id: audioId },
          },
        });
        const config = createAxiosConfig(
          'https://core.subsplash.com/media/v1/media-items',
          bearerToken,
          'POST',
          requestData
        );
        const result = await executeProviderCreate<SubsplashCreatedMedia>({
          operationKey,
          step: 'subsplash-media-item',
          payload: data,
          prepare: () =>
            reserveDurableProviderBindings(
              [
                { provider: 'subsplash', account: 'app:9XTSHD', remoteId: audioId },
                ...repairedImages
                  .map((image) => image.subsplashId || image.id)
                  .filter((id): id is string => typeof id === 'string' && !!id)
                  .map((remoteId) => ({ provider: 'subsplash' as const, account: 'app:9XTSHD', remoteId })),
              ],
              `${operationKey}:media-resources`,
              { targetReceiptId: providerReceiptId(operationKey, 'subsplash-media-item') }
            ),
          execute: async () => {
            const result = (await axios({ ...config, ...{ skipSubsplashEdgeRetry: true } })).data;
            if (typeof result?.id !== 'string' || !result.id.trim()) throw new Error('Missing media item ID');
            return result;
          },
        });
        // Publish the confirmed remote identity before releasing the shared sermon lock.
        await options?.commitCreatedMedia(result);
        return result;
      },
      { operationKey }
    );
  } catch (error) {
    if (isTransientUpstreamError(error)) {
      logger.warn('uploadToSubsplash transient upstream failure', {
        status: error.response?.status,
        operationKey,
        lockKey,
      });
      throw handleError(error, {
        suppressReporting: true,
        context: {
          functionName: 'uploadToSubsplash',
          operationKey,
          lockKey,
        },
      });
    }

    logger.error('uploadToSubsplash failed', {
      operationKey,
      lockKey,
      status: isAxiosError(error) ? error.response?.status : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    await emitOperationalAlert({
      alertCode: 'PUBLISH_SUBSPLASH_UPLOAD_RUNTIME_FAILURE',
      summary: 'uploadToSubsplash callable failed during publish upload flow.',
      error,
      context: {
        functionName: 'uploadToSubsplash',
        operationKey,
        lockKey,
      },
    });
    throw handleError(error);
  }
};

export default uploadToSubsplash;
