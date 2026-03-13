import firebaseAdmin from '../../firebase/firebaseAdmin';
import { https, logger } from 'firebase-functions/v2';
import { CallableRequest } from 'firebase-functions/v2/https';
import { canUserRolePublish, canUserRoleUpload, isUserRoleAdmin, User, UserRoleType } from '../../types/User';
import { IdTokenResult } from 'firebase/auth';
import { FunctionOutputType } from '../../types/Function';
import handleError from './handleError';

export interface GetUsersByIdsInputType {
  uids: string[];
}

export type GetUsersByIdsOutputType = FunctionOutputType<User[]>;

const USER_FETCH_CHUNK_SIZE = 100; // Firebase Admin getUsers supports up to 100 identifiers per call.

function toOutputUser(user: firebaseAdmin.auth.UserRecord): User {
  return {
    uid: user.uid,
    email: user.email ?? null,
    photoURL: user.photoURL ?? null,
    displayName: user.displayName ?? null,
    role: user.customClaims?.role as UserRoleType | undefined,
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
}

const getUsersByIds = https.onCall(async (request: CallableRequest<GetUsersByIdsInputType>): Promise<GetUsersByIdsOutputType> => {
  const requesterRole = request.auth?.token.role as UserRoleType | undefined;
  const requesterUid = request.auth?.uid;

  if (!requesterRole || !requesterUid) {
    return { status: 'error', error: 'Unauthorized.' };
  }

  if (requesterRole !== 'admin' && requesterRole !== 'publisher' && requesterRole !== 'uploader') {
    return { status: 'error', error: 'Unauthorized.' };
  }

  const requestedUids = Array.from(new Set((request.data.uids ?? []).filter(Boolean)));
  if (requestedUids.length === 0) {
    return { status: 'success', data: [] };
  }

  // Uploader role can only request their own profile.
  if (requesterRole === 'uploader') {
    if (requestedUids.some((uid) => uid !== requesterUid)) {
      return { status: 'error', error: 'Unauthorized.' };
    }
  }

  try {
    const auth = firebaseAdmin.auth();
    const users: User[] = [];
    const foundUids = new Set<string>();

    for (let i = 0; i < requestedUids.length; i += USER_FETCH_CHUNK_SIZE) {
      const batch = requestedUids.slice(i, i + USER_FETCH_CHUNK_SIZE);
      const response = await auth.getUsers(batch.map((uid) => ({ uid })));

      for (const userRecord of response.users) {
        foundUids.add(userRecord.uid);
        users.push(toOutputUser(userRecord));
      }
    }

    const missingUids = requestedUids.filter((uid) => !foundUids.has(uid));
    if (missingUids.length > 0) {
      logger.debug('Batch user lookup returned partial results', { requested: requestedUids.length, found: users.length, missing: missingUids.length });
    }

    return { status: 'success', data: users };
  } catch (error) {
    handleError(error, {
      alertCode: 'GET_USERS_BY_IDS_RUNTIME_FAILURE',
      summary: 'getUsersByIds failed while loading Firebase Auth users.',
      context: { functionName: 'getUsersByIds', requestedCount: requestedUids.length },
    });
    logger.error('Error fetching users by ids', error);
    return { status: 'error', error: `Error fetching users by ids ${error}` };
  }
});

export default getUsersByIds;
