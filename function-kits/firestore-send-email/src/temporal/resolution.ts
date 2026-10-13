import { createHash } from 'node:crypto';
import { Firestore, FieldValue, Timestamp, Transaction } from 'firebase-admin/firestore';
import { buildEmailAdmission, emailAdmissionJobId } from './ingress';
import { ExtendedSendMailOptions } from '../types';
import { expiryForPolicy, EmailExpiryPolicy } from './expiry-policy';

export type EmailResolutionDecision = 'confirm_accepted' | 'mark_failed_after_review' | 'resend_after_review';
export interface EmailResolution {
  decision: EmailResolutionDecision;
  expectedReceiptToken: string;
  evidenceReference: string;
  reason: string;
  duplicateRiskAcknowledged?: boolean;
}
export function validateEmailResolution(input: unknown): EmailResolution {
  if (!input || typeof input !== 'object') throw new Error('EMAIL_REVIEW_INVALID');
  const value = input as EmailResolution;
  if (!['confirm_accepted', 'mark_failed_after_review', 'resend_after_review'].includes(value.decision))
    throw new Error('EMAIL_REVIEW_INVALID');
  for (const key of ['expectedReceiptToken', 'evidenceReference', 'reason'] as const) {
    if (
      typeof value[key] !== 'string' ||
      !value[key].trim() ||
      value[key].length > (key === 'expectedReceiptToken' ? 128 : 1024)
    )
      throw new Error('EMAIL_REVIEW_INVALID');
  }
  if (value.decision === 'resend_after_review' && value.duplicateRiskAcknowledged !== true)
    throw new Error('EMAIL_REVIEW_DUPLICATE_RISK_ACK_REQUIRED');
  return {
    decision: value.decision,
    expectedReceiptToken: value.expectedReceiptToken,
    evidenceReference: value.evidenceReference.trim(),
    reason: value.reason.trim(),
    ...(value.duplicateRiskAcknowledged === true ? { duplicateRiskAcknowledged: true } : {}),
  };
}
function frozenPayload(options: ExtendedSendMailOptions): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      from: options.from,
      replyTo: options.replyTo,
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      headers: options.headers,
      categories: options.categories,
      message: { subject: options.subject, text: options.text, html: options.html, attachments: options.attachments },
      sendGrid: {
        templateId: options.templateId,
        dynamicTemplateData: options.dynamicTemplateData,
        mailSettings: options.mailSettings,
        customArgs: options.customArgs,
        ipPoolName: options.ipPoolName,
      },
    })
  );
}
/** Caller MUST freshly authorize actorUid as an administrator. All inputs except
 * the receipt identity remain private. This is recorded human provider-log review,
 * not a claim of automated SMTP reconciliation or exactly-once delivery. */
export async function resolveDurableEmail(
  db: Firestore,
  input: {
    ref: { jobId: string; projectId: string };
    actorUid: string;
    commandId: string;
    expectedJobRevision: number;
    expectedGeneration: number;
    assertCurrentInTransaction?: (tx: Transaction) => Promise<void>;
    onResolutionCommit?: (
      tx: Transaction,
      result: { state: 'confirmed' | 'failed' | 'resent'; replacementJobId?: string }
    ) => Promise<void>;
  } & EmailResolution
): Promise<{ state: 'confirmed' | 'failed' | 'resent'; replacementJobId?: string }> {
  const resolution = validateEmailResolution(input);
  if (!input.actorUid || !input.commandId || input.commandId.includes('/')) throw new Error('EMAIL_REVIEW_INVALID');
  const receiptRef = db.collection('durableEmailReceipts').doc(input.ref.jobId);
  const intentRef = db.collection('durableJobIntents').doc(input.ref.jobId);
  const jobRef = db.collection('durableJobs').doc(input.ref.jobId);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const [receipt, intent, job] = await Promise.all([tx.get(receiptRef), tx.get(intentRef), tx.get(jobRef)]);
    if (
      !receipt.exists ||
      !intent.exists ||
      intent.get('projectId') !== input.ref.projectId ||
      intent.get('kind') !== 'email.deliver'
    )
      throw new Error('EMAIL_REVIEW_NOT_FOUND');
    const previous = receipt.get('review');
    if (previous?.commandId === input.commandId) return previous.result;
    if (
      !job.exists ||
      job.get('revision') !== input.expectedJobRevision ||
      job.get('generation') !== input.expectedGeneration ||
      intent.get('generation') !== input.expectedGeneration
    )
      throw new Error('EMAIL_REVIEW_STALE');
    const entity = intent.get('entity') as { type: string; id: string };
    const entityKey = createHash('sha256')
      .update(JSON.stringify([input.ref.projectId, entity.type, entity.id, 'email']))
      .digest('hex');
    const head = await tx.get(db.collection('durableJobEntities').doc(entityKey));
    if (head.get('activeJobId') !== input.ref.jobId || head.get('generation') !== input.expectedGeneration)
      throw new Error('EMAIL_REVIEW_STALE');
    if (
      receipt.get('token') !== resolution.expectedReceiptToken ||
      !['sending', 'unknown', 'partial'].includes(receipt.get('state'))
    )
      throw new Error('EMAIL_REVIEW_STALE');
    const startedAt = receipt.get('startedAt');
    // A crashed/late activity has bounded network timeouts. Wait beyond its
    // two-minute deadline before a human may replace a still-sending attempt.
    if (receipt.get('state') === 'sending' && (!startedAt?.toMillis || now - startedAt.toMillis() < 300_000))
      throw new Error('EMAIL_REVIEW_ATTEMPT_STILL_ACTIVE');
    const original = intent.get('payload') as { mailPath: string; expiryPolicy?: EmailExpiryPolicy };
    if (!original?.mailPath || typeof original.mailPath !== 'string') throw new Error('EMAIL_REVIEW_INVALID');
    const mailRef = db.doc(original.mailPath);
    const originalMail = await tx.get(mailRef);
    const result: { state: 'confirmed' | 'failed' | 'resent'; replacementJobId?: string } = {
      state: resolution.decision === 'confirm_accepted' ? 'confirmed' : 'failed',
    };
    let replacement: ReturnType<typeof buildEmailAdmission> | undefined;
    let replacementMail: ReturnType<Firestore['doc']> | undefined;
    if (resolution.decision === 'resend_after_review') {
      const options = receipt.get('options') as ExtendedSendMailOptions;
      if (!options) throw new Error('EMAIL_REVIEW_FROZEN_ENVELOPE_MISSING');
      const collection = original.mailPath.slice(0, original.mailPath.lastIndexOf('/'));
      const id = `reviewed-${createHash('sha256')
        .update(JSON.stringify([input.ref.projectId, input.ref.jobId, input.commandId]))
        .digest('hex')}`;
      replacementMail = db.doc(`${collection}/${id}`);
      const jobId = emailAdmissionJobId(input.ref.projectId, replacementMail.path);
      replacement = buildEmailAdmission(
        input.ref.projectId,
        jobId,
        replacementMail.path,
        1,
        frozenPayload(options),
        now,
        original.expiryPolicy
      );
      // All duplicate reads precede writes. A receipt replay returns its stored result.
      const [mailDuplicate, jobDuplicate, headDuplicate] = await Promise.all([
        tx.get(replacementMail),
        tx.get(db.collection('durableJobs').doc(jobId)),
        tx.get(db.collection('durableJobEntities').doc(replacement.entityKey)),
      ]);
      if (mailDuplicate.exists || jobDuplicate.exists || headDuplicate.exists)
        throw new Error('EMAIL_REVIEW_REPLACEMENT_CONFLICT');
      replacement.job.requestedBy = input.actorUid;
      replacement.intent.actorUid = input.actorUid;
      result.state = 'resent';
      result.replacementJobId = jobId;
    }
    if (input.assertCurrentInTransaction) await input.assertCurrentInTransaction(tx);
    if (input.onResolutionCommit) await input.onResolutionCommit(tx, result);
    // Keep the original receipt/accepted-recipient information, fence late writes.
    tx.update(receiptRef, {
      state: resolution.decision === 'confirm_accepted' ? 'accepted' : 'rejected',
      token: `review:${input.commandId}`,
      review: {
        commandId: input.commandId,
        actorUid: input.actorUid,
        decision: resolution.decision,
        evidenceReference: resolution.evidenceReference,
        reason: resolution.reason,
        duplicateRiskAcknowledged: resolution.duplicateRiskAcknowledged === true,
        reviewedAt: now,
        result,
      },
      completedAt: FieldValue.serverTimestamp(),
    });
    if (originalMail.exists)
      tx.update(mailRef, {
        'delivery.state': resolution.decision === 'confirm_accepted' ? 'SUCCESS' : 'ERROR',
        'delivery.error':
          resolution.decision === 'confirm_accepted' ? null : 'Delivery closed after administrator review.',
        'delivery.endTime': FieldValue.serverTimestamp(),
        'delivery.reviewedBy': input.actorUid,
      });
    if (replacement && replacementMail) {
      const startTime = Timestamp.fromMillis(now);
      const expiry = original.expiryPolicy ? expiryForPolicy(startTime, original.expiryPolicy) : undefined;
      tx.create(replacementMail, {
        ...replacement.intent.payload.payload,
        delivery: {
          state: 'PENDING',
          startTime,
          attempts: 0,
          error: null,
          orchestrator: 'temporal',
          jobId: result.replacementJobId,
          ...(expiry ? { expireAt: expiry } : {}),
        },
      });
      tx.create(db.collection('durableJobs').doc(replacement.job.jobId), replacement.job);
      tx.create(db.collection('durableJobIntents').doc(replacement.job.jobId), replacement.intent);
      tx.create(db.collection('durableJobOutbox').doc(replacement.job.jobId), replacement.outbox);
      tx.set(db.collection('durableJobEntities').doc(replacement.entityKey), replacement.entity);
    }
    return result;
  });
}
