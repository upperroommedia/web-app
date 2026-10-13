import { ApplicationFailure } from '@temporalio/common';
import type { DurableJobRef, DurableJobStep } from '@upperroom/contracts/temporal';
import type { createDurableJobStore, DurableActivityExecution } from '@upperroom/orchestration/job-store';
type Store = Pick<ReturnType<typeof createDurableJobStore>, 'assertCurrent' | 'loadJob' | 'recordStep'>;
/** Publishing source registration may use only an already claimed, observable parent step. */
export async function beginClaimedPublishingStep(
  store: Store,
  ref: DurableJobRef,
  step: Pick<DurableJobStep, 'id' | 'label'>,
  execution: DurableActivityExecution | undefined,
  claimedStepIds: readonly string[],
  now = Date.now()
): Promise<void> {
  if (!execution || !claimedStepIds.includes(step.id) || !/^[a-z][a-z0-9-]{0,79}$/.test(step.id))
    throw ApplicationFailure.nonRetryable(
      'The publishing step is not owned by this execution',
      'EXECUTION_IDENTITY_MISSING'
    );
  await store.assertCurrent(ref);
  const job = await store.loadJob(ref);
  if (job.workflowId !== execution.workflowId)
    throw ApplicationFailure.nonRetryable('Workflow does not own this job', 'EXECUTION_OWNER_MISMATCH');
  const previous = job.steps.find((value) => value.id === step.id);
  // An exact receipt replay or a factual repair cannot turn a proved completed
  // phase back into unconfirmed work. New SDK work still owns its private epoch.
  if (previous && ['succeeded', 'cancelled', 'superseded'].includes(previous.state)) return;
  await store.recordStep(ref, {
    ...(previous ?? {}),
    ...step,
    state: 'running',
    attempt: execution.attempt,
    startedAt: previous?.startedAt ?? now,
    finishedAt: undefined,
    error: undefined,
    nextRetryAt: undefined,
  });
}
