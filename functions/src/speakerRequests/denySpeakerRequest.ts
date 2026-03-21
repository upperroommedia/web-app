import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import { adminBaseUrlSecretsWithRuntimeAlerts } from '../notifications/notificationSecrets';
import handleError from '../handleError';
import {
  DenySpeakerRequestInputType,
  DenySpeakerRequestOutputType,
  PersistedSpeakerRequestDocument,
  SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED,
  SPEAKER_REQUESTS_COLLECTION,
  SPEAKER_REQUEST_STATUS_DENIED,
  SPEAKER_REQUEST_STATUS_PENDING,
  SpeakerRequestNotificationState,
  validateDenySpeakerRequestInput,
} from './speakerRequestTypes';
import { queueSpeakerRequestOutcomeEmail } from './queueSpeakerRequestOutcomeEmail';

const isAdmin = (request: CallableRequest<unknown>): boolean =>
  request.auth?.token.role === 'admin' && typeof request.auth.uid === 'string';

export const denySpeakerRequestHandler = async (
  request: CallableRequest<DenySpeakerRequestInputType>
): Promise<DenySpeakerRequestOutputType> => {
  if (!isAdmin(request)) {
    return { status: 'error', error: 'Not Authorized' };
  }

  const validation = validateDenySpeakerRequestInput(request.data);
  if (!validation.ok) {
    return { status: 'error', error: validation.error };
  }

  const { speakerRequestId, message } = validation.value;
  const speakerRequestRef = firebaseAdmin.firestore().collection(SPEAKER_REQUESTS_COLLECTION).doc(speakerRequestId);
  const speakerRequestSnapshot = await speakerRequestRef.get();

  if (!speakerRequestSnapshot.exists) {
    return { status: 'error', error: 'Speaker request not found.' };
  }

  const speakerRequest = speakerRequestSnapshot.data() as PersistedSpeakerRequestDocument | undefined;
  if (!speakerRequest || typeof speakerRequest !== 'object') {
    return { status: 'error', error: 'Speaker request payload is invalid.' };
  }

  if (speakerRequest.status !== SPEAKER_REQUEST_STATUS_PENDING) {
    return { status: 'error', error: `Speaker request is already ${speakerRequest.status}.` };
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

    const outcomeEmailResult = await queueSpeakerRequestOutcomeEmail({
      speakerRequestId,
      requesterEmail: speakerRequest.requesterEmail,
      speakerName: speakerRequest.speakerName,
      status: SPEAKER_REQUEST_STATUS_DENIED,
      resolvedByUid,
      resolvedByEmail,
      resolvedAtMs,
      message,
    });

    const resolutionNotification: SpeakerRequestNotificationState =
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

    await speakerRequestRef.update({
      status: SPEAKER_REQUEST_STATUS_DENIED,
      updatedAtMs: resolvedAtMs,
      resolvedAtMs,
      resolvedByUid,
      resolvedByEmail,
      declineMessage: message,
      resolutionNotification,
    });

    return {
      status: 'success',
      data: {
        speakerRequestId,
        requesterUid: speakerRequest.requesterUid,
        speakerName: speakerRequest.speakerName,
        status: SPEAKER_REQUEST_STATUS_DENIED,
        ...(outcomeEmailResult.status === 'queue_failed'
          ? {
              warning: {
                code: SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED,
                message: 'Speaker request denied, but requester email could not be queued.',
              },
            }
          : {}),
      },
    };
  } catch (error) {
    handleError(error, {
      alertCode: 'DENY_SPEAKER_REQUEST_RUNTIME_FAILURE',
      summary: 'denySpeakerRequest failed while resolving a speaker request.',
      request,
      context: { functionName: 'denySpeakerRequest', speakerRequestId },
    });
    if (error instanceof Error) {
      return { status: 'error', error: error.message };
    }
    return { status: 'error', error: 'Failed to deny speaker request.' };
  }
};

const denyspeakerrequest = onCall({ secrets: adminBaseUrlSecretsWithRuntimeAlerts }, denySpeakerRequestHandler);

export default denyspeakerrequest;
