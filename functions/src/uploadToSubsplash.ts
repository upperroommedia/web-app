import { logger } from 'firebase-functions/v2';
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import axios, { AxiosResponse } from 'axios';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { ISpeaker } from '@upperroom/shared/types/Speaker';
import { ImageType } from '@upperroom/shared/types/Image';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import handleError from './handleError';
import { withIdempotency } from './locks/withIdempotency';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';

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
  return (await axios(axiosConfig)).data.id;
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
  return await axios(axiosConfig);
};

const uploadToSubsplash = onCall({ secrets: subsplashSecretsWithRuntimeAlerts }, async (request: CallableRequest<UPLOAD_TO_SUBSPLASH_INCOMING_DATA>): Promise<unknown> => {
  logger.log('uploadToSubsplash called');
  if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated with publish permissions.');
  }
  if (process.env.SUBSPLASH_EMAIL == undefined || process.env.SUBSPLASH_PASSWORD == undefined) {
    throw new HttpsError('failed-precondition', 'SUBSPLASH_EMAIL or SUBSPLASH_PASSWORD is not set.');
  }

  const data = request.data;
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
  logger.log('data', data);
  try {
    return await withIdempotency(operationKey, async () =>
      withSubsplashLocks(
        [`media-item:${lockKey}`],
        async () => {
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
          const audioId = await createAudioRef(data.audioTitle, bearerToken);
          logger.info(`Audio ID: ${audioId}`);
          // transcode the audio from a public url tagged to the audio id
          const transcodeResponse = await transcodeAudio(data.audioUrl, audioId, bearerToken);
          logger.info(`Transcode Statues: ${transcodeResponse.data.status}`);
          // uploadToSubsplash with the audio id

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
              images: data.images.map((image) => {
                if (image.subsplashId) {
                  return {
                    id: image.subsplashId,
                    type: image.type,
                  };
                }
                return;
              }),
              audio: { id: audioId },
            },
          });
          logger.log('request data', requestData);
          const config = createAxiosConfig(
            'https://core.subsplash.com/media/v1/media-items',
            bearerToken,
            'POST',
            requestData
          );
          return (await axios(config)).data;
        },
        { operationKey }
      )
    );
  } catch (error) {
    logger.error(error);
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
});

export default uploadToSubsplash;
