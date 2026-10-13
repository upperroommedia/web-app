import { createHash } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { DocumentReference } from 'firebase-admin/firestore';
import { prepareQueuedEmail } from './queueEmail';
import type { QueueEmailInput } from './notificationTypes';

/** Domain request and both mail outbox records commit together or not at all. */
export async function createRequestWithEmails<T extends object>(options: {
  target: DocumentReference;
  document: T;
  pendingKey: string;
  emails: Array<{ field: 'notification' | 'confirmationNotification'; input: QueueEmailInput }>;
}): Promise<{ id: string; created: boolean; document: T }> {
  const firestore = firebaseAdmin.firestore();
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const guard = firestore.collection('_pendingAccessRequestKeys').doc(digest(options.pendingKey));
  const mails = options.emails.map(({ field, input }, index) => ({
    field,
    payload: prepareQueuedEmail(input),
    ref: firestore.collection('mail').doc(`notification-${digest(`access-request:${options.target.id}:${index}`)}`),
  }));
  return firestore.runTransaction(async (tx) => {
    const pointer = await tx.get(guard);
    if (pointer.exists && typeof pointer.get('requestPath') === 'string') {
      const existing = await tx.get(firestore.doc(pointer.get('requestPath')));
      if (existing.exists && existing.get('status') === 'pending')
        return { id: existing.id, created: false, document: existing.data() as T };
    }
    await (
      await import('../temporal/releaseControl')
    ).assertAdmissionReleaseInTransaction(tx, firestore, 'role.resolve');
    // The pointer and request are transactionally coupled. The random target ID
    // is generated once before retries; no document exists before this commit.
    const document = { ...options.document };
    for (const mail of mails)
      Object.assign(document, {
        [mail.field]: { status: 'queued', attemptedAtMs: mail.payload.meta.queuedAtMs, queueMailId: mail.ref.id },
      });
    tx.create(options.target, document);
    for (const mail of mails) tx.create(mail.ref, mail.payload);
    tx.set(guard, { requestPath: options.target.path });
    return { id: options.target.id, created: true, document };
  });
}
