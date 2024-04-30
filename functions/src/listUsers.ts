import firebaseAdmin from '../../firebase/firebaseAdmin';
import { https, logger } from 'firebase-functions/v2';
import { CallableRequest } from 'firebase-functions/v2/https';
import { canUserRolePublish, canUserRoleUpload, isUserRoleAdmin, User } from '../../types/User';
import { IdTokenResult } from 'firebase/auth';
import { FunctionOutputType } from '../../types/Function';

export interface ListUsersInputType {
  maxResults?: number;
  pageToken?: string;
}

export type ListUsersOutputType = Promise<FunctionOutputType<User[]>>;

const listUsers = https.onCall(async (request: CallableRequest<ListUsersInputType>): ListUsersOutputType => {
  // check if user is admin (true "admin" custom claim), return error if not
  logger.debug('role', request.auth?.token.role);
  if (request.auth?.token.role !== 'admin') {
    return { status: 'error', error: `Unauthorized.` };
  }
  logger.debug('listAllUsers', request.data);
  const listAllUsers = async (maxResults?: number, nextPageToken?: string): Promise<User[]> => {
    let result: User[] = [];
    try {
      // List batch of users, 1000 at a time.
      const listUsersResult = await firebaseAdmin.auth().listUsers(maxResults, nextPageToken);
      logger.debug('listUsersResult', listUsersResult);
      result = listUsersResult.users.map((user) => {
        const userOutput: User = {
          uid: user.uid,
          email: user.email ?? null,
          photoURL: user.photoURL ?? null,
          displayName: user.displayName ?? null,
          role: user.customClaims?.role,
          firstName: '',
          lastName: '',
          canUpload: (): boolean => canUserRoleUpload(user.customClaims?.role),
          canPublish: (): boolean => canUserRolePublish(user.customClaims?.role),
          isAdmin: (): boolean => isUserRoleAdmin(user.customClaims?.role),
          emailVerified: false,
          isAnonymous: false,
          metadata: user.metadata,
          providerData: user.providerData,
          refreshToken: '',
          tenantId: user.tenantId ?? null,
          delete: function (): Promise<void> {
            throw new Error('Function not implemented.');
          },
          getIdToken: function (): Promise<string> {
            throw new Error('Function not implemented.');
          },
          getIdTokenResult: function (): Promise<IdTokenResult> {
            throw new Error('Function not implemented.');
          },
          reload: function (): Promise<void> {
            throw new Error('Function not implemented.');
          },
          toJSON: function (): object {
            throw new Error('Function not implemented.');
          },
          phoneNumber: user.phoneNumber ?? null,
          providerId: '',
        };
        return userOutput;
      });
      if (listUsersResult.pageToken) {
        result = result.concat(await listAllUsers(maxResults, listUsersResult.pageToken));
      }
    } catch (error) {
      logger.error('Error listing users', error);
    }
    return result;
  };
  // Start listing users from the beginning, 1000 at a time.
  return { status: 'success', data: await listAllUsers() };
});

export default listUsers;
