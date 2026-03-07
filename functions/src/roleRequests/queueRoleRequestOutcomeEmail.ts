import { logger } from 'firebase-functions/v2';
import { buildProfessionalEmailHtml, formatEmailDateTime } from '../notifications/emailTemplates';
import { getAdminBaseUrl } from '../notifications/notificationParams';
import { queueEmail } from '../notifications/queueEmail';
import {
  RequestableRoleType,
  ROLE_REQUEST_EMAIL_ENQUEUE_FAILED,
  ROLE_REQUEST_STATUS_ACCEPTED,
  ROLE_REQUEST_STATUS_DENIED,
} from './roleRequestTypes';

const EMAIL_BRAND_ICON_URL = 'https://uploader.upperroommedia.org/URM_icon.png';

type ResolutionStatus = typeof ROLE_REQUEST_STATUS_ACCEPTED | typeof ROLE_REQUEST_STATUS_DENIED;

const resolveAppHomeUrl = (): string => `${getAdminBaseUrl().replace(/\/+$/, '')}/`;

const buildOutcomeSubject = (status: ResolutionStatus): string =>
  status === ROLE_REQUEST_STATUS_ACCEPTED
    ? 'UpperRoom Media role request approved'
    : 'UpperRoom Media role request update';

const buildOutcomeText = (input: {
  requesterEmail: string;
  requestedRole: RequestableRoleType;
  status: ResolutionStatus;
  resolvedAtMs: number;
  appHomeUrl: string;
}): string => {
  const outcomeLabel = input.status === ROLE_REQUEST_STATUS_ACCEPTED ? 'Approved' : 'Denied';
  const nextStep =
    input.status === ROLE_REQUEST_STATUS_ACCEPTED
      ? `You can now sign in and access your approved permissions: ${input.appHomeUrl}`
      : 'If you need access, contact an administrator for further review.';

  return [
    'Your role request has been reviewed.',
    '',
    `Email: ${input.requesterEmail}`,
    `Requested role: ${input.requestedRole}`,
    `Outcome: ${outcomeLabel}`,
    `Reviewed at: ${formatEmailDateTime(input.resolvedAtMs)}`,
    '',
    nextStep,
  ].join('\n');
};

const buildOutcomeHtml = (input: {
  requesterEmail: string;
  requestedRole: RequestableRoleType;
  status: ResolutionStatus;
  resolvedAtMs: number;
  appHomeUrl: string;
}): string => {
  const approved = input.status === ROLE_REQUEST_STATUS_ACCEPTED;

  return buildProfessionalEmailHtml({
    preheader: approved ? 'Your role request was approved' : 'Your role request was reviewed',
    heading: approved ? 'Role request approved' : 'Role request denied',
    intro: approved
      ? 'Your access request was approved. You can sign in and continue working.'
      : 'Your access request was denied. Contact an administrator if you need additional context.',
    logoUrl: EMAIL_BRAND_ICON_URL,
    details: [
      { label: 'Email', value: input.requesterEmail },
      { label: 'Requested role', value: input.requestedRole },
      { label: 'Outcome', value: approved ? 'Approved' : 'Denied' },
      { label: 'Reviewed at', value: formatEmailDateTime(input.resolvedAtMs) },
    ],
    ...(approved
      ? {
          actionLabel: 'Open UpperRoom Media',
          actionUrl: input.appHomeUrl,
          actionHint: 'If the button does not open, use this link:',
        }
      : {}),
    footer: 'UpperRoom Media role request update',
  });
};

export const queueRoleRequestOutcomeEmail = async (input: {
  roleRequestId: string;
  requesterEmail: string;
  requestedRole: RequestableRoleType;
  status: ResolutionStatus;
  resolvedByUid: string;
  resolvedByEmail: string | null;
  resolvedAtMs: number;
}): Promise<
  | { status: 'queued'; queueMailId: string; attemptedAtMs: number }
  | { status: 'queue_failed'; attemptedAtMs: number; queueErrorMessage: string; warningCode: typeof ROLE_REQUEST_EMAIL_ENQUEUE_FAILED }
> => {
  const attemptedAtMs = Date.now();
  const appHomeUrl = resolveAppHomeUrl();
  try {
    const queueMailId = await queueEmail({
      to: [input.requesterEmail],
      source: 'role-request',
      alertType: input.status === ROLE_REQUEST_STATUS_ACCEPTED ? 'role-request-accepted' : 'role-request-denied',
      metadata: {
        roleRequestId: input.roleRequestId,
        requesterEmail: input.requesterEmail,
        requestedRole: input.requestedRole,
        outcome: input.status,
        resolvedByUid: input.resolvedByUid,
        resolvedByEmail: input.resolvedByEmail,
        resolvedAtMs: input.resolvedAtMs,
      },
      message: {
        subject: buildOutcomeSubject(input.status),
        text: buildOutcomeText({
          requesterEmail: input.requesterEmail,
          requestedRole: input.requestedRole,
          status: input.status,
          resolvedAtMs: input.resolvedAtMs,
          appHomeUrl,
        }),
        html: buildOutcomeHtml({
          requesterEmail: input.requesterEmail,
          requestedRole: input.requestedRole,
          status: input.status,
          resolvedAtMs: input.resolvedAtMs,
          appHomeUrl,
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
    logger.error('role request outcome email enqueue failed', {
      roleRequestId: input.roleRequestId,
      requesterEmail: input.requesterEmail,
      requestedRole: input.requestedRole,
      outcome: input.status,
      queueErrorMessage,
    });

    return {
      status: 'queue_failed',
      attemptedAtMs,
      queueErrorMessage,
      warningCode: ROLE_REQUEST_EMAIL_ENQUEUE_FAILED,
    };
  }
};
