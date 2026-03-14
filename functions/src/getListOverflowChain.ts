import { canUserRolePublish } from '@upperroom/shared/types/User';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import handleError from './handleError';
import { getOverflowChainState } from './helpers/listOverflowChain';
import type {
  GetListOverflowChainInputType,
  GetListOverflowChainOutputType,
} from '../../packages/contracts/getListOverflowChain';

const getlistoverflowchain = onCall(
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
      return await getOverflowChainState(request.data?.listId ?? '');
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default getlistoverflowchain;
