import { createHash, randomUUID } from 'node:crypto';
import { Firestore, FieldValue, Transaction } from 'firebase-admin/firestore';
import { EmailRuntime, isDefinitelyUnsent } from './runtime';
import { ExtendedSendMailOptions } from '../types';

export type EmailOutcome = 'confirmed' | 'safe_retry' | 'invalid' | 'rejected' | 'unknown' | 'partial' | 'cancelled';
export interface EmailDeliveryIntent {
  mailPath: string;
  payload: Record<string, any>;
}
export function emailMessageId(projectId: string, jobId: string): string {
  return `<${createHash('sha256').update(`${projectId}:${jobId}`).digest('hex')}@durable.upperroommedia.org>`;
}

/** Persist the uncertainty fence before issuing the non-idempotent send operation. */
export async function deliverDurableEmail(
  db: Firestore,
  runtime: EmailRuntime,
  ref: { jobId: string; projectId: string },
  intent: EmailDeliveryIntent,
  fence?: { assertCurrent(): Promise<void>; assertInTransaction(tx: Transaction): Promise<void> }
): Promise<EmailOutcome> {
  const receipt = db.collection('durableEmailReceipts').doc(ref.jobId);
  const mail = db.doc(intent.mailPath);
  const messageId = emailMessageId(ref.projectId, ref.jobId);
  const existing = await receipt.get();
  const state = existing.get('state');
  if (state === 'accepted') return 'confirmed';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'partial') return 'partial';
  if (state === 'rejected') return 'rejected';
  if (state === 'sending' || state === 'unknown') return 'unknown';
  // TTL/deletion revokes an unsubmitted message; never reconstruct and send it silently.
  if (!(await mail.get()).exists) return 'cancelled';

  let options = existing.get('options') as ExtendedSendMailOptions | undefined;
  if (!options) {
    try {
      options = await runtime.prepare(intent.payload, messageId);
    } catch (error) {
      if ([4, 8, 10, 13, 14].includes((error as { code?: number })?.code)) return 'safe_retry';
      await mail.update({
        'delivery.state': 'ERROR',
        'delivery.error': 'Email payload could not be prepared.',
        'delivery.endTime': FieldValue.serverTimestamp(),
      });
      return 'invalid';
    }
    // UID recipients/templates are frozen privately. A later retry cannot target newly changed addresses.
    await db.runTransaction(async (tx) => {
      const current = await tx.get(receipt);
      if (fence) await fence.assertInTransaction(tx);
      if (!current.exists)
        tx.create(receipt, { state: 'prepared', messageId, options, preparedAt: FieldValue.serverTimestamp() });
    });
    options = (await receipt.get()).get('options');
  }
  try {
    await runtime.verify();
  } catch {
    return 'safe_retry';
  }

  const token = randomUUID();
  const permission = await db.runTransaction(async (tx) => {
    const job = db.collection('durableJobs').doc(ref.jobId);
    const [current, projection, mailSnapshot] = await Promise.all([tx.get(receipt), tx.get(job), tx.get(mail)]);
    if (current.get('state') !== 'prepared') return 'blocked';
    const entity = projection.get('entity') as { type?: string; id?: string } | undefined;
    let superseded = !projection.exists || !entity?.type || !entity?.id;
    if (entity?.type && entity?.id) {
      const headId = createHash('sha256')
        .update(JSON.stringify([ref.projectId, entity.type, entity.id, 'email']))
        .digest('hex');
      const head = await tx.get(db.collection('durableJobEntities').doc(headId));
      superseded = head.get('activeJobId') !== ref.jobId || head.get('generation') !== projection.get('generation');
    }
    if (fence) await fence.assertInTransaction(tx);
    if (
      !mailSnapshot.exists ||
      superseded ||
      ['cancel_requested', 'cancelled', 'failed', 'succeeded', 'superseded'].includes(projection.get('state'))
    ) {
      tx.update(receipt, { state: 'cancelled', completedAt: FieldValue.serverTimestamp() });
      if (mailSnapshot.exists)
        tx.update(mail, {
          'delivery.state': 'ERROR',
          'delivery.error': 'Email cancelled before submission.',
          'delivery.endTime': FieldValue.serverTimestamp(),
        });
      return 'cancelled';
    }
    tx.update(receipt, {
      state: 'sending',
      token,
      startedAt: FieldValue.serverTimestamp(),
      attempts: FieldValue.increment(1),
    });
    tx.update(mail, {
      'delivery.state': 'PROCESSING',
      'delivery.attempts': FieldValue.increment(1),
      'delivery.error': null,
      'delivery.orchestrator': 'temporal',
      'delivery.messageId': messageId,
    });
    // Remove cancellation availability atomically with the non-idempotent send fence.
    tx.update(job, { actions: [], revision: FieldValue.increment(1), updatedAt: Date.now() });
    return 'send';
  });
  if (permission === 'cancelled') return 'cancelled';
  if (permission !== 'send') {
    const current = await receipt.get();
    return current.get('state') === 'accepted' ? 'confirmed' : 'unknown';
  }

  let outcome: EmailOutcome;
  let providerInfo: Awaited<ReturnType<EmailRuntime['send']>> | undefined;
  try {
    if (fence) await fence.assertCurrent();
    providerInfo = await runtime.send(options, fence?.assertCurrent);
    outcome = providerInfo.accepted.length
      ? providerInfo.rejected.length || providerInfo.pending.length
        ? 'partial'
        : 'confirmed'
      : 'rejected';
  } catch (error) {
    outcome = isDefinitelyUnsent(error) ? 'safe_retry' : 'unknown';
  }
  // No raw provider exceptions leave this activity or enter workflow history/UI.
  await db.runTransaction(async (tx) => {
    const current = await tx.get(receipt);
    if (current.get('token') !== token) throw new Error('EMAIL_RECEIPT_FENCE_CONFLICT');
    if (fence) await fence.assertInTransaction(tx);
    const receiptState = outcome === 'confirmed' ? 'accepted' : outcome === 'safe_retry' ? 'prepared' : outcome;
    const receiptUpdate: Record<string, unknown> = { state: receiptState, completedAt: FieldValue.serverTimestamp() };
    if (providerInfo) receiptUpdate.info = providerInfo;
    tx.update(receipt, receiptUpdate);
    const success = outcome === 'confirmed';
    const update: Record<string, unknown> = {
      'delivery.state': success ? 'SUCCESS' : outcome === 'safe_retry' ? 'RETRY' : 'ERROR',
      'delivery.error': success
        ? null
        : outcome === 'unknown'
        ? 'Provider acceptance is unknown. Review required before retry.'
        : outcome === 'partial'
        ? 'Some recipients were not confirmed. Review required.'
        : outcome === 'rejected'
        ? 'Provider rejected all recipients.'
        : 'Connection failed before email was submitted.',
      'delivery.endTime': FieldValue.serverTimestamp(),
      'delivery.leaseExpireTime': null,
    };
    if (providerInfo) update['delivery.info'] = providerInfo;
    tx.update(mail, update);
  });
  return outcome;
}
