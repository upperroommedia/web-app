import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import type { DurableJobRef, DurableJobState } from '@upperroom/contracts/temporal';
import type { createDurableJobStore } from '@upperroom/orchestration/job-store';
export function createLifecycleActivities(
  store: ReturnType<typeof createDurableJobStore>,
  options: {
    authorizeCriticalRepair?: (ref: DurableJobRef, certificateId: string) => Promise<unknown>;
  } = {}
) {
  return {
    async beginDurableReview(ref: DurableJobRef) {
      const current = await store.loadJob(ref);
      if (['succeeded', 'failed', 'cancelled', 'superseded'].includes(current.state))
        throw ApplicationFailure.nonRetryable('This operation already finished', 'TERMINAL_JOB');
      if (!['queued', 'needs_attention', 'reconciling', 'cancel_requested'].includes(current.state))
        throw ApplicationFailure.nonRetryable('This operation is not awaiting review', 'REVIEW_STATE_REQUIRED');
      await store.project(ref, { expectedRevision: current.revision, state: current.state, actions: current.actions });
    },
    async beginDurableCriticalRepair(ref: DurableJobRef, certificateId: string) {
      if (!options.authorizeCriticalRepair)
        throw ApplicationFailure.nonRetryable(
          'Critical repair authority is unavailable',
          'CRITICAL_REPAIR_AUTHORITY_REQUIRED'
        );
      await options.authorizeCriticalRepair(ref, certificateId);
      const current = await store.loadJob(ref);
      await store.project(ref, {
        expectedRevision: current.revision,
        state: current.state === 'cancel_requested' ? 'cancel_requested' : 'running',
        actions: [],
      });
    },
    async reportDurableCriticalRepairFailure(ref: DurableJobRef) {
      const current = await store.loadJob(ref);
      if (['succeeded', 'failed', 'cancelled', 'superseded'].includes(current.state)) return;
      await store.project(ref, {
        state: current.state === 'cancel_requested' ? 'cancel_requested' : 'needs_attention',
        actions: [],
        attention: {
          kind: 'external_result_unknown',
          message: 'An administrator must review the applied changes before repair can continue.',
        },
        error: {
          code: 'CRITICAL_REPAIR_REVIEW_REQUIRED',
          message: 'Repair needs a current administrator approval.',
          retryable: false,
        },
      });
    },
    async beginDurableCleanup(ref: DurableJobRef) {
      const current = await store.loadJob(ref);
      if (['succeeded', 'failed', 'cancelled', 'superseded'].includes(current.state))
        throw ApplicationFailure.nonRetryable('This operation already finished', 'TERMINAL_JOB');
      if (current.state !== 'cancel_requested' || current.result?.resolutionPurpose !== 'cleanup')
        throw ApplicationFailure.nonRetryable('Cancellation cleanup was not requested', 'CLEANUP_INTENT_MISSING');
      // Projection performs the current generation and private execution-epoch
      // checks. Cleanup authority is rechecked before any provider effects.
      await store.project(ref, {
        expectedRevision: current.revision,
        state: 'cancel_requested',
        actions: current.actions,
      });
    },
    async beginDurableJob(ref: DurableJobRef) {
      const current = await store.loadJob(ref);
      if (['succeeded', 'failed', 'cancelled', 'superseded'].includes(current.state)) return;
      if (current.state === 'cancel_requested') throw new CancelledFailure('Cancelled before work began');
      await store.assertCurrent(ref);
      const account =
        current.kind.startsWith('invite.') || ['role.resolve', 'role.assign', 'speaker.resolve'].includes(current.kind);
      await store.project(ref, {
        expectedRevision: current.revision,
        state: 'running',
        startedAt: current.startedAt ?? Date.now(),
        actions: account ? [] : ['cancel'],
      });
    },
    async finishDurableJob(ref: DurableJobRef, state: Extract<DurableJobState, 'succeeded' | 'cancelled' | 'failed'>) {
      const current = await store.loadJob(ref);
      if (['succeeded', 'failed', 'cancelled', 'superseded'].includes(current.state)) return;
      await store.project(ref, {
        state,
        finishedAt: Date.now(),
        actions: [],
        ...(state === 'failed'
          ? {
              error: {
                code: 'WORKFLOW_FAILED',
                message: 'This operation could not finish. Review the operation details.',
                retryable: false,
              },
            }
          : {}),
      });
    },
  };
}
export type LifecycleActivities = ReturnType<typeof createLifecycleActivities>;
