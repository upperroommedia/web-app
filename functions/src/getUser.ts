import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { https, logger } from 'firebase-functions/v2';
import { CallableRequest } from 'firebase-functions/v2/https';
import { DirectoryUser } from '@upperroom/shared/types/User';
import { FunctionOutputType } from '@upperroom/shared/types/Function';
import handleError from './handleError';
import { toDirectoryUser } from './userDirectory';
export interface GetUserInputType {
  uid: string;
}

export type GetUserOutputType = FunctionOutputType<DirectoryUser>;

const getUser = https.onCall(async (request: CallableRequest<GetUserInputType>): Promise<GetUserOutputType> => {
  // check if user is admin (true "admin" custom claim), return error if not
  if (request.auth?.token.role !== 'admin') {
    return { status: 'error', error: `Unauthorized.` };
  }
  logger.debug('getUser', request.data);
  try {
    // List batch of users, 1000 at a time.
    const user = await firebaseAdmin.auth().getUser(request.data.uid);
    logger.debug('listUsersResult', user);
    return { status: 'success', data: toDirectoryUser(user) };
  } catch (error) {
    handleError(error, {
      alertCode: 'GET_USER_RUNTIME_FAILURE',
      summary: 'getUser failed while loading a Firebase Auth user.',
      request,
      context: { functionName: 'getUser', uid: request.data.uid },
    });
    logger.error('Error listing users', error);
    return { status: 'error', error: `Error listing users ${error}` };
  }
});

export default getUser;
