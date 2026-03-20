import { canUserRolePublish } from '@upperroom/shared/types/User';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import handleError from './handleError';
import { getOverflowChainState } from './helpers/listOverflowChain';
import { loadRemoteChainItems } from './helpers/remoteChainItems';
import { authenticateSubsplash } from './subsplashUtils';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import type {
  GetListOverflowChainInputType,
  GetListOverflowChainOutputType,
} from '../../packages/contracts/getListOverflowChain';

const getlistoverflowchain = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<GetListOverflowChainInputType>): Promise<GetListOverflowChainOutputType> => {
    logger.log('getlistoverflowchain', {
      uid: request.auth?.uid,
      listId: request.data?.listId,
    });

    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError(
        'unauthenticated',
        'The function must be called while authenticated with publish permissions.'
      );
    }

    try {
      const chainState = await getOverflowChainState(request.data?.listId ?? '');
      const rootSubsplashId = chainState.nodes.find((node) => node.isRoot)?.subsplashId?.trim();

      if (!rootSubsplashId) {
        return chainState;
      }

      const token = await authenticateSubsplash();
      const { remoteItems } = await loadRemoteChainItems(chainState.rootListId, token, chainState);

      return {
        ...chainState,
        remoteItems,
      };
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default getlistoverflowchain;
