import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { logger } from 'firebase-functions/v2';
import { QueueEmailInput } from './notificationTypes';

const MAIL_COLLECTION = 'mail';
const STAGING_PROJECT_ID = 'urm-app-staging';
const STAGING_SUBJECT_PREFIX = '[STAGING]';

const normalizeRecipients = (to: string[]): string[] => {
  const recipients = to.map((recipient) => recipient.trim()).filter((recipient) => recipient.length > 0);
  return Array.from(new Set(recipients));
};

const getProjectId = (): string =>
  process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || '';

const isStagingProject = (): boolean => getProjectId() === STAGING_PROJECT_ID;

const applyStagingSubjectPrefix = (subject: string): string => {
  if (!isStagingProject()) {
    return subject;
  }

  if (subject.startsWith(`${STAGING_SUBJECT_PREFIX} `)) {
    return subject;
  }

  return `${STAGING_SUBJECT_PREFIX} ${subject}`;
};

export const queueEmail = async (input: QueueEmailInput): Promise<string> => {
  const recipients = normalizeRecipients(input.to);
  if (recipients.length === 0) {
    throw new Error('queueEmail requires at least one recipient.');
  }

  const queuedAtMs = Date.now();
  const mailRef = await firebaseAdmin.firestore().collection(MAIL_COLLECTION).add({
    to: recipients,
    message: {
      ...input.message,
      subject: applyStagingSubjectPrefix(input.message.subject),
    },
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
