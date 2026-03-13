import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import { adminBaseUrlSecret } from '../notifications/notificationSecrets';
import handleError from '../handleError';
import {
  DenyRoleRequestInputType,
  DenyRoleRequestOutputType,
  PersistedRoleRequestDocument,
  RoleRequestNotificationState,
  ROLE_REQUEST_EMAIL_ENQUEUE_FAILED,
  ROLE_REQUESTS_COLLECTION,
  ROLE_REQUEST_STATUS_DENIED,
  ROLE_REQUEST_STATUS_PENDING,
} from './roleRequestTypes';
import { queueRoleRequestOutcomeEmail } from './queueRoleRequestOutcomeEmail';

const isAdmin = (request: CallableRequest<unknown>): boolean =>
  request.auth?.token.role === 'admin' && typeof request.auth.uid === 'string';

export const denyRoleRequestHandler = async (
  request: CallableRequest<DenyRoleRequestInputType>
): Promise<DenyRoleRequestOutputType> => {
  if (!isAdmin(request)) {
    return { status: 'error', error: 'Not Authorized' };
  }

  const roleRequestId = request.data?.roleRequestId?.trim();
  if (!roleRequestId) {
    return { status: 'error', error: 'Role request id is required.' };
  }

  const roleRequestRef = firebaseAdmin.firestore().collection(ROLE_REQUESTS_COLLECTION).doc(roleRequestId);
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
      status: ROLE_REQUEST_STATUS_DENIED,
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
      status: ROLE_REQUEST_STATUS_DENIED,
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
        status: ROLE_REQUEST_STATUS_DENIED,
        ...(outcomeEmailResult.status === 'queue_failed'
          ? {
              warning: {
                code: ROLE_REQUEST_EMAIL_ENQUEUE_FAILED,
                message: 'Role request denied, but requester email could not be queued.',
              },
            }
          : {}),
      },
    };
  } catch (error) {
    handleError(error, {
      alertCode: 'DENY_ROLE_REQUEST_RUNTIME_FAILURE',
      summary: 'denyRoleRequest failed while resolving a role request.',
      context: { functionName: 'denyRoleRequest', roleRequestId },
    });
    if (error instanceof Error) {
      return { status: 'error', error: error.message };
    }
    return { status: 'error', error: 'Failed to deny role request.' };
  }
};

const denyrolerequest = onCall({ secrets: [adminBaseUrlSecret] }, denyRoleRequestHandler);

export default denyrolerequest;
