import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { DurableActivityExecution } from '@upperroom/orchestration/job-store';
import {
  publishingMutationRequestFingerprint,
  type PublishingMutationFinalSettlement,
  type PublishingMutationEffectsClosure,
  type PublishingMutationPlan,
  type PublishingMutationRequest,
} from '../../../../functions/src/temporal/publishing/durableOperationContext';
import {
  verifyPublishingMutationTarget,
  assertPublishingMutationTargetProofForSession,
} from '../../../../functions/src/temporal/publishing/mutationTargetProof';
import { assertLiveProviderMutationProject, isPrivateProviderMutationSimulation } from './provider-isolation';
import {
  assertAcknowledgedProjectionRequestPrepared,
  prepareAcknowledgedProjectionPlan,
  prepareAcknowledgedProjectionSeal,
  prepareOriginalAcknowledgedProjectionReplay,
  validateOriginalAcknowledgedMutation,
} from '../../../../functions/src/temporal/publishing/criticalAcknowledgedRepair';
import {
  acquireProviderMutationSession,
  executeProviderMutationOnce,
  prepareProviderMutationSessionCommit,
  prepareProviderMutationSessionCommitFromClosedEvidence,
  providerMutationFingerprint,
  PROVIDER_MUTATION_SESSIONS,
  abortUnsentProviderMutationSession,
  prepareProviderMutationEffectsClosed,
  type ProviderMutationSession,
} from '../../../../functions/src/temporal/publishing/providerMutationGuard';
const fail = (): never => {
  throw Object.assign(new Error('Provider mutation plan is unresolved'), { code: 'PROVIDER_MUTATION_UNRESOLVED' });
};
const parentHint = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== 'object') return;
  const body = payload as Record<string, unknown>,
    embedded = body._embedded as Record<string, unknown> | undefined,
    source = embedded?.['source-list'] as Record<string, unknown> | undefined;
  const candidate = body.listId ?? source?.id;
  return typeof candidate === 'string' ? candidate : undefined;
};
interface Plan {
  session: ProviderMutationSession;
  fingerprint: string;
  committed: boolean;
}
/** Process memory locates the current activity's handles; Firestore owns every lock and request fact. */
export function createProviderMutationRegistry(options: {
  firestore: Firestore;
  projectId: string;
  getExecution(): DurableActivityExecution | undefined;
  getUiStepIds(): string[];
  assertCurrentInTransaction(tx: Transaction, ref: DurableJobRef): Promise<unknown>;
  prepareEvidenceWakeup?: Parameters<typeof executeProviderMutationOnce>[0]['prepareEvidenceWakeup'];
  assertNewProviderEffectInTransaction?(tx: Transaction, ref: DurableJobRef): Promise<void>;
}) {
  const contexts = new Map<string, Map<string, Plan>>();
  const identity = () => {
    const value = options.getExecution();
    if (!value || ['repairPublishingCritical', 'beginDurableCriticalRepair'].includes(value.activityType)) fail();
    return providerMutationFingerprint([
      value!.workflowId,
      value!.runId,
      value!.activityId,
      value!.scheduledAt,
      value!.attempt,
      value!.worker?.instanceId ?? null,
    ]);
  };
  const context = (ref: DurableJobRef) => {
    if (ref.projectId !== options.projectId) fail();
    const key = identity();
    let plans = contexts.get(key);
    if (!plans) {
      plans = new Map();
      contexts.set(key, plans);
    }
    return plans;
  };
  const get = (ref: DurableJobRef, operation: string) => {
    const plan = context(ref).get(operation) ?? fail();
    if (plan.session.scope.projectId !== ref.projectId || plan.session.scope.jobId !== ref.jobId) fail();
    return plan;
  };
  const forFactualSettlement = async (
    tx: Transaction,
    ref: DurableJobRef,
    operation: string,
    validateSourceCompletion?: PublishingMutationFinalSettlement['validateSourceCompletion'],
    closing = false
  ): Promise<Plan> => {
    await options.assertCurrentInTransaction(tx, ref);
    const cached = context(ref).get(operation);
    if (cached) return cached;
    const scope = { projectId: ref.projectId, jobId: ref.jobId, operation },
      id = providerMutationFingerprint(scope);
    const snapshot = await tx.get(options.firestore.collection(PROVIDER_MUTATION_SESSIONS).doc(id));
    if (
      !['active', 'committed'].includes(snapshot.get('state')) ||
      providerMutationFingerprint(snapshot.get('scope')) !== providerMutationFingerprint(scope) ||
      !Array.isArray(snapshot.get('resources'))
    )
      fail();
    if (
      !closing &&
      snapshot.get('state') === 'active' &&
      (snapshot.get('effectsClosed') !== true || !validateSourceCompletion)
    )
      fail();
    const session: ProviderMutationSession = { db: options.firestore, id, scope, resources: snapshot.get('resources') };
    if (!validateSourceCompletion && !closing) fail();
    // This handle locates preserved ownership only: it cannot acquire resources or admit a new request.
    return {
      session,
      fingerprint: providerMutationFingerprint({ operation, resources: session.resources }),
      committed: snapshot.get('state') === 'committed',
    };
  };
  return {
    clearCurrent() {
      const value = options.getExecution();
      if (value)
        contexts.delete(
          providerMutationFingerprint([
            value.workflowId,
            value.runId,
            value.activityId,
            value.scheduledAt,
            value.attempt,
            value.worker?.instanceId ?? null,
          ])
        );
    },
    async beginProviderMutationPlan(ref: DurableJobRef, plan: PublishingMutationPlan): Promise<void> {
      if (!isPrivateProviderMutationSimulation()) assertLiveProviderMutationProject(ref.projectId);
      const plans = context(ref),
        fingerprint = providerMutationFingerprint(plan),
        prior = plans.get(plan.operation);
      if (prior) {
        if (
          prior.fingerprint !== fingerprint ||
          prior.session.scope.jobId !== ref.jobId ||
          prior.session.scope.projectId !== ref.projectId
        )
          fail();
        return;
      }
      // A caller must plan the whole set, rather than hold A while waiting for B.
      if ([...plans.values()].some((value) => !value.committed)) {
        await options.firestore.runTransaction(async (tx) => {
          await options.assertCurrentInTransaction(tx, ref);
          for (const value of plans.values()) {
            const existing = await tx.get(
              options.firestore.collection(PROVIDER_MUTATION_SESSIONS).doc(value.session.id)
            );
            if (existing.get('state') !== 'committed') fail();
          }
        });
      }
      const scope = { projectId: ref.projectId, jobId: ref.jobId, operation: plan.operation };
      const id = providerMutationFingerprint(scope);
      const committed = await options.firestore.runTransaction(async (tx) => {
        await options.assertCurrentInTransaction(tx, ref);
        const snapshot = await tx.get(options.firestore.collection(PROVIDER_MUTATION_SESSIONS).doc(id));
        if (snapshot.get('state') !== 'committed') return undefined;
        const resources = plan.resources.map((resource) => ({
          ...resource,
          key: providerMutationFingerprint([ref.projectId, resource.provider, resource.account, resource.resourceId]),
        }));
        const sorted = [...new Map(resources.map((resource) => [resource.key, resource])).values()]
          .sort((a, b) => a.key.localeCompare(b.key))
          .map(({ key, ...resource }) => resource);
        if (
          providerMutationFingerprint(snapshot.get('scope')) !== providerMutationFingerprint(scope) ||
          providerMutationFingerprint(snapshot.get('resources')) !== providerMutationFingerprint(sorted)
        )
          fail();
        return { db: options.firestore, id, scope, resources: sorted } satisfies ProviderMutationSession;
      });
      const session =
        committed ??
        (await acquireProviderMutationSession({
          db: options.firestore,
          scope,
          resources: plan.resources,
          assertCurrentInTransaction: (tx) => options.assertCurrentInTransaction(tx, ref).then(() => {}),
        }));
      plans.set(plan.operation, { session, fingerprint, committed: Boolean(committed) });
    },
    async runPublishingProviderMutation<T>(ref: DurableJobRef, request: PublishingMutationRequest<T>): Promise<T> {
      const plan = get(ref, request.operation);
      const original = await options.firestore.runTransaction(async (tx) => {
        await options.assertCurrentInTransaction(tx, ref);
        return validateOriginalAcknowledgedMutation(tx, plan.session, {
          step: request.step,
          method: request.method,
          target: request.target,
          fingerprint: publishingMutationRequestFingerprint(request),
        });
      });
      if (original) return original.result as T;
      if (plan.committed) fail();
      await options.firestore.runTransaction(async (tx) => {
        await options.assertCurrentInTransaction(tx, ref);
        await assertAcknowledgedProjectionRequestPrepared(tx, plan.session, {
          step: request.step,
          method: request.method,
          target: request.target,
          fingerprint: publishingMutationRequestFingerprint(request),
        });
      });
      const targetProof = await verifyPublishingMutationTarget({
        db: options.firestore,
        ref,
        session: plan.session,
        target: request.target,
        parentHint: parentHint(request.payload),
      });
      return executeProviderMutationOnce({
        session: plan.session,
        step: request.step,
        method: request.method,
        payload: { target: request.target, body: request.payload },
        executionId: identity(),
        prepareEvidenceWakeup: options.prepareEvidenceWakeup,
        assertCurrentInTransaction: async (tx) => {
          await options.assertCurrentInTransaction(tx, ref);
          await options.assertNewProviderEffectInTransaction?.(tx, ref);
          await assertAcknowledgedProjectionRequestPrepared(tx, plan.session, {
            step: request.step,
            method: request.method,
            target: request.target,
            fingerprint: publishingMutationRequestFingerprint(request),
          });
          await assertPublishingMutationTargetProofForSession(tx, targetProof, plan.session);
        },
        send: request.send,
      });
    },
    async prepareProviderMutationEffectsClosed(
      tx: Transaction,
      ref: DurableJobRef,
      input: PublishingMutationEffectsClosure
    ) {
      const plan = await forFactualSettlement(tx, ref, input.operation, undefined, true);
      if (plan.committed) {
        await input.validateSourceEffects(
          tx,
          plan.session,
          (
            await tx.get(
              options.firestore.collection(PROVIDER_MUTATION_SESSIONS).doc(plan.session.id).collection('requests')
            )
          ).docs
        );
        return { alreadyClosed: true, commit: () => {} };
      }
      return prepareProviderMutationEffectsClosed(tx, plan.session, input.validateSourceEffects);
    },
    async prepareProviderMutationPlanCommit(
      tx: Transaction,
      ref: DurableJobRef,
      input: PublishingMutationFinalSettlement
    ) {
      const plan = await forFactualSettlement(tx, ref, input.operation, input.validateSourceCompletion);
      const persisted = await tx.get(options.firestore.collection(PROVIDER_MUTATION_SESSIONS).doc(plan.session.id));
      if (persisted.get('effectsClosed') === true) {
        if (!input.validateSourceCompletion) fail();
        return prepareProviderMutationSessionCommitFromClosedEvidence(
          tx,
          plan.session,
          async (transaction, session, seal) => {
            const proof = await input.validateSourceCompletion!(transaction, session, seal);
            if (!proof) fail();
            await options.assertCurrentInTransaction(transaction, ref);
            return proof!;
          }
        );
      }
      if (input.validateSourceCompletion) {
        await input.validateSourceCompletion(tx, plan.session);
        await options.assertCurrentInTransaction(tx, ref);
      }
      const prepared = await prepareProviderMutationSessionCommit(tx, plan.session);
      if (prepared.alreadyCommitted) return prepared;
      const requests = await tx.get(
        options.firestore.collection(PROVIDER_MUTATION_SESSIONS).doc(plan.session.id).collection('requests')
      );
      if (requests.empty) return prepared;
      const seal = await prepareAcknowledgedProjectionSeal(tx, plan.session);
      return {
        alreadyCommitted: false,
        commit: () => {
          seal.commit();
          prepared.commit();
        },
      };
    },
    async prepareAcknowledgedProjectionPlan(
      tx: Transaction,
      ref: DurableJobRef,
      input: Parameters<typeof prepareAcknowledgedProjectionPlan>[2] & { operation: string }
    ) {
      const plan = get(ref, input.operation);
      await options.assertCurrentInTransaction(tx, ref);
      const replay = await prepareOriginalAcknowledgedProjectionReplay(tx, plan.session, input);
      if (replay) return replay;
      const targets = [
        ...input.requests.flatMap((request) => (request.target ? [request.target] : [])),
        ...input.verifications.map(({ provider, account, resourceType, resourceId }) => ({
          provider,
          account,
          resourceType,
          resourceId,
        })),
      ];
      const dynamic = [
        ...new Map(
          targets
            .filter(
              (target) =>
                !plan.session.resources.some(
                  (resource) => providerMutationFingerprint(resource) === providerMutationFingerprint(target)
                )
            )
            .map((target) => [providerMutationFingerprint(target), target])
        ).values(),
      ];
      const targetProofs = [];
      for (const target of dynamic) {
        const request = input.requests.find(
          (value) => value.target && providerMutationFingerprint(value.target) === providerMutationFingerprint(target)
        );
        targetProofs.push(
          await verifyPublishingMutationTarget({
            db: options.firestore,
            ref,
            session: plan.session,
            target,
            parentHint: parentHint(request?.payload),
          })
        );
      }
      return prepareAcknowledgedProjectionPlan(
        tx,
        plan.session,
        { ...input, uiStepIds: options.getUiStepIds() },
        { targetProofs }
      );
    },
    async abortProviderMutationPlan(ref: DurableJobRef, input: { operation: string }): Promise<void> {
      let session = context(ref).get(input.operation)?.session;
      if (!session) {
        session = await options.firestore.runTransaction(async (tx) => {
          await options.assertCurrentInTransaction(tx, ref);
          const scope = { projectId: ref.projectId, jobId: ref.jobId, operation: input.operation },
            id = providerMutationFingerprint(scope);
          const record = await tx.get(options.firestore.collection(PROVIDER_MUTATION_SESSIONS).doc(id));
          if (
            providerMutationFingerprint(record.get('scope')) !== providerMutationFingerprint(scope) ||
            !Array.isArray(record.get('resources'))
          )
            fail();
          return { db: options.firestore, id, scope, resources: record.get('resources') } as ProviderMutationSession;
        });
      }
      await abortUnsentProviderMutationSession({
        session,
        assertCurrentInTransaction: (tx) => options.assertCurrentInTransaction(tx, ref).then(() => {}),
      });
    },
  };
}
