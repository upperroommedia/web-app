import type { LegacyAdmissionLease } from './temporal/legacyAdmissionLease';
import { ROLES } from '@upperroom/shared/context/types';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { https, logger } from 'firebase-functions/v2';
import { CallableRequest } from 'firebase-functions/v2/https';
import { FunctionOutputType } from '@upperroom/shared/types/Function';
import handleError from './handleError';
export interface SetUserRoleInputType {
  uid: string;
  role: string;
}

export type SetUserRoleOutputType = FunctionOutputType<'success'>;

export const setUserRoleHandler = async (
  request: CallableRequest<SetUserRoleInputType>,
  lease?: LegacyAdmissionLease
): Promise<SetUserRoleOutputType> => {
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
      await lease?.markEffectsStarted();
      await auth.setCustomUserClaims(user.uid, { ...user.customClaims, role: request.data.role });
      await auth.revokeRefreshTokens(user.uid);
      return { status: 'success', data: 'success' };
    }
  } catch (e) {
    handleError(e, {
      alertCode: 'SET_USER_ROLE_RUNTIME_FAILURE',
      summary: 'setUserRole failed while updating custom claims.',
      request,
      context: { functionName: 'setUserRole', uid: request.data.uid, role: request.data.role },
    });
    if (e instanceof Error) {
      return { status: 'error', error: e.message };
    }
    return { status: 'error', error: JSON.stringify(e) };
  }
};
export const setUserRoleSource = async (
  request: CallableRequest<SetUserRoleInputType>
): Promise<SetUserRoleOutputType> => {
  if (!request.auth?.uid || request.auth.token.role !== 'admin') return setUserRoleHandler(request);
  return (await import('./temporal/accounts/sourceAdmission')).withLegacyAccountSource(
    firebaseAdmin.firestore(),
    request.auth.uid,
    'role.assign',
    (lease) => setUserRoleHandler(request, lease)
  );
};
const setUserRole = https.onCall(setUserRoleSource);
export default setUserRole;
