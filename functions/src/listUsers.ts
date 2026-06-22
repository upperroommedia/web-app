import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { https, logger } from 'firebase-functions/v2';
import { CallableRequest } from 'firebase-functions/v2/https';
import { DirectoryUser } from '@upperroom/shared/types/User';
import { FunctionOutputType } from '@upperroom/shared/types/Function';
import handleError from './handleError';
import { toDirectoryUser } from './userDirectory';

export interface ListUsersInputType {
  maxResults?: number;
  pageToken?: string;
}

export type ListUsersOutputType = FunctionOutputType<DirectoryUser[]>;

const listUsers = https.onCall(async (request: CallableRequest<ListUsersInputType>): Promise<ListUsersOutputType> => {
  // check if user is admin (true "admin" custom claim), return error if not
  logger.debug('role', request.auth?.token.role);
  if (request.auth?.token.role !== 'admin') {
    return { status: 'error', error: `Unauthorized.` };
  }
  logger.debug('listAllUsers', request.data);
  const listAllUsers = async (maxResults?: number, nextPageToken?: string): Promise<DirectoryUser[]> => {
    let result: DirectoryUser[] = [];
    try {
      // List batch of users, 1000 at a time.
      const listUsersResult = await firebaseAdmin.auth().listUsers(maxResults, nextPageToken);
      logger.debug('listUsersResult', listUsersResult);
      result = listUsersResult.users.map(toDirectoryUser);
      if (listUsersResult.pageToken) {
        result = result.concat(await listAllUsers(maxResults, listUsersResult.pageToken));
      }
    } catch (error) {
      handleError(error, {
        alertCode: 'LIST_USERS_RUNTIME_FAILURE',
        summary: 'listUsers failed while paging Firebase Auth users.',
        request,
        context: { functionName: 'listUsers' },
      });
      logger.error('Error listing users', error);
    }
    return result;
  };
  // Start listing users from the beginning, 1000 at a time.
  return { status: 'success', data: await listAllUsers() };
});

export default listUsers;
