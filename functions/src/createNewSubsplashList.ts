import {reserveSubsplashAssociation} from './temporal/publishing/providerAssociations';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
// create a new Subsplash List
import axios from 'axios';
import { executeProviderCreate,providerReceiptId } from './temporal/publishing/providerReceipts';
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

export const createNewSubsplashListDomain = async (
  request: Pick<CallableRequest<CreateNewSubsplashListInputType>, 'data' | 'auth'>
): Promise<CreateNewSubsplashListOutputType> => {
  logger.log('createNewSubsplashList', {uid:request.auth?.uid});
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
};

const createNewSubsplashListCallable = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: Parameters<typeof createNewSubsplashListDomain>[0]) =>{

if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
if (!request.auth?.uid) {
 const { HttpsError } = await import('firebase-functions/v2/https');
 throw new HttpsError('unauthenticated', 'Authentication is required.');
}
const { withLegacyAdmissionLease } = await import('./temporal/legacyAdmissionLease');
return withLegacyAdmissionLease(firebaseAdmin.firestore(), {domain:'publishing',actorUid:request.auth.uid,operation:"createNewSubsplashList",projectId:firebaseAdmin.app().options.projectId || ''}, async lease => {
 await lease.markEffectsStarted();
return createNewSubsplashListDomain(request);
});
}
);

export async function createNewSubsplashList(input: CreateNewSubsplashListInputType) {
  logger.log('CreatingNewListFrom', {title:input.title,imageCount:input.images?.length ?? 0});
  const lockKey = getCreateLockKey(input.title ?? '');
  const operationKey = getOperationKey(input.operationKey);

  const runMutation = async (): Promise<CreateNewSubsplashListOutputType> => {
    const token = await authenticateSubsplash();
    const repairedImages = input.images
      ? await repairMismatchedSubsplashImageRefs(input.images, token, input.operationKey)
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
    Object.assign(config, { skipSubsplashEdgeRetry: true });
    const create = async (): Promise<CreateNewSubsplashListOutputType> => {
      const response = (await axios(config)).data;
      if (typeof response.id !== 'string' || !response.id) throw new HttpsError('internal', 'Subsplash returned no list ID.');
      return { listId: response.id };
    };
    const prepare=()=>reserveSubsplashAssociation(`listcreate:${operationKey??input.title}`,(payload._embedded.images??[]).map(image=>image.id),payload,operationKey?{targetReceiptId:providerReceiptId(operationKey,'list-create')}:{});
    if (operationKey) return executeProviderCreate({ operationKey, step: 'list-create', payload,prepare, execute: create });
    await prepare();
    const response = await create();
    // the response also returns the display options for the list which determine how the list is displayed on the different platforms
    // since this will not be changable through our ui, the display options are not returned
    return response;
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
