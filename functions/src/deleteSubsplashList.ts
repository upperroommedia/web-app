import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
// delete a Subsplash List
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type {
  DeleteSubsplashListInputType,
  DeleteSubsplashListOutputType,
} from '../../packages/contracts/deleteSubsplashList';
import handleError from './handleError';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { withIdempotency } from './locks/withIdempotency';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { authenticateSubsplash } from './subsplashUtils';
import { deleteLogicalListChain } from './helpers/deleteLogicalListChain';

const getOperationKey = (operationKey?: string): string | undefined => {
  const normalizedKey = operationKey?.trim();
  return normalizedKey ? normalizedKey : undefined;
};

export const deleteSubsplashListDomain = async (
  request: Pick<CallableRequest<DeleteSubsplashListInputType>, 'data' | 'auth'>
): Promise<DeleteSubsplashListOutputType> => {
  logger.log('deleteSubsplashList', {uid:request.auth?.uid});
  if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  const operationKey = getOperationKey(request.data.operationKey);

  const runMutation = async (): Promise<DeleteSubsplashListOutputType> => {
    const token = await authenticateSubsplash();
    const result = await deleteLogicalListChain({
      listId: request.data.listId,
      operationKey,
      token,
    });
    return {
      status: 'deleted',
      requestedListId: result.requestedListId,
      rootListId: result.rootListId,
      deletedFirestoreListIds: result.deletedFirestoreListIds,
      deletedSubsplashListIds: result.deletedSubsplashListIds,
    };
  };

  try {
    if (operationKey) {
      return await withIdempotency(operationKey, runMutation);
    }
    return await runMutation();
  } catch (error) {
    const httpsError = handleError(error);
    JSON.parse(JSON.stringify(httpsError));
    throw httpsError;
  }
};

const deleteSubsplashList = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: Parameters<typeof deleteSubsplashListDomain>[0]) =>{

if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
if (!request.auth?.uid) {
 const { HttpsError } = await import('firebase-functions/v2/https');
 throw new HttpsError('unauthenticated', 'Authentication is required.');
}
const { withLegacyAdmissionLease } = await import('./temporal/legacyAdmissionLease');
return withLegacyAdmissionLease(firebaseAdmin.firestore(), {domain:'publishing',actorUid:request.auth.uid,operation:"deleteSubsplashList",projectId:firebaseAdmin.app().options.projectId || ''}, async lease => {
 await lease.markEffectsStarted();
return deleteSubsplashListDomain(request);
});
}
);

export default deleteSubsplashList;
