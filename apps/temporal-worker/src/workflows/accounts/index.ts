import {
  ActivityCancellationType,
  isCancellation,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  makeContinueAsNewFunc,
} from '@temporalio/workflow';
import { assertAttentionContinuation, waitForAttentionResume } from '../attention';
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
const accountSteps = ['validate', 'claims', 'sessions', 'speaker', 'resolve', 'notification'] as const;
type AccountStep = (typeof accountSteps)[number];
interface AccountAttentionContinuation {
  schemaVersion: 1;
  waiting: true;
  resumeRequested: boolean;
  step: AccountStep;
  status: { step: string; state: string; code?: string; receiptId?: string };
}
async function runAccountWorkflow(
  ref: DurableJobRef,
  attention?: AccountAttentionContinuation
): Promise<{ state: 'completed' }> {
  assertAttentionContinuation(attention);
  if (
    attention &&
    (attention.schemaVersion !== 1 ||
      attention.waiting !== true ||
      !accountSteps.includes(attention.step) ||
      !attention.status ||
      attention.status.step !== attention.step ||
      !['blocked', 'needs_review'].includes(attention.status.state) ||
      typeof attention.resumeRequested !== 'boolean')
  )
    throw new Error('Invalid account attention continuation');
  let resume = attention?.resumeRequested ? 1 : 0;
  let status: { step: string; state: string; code?: string; receiptId?: string } = attention?.status ?? {
    step: 'validate',
    state: 'running',
  };
  setHandler(accountResume, () => {
    resume += 1;
  });
  setHandler(accountStatus, () => status);
  const run = async (name: AccountStep, operation: () => Promise<AccountStepResult>) => {
    if (attention && accountSteps.indexOf(name) < accountSteps.indexOf(attention.step)) return;
    const wait = (before: number) =>
      waitForAttentionResume(
        () => resume > before,
        () =>
          makeContinueAsNewFunc<typeof accountsWorkflow>({ initialVersioningBehavior: 'AUTO_UPGRADE' })(ref, {
            schemaVersion: 1,
            waiting: true,
            resumeRequested: resume > before,
            step: name,
            status,
          })
      );
    if (attention && name === attention.step) await wait(0);
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
      await wait(before);
    }
  };
  return withDurableLifecycle(
    ref,
    async () => {
      await run('validate', () => controls.validateAccountOperation(ref));
      await run('claims', () => activities.applyAccountClaims(ref));
      await run('sessions', () => activities.revokeAccountSessions(ref));
      await run('speaker', () => speaker.createAccountSpeaker(ref));
      await run('resolve', () => activities.resolveAccountDocument(ref));
      await run('notification', () => activities.notifyAccountOutcome(ref));
      status = { step: 'notification', state: 'completed' };
      return { state: 'completed' as const };
    },
    { continuingAttention: Boolean(attention) }
  );
}

export async function accountsWorkflow(
  ref: DurableJobRef,
  attention?: AccountAttentionContinuation
): Promise<{ state: 'completed' }> {
  return runAccountWorkflow(ref, attention);
}
