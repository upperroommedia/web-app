// create a new Subsplash List
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
import { repairMismatchedSubsplashImageRefs } from './helpers/subsplashImageRefs';

export interface CreateNewSubsplashListInputType {
  title: string;
  subtitle?: string;
  images?: ImageType[];
  operationKey?: string;
}
export interface CreateNewSubsplashListOutputType {
  listId: string;
}

const getOperationKey = (operationKey?: string): string | undefined => {
  const normalizedKey = operationKey?.trim();
  return normalizedKey ? normalizedKey : undefined;
};

const getCreateLockKey = (title: string): string => {
  const normalizedTitle = title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return `list:create-${normalizedTitle || 'untitled'}`;
};

const createNewSubsplashListCallable = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<CreateNewSubsplashListInputType>): Promise<CreateNewSubsplashListOutputType> => {
    logger.log('createNewSubsplashList', request);
    if (!canUserRolePublish(request.auth?.token.role)) {
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
  const lockKey = getCreateLockKey(input.title ?? '');
  const operationKey = getOperationKey(input.operationKey);

  const runMutation = async (): Promise<CreateNewSubsplashListOutputType> => {
    const token = await authenticateSubsplash();
    const repairedImages = input.images
      ? await repairMismatchedSubsplashImageRefs(input.images, token)
      : undefined;
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
      _embedded: repairedImages
        ? {
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
          }
        : {},
    };
    const config = createAxiosConfig(url, token, 'POST', payload);
    const response = (await axios(config)).data;
    // the response also returns the display options for the list which determine how the list is displayed on the different platforms
    // since this will not be changable through our ui, the display options are not returned
    return { listId: response.id as string };
  };

  const runLockedMutation = async (): Promise<CreateNewSubsplashListOutputType> => {
    return withSubsplashLocks([lockKey], runMutation, {
      ...(operationKey ? { operationKey } : {}),
    });
  };

  if (operationKey) {
    return withIdempotency(operationKey, runLockedMutation);
  }

  return runLockedMutation();
}

export default createNewSubsplashListCallable;
