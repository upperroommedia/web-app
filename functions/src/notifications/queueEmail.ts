import { createHash } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { logger } from 'firebase-functions/v2';
import { runDurableTransaction } from '../temporal/publishing/durableOperationContext';
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

export const prepareQueuedEmail = (input: QueueEmailInput) => {
  const recipients = normalizeRecipients(input.to);
  if (recipients.length === 0) {
    throw new Error('queueEmail requires at least one recipient.');
  }

  const queuedAtMs = Date.now();
  return {
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
      ...(input.temporalParentJobRef ? { temporalParentJobRef: input.temporalParentJobRef } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  };
};

const enqueueEmail = async (input: QueueEmailInput): Promise<{ id: string; created: boolean }> => {
  const payload = prepareQueuedEmail(input);
  const recipients = payload.to;
  const collection = firebaseAdmin.firestore().collection(MAIL_COLLECTION);
  const mailRef = input.idempotencyKey
    ? collection.doc(`notification-${createHash('sha256').update(input.idempotencyKey).digest('hex')}`)
    : await collection.add(payload);
  const created = input.idempotencyKey
    ? await runDurableTransaction(firebaseAdmin.firestore(), async (transaction) => {
        if ((await transaction.get(mailRef)).exists) return false;
        transaction.create(mailRef, payload);
        return true;
      })
    : true;

  if (created)
    logger.info('notification email queued', {
      mailId: mailRef.id,
      source: input.source,
      alertType: input.alertType,
      recipientCount: recipients.length,
    });

  return { id: mailRef.id, created };
};

export const queueEmail = async (input: QueueEmailInput): Promise<string> => (await enqueueEmail(input)).id;

export const queueEmailOnce = async (input: QueueEmailInput & { idempotencyKey: string }): Promise<boolean> =>
  (await enqueueEmail(input)).created;
