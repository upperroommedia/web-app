import { logger } from 'firebase-functions/v2';
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import axios from 'axios';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from './uploadToSubsplash';
import { canUserRolePublish } from '../../types/User';
import handleError from './handleError';

export interface EDIT_SUBSPLASH_SERMON_INCOMING_DATA
  extends Partial<Omit<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, 'audioUrl' | 'autoPublish'>> {
  operationKey: string;
  subsplashId: string;
}

const editSubsplashSermon = onCall(
  async (request: CallableRequest<EDIT_SUBSPLASH_SERMON_INCOMING_DATA>): Promise<unknown> => {
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated with publish permissions.');
    }
    if (process.env.EMAIL == undefined || process.env.PASSWORD == undefined) {
      throw new HttpsError('failed-precondition', 'Email or Password are not set in .env file');
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
    logger.log('data', data);
    try {
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

      // only send non null values to subsplash
      const requestData = JSON.stringify({
        app_key: '9XTSHD',
        ...(tags.length > 0 && { tags: tags }),
        ...(data.title && { title: data.title }),
        ...(data.subtitle && { subtitle: data.subtitle }),
        ...(data.description && { summary: data.description }),
        ...(data.date && { date: data.date }),
        ...(data.images && {
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
            // audio: { id: data.audioId },
          },
        }),
      });
      logger.log('request data', requestData);
      const config = createAxiosConfig(
        `https://core.subsplash.com/media/v1/media-items/${data.subsplashId}`,
        bearerToken,
        'PATCH',
        requestData
      );
      logger.log('config', config);
      return (await axios(config)).data;
    } catch (error) {
      logger.error(error);
      throw handleError(error);
    }
  }
);

export default editSubsplashSermon;
