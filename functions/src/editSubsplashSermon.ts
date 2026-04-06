import { logger } from 'firebase-functions/v2';
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import axios from 'axios';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from './uploadToSubsplash';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { ImageType } from '@upperroom/shared/types/Image';
import handleError from './handleError';
import { withIdempotency } from './locks/withIdempotency';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { emitOperationalAlert } from './notifications/emitOperationalAlert';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { repairMismatchedSubsplashImageRefs } from './helpers/subsplashImageRefs';

export interface EDIT_SUBSPLASH_SERMON_INCOMING_DATA
  extends Partial<Omit<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, 'audioUrl' | 'autoPublish'>> {
  operationKey: string;
  subsplashId: string;
}

const editSubsplashSermon = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<EDIT_SUBSPLASH_SERMON_INCOMING_DATA>): Promise<unknown> => {
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
    if (!data.subsplashId || !data.subsplashId.trim()) {
      throw new HttpsError('invalid-argument', 'subsplashId is required.');
    }
    const operationKey = data.operationKey.trim();
    const subsplashId = data.subsplashId.trim();
    logger.log('data', data);
    try {
      return await withIdempotency(operationKey, async () =>
        withSubsplashLocks(
          [`media-item:${subsplashId}`],
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

            const repairedImages = Array.isArray(data.images)
              ? await repairMismatchedSubsplashImageRefs(data.images, bearerToken)
              : undefined;
            const validImages = Array.isArray(repairedImages)
              ? repairedImages
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
                  .filter((image): image is { id: string; type: ImageType['type'] } => image !== undefined)
              : undefined;

            // only send non null values to subsplash
            const requestData = JSON.stringify({
              app_key: '9XTSHD',
              ...(Array.isArray(data.speakers) || Array.isArray(data.topics) ? { tags } : {}),
              ...(typeof data.title === 'string' ? { title: data.title } : {}),
              ...(typeof data.subtitle === 'string' ? { subtitle: data.subtitle } : {}),
              ...(typeof data.description === 'string' ? { summary: data.description } : {}),
              ...(data.date && { date: data.date }),
              ...(validImages && {
                _embedded: {
                  images: validImages,
                },
              }),
            });
            logger.log('request data', requestData);
            const config = createAxiosConfig(
              `https://core.subsplash.com/media/v1/media-items/${subsplashId}`,
              bearerToken,
              'PATCH',
              requestData
            );
            logger.log('config', config);
            return (await axios(config)).data;
          },
          { operationKey }
        )
      );
    } catch (error) {
      logger.error(error);
      await emitOperationalAlert({
        alertCode: 'PUBLISH_SUBSPLASH_EDIT_RUNTIME_FAILURE',
        summary: 'editSubsplashSermon callable failed during publish edit flow.',
        error,
        context: {
          functionName: 'editSubsplashSermon',
          operationKey,
          subsplashId,
        },
      });
      throw handleError(error);
    }
  }
);

export default editSubsplashSermon;
