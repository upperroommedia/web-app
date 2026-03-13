// delete a Subsplash List
import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import handleError from './handleError';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { canUserRolePublish } from '../../types/User';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';

export interface DeleteSubsplashListInputType {
  listId: string;
  operationKey?: string;
}
export type DeleteSubsplashListOutputType = void;

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
    const url = `https://core.subsplash.com/builder/v1/lists/${request.data.listId}`;
    const operationKey = getOperationKey(request.data.operationKey);

    const runMutation = async (): Promise<DeleteSubsplashListOutputType> => {
      const config = createAxiosConfig(url, await authenticateSubsplash(), 'DELETE');
      await axios(config);
    };

    const runLockedMutation = async (): Promise<DeleteSubsplashListOutputType> => {
      return withSubsplashLocks([`list:${request.data.listId}`], runMutation, {
        ...(operationKey ? { operationKey } : {}),
      });
    };

    try {
      if (operationKey) {
        await withIdempotency(operationKey, runLockedMutation);
        return;
      }
      await runLockedMutation();
    } catch (error) {
      const httpsError = handleError(error);
      JSON.parse(JSON.stringify(httpsError));
      throw httpsError;
    }
  }
);

export default deleteSubsplashList;
