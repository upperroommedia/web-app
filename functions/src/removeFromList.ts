import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import handleError from './handleError';
import { authenticateSubsplashV2, createAxiosConfig } from './subsplashUtils';
import { canUserRolePublish } from '../../types/User';

export interface RemoveFromListInputType {
  listIds: string[];
  listItemIds: string[];
}

type status = 'success' | 'error';
type OutputTypes =
  | {
      listId: string;
      status: 'success';
    }
  | {
      listId: string;
      status: 'error';
      error: string;
    };
export type RemoveFromListOutputType = OutputTypes[];
export const removeFromList = async (listIds: string[], listItemIds: string[]) => {
  if (!process.env.YOUSSEF_UID) {
    throw new Error('Could not find YOUSSEF_UID in .env');
  }
  const uid = process.env.YOUSSEF_UID;
  const token = await authenticateSubsplashV2(uid);
  const result = await Promise.allSettled(
    listItemIds.map(async (id) => {
      logger.log(`Deleting item with id: ${id}`);
      const deleteConfig = createAxiosConfig(`https://core.subsplash.com/builder/v1/list-rows/${id}`, token, 'DELETE');
      return (await axios(deleteConfig)).data;
    })
  );
  logger.log(result);
  const returnResult = result.map((r, index) => {
    if (r.status === 'fulfilled') {
      const status: status = 'success';
      return { listId: listIds[index], status, listItemId: r.value };
    } else {
      logger.log('error', r.reason);
      const status: status = 'error';
      let message = '';
      if ('message' in r.reason) {
        message = r.reason.message;
      } else {
        message = JSON.stringify(r.reason);
      }
      return { listId: listIds[index], status, error: message };
    }
  });
  return returnResult;
};
const removeFromListCallable = onCall(
  async (request: CallableRequest<RemoveFromListInputType>): Promise<RemoveFromListOutputType> => {
    logger.log('removeFromList');

    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const data = request.data;
    if (!data.listItemIds || !data.listIds || data.listIds.length !== data.listItemIds.length) {
      throw new HttpsError(
        'invalid-argument',
        'The function must be called with non-empty equal sized listItemIds and listIds.'
      );
    }
    try {
      return await removeFromList(data.listIds, data.listItemIds);
    } catch (err) {
      throw handleError(err);
    }
  }
);

export default removeFromListCallable;
