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

const deleteSubsplashList = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<DeleteSubsplashListInputType>): Promise<DeleteSubsplashListOutputType> => {
    logger.log('deleteSubsplashList', request);
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
  }
);

export default deleteSubsplashList;
