import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import { adminBaseUrlSecretsWithRuntimeAlerts } from '../notifications/notificationSecrets';
import handleError from '../handleError';
import {
  AcceptRoleRequestInputType,
  AcceptRoleRequestOutputType,
  PersistedRoleRequestDocument,
  RoleRequestNotificationState,
  ROLE_REQUEST_EMAIL_ENQUEUE_FAILED,
  ROLE_REQUESTS_COLLECTION,
  ROLE_REQUEST_STATUS_ACCEPTED,
  ROLE_REQUEST_STATUS_PENDING,
} from './roleRequestTypes';
import { queueRoleRequestOutcomeEmail } from './queueRoleRequestOutcomeEmail';

const isAdmin = (request: CallableRequest<unknown>): boolean =>
  request.auth?.token.role === 'admin' && typeof request.auth.uid === 'string';

export const acceptRoleRequestHandler = async (
  request: CallableRequest<AcceptRoleRequestInputType>
): Promise<AcceptRoleRequestOutputType> => {
  if (!isAdmin(request)) {
    return { status: 'error', error: 'Not Authorized' };
  }

  const roleRequestId = request.data?.roleRequestId?.trim();
  if (!roleRequestId) {
    return { status: 'error', error: 'Role request id is required.' };
  }

  const firestore = firebaseAdmin.firestore();
  const auth = firebaseAdmin.auth();
  const roleRequestRef = firestore.collection(ROLE_REQUESTS_COLLECTION).doc(roleRequestId);
  const roleRequestSnapshot = await roleRequestRef.get();

  if (!roleRequestSnapshot.exists) {
    return { status: 'error', error: 'Role request not found.' };
  }

  const roleRequest = roleRequestSnapshot.data() as PersistedRoleRequestDocument | undefined;
  if (!roleRequest || typeof roleRequest !== 'object') {
    return { status: 'error', error: 'Role request payload is invalid.' };
  }

  if (roleRequest.status !== ROLE_REQUEST_STATUS_PENDING) {
    return { status: 'error', error: `Role request is already ${roleRequest.status}.` };
  }

  try {
    const user = await auth.getUser(roleRequest.requesterUid);
    const mergedClaims = {
      ...(user.customClaims ?? {}),
      role: roleRequest.requestedRole,
    };

    await auth.setCustomUserClaims(user.uid, mergedClaims);
    await auth.revokeRefreshTokens(user.uid);

    const resolvedByUid = request.auth?.uid;
    if (typeof resolvedByUid !== 'string') {
      return { status: 'error', error: 'Not Authorized' };
    }

    const resolvedAtMs = Date.now();
    const resolvedByEmail =
      typeof request.auth?.token.email === 'string' && request.auth.token.email.trim().length > 0
        ? request.auth.token.email.trim().toLowerCase()
        : null;
    const outcomeEmailResult = await queueRoleRequestOutcomeEmail({
      roleRequestId,
      requesterEmail: roleRequest.requesterEmail,
      requestedRole: roleRequest.requestedRole,
      status: ROLE_REQUEST_STATUS_ACCEPTED,
      resolvedByUid,
      resolvedByEmail,
      resolvedAtMs,
    });
    const resolutionNotification: RoleRequestNotificationState =
      outcomeEmailResult.status === 'queued'
        ? {
            status: 'queued',
            attemptedAtMs: outcomeEmailResult.attemptedAtMs,
            queueMailId: outcomeEmailResult.queueMailId,
          }
        : {
            status: 'queue_failed',
            attemptedAtMs: outcomeEmailResult.attemptedAtMs,
            queueErrorMessage: outcomeEmailResult.queueErrorMessage,
            warningCode: outcomeEmailResult.warningCode,
          };

    await roleRequestRef.update({
      status: ROLE_REQUEST_STATUS_ACCEPTED,
      updatedAtMs: resolvedAtMs,
      resolvedAtMs,
      resolvedByUid,
      resolvedByEmail,
      resolutionNotification,
    });

    return {
      status: 'success',
      data: {
        roleRequestId,
        requesterUid: roleRequest.requesterUid,
        requestedRole: roleRequest.requestedRole,
        status: ROLE_REQUEST_STATUS_ACCEPTED,
        ...(outcomeEmailResult.status === 'queue_failed'
          ? {
              warning: {
                code: ROLE_REQUEST_EMAIL_ENQUEUE_FAILED,
                message: 'Role request accepted, but requester email could not be queued.',
              },
            }
          : {}),
      },
    };
  } catch (error) {
    handleError(error, {
      alertCode: 'ACCEPT_ROLE_REQUEST_RUNTIME_FAILURE',
      summary: 'acceptRoleRequest failed while resolving a role request.',
      request,
      context: { functionName: 'acceptRoleRequest', roleRequestId },
    });
    if (error instanceof Error) {
      return { status: 'error', error: error.message };
    }
    return { status: 'error', error: 'Failed to accept role request.' };
  }
};

const acceptrolerequest = onCall({ secrets: adminBaseUrlSecretsWithRuntimeAlerts }, acceptRoleRequestHandler);

export default acceptrolerequest;
