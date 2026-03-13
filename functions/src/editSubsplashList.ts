import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { ImageType } from '../../types/Image';
import handleError from './handleError';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { canUserRolePublish } from '../../types/User';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';
import { subsplashSecrets } from './subsplashSecrets';

export interface EditSubsplashListInputType {
  listId: string;
  title?: string;
  subtitle?: string;
  images?: ImageType[];
  operationKey?: string;
}
export type EditSubsplashListOutputType = void;

const getOperationKey = (operationKey?: string): string | undefined => {
  const normalizedKey = operationKey?.trim();
  return normalizedKey ? normalizedKey : undefined;
};

const editSubpslashList = onCall(
  { secrets: subsplashSecrets },
  async (request: CallableRequest<EditSubsplashListInputType>): Promise<EditSubsplashListOutputType> => {
    logger.log('editSubsplashList', request);
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const data = request.data;

    const requestData = JSON.stringify({
      app_key: '9XTSHD',
      ...(data.title && { title: data.title }),
      ...(data.subtitle && { subtitle: data.subtitle }),
      ...(data.images && {
        _embedded: {
          images: data.images
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
        },
      }),
    });
    logger.log('request data', requestData);
    const operationKey = getOperationKey(data.operationKey);
    const runMutation = async (): Promise<EditSubsplashListOutputType> => {
      const config = createAxiosConfig(
        `https://core.subsplash.com/builder/v1/lists/${data.listId}`,
        await authenticateSubsplash(),
        'PATCH',
        requestData
      );
      logger.log('config', config);
      return (await axios(config)).data;
    };

    const runLockedMutation = async (): Promise<EditSubsplashListOutputType> => {
      return withSubsplashLocks([`list:${data.listId}`], runMutation, {
        ...(operationKey ? { operationKey } : {}),
      });
    };

    try {
      if (operationKey) {
        return await withIdempotency(operationKey, runLockedMutation);
      }
      return await runLockedMutation();
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default editSubpslashList;
