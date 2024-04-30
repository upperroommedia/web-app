import { ROLES } from '../../context/types';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { https, logger } from 'firebase-functions/v2';
import { CallableRequest } from 'firebase-functions/v2/https';
import { FunctionOutputType } from '../../types/Function';
export interface SetUserRoleInputType {
  uid: string;
  role: string;
}

export type SetUserRoleOutputType = FunctionOutputType<'success'>;

const setUserRole = https.onCall(
  async (request: CallableRequest<SetUserRoleInputType>): Promise<SetUserRoleOutputType> => {
    logger.debug('role', request.auth?.token.role);
    if (request.auth?.token.role !== 'admin') {
      logger.error(`Not Authorized, current user is ${request.auth?.token.role ?? 'unknown'} and must be admin.`);
      return { status: 'error', error: 'Not Authorized' };
    }
    if (!ROLES.includes(request.data.role)) {
      return { status: 'error', error: `Invalid Role: Should be either ${ROLES.join(', ')}` };
    }
    const auth = firebaseAdmin.auth();
    try {
      const user = await auth.getUser(request.data.uid);
      if (user.customClaims?.role === request.data.role) {
        return { status: 'error', error: `User is already role: ${request.data.role}` };
      } else {
        await auth.setCustomUserClaims(user.uid, { role: request.data.role });
        await auth.revokeRefreshTokens(user.uid);
        return { status: 'success', data: 'success' };
      }
    } catch (e) {
      if (e instanceof Error) {
        return { status: 'error', error: e.message };
      }
      return { status: 'error', error: JSON.stringify(e) };
    }
  }
);

export default setUserRole;
