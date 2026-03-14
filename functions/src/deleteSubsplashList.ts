// delete a Subsplash List
import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type {
  DeleteSubsplashListBlockedDetails,
  DeleteSubsplashListInputType,
  DeleteSubsplashListOutputType,
} from '../../packages/contracts/deleteSubsplashList';
import handleError from './handleError';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { getOverflowChainState } from './helpers/listOverflowChain';

const getOperationKey = (operationKey?: string): string | undefined => {
  const normalizedKey = operationKey?.trim();
  return normalizedKey ? normalizedKey : undefined;
};

const buildBlockedDeleteDetails = (
  requestedListId: string,
  chainState: Awaited<ReturnType<typeof getOverflowChainState>>
): DeleteSubsplashListBlockedDetails => {
  const [rootNode, ...overflowNodes] = chainState.nodes;

  return {
    reason: 'ROOT_HAS_OVERFLOW_PAGES',
    requestedListId,
    rootListId: chainState.rootListId,
    rootName: rootNode?.name ?? chainState.rootListId,
    logicalCount: chainState.logicalCount,
    totalPages: chainState.nodes.length,
    overflowPageCount: overflowNodes.length,
    overflowPages: overflowNodes.map((node) => ({
      firestoreListId: node.firestoreListId,
      subsplashId: node.subsplashId,
      name: node.name,
      depth: node.depth,
      count: node.count,
    })),
  };
};

const deleteSubsplashList = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<DeleteSubsplashListInputType>): Promise<DeleteSubsplashListOutputType> => {
    logger.log('deleteSubsplashList', request);
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const chainState = await getOverflowChainState(request.data.listId);
    const requestedNode = chainState.nodes.find((node) => node.firestoreListId === request.data.listId);
    if (!requestedNode?.subsplashId) {
      throw new HttpsError('failed-precondition', `List ${request.data.listId} is missing a Subsplash id.`);
    }

    if (chainState.rootListId === request.data.listId && chainState.nodes.length > 1) {
      return {
        status: 'blocked',
        blocked: buildBlockedDeleteDetails(request.data.listId, chainState),
      };
    }

    const url = `https://core.subsplash.com/builder/v1/lists/${requestedNode.subsplashId}`;
    const operationKey = getOperationKey(request.data.operationKey);

    const runMutation = async (): Promise<DeleteSubsplashListOutputType> => {
      const config = createAxiosConfig(url, await authenticateSubsplash(), 'DELETE');
      await axios(config);
      return { status: 'deleted' };
    };

    const runLockedMutation = async (): Promise<DeleteSubsplashListOutputType> => {
      return withSubsplashLocks([`list:${requestedNode.subsplashId}`], runMutation, {
        ...(operationKey ? { operationKey } : {}),
      });
    };

    try {
      if (operationKey) {
        return await withIdempotency(operationKey, runLockedMutation);
      }
      return await runLockedMutation();
    } catch (error) {
      const httpsError = handleError(error);
      JSON.parse(JSON.stringify(httpsError));
      throw httpsError;
    }
  }
);

export default deleteSubsplashList;
