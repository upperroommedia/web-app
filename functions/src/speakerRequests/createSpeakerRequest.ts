import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import { buildProfessionalEmailHtml, formatEmailDateTime } from '../notifications/emailTemplates';
import { emitOperationalAlert } from '../notifications/emitOperationalAlert';
import { getAdminBaseUrl, getAdminRequestRecipients } from '../notifications/notificationParams';
import { adminRequestSecretsWithRuntimeAlerts } from '../notifications/notificationSecrets';
import { SpeakerRequestNotificationPayload } from '../notifications/notificationTypes';
import { queueEmail } from '../notifications/queueEmail';
import {
  buildSpeakerRequestAdminUrl,
  CreateSpeakerRequestInputType,
  CreateSpeakerRequestOutputType,
  normalizeSpeakerRequestNameForDuplicateCheck,
  PersistedSpeakerRequestDocument,
  SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED,
  SPEAKER_REQUESTS_COLLECTION,
  SPEAKER_REQUEST_STATUS_PENDING,
  SpeakerRequestNotificationState,
  validateCreateSpeakerRequestInput,
} from './speakerRequestTypes';

const firestore = firebaseAdmin.firestore();
const EMAIL_BRAND_ICON_URL = 'https://uploader.upperroommedia.org/URM_icon.png';

const readRequesterEmail = (request: CallableRequest<CreateSpeakerRequestInputType>): string | null => {
  const authEmail = request.auth?.token.email;
  if (typeof authEmail !== 'string') {
    return null;
  }
  const normalizedEmail = authEmail.trim().toLowerCase();
  return normalizedEmail.length > 0 ? normalizedEmail : null;
};

const readRequesterDisplayName = (request: CallableRequest<CreateSpeakerRequestInputType>): string | undefined => {
  const authName = request.auth?.token.name;
  if (typeof authName !== 'string') {
    return undefined;
  }
  const normalizedName = authName.trim();
  return normalizedName.length > 0 ? normalizedName : undefined;
};

const buildAdminMessageText = (payload: SpeakerRequestNotificationPayload): string => {
  const requesterIdentity = payload.requesterDisplayName
    ? `${payload.requesterDisplayName} <${payload.requesterEmail}>`
    : payload.requesterEmail;

  return [
    'A new speaker request was submitted.',
    '',
    `Requester: ${requesterIdentity}`,
    `Speaker name: ${payload.speakerName}`,
    `Submitted at: ${formatEmailDateTime(payload.requestedAtMs)}`,
    `Description: ${payload.description}`,
    `Image: ${payload.image.downloadLink}`,
    '',
    `Review request: ${payload.adminUrl}`,
  ].join('\n');
};

const buildAdminMessageHtml = (payload: SpeakerRequestNotificationPayload): string =>
  buildProfessionalEmailHtml({
    preheader: `Speaker request from ${payload.requesterEmail}`,
    heading: 'New speaker request submitted',
    intro: 'A user submitted a request for a new speaker and is waiting for admin review.',
    details: [
      {
        label: 'Requester',
        value: payload.requesterDisplayName
          ? `${payload.requesterDisplayName} <${payload.requesterEmail}>`
          : payload.requesterEmail,
      },
      { label: 'Speaker name', value: payload.speakerName },
      { label: 'Submitted at', value: formatEmailDateTime(payload.requestedAtMs) },
      { label: 'Description', value: payload.description },
    ],
    imageUrl: payload.image.downloadLink,
    imageAlt: `${payload.speakerName} request image`,
    imageCaption: 'Submitted speaker image',
    actionLabel: 'Review speaker requests',
    actionUrl: payload.adminUrl,
    actionHint: 'Open this URL directly if the button does not work:',
    footer: 'UpperRoom Media admin notification',
  });

const buildConfirmationMessageText = (payload: {
  requesterEmail: string;
  speakerName: string;
  description: string;
  requestedAtMs: number;
  image: SpeakerRequestNotificationPayload['image'];
}): string =>
  [
    'Your speaker request has been received.',
    '',
    `Email: ${payload.requesterEmail}`,
    `Speaker name: ${payload.speakerName}`,
    `Submitted at: ${formatEmailDateTime(payload.requestedAtMs)}`,
    `Description: ${payload.description}`,
    '',
    'An admin will review the request and follow up by email.',
  ].join('\n');

const buildConfirmationMessageHtml = (payload: {
  requesterEmail: string;
  speakerName: string;
  description: string;
  requestedAtMs: number;
  image: SpeakerRequestNotificationPayload['image'];
}): string =>
  buildProfessionalEmailHtml({
    preheader: 'We received your speaker request',
    heading: 'Speaker request received',
    intro: 'Your request has been sent to an admin and will be reviewed shortly.',
    logoUrl: EMAIL_BRAND_ICON_URL,
    details: [
      { label: 'Email', value: payload.requesterEmail },
      { label: 'Speaker name', value: payload.speakerName },
      { label: 'Submitted at', value: formatEmailDateTime(payload.requestedAtMs) },
      { label: 'Description', value: payload.description },
    ],
    imageUrl: payload.image.downloadLink,
    imageAlt: `${payload.speakerName} request image`,
    imageCaption: 'Submitted speaker image',
    footer: 'UpperRoom Media speaker request confirmation',
  });

const listExistingSpeakerRequests = async (
  requesterUid: string
): Promise<Array<{ id: string; data: PersistedSpeakerRequestDocument }>> => {
  const snapshot = await firestore
    .collection(SPEAKER_REQUESTS_COLLECTION)
    .where('requesterUid', '==', requesterUid)
    .limit(25)
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() as PersistedSpeakerRequestDocument }));
};

const createSpeakerRequest = onCall(
  { secrets: adminRequestSecretsWithRuntimeAlerts },
  async (request: CallableRequest<CreateSpeakerRequestInputType>): Promise<CreateSpeakerRequestOutputType> => {
    const requesterUid = request.auth?.uid;
    if (!requesterUid) {
      return { status: 'error', error: 'Unauthorized.' };
    }

    const requesterEmail = readRequesterEmail(request);
    if (!requesterEmail) {
      return { status: 'error', error: 'Requester email is required.' };
    }

    const validation = validateCreateSpeakerRequestInput(request.data);
    if (!validation.ok) {
      return { status: 'error', error: validation.error };
    }

    const requesterDisplayName = readRequesterDisplayName(request);
    const adminUrl = buildSpeakerRequestAdminUrl(getAdminBaseUrl());
    const createdAtMs = Date.now();

    const existingRequests = await listExistingSpeakerRequests(requesterUid);
    const normalizedName = normalizeSpeakerRequestNameForDuplicateCheck(validation.value.speakerName);
    const existing = existingRequests.find(
      ({ data }) =>
        data.status === SPEAKER_REQUEST_STATUS_PENDING &&
        normalizeSpeakerRequestNameForDuplicateCheck(data.speakerName) === normalizedName
    );

    if (existing) {
      return {
        status: 'success',
        data: {
          speakerRequestId: existing.id,
          requestStatus: 'existing',
          notification: {
            ...existing.data.notification,
            status: 'skipped_existing',
          },
          confirmationNotification: {
            ...existing.data.notification,
            status: 'skipped_existing',
          },
        },
      };
    }

    const persistedRequest: PersistedSpeakerRequestDocument = {
      requesterUid,
      requesterEmail,
      ...(requesterDisplayName ? { requesterDisplayName } : {}),
      speakerName: validation.value.speakerName,
      description: validation.value.description,
      image: validation.value.image,
      status: SPEAKER_REQUEST_STATUS_PENDING,
      createdAtMs,
      updatedAtMs: createdAtMs,
      adminUrl,
      notification: {
        status: 'not_attempted',
      },
    };

    const speakerRequestRef = await firestore.collection(SPEAKER_REQUESTS_COLLECTION).add(persistedRequest);

    const notificationPayload: SpeakerRequestNotificationPayload = {
      requesterUid,
      requesterEmail,
      ...(requesterDisplayName ? { requesterDisplayName } : {}),
      speakerName: validation.value.speakerName,
      description: validation.value.description,
      image: validation.value.image,
      requestedAtMs: createdAtMs,
      adminUrl,
    };

    let adminNotificationState: SpeakerRequestNotificationState = { status: 'not_attempted' };
    let confirmationNotificationState: SpeakerRequestNotificationState = { status: 'not_attempted' };
    const warnings: string[] = [];

    const adminRequestRecipients = getAdminRequestRecipients();

    try {
      const adminMailId = await queueEmail({
        to: adminRequestRecipients,
        source: 'speaker-request',
        alertType: 'speaker-request-created',
        metadata: {
          speakerRequestId: speakerRequestRef.id,
          requesterUid,
          requesterEmail,
          speakerName: validation.value.speakerName,
          description: validation.value.description,
          imageUrl: validation.value.image.downloadLink,
          requestedAtMs: createdAtMs,
          adminUrl,
        },
        message: {
          subject: `[URM] Speaker request: ${validation.value.speakerName}`,
          text: buildAdminMessageText(notificationPayload),
          html: buildAdminMessageHtml(notificationPayload),
        },
      });

      adminNotificationState = {
        status: 'queued',
        attemptedAtMs: Date.now(),
        queueMailId: adminMailId,
      };
    } catch (error) {
      const queueErrorMessage = error instanceof Error ? error.message : 'Unknown queue error';
      adminNotificationState = {
        status: 'queue_failed',
        attemptedAtMs: Date.now(),
        queueErrorMessage,
        warningCode: SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED,
      };
      warnings.push('admin');
      try {
        await emitOperationalAlert({
          alertCode: SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED,
          summary: 'Failed to enqueue speaker-request admin notification email.',
          error,
          context: {
            functionName: 'createSpeakerRequest',
            speakerRequestId: speakerRequestRef.id,
            requesterUid,
            requesterEmail,
            speakerName: validation.value.speakerName,
            requestedAtMs: createdAtMs,
          },
        });
      } catch (alertError) {
        logger.error('failed to emit speaker-request admin queue failure alert', {
          speakerRequestId: speakerRequestRef.id,
          queueErrorMessage,
          alertError: alertError instanceof Error ? alertError.message : String(alertError),
        });
      }
    }

    try {
      const confirmationMailId = await queueEmail({
        to: [requesterEmail],
        source: 'speaker-request',
        alertType: 'speaker-request-confirmation',
        metadata: {
          speakerRequestId: speakerRequestRef.id,
          requesterUid,
          requesterEmail,
          speakerName: validation.value.speakerName,
          requestedAtMs: createdAtMs,
        },
        message: {
          subject: 'UpperRoom Media speaker request received',
          text: buildConfirmationMessageText({
            requesterEmail,
            speakerName: validation.value.speakerName,
            description: validation.value.description,
            requestedAtMs: createdAtMs,
            image: validation.value.image,
          }),
          html: buildConfirmationMessageHtml({
            requesterEmail,
            speakerName: validation.value.speakerName,
            description: validation.value.description,
            requestedAtMs: createdAtMs,
            image: validation.value.image,
          }),
        },
      });

      confirmationNotificationState = {
        status: 'queued',
        attemptedAtMs: Date.now(),
        queueMailId: confirmationMailId,
      };
    } catch (error) {
      const queueErrorMessage = error instanceof Error ? error.message : 'Unknown queue error';
      confirmationNotificationState = {
        status: 'queue_failed',
        attemptedAtMs: Date.now(),
        queueErrorMessage,
        warningCode: SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED,
      };
      warnings.push('confirmation');
      try {
        await emitOperationalAlert({
          alertCode: SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED,
          summary: 'Failed to enqueue speaker-request confirmation email.',
          error,
          context: {
            functionName: 'createSpeakerRequest',
            speakerRequestId: speakerRequestRef.id,
            requesterUid,
            requesterEmail,
            speakerName: validation.value.speakerName,
            requestedAtMs: createdAtMs,
          },
        });
      } catch (alertError) {
        logger.error('failed to emit speaker-request confirmation queue failure alert', {
          speakerRequestId: speakerRequestRef.id,
          queueErrorMessage,
          alertError: alertError instanceof Error ? alertError.message : String(alertError),
        });
      }
    }

    await speakerRequestRef.update({
      updatedAtMs: Date.now(),
      notification: adminNotificationState,
      confirmationNotification: confirmationNotificationState,
    });

    return {
      status: 'success',
      data: {
        speakerRequestId: speakerRequestRef.id,
        requestStatus: 'created',
        notification: adminNotificationState,
        confirmationNotification: confirmationNotificationState,
        ...(warnings.length > 0
          ? {
              warning: {
                code: SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED,
                message: 'Speaker request persisted, but one or more emails could not be queued.',
              },
            }
          : {}),
      },
    };
  }
);

export default createSpeakerRequest;
