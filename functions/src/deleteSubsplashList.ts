// delete a Subsplash List
import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import handleError from './handleError';
import { authenticateSubsplashV2, createAxiosConfig } from './subsplashUtils';
import { canUserRolePublish } from '../../types/User';

export interface DeleteSubsplashListInputType {
  listId: string;
}
export type DeleteSubsplashListOutputType = void;

const deleteSubsplashList = onCall(
  async (request: CallableRequest<DeleteSubsplashListInputType>): Promise<DeleteSubsplashListOutputType> => {
    logger.log('deleteSubsplashList', request);
    if (!request.auth || !canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const url = `https://core.subsplash.com/builder/v1/lists/${request.data.listId}`;
    try {
      const config = createAxiosConfig(url, await authenticateSubsplashV2(request.auth.uid), 'DELETE');
      await axios(config);
    } catch (error) {
      const httpsError = handleError(error);
      JSON.parse(JSON.stringify(httpsError));
      throw httpsError;
    }
  }
);

export default deleteSubsplashList;
