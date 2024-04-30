import firebaseAdmin from '../../firebase/firebaseAdmin';
import { https, logger } from 'firebase-functions/v2';
import { CallableRequest } from 'firebase-functions/v2/https';
import { canUserRolePublish, canUserRoleUpload, isUserRoleAdmin, User } from '../../types/User';
import { IdTokenResult } from 'firebase/auth';
import { FunctionOutputType } from '../../types/Function';
export interface GetUserInputType {
  uid: string;
}

export type GetUserOutputType = FunctionOutputType<User>;

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
    return { status: 'success', data: userOutput };
  } catch (error) {
    logger.error('Error listing users', error);
    return { status: 'error', error: `Error listing users ${error}` };
  }
});

export default getUser;
