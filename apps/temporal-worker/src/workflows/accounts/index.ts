import {
  ActivityCancellationType,
  isCancellation,
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import { withDurableLifecycle } from '../lifecycle';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { createAccountActivities } from '../../../../../functions/src/temporal/accounts/activities';
import type { AccountStepResult } from '../../../../../functions/src/temporal/accounts/types';

type Activities = ReturnType<typeof createAccountActivities>;
const activities = proxyActivities<
  Omit<Activities, 'createAccountSpeaker' | 'validateAccountOperation' | 'reportAccountAttention'>
>({
  startToCloseTimeout: '1 minute',
  heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { initialInterval: '1 second', maximumInterval: '1 minute', maximumAttempts: 12 },
});
const controls = proxyActivities<Pick<Activities, 'validateAccountOperation' | 'reportAccountAttention'>>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '1 minute',
  heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 12 },
});
// The speaker domain already has receipts, but ambiguous external creation must
// enter review rather than automatically reissuing an entire provider mutation.
const speaker = proxyActivities<Pick<Activities, 'createAccountSpeaker'>>({
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 1 },
});
export const accountResume = defineSignal('accountResume');
export const accountStatus = defineQuery<{ step: string; state: string; code?: string; receiptId?: string }>(
  'accountStatus'
);
async function runAccountWorkflow(ref: DurableJobRef): Promise<{ state: 'completed' }> {
  let resume = 0;
  let status: { step: string; state: string; code?: string } = { step: 'validate', state: 'running' };
  setHandler(accountResume, () => {
    resume += 1;
  });
  setHandler(accountStatus, () => status);
  const run = async (name: string, operation: () => Promise<AccountStepResult>) => {
    for (;;) {
      const before = resume;
      status = { step: name, state: 'running' };
      let result: AccountStepResult;
      try {
        result = await operation();
      } catch (error) {
        if (isCancellation(error)) throw error;
        result = await controls.reportAccountAttention(ref, name);
      }
      status = { step: name, ...result };
      if (result.state === 'completed') return;
      await condition(() => resume > before);
    }
  };
  return withDurableLifecycle(ref, async () => {
    await run('validate', () => controls.validateAccountOperation(ref));
    await run('claims', () => activities.applyAccountClaims(ref));
    await run('sessions', () => activities.revokeAccountSessions(ref));
    await run('speaker', () => speaker.createAccountSpeaker(ref));
    await run('resolve', () => activities.resolveAccountDocument(ref));
    await run('notification', () => activities.notifyAccountOutcome(ref));
    status = { step: 'notification', state: 'completed' };
    return { state: 'completed' as const };
  });
}

export async function accountsWorkflow(ref: DurableJobRef): Promise<{ state: 'completed' }> {
  return runAccountWorkflow(ref);
}
