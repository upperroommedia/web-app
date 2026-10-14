import {markPublishingCritical, getPublishingMutationOperation, runPublishingProviderMutation} from './temporal/publishing/durableOperationContext';
import { providerPayloadFingerprint } from './temporal/publishing/providerReceipts';
import { assertSynchronousProviderMutationCompleted } from './temporal/publishing/providerMutationCompletion';
import {reserveSubsplashAssociation} from './temporal/publishing/providerAssociations';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import axios from './providerSandbox/http';
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

export const editSubsplashListDomain = async (
  request: Pick<CallableRequest<EditSubsplashListInputType>, 'data' | 'auth'>
): Promise<EditSubsplashListOutputType> => {
  logger.log('editSubsplashList', {uid:request.auth?.uid});
  if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  const data = request.data;

  const operationKey = getOperationKey(data.operationKey);
  const runMutation = async (): Promise<EditSubsplashListOutputType> => {
    const token = await authenticateSubsplash();
    const repairedImages = data.images
      ? await repairMismatchedSubsplashImageRefs(data.images, token, data.operationKey)
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
    await markPublishingCritical('PUBLISHING_ASSOCIATION_CRITICAL', {
      provider: 'subsplash', resourceType: 'list', resourceId: data.listId, accountId: 'app:9XTSHD',
      method: 'PATCH', requestFingerprint: providerPayloadFingerprint(JSON.parse(requestData)),
    });
    await reserveSubsplashAssociation(`listmetadata:${data.listId}`,[data.listId,...(repairedImages??[]).map(image=>image.subsplashId||image.id)],JSON.parse(requestData),{target:{provider:'subsplash',kind:'list',remoteId:data.listId}});
    Object.assign(config, { skipSubsplashEdgeRetry: true });
    const payload = JSON.parse(requestData);
    await runPublishingProviderMutation({
      operation: getPublishingMutationOperation() ?? 'legacy-list-mutation',
      step: `edit-list:${data.listId}:${providerPayloadFingerprint(payload)}`,
      target: { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'list', resourceId: data.listId },
      method: 'PATCH', payload,
      send: async () => { assertSynchronousProviderMutationCompleted(await axios(config)); return { completion: 'acknowledged', result: { id: data.listId } }; },
    });

    if (data.title?.trim()) {
      await syncOverflowChainNames(data.listId, data.title.trim(), token);
    }

    return;
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
};

const editSubpslashList = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: Parameters<typeof editSubsplashListDomain>[0]) =>{

if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
if (!request.auth?.uid) {
 const { HttpsError } = await import('firebase-functions/v2/https');
 throw new HttpsError('unauthenticated', 'Authentication is required.');
}
const { withLegacyAdmissionLease } = await import('./temporal/legacyAdmissionLease');
return withLegacyAdmissionLease(firebaseAdmin.firestore(), {domain:'publishing',actorUid:request.auth.uid,operation:"editSubsplashList",projectId:firebaseAdmin.app().options.projectId || ''}, async lease => {
 await lease.markEffectsStarted();
return editSubsplashListDomain(request);
});
}
);

export default editSubpslashList;
