import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import { adminBaseUrlSecretsWithRuntimeAlerts } from '../notifications/notificationSecrets';
import handleError from '../handleError';
import {
  AcceptSpeakerRequestInputType,
  AcceptSpeakerRequestOutputType,
  PersistedSpeakerRequestDocument,
  SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED,
  SPEAKER_REQUESTS_COLLECTION,
  SPEAKER_REQUEST_STATUS_ACCEPTED,
  SPEAKER_REQUEST_STATUS_PENDING,
  SpeakerRequestNotificationState,
} from './speakerRequestTypes';
import { queueSpeakerRequestOutcomeEmail } from './queueSpeakerRequestOutcomeEmail';
import { createSpeakerMutation } from '../speakers/speakerMutations';
import { requireSquareImage, requireTrimmedSpeakerName } from '../speakers/speakerMutations';

const isAdmin = (request: CallableRequest<unknown>): boolean =>
  request.auth?.token.role === 'admin' && typeof request.auth.uid === 'string';

export const acceptSpeakerRequestHandler = async (
  request: CallableRequest<AcceptSpeakerRequestInputType>
): Promise<AcceptSpeakerRequestOutputType> => {
  if (!isAdmin(request)) {
    return { status: 'error', error: 'Not Authorized' };
  }

  const speakerRequestId = request.data?.speakerRequestId?.trim();
  if (!speakerRequestId) {
    return { status: 'error', error: 'Speaker request id is required.' };
  }

  const firestore = firebaseAdmin.firestore();
  const speakerRequestRef = firestore.collection(SPEAKER_REQUESTS_COLLECTION).doc(speakerRequestId);
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
    const speakerName = requireTrimmedSpeakerName(request.data?.speaker?.name);
    requireSquareImage(request.data?.speaker?.images);
    const createSpeakerResult = await createSpeakerMutation({
      speaker: {
        name: speakerName,
        description: request.data?.speaker?.description,
        shortDescription: request.data?.speaker?.shortDescription,
        images: request.data?.speaker?.images ?? [],
      },
      createSpeakerList: request.data?.createSpeakerList === true,
      operationKey: `speaker-request:${speakerRequestId}`,
    });

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
      speakerId: createSpeakerResult.speakerId,
      status: SPEAKER_REQUEST_STATUS_ACCEPTED,
      resolvedByUid,
      resolvedByEmail,
      resolvedAtMs,
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
      status: SPEAKER_REQUEST_STATUS_ACCEPTED,
      updatedAtMs: resolvedAtMs,
      resolvedAtMs,
      resolvedByUid,
      resolvedByEmail,
      speakerId: createSpeakerResult.speakerId,
      speakerNameAtResolution: createSpeakerResult.speaker.name,
      resolutionNotification,
    });

    return {
      status: 'success',
      data: {
        speakerRequestId,
        requesterUid: speakerRequest.requesterUid,
        speakerName: speakerRequest.speakerName,
        speakerId: createSpeakerResult.speakerId,
        status: SPEAKER_REQUEST_STATUS_ACCEPTED,
        speakerListCreated: createSpeakerResult.speakerListCreated === true,
        ...(outcomeEmailResult.status === 'queue_failed'
          ? {
              warning: {
                code: SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED,
                message: 'Speaker request accepted, but requester email could not be queued.',
              },
            }
          : {}),
      },
    };
  } catch (error) {
    handleError(error, {
      alertCode: 'ACCEPT_SPEAKER_REQUEST_RUNTIME_FAILURE',
      summary: 'acceptSpeakerRequest failed while resolving a speaker request.',
      request,
      context: { functionName: 'acceptSpeakerRequest', speakerRequestId },
    });
    if (error instanceof Error) {
      return { status: 'error', error: error.message };
    }
    return { status: 'error', error: 'Failed to accept speaker request.' };
  }
};

const acceptspeakerrequest = onCall({ secrets: adminBaseUrlSecretsWithRuntimeAlerts }, acceptSpeakerRequestHandler);

export default acceptspeakerrequest;
