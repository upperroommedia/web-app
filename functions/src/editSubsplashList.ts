import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { ImageType } from '../../types/Image';
import handleError from './handleError';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';

export interface EditSubsplashListInputType {
  listId: string;
  title?: string;
  subtitle?: string;
  images?: ImageType[];
}
export type EditSubsplashListOutputType = void;

const editSubpslashList = onCall(
  async (request: CallableRequest<EditSubsplashListInputType>): Promise<EditSubsplashListOutputType> => {
    logger.log('deleteSubsplashList', request);
    if (request.auth?.token.role !== 'admin') {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const data = request.data;

    const requestData = JSON.stringify({
      app_key: '9XTSHD',
      ...(data.title && { title: data.title }),
      ...(data.subtitle && { subtitle: data.subtitle }),
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
        },
      }),
    });
    logger.log('request data', requestData);
    try {
      const config = createAxiosConfig(
        `https://core.subsplash.com/builder/v1/lists/${data.listId}`,
        await authenticateSubsplash(),
        'PATCH',
        requestData
      );
      logger.log('config', config);
      return (await axios(config)).data;
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default editSubpslashList;
