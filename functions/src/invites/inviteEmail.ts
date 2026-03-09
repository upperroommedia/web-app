import { logger } from 'firebase-functions/v2';
import {
  buildProfessionalEmailHtml,
  formatEmailDateTime,
} from '../notifications/emailTemplates';
import { getAdminBaseUrl } from '../notifications/notificationParams';
import { queueEmail } from '../notifications/queueEmail';
import {
  INVITE_EMAIL_ENQUEUE_FAILED,
  InviteEmailState,
  InviteEmailStatus,
  InviteRoleType,
} from './inviteTypes';

export const buildInviteClaimUrl = (token: string): string => {
  const baseUrl = getAdminBaseUrl().replace(/\/+$/, '');
  return `${baseUrl}/invite/claim?token=${encodeURIComponent(token)}`;
};

const EMAIL_BRAND_ICON_URL = 'https://uploader.upperroommedia.org/URM_icon.png';

const buildInviteEmailMessageText = ({
  invitedEmail,
  invitedRole,
  inviteUrl,
  expiresAtMs,
}: {
  invitedEmail: string;
  invitedRole: InviteRoleType;
  inviteUrl: string;
  expiresAtMs: number;
}): string =>
  [
    'You have been invited to UpperRoom Media.',
    '',
    `Recipient: ${invitedEmail}`,
    `Requested role: ${invitedRole}`,
    `Expires: ${formatEmailDateTime(expiresAtMs)}`,
    '',
    `Claim invite: ${inviteUrl}`,
    '',
    'If this invite was not expected, you can safely ignore this email.',
  ].join('\n');

const buildInviteEmailMessageHtml = ({
  invitedEmail,
  invitedRole,
  inviteUrl,
  expiresAtMs,
}: {
  invitedEmail: string;
  invitedRole: InviteRoleType;
  inviteUrl: string;
  expiresAtMs: number;
}): string =>
  buildProfessionalEmailHtml({
    preheader: `Role invite for ${invitedEmail}`,
    heading: 'You are invited to UpperRoom Media',
    intro: 'Use the button below to claim your invite and activate your role access.',
    logoUrl: EMAIL_BRAND_ICON_URL,
    details: [
      { label: 'Invited email', value: invitedEmail },
      { label: 'Requested role', value: invitedRole },
      { label: 'Expires', value: formatEmailDateTime(expiresAtMs) },
    ],
    actionLabel: 'Claim invite',
    actionUrl: inviteUrl,
    actionHint: 'If the button does not open, copy and paste this URL into your browser:',
    footer: 'This invite expires automatically and can only be claimed by the invited email address.',
  });

export const queueInviteEmail = async ({
  inviteId,
  invitedEmail,
  invitedRole,
  inviteUrl,
  expiresAtMs,
}: {
  inviteId: string;
  invitedEmail: string;
  invitedRole: InviteRoleType;
  inviteUrl: string;
  expiresAtMs: number;
}): Promise<InviteEmailState> => {
  const attemptedAtMs = Date.now();
  try {
    const queueMailId = await queueEmail({
      to: [invitedEmail],
      source: 'role-request',
      alertType: 'invite-issued',
      metadata: {
        inviteId,
        invitedEmail,
        invitedRole,
        expiresAtMs,
      },
      message: {
        subject: 'UpperRoom Media invite',
        text: buildInviteEmailMessageText({
          invitedEmail,
          invitedRole,
          inviteUrl,
          expiresAtMs,
        }),
        html: buildInviteEmailMessageHtml({
          invitedEmail,
          invitedRole,
          inviteUrl,
          expiresAtMs,
        }),
      },
    });

    return {
      status: InviteEmailStatus.QUEUED,
      attemptedAtMs,
      queueMailId,
    };
  } catch (error) {
    const queueErrorMessage = error instanceof Error ? error.message : 'Unknown queue error';
    logger.error('invite email enqueue failed', {
      inviteId,
      invitedEmail,
      invitedRole,
      queueErrorMessage,
    });
    return {
      status: InviteEmailStatus.QUEUE_FAILED,
      attemptedAtMs,
      queueErrorMessage,
      warningCode: INVITE_EMAIL_ENQUEUE_FAILED,
    };
  }
};
