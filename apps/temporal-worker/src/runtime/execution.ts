import { safeCancellation } from './safe-activities';
import type { WorkerWitness } from './worker-witness';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Context } from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import type { Client } from '@temporalio/client';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { DurableActivityExecution, createDurableJobStore } from '@upperroom/orchestration/job-store';

type Store = Pick<
  ReturnType<typeof createDurableJobStore>,
  'loadJob' | 'registerActivityExecution' | 'recordActivityExecutionDrained'
>;
const crossWorkflowControls = new Set([
  'registerMediaObserver',
  'readMediaObservers',
  'readMediaCompletion',
  'requestMediaCancellation',
]);
/** Metadata is private, authoritative Temporal time, never local clock or history payload. */
export class ActivityExecutionContext {
  private readonly scope = new AsyncLocalStorage<DurableActivityExecution | undefined>();
  private readonly steps = new AsyncLocalStorage<readonly string[]>();
  private readonly starts = new Map<string, string>();
  private readonly fetching = new Map<string, Promise<string>>();
  private store?: Store;
  constructor(
    private readonly client?: Pick<Client, 'workflow' | 'connection'>,
    private readonly witness?: WorkerWitness
  ) {}
  bindStore(store: Store) {
    this.store = store;
  }
  current = () => this.scope.getStore();
  currentStepIds = () => [...(this.steps.getStore() ?? [])];
  async withRepairSteps<T>(
    ref: DurableJobRef,
    sourceStepIds: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    const execution = this.current();
    if (
      !execution ||
      execution.activityType !== 'repairPublishingCritical' ||
      !this.store ||
      sourceStepIds.length > 32 ||
      sourceStepIds.some((id) => !/^[a-z][a-z0-9_-]{0,99}$/.test(id))
    )
      throw ApplicationFailure.nonRetryable('Repair step authority is unavailable', 'PERMISSION_CHANGED');
    const stepIds = [...new Set([...this.currentStepIds(), ...sourceStepIds])];
    if (stepIds.length > 32)
      throw ApplicationFailure.nonRetryable('Repair step authority is unavailable', 'PERMISSION_CHANGED');
    return this.steps.run(stepIds, async () => {
      await this.store!.registerActivityExecution(ref, execution, { stepIds, countsAttempt: false });
      return operation();
    });
  }
  private async runStart(workflowId: string, runId: string): Promise<string> {
    const cached = this.starts.get(runId);
    if (cached) return cached;
    if (!this.client) throw new Error('EXECUTION_CLIENT_REQUIRED');
    let pending = this.fetching.get(runId);
    if (!pending) {
      pending = (async () => {
        const description = await this.client!.connection.withDeadline(Date.now() + 5000, () =>
          this.client!.workflow.getHandle(workflowId, runId).describe()
        );
        const timestamp = description.raw.workflowExecutionInfo?.startTime;
        if (!timestamp?.seconds) throw new Error('EXECUTION_START_UNAVAILABLE');
        const nanos = (BigInt(timestamp.seconds.toString()) * 1_000_000_000n + BigInt(timestamp.nanos ?? 0)).toString();
        this.starts.set(runId, nanos);
        if (this.starts.size > 1000) this.starts.delete(this.starts.keys().next().value!);
        return nanos;
      })().finally(() => this.fetching.delete(runId));
      this.fetching.set(runId, pending);
    }
    return pending;
  }
  async run<T>(name: string, args: unknown[], stepIds: readonly string[], operation: () => Promise<T>): Promise<T> {
    const candidate = args[0] as Partial<DurableJobRef> | undefined;
    if (
      !candidate ||
      Array.isArray(candidate) ||
      typeof candidate.jobId !== 'string' ||
      typeof candidate.projectId !== 'string'
    )
      return this.scope.run(undefined, operation);
    const ref = candidate as DurableJobRef;
    try {
      const info = Context.current().info,
        execution = info.workflowExecution;
      if (!execution || !this.store)
        throw ApplicationFailure.nonRetryable('Workflow identity cannot be verified', 'EXECUTION_IDENTITY_MISSING');
      const job = await this.store.loadJob(ref);
      if (job.workflowId !== execution.workflowId) {
        // Child observers and cancellation controllers deliberately inspect another
        // job. Their domain adapter validates the exact reference and permissions;
        // they must not claim the target coordinator's execution epoch.
        if (crossWorkflowControls.has(name)) return this.scope.run(undefined, operation);
        throw ApplicationFailure.nonRetryable('Workflow does not own this job', 'EXECUTION_OWNER_MISMATCH');
      }
      const identity: DurableActivityExecution = {
        workflowId: execution.workflowId,
        runId: execution.runId,
        activityId: info.activityId,
        activityType: info.activityType,
        temporalNamespace: info.namespace,
        ...(this.witness ? { worker: this.witness } : {}),
        scheduledAt: info.scheduledTimestampMs,
        attempt: info.attempt,
        runStartedAtNanos: await this.runStart(execution.workflowId, execution.runId),
      };
      return await this.scope.run(identity, () =>
        this.steps.run(stepIds, async () => {
          if (Context.current().cancellationSignal.aborted)
            throw safeCancellation(Context.current().cancellationSignal);
          await this.store!.registerActivityExecution(ref, identity, {
            stepIds,
            countsAttempt:
              !name.startsWith('report') &&
              !name.startsWith('project') &&
              ![
                'beginDurableCleanup',
                'beginDurableCriticalRepair',
                'recoverPublishingActivityFailure',
                'recoverPublishingEntityFailure',
                'getEmailReceiptState',
                'exhaustEmailRetries',
                'finishImage',
                'getImageDisposition',
                'reviewProviderOrphanAcknowledgement',
                'compilePublishingCriticalRepairEvidence',
                'beginDurableReview',
                'savePublishingCreateReviewCheckpoint',
                'loadPublishingCreateReviewContinuation',
                'finishSearch',
                'finishSearchBackfill',
                'resolveLatestBundleJob',
              ].includes(name),
          });
          if (Context.current().cancellationSignal.aborted)
            throw safeCancellation(Context.current().cancellationSignal);
          try {
            return await operation();
          } finally {
            // A witness is written only after the real provider/native promise settled.
            // Infrastructure failure leaves no proof and therefore requires review.
            try {
              await this.store!.recordActivityExecutionDrained(ref, identity);
            } catch {}
          }
        })
      );
    } catch (error) {
      if (Context.current().cancellationSignal.aborted) throw safeCancellation(Context.current().cancellationSignal);
      if (error instanceof ApplicationFailure || error instanceof CancelledFailure) throw error;
      const code = (error as { code?: string })?.code;
      if (['STALE_EXECUTION', 'PROJECT_MISMATCH', 'STALE_GENERATION'].includes(code ?? ''))
        throw ApplicationFailure.nonRetryable('This execution is no longer current', code!);
      throw ApplicationFailure.retryable(
        'Execution metadata is temporarily unavailable',
        'EXECUTION_METADATA_UNAVAILABLE'
      );
    }
  }
}
