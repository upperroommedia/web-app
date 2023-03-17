// create a new Subsplash List
import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { ImageType } from '../../types/Image';
import handleError from './handleError';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';

export interface CreateNewSubsplashListInputType {
  title: string;
  subtitle?: string;
  images?: ImageType[];
}
export interface CreateNewSubsplashListOutputType {
  listId: string;
}

const createNewSubsplashListCallable = onCall(
  async (request: CallableRequest<CreateNewSubsplashListInputType>): Promise<CreateNewSubsplashListOutputType> => {
    logger.log('createNewSubsplashList', request);
    if (request.auth?.token.role !== 'admin') {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    try {
      return await createNewSubsplashList(request.data);
    } catch (error) {
      const httpsError = handleError(error);
      logger.error(httpsError);
      throw httpsError;
    }
  }
);

export async function createNewSubsplashList(input: CreateNewSubsplashListInputType) {
  logger.log('CreatingNewListFrom', input);
  const url = 'https://core.subsplash.com/builder/v1/lists';
  const payload = {
    app_key: '9XTSHD',
    display_type: 'image',
    generated: false,
    header_type: 'none',
    layout_type: 'list',
    title: input.title,
    ...(input.subtitle && { subtitle: input.subtitle }),
    type: 'standard',
    _embedded: input.images
      ? {
          images: input.images.map((image) => {
            return {
              id: image.id,
              type: image.type,
            };
          }),
        }
      : {},
  };
  const config = createAxiosConfig(url, await authenticateSubsplash(), 'POST', payload);
  const response = (await axios(config)).data;
  // the response also returns the display options for the list which determine how the list is displayed on the different platforms
  // since this will not be changable through our ui, the display options are not returned
  return { listId: response.id as string };
}

export default createNewSubsplashListCallable;
