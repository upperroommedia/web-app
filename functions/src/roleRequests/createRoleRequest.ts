import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import {
  buildProfessionalEmailHtml,
  formatEmailDateTime,
} from '../notifications/emailTemplates';
import { emitOperationalAlert } from '../notifications/emitOperationalAlert';
import { getAdminBaseUrl, getRoleRequestRecipients } from '../notifications/notificationParams';
import { roleRequestSecretsWithRuntimeAlerts } from '../notifications/notificationSecrets';
import { RoleRequestNotificationPayload } from '../notifications/notificationTypes';
import { queueEmail } from '../notifications/queueEmail';
import {
  buildRoleRequestAdminUrl,
  CreateRoleRequestInputType,
  CreateRoleRequestOutputType,
  PersistedRoleRequestDocument,
  ROLE_REQUEST_EMAIL_ENQUEUE_FAILED,
  ROLE_REQUESTS_COLLECTION,
  ROLE_REQUEST_STATUS_PENDING,
  RoleRequestNotificationState,
  validateCreateRoleRequestInput,
} from './roleRequestTypes';

const firestore = firebaseAdmin.firestore();

const readRequesterEmail = (request: CallableRequest<CreateRoleRequestInputType>): string | null => {
  const authEmail = request.auth?.token.email;
  if (typeof authEmail !== 'string') {
    return null;
  }
  const normalizedEmail = authEmail.trim().toLowerCase();
  return normalizedEmail.length > 0 ? normalizedEmail : null;
};

const readRequesterDisplayName = (request: CallableRequest<CreateRoleRequestInputType>): string | undefined => {
  const authName = request.auth?.token.name;
  if (typeof authName !== 'string') {
    return undefined;
  }
  const normalizedName = authName.trim();
  return normalizedName.length > 0 ? normalizedName : undefined;
};

const buildRoleRequestMessageText = (payload: RoleRequestNotificationPayload): string => {
  const requesterIdentity = payload.requesterDisplayName
    ? `${payload.requesterDisplayName} <${payload.requesterEmail}>`
    : payload.requesterEmail;

  return [
    'A new role request was submitted.',
    '',
    `Requester: ${requesterIdentity}`,
    `Requested role: ${payload.requestedRole}`,
    `Submitted at: ${formatEmailDateTime(payload.requestedAtMs)}`,
    `Reason: ${payload.reason}`,
    '',
    `Review request: ${payload.adminUrl}`,
  ].join('\n');
};

const buildRoleRequestMessageHtml = (payload: RoleRequestNotificationPayload): string => {
  const requesterIdentity = payload.requesterDisplayName
    ? `${payload.requesterDisplayName} <${payload.requesterEmail}>`
    : payload.requesterEmail;

  return buildProfessionalEmailHtml({
    preheader: `Role request from ${payload.requesterEmail}`,
    heading: 'New role request submitted',
    intro: 'A user submitted a role access request and is waiting for admin review.',
    details: [
      { label: 'Requester', value: requesterIdentity },
      { label: 'Requested role', value: payload.requestedRole },
      { label: 'Submitted at', value: formatEmailDateTime(payload.requestedAtMs) },
      { label: 'Reason', value: payload.reason },
    ],
    actionLabel: 'Review requests',
    actionUrl: payload.adminUrl,
    actionHint: 'Open this URL directly if the button does not work:',
    footer: 'UpperRoom Media admin notification',
  });
};

const listExistingRoleRequests = async (
  requesterUid: string
): Promise<Array<{ id: string; data: PersistedRoleRequestDocument }>> => {
  const snapshot = await firestore
    .collection(ROLE_REQUESTS_COLLECTION)
    .where('requesterUid', '==', requesterUid)
    .limit(25)
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() as PersistedRoleRequestDocument }));
};

const createRoleRequest = onCall(
  { secrets: roleRequestSecretsWithRuntimeAlerts },
  async (request: CallableRequest<CreateRoleRequestInputType>): Promise<CreateRoleRequestOutputType> => {
    const requesterUid = request.auth?.uid;
    if (!requesterUid) {
      return { status: 'error', error: 'Unauthorized.' };
    }

    const requesterEmail = readRequesterEmail(request);
    if (!requesterEmail) {
      return { status: 'error', error: 'Requester email is required.' };
    }

    const validation = validateCreateRoleRequestInput(request.data);
    if (!validation.ok) {
      return { status: 'error', error: validation.error };
    }

    const requesterDisplayName = readRequesterDisplayName(request);
    const adminUrl = buildRoleRequestAdminUrl(getAdminBaseUrl());
    const createdAtMs = Date.now();

    const existingRequests = await listExistingRoleRequests(requesterUid);
    const existing = existingRequests.find(
      ({ data }) =>
        data.status === ROLE_REQUEST_STATUS_PENDING &&
        data.requestedRole === validation.value.requestedRole
    );

    if (existing) {
      return {
        status: 'success',
        data: {
          roleRequestId: existing.id,
          requestStatus: 'existing',
          notification: {
            ...existing.data.notification,
            status: 'skipped_existing',
          },
        },
      };
    }

    const persistedRequest: PersistedRoleRequestDocument = {
      requesterUid,
      requesterEmail,
      ...(requesterDisplayName ? { requesterDisplayName } : {}),
      requestedRole: validation.value.requestedRole,
      reason: validation.value.reason,
      status: ROLE_REQUEST_STATUS_PENDING,
      createdAtMs,
      updatedAtMs: createdAtMs,
      adminUrl,
      notification: {
        status: 'not_attempted',
      },
    };

    const roleRequestRef = await firestore.collection(ROLE_REQUESTS_COLLECTION).add(persistedRequest);

    const roleRequestPayload: RoleRequestNotificationPayload = {
      requesterUid,
      requesterEmail,
      ...(requesterDisplayName ? { requesterDisplayName } : {}),
      requestedRole: validation.value.requestedRole,
      reason: validation.value.reason,
      requestedAtMs: createdAtMs,
      adminUrl,
    };

    const roleRequestRecipients = getRoleRequestRecipients();

    try {
      const mailId = await queueEmail({
        to: roleRequestRecipients,
        source: 'role-request',
        alertType: 'role-request-created',
        metadata: {
          roleRequestId: roleRequestRef.id,
          requesterUid,
          requesterEmail,
          requestedRole: validation.value.requestedRole,
          reason: validation.value.reason,
          requestedAtMs: createdAtMs,
          adminUrl,
        },
        message: {
          subject: `[URM] Role request: ${validation.value.requestedRole}`,
          text: buildRoleRequestMessageText(roleRequestPayload),
          html: buildRoleRequestMessageHtml(roleRequestPayload),
        },
      });

      const notificationState: RoleRequestNotificationState = {
        status: 'queued',
        attemptedAtMs: Date.now(),
        queueMailId: mailId,
      };

      await roleRequestRef.update({
        updatedAtMs: Date.now(),
        notification: notificationState,
      });

      return {
        status: 'success',
        data: {
          roleRequestId: roleRequestRef.id,
          requestStatus: 'created',
          notification: notificationState,
        },
      };
    } catch (error) {
      const queueErrorMessage = error instanceof Error ? error.message : 'Unknown queue error';
      const notificationState: RoleRequestNotificationState = {
        status: 'queue_failed',
        attemptedAtMs: Date.now(),
        queueErrorMessage,
        warningCode: ROLE_REQUEST_EMAIL_ENQUEUE_FAILED,
      };

      await roleRequestRef.update({
        updatedAtMs: Date.now(),
        notification: notificationState,
      });

      try {
        await emitOperationalAlert({
          alertCode: ROLE_REQUEST_EMAIL_ENQUEUE_FAILED,
          summary: 'Failed to enqueue role-request notification email.',
          error,
          context: {
            functionName: 'createRoleRequest',
            roleRequestId: roleRequestRef.id,
            requesterUid,
            requesterEmail,
            requestedRole: validation.value.requestedRole,
            requestedAtMs: createdAtMs,
          },
        });
      } catch (alertError) {
        logger.error('failed to emit role-request queue failure alert', {
          roleRequestId: roleRequestRef.id,
          queueErrorMessage,
          alertError: alertError instanceof Error ? alertError.message : String(alertError),
        });
      }

      return {
        status: 'success',
        data: {
          roleRequestId: roleRequestRef.id,
          requestStatus: 'created',
          notification: notificationState,
          warning: {
            code: ROLE_REQUEST_EMAIL_ENQUEUE_FAILED,
            message: 'Role request persisted, but notification enqueue failed.',
          },
        },
      };
    }
  }
);

export default createRoleRequest;
