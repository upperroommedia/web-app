import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  makeContinueAsNewFunc,
} from '@temporalio/workflow';
import { assertAttentionContinuation, waitForAttentionResume } from '../attention';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { EmailActivities } from '../../activities/email';
import type { EmailOutcome } from '@upperroom/function-kit-firestore-send-email/lib/temporal/delivery';

const delivery = proxyActivities<Pick<EmailActivities, 'deliverEmail'>>({
  taskQueue: 'urm-email',
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '5 seconds', maximumInterval: '1 minute' },
});
const controls = proxyActivities<Pick<EmailActivities, 'exhaustEmailRetries' | 'getEmailReceiptState'>>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '1 minute',
  retry: { initialInterval: '5 seconds', maximumInterval: '1 minute' },
});
export const emailResume = defineSignal('emailResume');
export const emailStatus = defineQuery<{ state: string; attempt: number }>('emailStatus');
/** SMTP lacks provider idempotency; an ambiguous receipt never causes a blind resend. */
interface EmailAttentionContinuation {
  schemaVersion: 1;
  waiting: true;
  resumeRequested: boolean;
  safeAttempts: number;
  status: { state: string; attempt: number };
}
export async function emailDeliveryWorkflow(ref: DurableJobRef, attention?: EmailAttentionContinuation): Promise<void> {
  assertAttentionContinuation(attention);
  if (
    attention &&
    (!Number.isSafeInteger(attention.safeAttempts) ||
      attention.safeAttempts < 0 ||
      attention.safeAttempts > 12 ||
      !attention.status ||
      !['unknown', 'partial', 'needs_attention'].includes(attention.status.state) ||
      !Number.isSafeInteger(attention.status.attempt) ||
      attention.status.attempt < 1)
  )
    throw new Error('Invalid email attention continuation');
  let resume = attention?.resumeRequested ? 1 : 0;
  let status = attention?.status ?? { state: 'queued', attempt: 0 };
  setHandler(emailResume, () => {
    resume += 1;
  });
  setHandler(emailStatus, () => status);
  let safeAttempts = attention?.safeAttempts ?? 0;
  const reconcileAfterResume = async (observedResume: number) => {
    await waitForAttentionResume(
      () => resume > observedResume,
      () =>
        makeContinueAsNewFunc<typeof emailDeliveryWorkflow>({ initialVersioningBehavior: 'AUTO_UPGRADE' })(ref, {
          schemaVersion: 1,
          waiting: true,
          resumeRequested: resume > observedResume,
          safeAttempts,
          status,
        })
    );
    // The original uncertainty fence survives rotation. Only an actual user signal
    // authorizes this receipt check; deploying a new worker never sends email.
    const receiptState = await controls.getEmailReceiptState(ref);
    if (receiptState === 'confirmed' || receiptState === 'rejected') return true;
    if (receiptState === 'prepared') safeAttempts = 0;
    return false;
  };
  if (attention?.waiting && (await reconcileAfterResume(0))) return;
  for (;;) {
    const observedResume = resume;
    status = { state: 'running', attempt: safeAttempts + 1 };
    const result: EmailOutcome = await delivery.deliverEmail(ref);
    status = { state: result, attempt: safeAttempts + 1 };
    if (result === 'confirmed' || result === 'invalid' || result === 'rejected' || result === 'cancelled') return;
    if (result === 'safe_retry') {
      safeAttempts += 1;
      if (safeAttempts < 12) {
        await condition(() => resume > observedResume, Math.min(15_000 * 2 ** (safeAttempts - 1), 300_000));
        continue;
      }
      await controls.exhaustEmailRetries(ref);
      status = { state: 'needs_attention', attempt: safeAttempts };
    }
    // The server validates a resume command against the private receipt. Signals
    // cannot clear its uncertainty fence. An externally reconciled receipt may finish.
    if (await reconcileAfterResume(observedResume)) return;
  }
}
