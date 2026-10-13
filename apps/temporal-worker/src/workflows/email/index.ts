import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
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
export async function emailDeliveryWorkflow(ref: DurableJobRef): Promise<void> {
  let resume = 0;
  let status = { state: 'queued', attempt: 0 };
  setHandler(emailResume, () => {
    resume += 1;
  });
  setHandler(emailStatus, () => status);
  let safeAttempts = 0;
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
    await condition(() => resume > observedResume);
    const receiptState = await controls.getEmailReceiptState(ref);
    if (receiptState === 'confirmed' || receiptState === 'rejected') return;
    if (receiptState === 'prepared') safeAttempts = 0;
  }
}
