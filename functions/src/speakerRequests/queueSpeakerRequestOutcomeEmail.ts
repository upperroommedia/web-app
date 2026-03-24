import { logger } from 'firebase-functions/v2';
import { buildProfessionalEmailHtml, formatEmailDateTime } from '../notifications/emailTemplates';
import { getAdminBaseUrl } from '../notifications/notificationParams';
import { queueEmail } from '../notifications/queueEmail';
import {
  SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED,
  SPEAKER_REQUEST_STATUS_ACCEPTED,
  SPEAKER_REQUEST_STATUS_DENIED,
} from './speakerRequestTypes';

const EMAIL_BRAND_ICON_URL = 'https://uploader.upperroommedia.org/URM_icon.png';

type ResolutionStatus = typeof SPEAKER_REQUEST_STATUS_ACCEPTED | typeof SPEAKER_REQUEST_STATUS_DENIED;

const resolveUploadPageUrl = (): string => `${getAdminBaseUrl().replace(/\/+$/, '')}/`;

const buildOutcomeSubject = (status: ResolutionStatus): string =>
  status === SPEAKER_REQUEST_STATUS_ACCEPTED
    ? 'UpperRoom Media speaker request approved'
    : 'UpperRoom Media speaker request update';

const buildOutcomeText = (input: {
  requesterEmail: string;
  speakerName: string;
  status: ResolutionStatus;
  resolvedAtMs: number;
  uploadPageUrl: string;
  message?: string;
}): string => {
  const outcomeLabel = input.status === SPEAKER_REQUEST_STATUS_ACCEPTED ? 'Approved' : 'Denied';
  const nextStep =
    input.status === SPEAKER_REQUEST_STATUS_ACCEPTED
      ? `The speaker has been added. You can return to the upload page here: ${input.uploadPageUrl}`
      : `Admin response: ${input.message ?? 'No additional message was provided.'}`;

  return [
    'Your speaker request has been reviewed.',
    '',
    `Email: ${input.requesterEmail}`,
    `Speaker: ${input.speakerName}`,
    `Outcome: ${outcomeLabel}`,
    `Reviewed at: ${formatEmailDateTime(input.resolvedAtMs)}`,
    '',
    nextStep,
  ].join('\n');
};

const buildOutcomeHtml = (input: {
  requesterEmail: string;
  speakerName: string;
  status: ResolutionStatus;
  resolvedAtMs: number;
  uploadPageUrl: string;
  message?: string;
}): string => {
  const approved = input.status === SPEAKER_REQUEST_STATUS_ACCEPTED;

  return buildProfessionalEmailHtml({
    preheader: approved ? 'Your speaker request was approved' : 'Your speaker request was reviewed',
    heading: approved ? 'Speaker request approved' : 'Speaker request denied',
    intro: approved
      ? 'Your requested speaker has been added and is ready to use on the uploader page.'
      : 'Your speaker request was reviewed by an admin.',
    logoUrl: EMAIL_BRAND_ICON_URL,
    details: [
      { label: 'Email', value: input.requesterEmail },
      { label: 'Speaker', value: input.speakerName },
      { label: 'Outcome', value: approved ? 'Approved' : 'Denied' },
      { label: 'Reviewed at', value: formatEmailDateTime(input.resolvedAtMs) },
      ...(!approved && input.message ? [{ label: 'Admin response', value: input.message }] : []),
    ],
    ...(approved
      ? {
          actionLabel: 'Open Upload Page',
          actionUrl: input.uploadPageUrl,
          actionHint: 'If the button does not open, use this link:',
        }
      : {}),
    footer: 'UpperRoom Media speaker request update',
  });
};

export const queueSpeakerRequestOutcomeEmail = async (input: {
  speakerRequestId: string;
  requesterEmail: string;
  speakerName: string;
  status: ResolutionStatus;
  resolvedByUid: string;
  resolvedByEmail: string | null;
  resolvedAtMs: number;
  message?: string;
  speakerId?: string;
}): Promise<
  | { status: 'queued'; queueMailId: string; attemptedAtMs: number }
  | { status: 'queue_failed'; attemptedAtMs: number; queueErrorMessage: string; warningCode: typeof SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED }
> => {
  const attemptedAtMs = Date.now();
  const uploadPageUrl = resolveUploadPageUrl();
  try {
    const queueMailId = await queueEmail({
      to: [input.requesterEmail],
      source: 'speaker-request',
      alertType:
        input.status === SPEAKER_REQUEST_STATUS_ACCEPTED ? 'speaker-request-accepted' : 'speaker-request-denied',
      metadata: {
        speakerRequestId: input.speakerRequestId,
        requesterEmail: input.requesterEmail,
        speakerName: input.speakerName,
        outcome: input.status,
        resolvedByUid: input.resolvedByUid,
        resolvedByEmail: input.resolvedByEmail,
        resolvedAtMs: input.resolvedAtMs,
        ...(input.message ? { message: input.message } : {}),
        ...(input.speakerId ? { speakerId: input.speakerId } : {}),
      },
      message: {
        subject: buildOutcomeSubject(input.status),
        text: buildOutcomeText({
          requesterEmail: input.requesterEmail,
          speakerName: input.speakerName,
          status: input.status,
          resolvedAtMs: input.resolvedAtMs,
          uploadPageUrl,
          message: input.message,
        }),
        html: buildOutcomeHtml({
          requesterEmail: input.requesterEmail,
          speakerName: input.speakerName,
          status: input.status,
          resolvedAtMs: input.resolvedAtMs,
          uploadPageUrl,
          message: input.message,
        }),
      },
    });

    return {
      status: 'queued',
      queueMailId,
      attemptedAtMs,
    };
  } catch (error) {
    const queueErrorMessage = error instanceof Error ? error.message : 'Unknown queue error';
    logger.error('speaker request outcome email enqueue failed', {
      speakerRequestId: input.speakerRequestId,
      requesterEmail: input.requesterEmail,
      speakerName: input.speakerName,
      outcome: input.status,
      queueErrorMessage,
    });

    return {
      status: 'queue_failed',
      attemptedAtMs,
      queueErrorMessage,
      warningCode: SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED,
    };
  }
};
