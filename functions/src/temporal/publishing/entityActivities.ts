import { executeReviewedPublishingEntityCreateContinuation } from './reviewedEntityCreateContinuation';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { settleCancelledPublishingAllocations } from './allocationBarrier';
import type { Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import {
  runPublishingEntityContext,
  executePublishingEntityOperation,
  type PublishingEntityIntent,
  type PublishingEntityExecutionOptions,
} from './entityMutations';
import { executeMaintenancePage, normalizeMaintenanceInput, type MaintenancePageResult } from './maintenance';
import type { PublishingStepResult } from './types';
import {
  releaseCanonicalProviderBindingsForCurrentJob,
  type PublishingMutationFinalSettlement,
  type PublishingMutationEffectsClosure,
  type PublishingAcknowledgedProjectionPlan,
  type PublishingMutationPlan,
  type PublishingMutationRequest,
  runDurableTransaction,
  runDurablePublishingOperation,
} from './durableOperationContext';
import { listProviderReceiptsForJob } from './providerReceipts';
import { cancelPublishingEffects } from './cancellation';
import { abortProvablyUnsentProviderMutationSessionsForJob } from './providerMutationGuard';
import { abortCancelledDesiredProviderDeletions } from './desiredDeletionCancellation';
export interface PublishingEntityActivityStore {
  getSourceStepIds?: () => string[];
  prepareProviderMutationEffectsClosed?: (
    tx: Transaction,
    ref: DurableJobRef,
    plan: PublishingMutationEffectsClosure
  ) => Promise<{ alreadyClosed: boolean; commit: () => void }>;
  abortProviderMutationPlan?: (ref: DurableJobRef, plan: { operation: string }) => Promise<void>;
  prepareAcknowledgedProjectionPlan?: (
    tx: Transaction,
    ref: DurableJobRef,
    plan: PublishingAcknowledgedProjectionPlan
  ) => Promise<{ projectionDigest: string; commit: () => void }>;
  beginProviderMutationPlan?: (ref: DurableJobRef, plan: PublishingMutationPlan) => Promise<void>;
  runPublishingProviderMutation?: <T>(ref: DurableJobRef, request: PublishingMutationRequest<T>) => Promise<T>;
  prepareProviderMutationPlanCommit?: (
    tx: Transaction,
    ref: DurableJobRef,
    plan: PublishingMutationFinalSettlement
  ) => Promise<{ alreadyCommitted: boolean; commit: () => void }>;
  loadIntent(ref: DurableJobRef): Promise<PublishingEntityIntent>;
  assertCurrent(ref: DurableJobRef): Promise<void>;
  commitCurrent(ref: DurableJobRef, mutation: (tx: Transaction) => Promise<void>): Promise<void>;
  markCritical(
    ref: DurableJobRef,
    reasonCode: string,
    prepare?: (tx: Transaction) => Promise<() => void>
  ): Promise<void>;
  recordResult(ref: DurableJobRef, result: PublishingStepResult): Promise<void>;
  leaseAudio(ref: DurableJobRef, sermonId?: string, sourcePath?: string): Promise<void>;
  releaseAudio(ref: DurableJobRef): Promise<{ released: boolean }>;
}
export interface EntityActivityResult extends PublishingStepResult {
  blockingJobId?: string;
  result?: Record<string, unknown>;
}
export function createPublishingEntityActivities(store: PublishingEntityActivityStore) {
  const failure = async (ref: DurableJobRef, error: unknown): Promise<EntityActivityResult> => {
    const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
    const reason = details && typeof details === 'object' && 'reason' in details ? details.reason : undefined;
    let receiptId =
      details &&
      typeof details === 'object' &&
      'receiptId' in details &&
      typeof details.receiptId === 'string' &&
      /^[a-f0-9]{64}$/.test(details.receiptId)
        ? details.receiptId
        : undefined;
    const rawMutationSessionId =
      error && typeof error === 'object' && 'mutationSessionId' in error
        ? error.mutationSessionId
        : details && typeof details === 'object' && 'mutationSessionId' in details
        ? details.mutationSessionId
        : undefined;
    const mutationSessionId =
      typeof rawMutationSessionId === 'string' && /^[a-f0-9]{64}$/.test(rawMutationSessionId)
        ? rawMutationSessionId
        : undefined;
    const candidate =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    const detailCode = details && typeof details === 'object' && 'code' in details ? details.code : undefined;
    const blockingJobId =
      details &&
      typeof details === 'object' &&
      'blockingJobId' in details &&
      typeof details.blockingJobId === 'string' &&
      /^[A-Za-z0-9:_-]{1,256}$/.test(details.blockingJobId)
        ? details.blockingJobId
        : undefined;
    const permissionChanged =
      !!candidate && ['PERMISSION_CHANGED', 'PUBLISHING_PERMISSION_CHANGED', 'permission-denied'].includes(candidate);
    if (permissionChanged && !receiptId) {
      try {
        const receipts = await listProviderReceiptsForJob(ref);
        receiptId =
          receipts.find((item) => item.receipt.state === 'executing' || item.receipt.state === 'needs_review')
            ?.receiptId ?? receipts.find((item) => item.receipt.state === 'confirmed')?.receiptId;
      } catch {
        /* Preserve blocked permission state if private proof lookup is unavailable. */
      }
    }
    const response = error && typeof error === 'object' && 'response' in error ? error.response : undefined;
    const status = response && typeof response === 'object' && 'status' in response ? response.status : undefined;
    const transient =
      (candidate &&
        [
          'unavailable',
          'deadline-exceeded',
          'resource-exhausted',
          'aborted',
          'ECONNRESET',
          'ETIMEDOUT',
          'ECONNABORTED',
          'ERR_NETWORK',
          'EAI_AGAIN',
        ].includes(candidate)) ||
      status === 429 ||
      (typeof status === 'number' && status >= 500 && status <= 599);
    const mutationCode = [candidate, detailCode].find(
      (value) =>
        value === 'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT' ||
        value === 'PROVIDER_MUTATION_UNRESOLVED' ||
        value === 'PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED'
    );
    const code = mutationCode
      ? mutationCode
      : reason === 'PROVIDER_RESULT_AMBIGUOUS'
      ? 'PROVIDER_CREATE_AMBIGUOUS'
      : reason === 'PROVIDER_UPLOAD_SLOT_UNAVAILABLE'
      ? 'PUBLISHING_PROVIDER_REPAIR_REQUIRED'
      : detailCode === 'PUBLISHED_LIST_DRIFT_BLOCKED'
      ? 'PUBLISHING_DRIFT'
      : permissionChanged
      ? 'PUBLISHING_PERMISSION_CHANGED'
      : transient
      ? 'PUBLISHING_TRANSIENT'
      : candidate &&
        [
          'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
          'PUBLISHING_AUDIO_PROCESSING',
          'PUBLISHING_SUPERSEDED',
          'PUBLISHING_AUDIO_SUPERSEDED',
          'PUBLISHING_PROVIDER_REPAIR_REQUIRED',
          'PUBLISHING_DRIFT',
        ].includes(candidate)
      ? candidate
      : 'ENTITY_MUTATION_FAILED';
    const result: EntityActivityResult = {
      state: ['PROVIDER_CREATE_AMBIGUOUS', 'PUBLISHING_DRIFT'].includes(code)
        ? 'needs_review'
        : [
            'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT',
            'PROVIDER_MUTATION_UNRESOLVED',
            'PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED',
            'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
            'PUBLISHING_SUPERSEDED',
            'PUBLISHING_AUDIO_SUPERSEDED',
            'PUBLISHING_PROVIDER_REPAIR_REQUIRED',
            'PUBLISHING_PERMISSION_CHANGED',
          ].includes(code)
        ? 'blocked'
        : 'failed',
      code,
      ...(mutationSessionId ? { mutationSessionId } : {}),
      ...(receiptId ? { receiptId } : {}),
      ...(code === 'PUBLISHING_PROVIDER_ALLOCATION_PENDING' && blockingJobId ? { blockingJobId } : {}),
    };
    // Processing waits and known transport retries must not hold audio admission
    // while the workflow sleeps. Unknown provider effects retain their lease.
    if (
      [
        'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
        'PUBLISHING_AUDIO_PROCESSING',
        'PUBLISHING_TRANSIENT',
        'PUBLISHING_SUPERSEDED',
        'PUBLISHING_AUDIO_SUPERSEDED',
      ].includes(code)
    )
      await store.releaseAudio(ref);
    await store.recordResult(ref, result);
    return result;
  };
  return {
    async reportPublishingEntityCancellationFailure(
      ref: DurableJobRef
    ): Promise<EntityActivityResult & { cancelOnly: true }> {
      // Reporting a stuck cancellation cannot depend on the original actor's
      // current role. It dispatches no provider mutation or canonical projection.
      let receiptId: string | undefined;
      try {
        const receipts = await listProviderReceiptsForJob(ref);
        receiptId =
          receipts.find((item) => item.receipt.state === 'executing' || item.receipt.state === 'needs_review')
            ?.receiptId ?? receipts.find((item) => item.receipt.state === 'confirmed')?.receiptId;
      } catch {
        /* Preserve the live cancellation barrier even without a receipt proof. */
      }
      const outcome: EntityActivityResult & { cancelOnly: true } = {
        state: 'blocked',
        code: 'PUBLISHING_CANCEL_REPAIR_REQUIRED',
        ...(receiptId ? { receiptId } : {}),
        cancelOnly: true,
      };
      await store.recordResult(ref, outcome);
      return outcome;
    },
    async cleanupCancelledPublishingEntity(ref: DurableJobRef): Promise<EntityActivityResult & { cancelOnly: true }> {
      const intent = await store.loadIntent(ref);
      const outcome = await runDurablePublishingOperation(
        ref.jobId,
        async () => {
          const held = (
            await abortProvablyUnsentProviderMutationSessionsForJob(firebaseAdmin.firestore(), ref, (mutate) =>
              runDurableTransaction(firebaseAdmin.firestore(), mutate)
            )
          ).find((session) => session.state === 'active');
          if (held)
            return {
              state: 'blocked' as const,
              code: 'PUBLISHING_CANCEL_MUTATION_REVIEW_REQUIRED',
              mutationSessionId: held.sessionId,
            };
          await abortCancelledDesiredProviderDeletions(firebaseAdmin.firestore(), ref, store);
          return cancelPublishingEffects(ref, intent, store);
        },
        (mutate) => store.commitCurrent(ref, mutate),
        { cancelOnly: true }
      );
      if (outcome.state === 'completed') {
        await settleCancelledPublishingAllocations(firebaseAdmin.firestore(), store, ref);
        await store.releaseAudio(ref);
      }
      await store.recordResult(ref, outcome);
      return { ...outcome, cancelOnly: true };
    },
    async recoverPublishingEntityFailure(ref: DurableJobRef): Promise<EntityActivityResult> {
      // Recovery is report-only; a revoked original actor must not hide already-confirmed receipt evidence.
      let receipts: Awaited<ReturnType<typeof listProviderReceiptsForJob>>;
      try {
        receipts = await listProviderReceiptsForJob(ref);
      } catch {
        // A failed proof query cannot demonstrate that any provider POST is safe
        // to replay or that its audio lease may be released.
        const result: EntityActivityResult = { state: 'blocked', code: 'PUBLISHING_PROVIDER_REPAIR_REQUIRED' };
        await store.recordResult(ref, result);
        return result;
      }
      const ambiguous = receipts
        .filter((item) => ['executing', 'needs_review'].includes(item.receipt.state))
        .sort((a, b) => a.receiptId.localeCompare(b.receiptId))[0];
      if (ambiguous)
        return failure(ref, { details: { reason: 'PROVIDER_RESULT_AMBIGUOUS', receiptId: ambiguous.receiptId } });
      // Prepared allocations never dispatched; confirmed allocations are replayed
      // by their primitive receipts. The job retains the original operation keys.
      const confirmed = receipts.find((item) => item.receipt.state === 'confirmed');
      return failure(ref, {
        code: 'unavailable',
        ...(confirmed ? { details: { receiptId: confirmed.receiptId } } : {}),
      });
    },
    async projectPublishingEntityAttention(
      ref: DurableJobRef,
      code:
        | 'PUBLISHING_DELETION_SETTLEMENT_REVIEW_REQUIRED'
        | 'PUBLISHING_RETRY_EXHAUSTED' = 'PUBLISHING_RETRY_EXHAUSTED'
    ): Promise<void> {
      await store.recordResult(ref, { state: 'failed', code });
    },
    async executeReviewedPublishingEntityCreate(
      ref: DurableJobRef,
      checkpointId: string
    ): Promise<EntityActivityResult> {
      try {
        const options: PublishingEntityExecutionOptions = {
          getSourceStepIds: store.getSourceStepIds,
          prepareProviderMutationEffectsClosed: store.prepareProviderMutationEffectsClosed,
          abortProviderMutationPlan: store.abortProviderMutationPlan,
          prepareAcknowledgedProjectionPlan: store.prepareAcknowledgedProjectionPlan,
          beginProviderMutationPlan: store.beginProviderMutationPlan,
          runPublishingProviderMutation: store.runPublishingProviderMutation,
          prepareProviderMutationPlanCommit: store.prepareProviderMutationPlanCommit,
          assertCurrent: (current) => store.assertCurrent(current),
          commitCurrent: (current, mutate) => store.commitCurrent(current, mutate),
          leaseAudio: (current, sermonId, sourcePath) => store.leaseAudio(current, sermonId, sourcePath),
          releaseAudio: (current) => store.releaseAudio(current),
          markCritical: (current, reasonCode, prepare) => store.markCritical(current, reasonCode, prepare),
        };
        const result = await runPublishingEntityContext(ref, options, async () => {
          const completed = await executeReviewedPublishingEntityCreateContinuation(ref, checkpointId, {
            ...options,
            firestore: firebaseAdmin.firestore(),
            loadIntent: (current) => store.loadIntent(current),
            assertCurrent: (current) => store.assertCurrent(current),
            commitCurrent: (current, write) => store.commitCurrent(current, write),
          });
          await releaseCanonicalProviderBindingsForCurrentJob();
          return completed;
        });
        await store.releaseAudio(ref);
        const outcome: EntityActivityResult = { state: 'completed', result };
        await store.recordResult(ref, outcome);
        return outcome;
      } catch (error) {
        return failure(ref, error);
      }
    },
    async executePublishingEntityActivity(ref: DurableJobRef): Promise<EntityActivityResult> {
      try {
        const intent = await store.loadIntent(ref);
        await store.assertCurrent(ref);
        const result = await executePublishingEntityOperation(ref, intent, {
          getSourceStepIds: store.getSourceStepIds,
          prepareProviderMutationEffectsClosed: store.prepareProviderMutationEffectsClosed,
          abortProviderMutationPlan: store.abortProviderMutationPlan,
          prepareAcknowledgedProjectionPlan: store.prepareAcknowledgedProjectionPlan,
          beginProviderMutationPlan: store.beginProviderMutationPlan,
          runPublishingProviderMutation: store.runPublishingProviderMutation,
          prepareProviderMutationPlanCommit: store.prepareProviderMutationPlanCommit,
          assertCurrent: (current) => store.assertCurrent(current),
          commitCurrent: (current, mutate) => store.commitCurrent(current, mutate),
          leaseAudio: (current, sermonId, sourcePath) => store.leaseAudio(current, sermonId, sourcePath),
          releaseAudio: (current) => store.releaseAudio(current),
          markCritical: (current, reasonCode, prepare) => store.markCritical(current, reasonCode, prepare),
        });
        await store.releaseAudio(ref);
        const outcome: EntityActivityResult = { state: 'completed', result };
        await store.recordResult(ref, outcome);
        return outcome;
      } catch (error) {
        return failure(ref, error);
      }
    },
    async executePublishingMaintenancePage(
      ref: DurableJobRef,
      cursor?: string
    ): Promise<EntityActivityResult & { page?: MaintenancePageResult }> {
      try {
        const intent = await store.loadIntent(ref);
        await store.assertCurrent(ref);
        const raw =
          intent.payload.input && typeof intent.payload.input === 'object' ? intent.payload.input : intent.payload;
        const input = normalizeMaintenanceInput({ ...raw, ...(cursor ? { cursor } : {}) });
        const page = await runDurablePublishingOperation(
          ref.jobId,
          () => executeMaintenancePage(ref, intent.actorUid, input),
          (mutate) => store.commitCurrent(ref, mutate),
          {
            getSourceStepIds: store.getSourceStepIds,
            prepareProviderMutationEffectsClosed: store.prepareProviderMutationEffectsClosed
              ? (tx, plan) => store.prepareProviderMutationEffectsClosed!(tx, ref, plan)
              : undefined,
            abortProviderMutationPlan: store.abortProviderMutationPlan
              ? (plan) => store.abortProviderMutationPlan!(ref, plan)
              : undefined,
            prepareAcknowledgedProjectionPlan: store.prepareAcknowledgedProjectionPlan
              ? (tx, plan) => store.prepareAcknowledgedProjectionPlan!(tx, ref, plan)
              : undefined,
            beginProviderMutationPlan: store.beginProviderMutationPlan
              ? (plan) => store.beginProviderMutationPlan!(ref, plan)
              : undefined,
            runPublishingProviderMutation: store.runPublishingProviderMutation
              ? (request) => store.runPublishingProviderMutation!(ref, request)
              : undefined,
            prepareProviderMutationPlanCommit: store.prepareProviderMutationPlanCommit
              ? (tx, plan) => store.prepareProviderMutationPlanCommit!(tx, ref, plan)
              : undefined,
            markCritical: (reasonCode, prepare) => store.markCritical(ref, reasonCode, prepare),
          }
        );
        return { state: 'completed', page };
      } catch (error) {
        return failure(ref, error);
      }
    },
  };
}
