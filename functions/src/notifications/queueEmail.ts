import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { logger } from 'firebase-functions/v2';
import { QueueEmailInput } from './notificationTypes';

const MAIL_COLLECTION = 'mail';

const normalizeRecipients = (to: string[]): string[] => {
  const recipients = to.map((recipient) => recipient.trim()).filter((recipient) => recipient.length > 0);
  return Array.from(new Set(recipients));
};

export const queueEmail = async (input: QueueEmailInput): Promise<string> => {
  const recipients = normalizeRecipients(input.to);
  if (recipients.length === 0) {
    throw new Error('queueEmail requires at least one recipient.');
  }

  const queuedAtMs = Date.now();
  const mailRef = await firebaseAdmin.firestore().collection(MAIL_COLLECTION).add({
    to: recipients,
    message: input.message,
    meta: {
      source: input.source,
      alertType: input.alertType,
      alertCode: input.alertCode ?? null,
      queuedAtMs,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  });

  logger.info('notification email queued', {
    mailId: mailRef.id,
    source: input.source,
    alertType: input.alertType,
    recipientCount: recipients.length,
  });

  return mailRef.id;
};
