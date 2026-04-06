import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { ImageType } from '@upperroom/shared/types/Image';
import handleError from './handleError';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { syncOverflowChainNames } from './helpers/listOverflowChain';
import { repairMismatchedSubsplashImageRefs } from './helpers/subsplashImageRefs';

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
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<EditSubsplashListInputType>): Promise<EditSubsplashListOutputType> => {
    logger.log('editSubsplashList', request);
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const data = request.data;

    const operationKey = getOperationKey(data.operationKey);
    const runMutation = async (): Promise<EditSubsplashListOutputType> => {
      const token = await authenticateSubsplash();
      const repairedImages = data.images
        ? await repairMismatchedSubsplashImageRefs(data.images, token)
        : undefined;
      const requestData = JSON.stringify({
        app_key: '9XTSHD',
        ...(data.title && { title: data.title }),
        ...(data.subtitle && { subtitle: data.subtitle }),
        ...(repairedImages && {
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
          },
        }),
      });
      logger.log('request data', requestData);
      const config = createAxiosConfig(
        `https://core.subsplash.com/builder/v1/lists/${data.listId}`,
        token,
        'PATCH',
        requestData
      );
      logger.log('config', config);
      const response = await axios(config);

      if (data.title?.trim()) {
        await syncOverflowChainNames(data.listId, data.title.trim(), token);
      }

      return response.data;
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
