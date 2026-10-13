import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { FixedRepairOperation } from './criticalRepair';
import {
  acquireProviderMutationSession,
  executeProviderMutationOnce,
  prepareProviderMutationEffectsClosed,
  prepareProviderMutationSessionCommitFromClosedEvidence,
  providerMutationFingerprint,
  validateProviderMutationOriginalCompletion,
  PROVIDER_MUTATION_SESSIONS,
  PROVIDER_MUTATION_FACTS,
  ProviderMutationGuardError,
  type ProviderMutationSession,
  type ProviderMutationTransactionRunner,
  type ProviderMutationReadyCanonicalCompletionValidator,
  type ProviderMutationEffectsClosureProof,
} from './providerMutationGuard';

type CertifiedDelete = Extract<FixedRepairOperation, { kind: 'provider_delete' }>;
export interface CertifiedPublishingDeletionAuthority {
  ref: DurableJobRef;
  certificateId: string;
  generation: number;
  operation: CertifiedDelete;
}
/** Must load the immutable certificate and current grant/admin/SDK/generation in this transaction.
 * A certificate digest supplied by an operator is never sufficient authority. */
export type CertifiedPublishingDeletionAuthorizationPhase = 'acquire' | 'replay' | 'claim' | 'close' | 'settle';
export type CertifiedPublishingDeletionAuthorizer = (
  tx: Transaction,
  authority: CertifiedPublishingDeletionAuthority,
  phase: CertifiedPublishingDeletionAuthorizationPhase
) => Promise<void>;
export interface CertifiedPublishingDeletionLease {
  ref: DurableJobRef;
  certificateId: string;
  generation: number;
  operations: CertifiedDelete[];
  session: ProviderMutationSession;
}
export interface CertifiedPublishingDeletionHandle extends CertifiedPublishingDeletionAuthority {
  lease: CertifiedPublishingDeletionLease;
  session: ProviderMutationSession;
  completion: 'acknowledged' | 'rejected_no_effect';
}
const unresolved = (sessionId?: string): never => {
  throw new ProviderMutationGuardError('PROVIDER_MUTATION_UNRESOLVED', sessionId);
};
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s/?#]/.test(value);
function descriptor(authority: CertifiedPublishingDeletionAuthority) {
  const { operation: op } = authority;
  if (
    !sha(authority.certificateId) ||
    !Number.isSafeInteger(authority.generation) ||
    authority.generation < 1 ||
    !id(authority.ref.projectId) ||
    !id(authority.ref.jobId) ||
    op.kind !== 'provider_delete' ||
    op.method !== 'DELETE' ||
    !Object.keys(op).every((key) =>
      ['kind', 'provider', 'resourceType', 'resourceId', 'accountId', 'method'].includes(key)
    ) ||
    !id(op.resourceId)
  )
    unresolved();
  if (
    !(
      op.provider === 'subsplash' &&
      op.accountId === 'app:9XTSHD' &&
      ['media', 'audio', 'series', 'list', 'list-row', 'tag'].includes(op.resourceType)
    ) &&
    !(op.provider === 'soundcloud' && op.resourceType === 'track' && /^soundcloud:users:[0-9]+$/.test(op.accountId))
  )
    unresolved();
  const resource = {
    provider: op.provider,
    account: op.accountId,
    resourceType: op.resourceType,
    resourceId: op.resourceId,
  };
  const operation = `critical-fixed-delete:${authority.certificateId}:${providerMutationFingerprint([
    authority.generation,
    resource,
  ])}`;
  const scope = { projectId: authority.ref.projectId, jobId: authority.ref.jobId, operation };
  const step = `certified-fixed-delete:${providerMutationFingerprint(resource)}`;
  const payload = { certificateId: authority.certificateId, generation: authority.generation, resource };
  return { scope, resource, step, payload };
}
function leaseDescriptor(lease: Omit<CertifiedPublishingDeletionLease, 'session'>) {
  if (!lease.operations.length) unresolved();
  const items = lease.operations.map((operation) => descriptor({ ...lease, operation }));
  const resources = [
    ...new Map(items.map((item) => [providerMutationFingerprint(item.resource), item.resource])).values(),
  ];
  if (resources.length !== items.length) unresolved();
  // Match core resource lock ordering exactly; a restart reconstructs the identical private scope.
  resources.sort((a, b) =>
    providerMutationFingerprint([lease.ref.projectId, a.provider, a.account, a.resourceId]).localeCompare(
      providerMutationFingerprint([lease.ref.projectId, b.provider, b.account, b.resourceId])
    )
  );
  const scope = {
    projectId: lease.ref.projectId,
    jobId: lease.ref.jobId,
    operation: `critical-fixed-delete:${lease.certificateId}:${providerMutationFingerprint([
      lease.generation,
      resources,
    ])}`,
  };
  return { scope, resources, steps: items.map((item) => item.step).sort() };
}
/** Derive the exact source-owned session identity before original-session cancellation scans. */
export function certifiedPublishingDeletionSessionId(plan: Omit<CertifiedPublishingDeletionLease, 'session'>): string {
  return providerMutationFingerprint(leaseDescriptor(plan).scope);
}
function assertLease(lease: CertifiedPublishingDeletionLease) {
  const source = leaseDescriptor(lease);
  if (
    lease.session.id !== providerMutationFingerprint(source.scope) ||
    providerMutationFingerprint(lease.session.scope) !== providerMutationFingerprint(source.scope) ||
    providerMutationFingerprint(lease.session.resources) !== providerMutationFingerprint(source.resources)
  )
    unresolved(lease.session.id);
  return source;
}
function assertHandle(handle: CertifiedPublishingDeletionHandle) {
  assertLease(handle.lease);
  if (
    handle.session !== handle.lease.session ||
    handle.ref.projectId !== handle.lease.ref.projectId ||
    handle.ref.jobId !== handle.lease.ref.jobId ||
    handle.certificateId !== handle.lease.certificateId ||
    handle.generation !== handle.lease.generation ||
    !handle.lease.operations.some(
      (op) => providerMutationFingerprint(op) === providerMutationFingerprint(handle.operation)
    )
  )
    unresolved(handle.session.id);
  return descriptor(handle);
}
/** Acquire the entire certificate DELETE set atomically before any transport. The callback must
 * compare operations against the complete private certificate catalogue, including no omitted target. */
export async function acquireCertifiedPublishingDeletionSession(
  input: Omit<CertifiedPublishingDeletionLease, 'session'> & {
    db: Firestore;
    transactionRunner: ProviderMutationTransactionRunner;
    validateCompletePlanInTransaction: (
      tx: Transaction,
      plan: Omit<CertifiedPublishingDeletionLease, 'session'>
    ) => Promise<void>;
    authorizeInTransaction: CertifiedPublishingDeletionAuthorizer;
  }
): Promise<CertifiedPublishingDeletionLease> {
  const source = leaseDescriptor(input);
  const session = await acquireProviderMutationSession({
    db: input.db,
    scope: source.scope,
    resources: source.resources,
    transactionRunner: input.transactionRunner,
    assertCurrentInTransaction: async (tx) => {
      await input.validateCompletePlanInTransaction(tx, input);
      for (const operation of input.operations)
        await input.authorizeInTransaction(tx, { ...input, operation }, 'acquire');
    },
  });
  return {
    ref: input.ref,
    certificateId: input.certificateId,
    generation: input.generation,
    operations: input.operations.map((op) => ({ ...op })),
    session,
  };
}
/** One original synchronous DELETE. No retry, redirect, GET match, or absence can manufacture ACK.
 * The caller must disable transport retries/redirects and derive its URL from this exact operation. */
export async function executeCertifiedPublishingDeletion(
  input: CertifiedPublishingDeletionAuthority & {
    db: Firestore;
    lease: CertifiedPublishingDeletionLease;
    executionId: string;
    transactionRunner: ProviderMutationTransactionRunner;
    authorizeInTransaction: CertifiedPublishingDeletionAuthorizer;
    sendOriginalDelete: (operation: CertifiedDelete) => Promise<{ status: number }>;
  }
): Promise<CertifiedPublishingDeletionHandle> {
  const source = descriptor(input);
  const fence = (tx: Transaction) => input.authorizeInTransaction(tx, input, 'claim');
  const session = input.lease.session;
  assertHandle({ ...input, session, completion: 'acknowledged' });
  if (session.db !== input.db) unresolved(session.id);
  // A genuine original no-effect response is replayable as a disposition, never as positive ACK.
  const previous = await input.transactionRunner(async (tx) => {
    await input.authorizeInTransaction(tx, input, 'replay');
    const request = await tx.get(
      input.db
        .collection(PROVIDER_MUTATION_SESSIONS)
        .doc(session.id)
        .collection('requests')
        .doc(providerMutationFingerprint(source.step))
    );
    if (!request.exists) return undefined;
    if (
      request.get('step') !== source.step ||
      request.get('method') !== 'DELETE' ||
      request.get('fingerprint') !== providerMutationFingerprint(['DELETE', source.payload])
    )
      unresolved(session.id);
    await validateProviderMutationOriginalCompletion(tx, session, [request as FirebaseFirestore.QueryDocumentSnapshot]);
    const state = request.get('state');
    if (state !== 'acknowledged' && state !== 'rejected_no_effect') unresolved(session.id);
    if (state === 'rejected_no_effect') {
      const fact = await tx.get(
        input.db
          .collection(PROVIDER_MUTATION_FACTS)
          .doc(providerMutationFingerprint([session.id, source.step, request.get('claim')]))
      );
      const evidence = fact.get('evidence');
      if (
        evidence?.transport !== 'original_http_response' ||
        ![404, 410].includes(evidence.status) ||
        evidence.providerCode !== 'fixed_resource_absent'
      )
        unresolved(session.id);
    }
    return state as 'acknowledged' | 'rejected_no_effect';
  });
  let completion: CertifiedPublishingDeletionHandle['completion'] = previous ?? 'acknowledged';
  if (!previous) {
    try {
      await executeProviderMutationOnce({
        session,
        step: source.step,
        method: 'DELETE',
        payload: source.payload,
        executionId: input.executionId,
        transactionRunner: input.transactionRunner,
        assertCurrentInTransaction: fence,
        send: async () => {
          const response = await input.sendOriginalDelete(input.operation);
          if (response.status === 200 || response.status === 204)
            return { completion: 'acknowledged', result: { originalHttpStatus: response.status } };
          if (response.status === 404 || response.status === 410)
            return {
              completion: 'rejected_no_effect',
              evidence: {
                transport: 'original_http_response',
                status: response.status,
                providerCode: 'fixed_resource_absent',
              },
            };
          return unresolved(session.id);
        },
      });
    } catch (error) {
      if (!(error instanceof ProviderMutationGuardError) || error.code !== 'PROVIDER_MUTATION_REJECTED_NO_EFFECT')
        throw error;
      completion = 'rejected_no_effect';
    }
  }
  return {
    ref: input.ref,
    certificateId: input.certificateId,
    generation: input.generation,
    operation: input.operation,
    lease: input.lease,
    session,
    completion,
  };
}
/** Fresh authenticated fixed-ID absence is required before closing effects; ownership remains held. */
export async function prepareCertifiedPublishingDeletionEffectsClosed(
  tx: Transaction,
  handle: CertifiedPublishingDeletionHandle,
  input: {
    authorizeInTransaction: CertifiedPublishingDeletionAuthorizer;
    validateFixedAbsence: (
      tx: Transaction,
      handle: CertifiedPublishingDeletionHandle
    ) => Promise<ProviderMutationEffectsClosureProof | void>;
  }
): Promise<{ alreadyClosed: boolean; commit: () => void }> {
  assertHandle(handle);
  const source = assertLease(handle.lease);
  for (const operation of handle.lease.operations)
    await input.authorizeInTransaction(tx, { ...handle, operation }, 'close');
  return prepareProviderMutationEffectsClosed(tx, handle.session, async (transaction) => {
    const sourceProof = await input.validateFixedAbsence(transaction, handle);
    if (sourceProof !== undefined) {
      // The trusted source validator reads its immutable qualified-disposition program in this
      // transaction. Forward its digest intact while forbidding expansion or NoSEND for these
      // newly claimed DELETEs: every lease step needs an actual original transport completion.
      if (
        !sha(sourceProof.sourceProgramDigest) ||
        !Array.isArray(sourceProof.expectedRequestSteps) ||
        !Array.isArray(sourceProof.qualifiedNoSendSteps) ||
        sourceProof.qualifiedNoSendSteps.length !== 0 ||
        providerMutationFingerprint([...sourceProof.expectedRequestSteps].sort()) !==
          providerMutationFingerprint(source.steps)
      )
        unresolved(handle.session.id);
      return sourceProof;
    }
    return {
      sourceProgramDigest: providerMutationFingerprint([handle.certificateId, handle.generation, source.resources]),
      expectedRequestSteps: source.steps,
      qualifiedNoSendSteps: [],
    };
  });
}
/** Invoke the closure only with same-ID canonical cleanup and usage-index settlement in this transaction.
 * The source validator reads private immutable completion/EOF receipts, not a caller boolean. */
export async function prepareCertifiedPublishingDeletionFinalSettlement(
  tx: Transaction,
  handle: CertifiedPublishingDeletionHandle,
  input: {
    authorizeInTransaction: CertifiedPublishingDeletionAuthorizer;
    validateSourceCompletion: ProviderMutationReadyCanonicalCompletionValidator;
  }
): Promise<{ alreadyCommitted: boolean; commit: () => void }> {
  assertHandle(handle);
  for (const operation of handle.lease.operations)
    await input.authorizeInTransaction(tx, { ...handle, operation }, 'settle');
  return prepareProviderMutationSessionCommitFromClosedEvidence(tx, handle.session, input.validateSourceCompletion);
}

export interface CertifiedPublishingDeletionController {
  /** Source-only reconstruction, never a workflow/client-supplied lease. */
  readonly lease: CertifiedPublishingDeletionLease;
  execute(
    operation: CertifiedDelete,
    sendOriginalDelete: (operation: CertifiedDelete) => Promise<{ status: number }>
  ): Promise<CertifiedPublishingDeletionHandle>;
  prepareEffectsClosed(
    tx: Transaction,
    validateFixedAbsence: (
      tx: Transaction,
      lease: CertifiedPublishingDeletionLease
    ) => Promise<ProviderMutationEffectsClosureProof | void>
  ): Promise<{ alreadyClosed: boolean; commit(): void }>;
  prepareFinalSettlement(
    tx: Transaction,
    validateSourceCompletion: ProviderMutationReadyCanonicalCompletionValidator
  ): Promise<{ alreadyCommitted: boolean; commit(): void }>;
}
/** Adapter for the repair activity's SDK-fenced commitCurrent. Creation must happen before any
 * provider observation: the entire immutable certificate DELETE set owns its locks first. */
export async function createCertifiedPublishingDeletionGuard(input: {
  ref: DurableJobRef;
  certificateId: string;
  generation: number;
  firestore: Firestore;
  commitCurrent(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
  getRepairObservationScope(): Promise<string>;
  readCompleteDeleteSet(): Promise<CertifiedDelete[]>;
  validateCompleteDeleteSetInTransaction(tx: Transaction, operations: CertifiedDelete[]): Promise<void>;
  authorizeCertifiedDeletionInTransaction(
    tx: Transaction,
    operation: CertifiedDelete,
    phase: CertifiedPublishingDeletionAuthorizationPhase
  ): Promise<void>;
}): Promise<CertifiedPublishingDeletionController | undefined> {
  const operations = await input.readCompleteDeleteSet();
  if (!operations.length) return undefined;
  const transactionRunner: ProviderMutationTransactionRunner = async <T>(mutate: (tx: Transaction) => Promise<T>) => {
    let result!: T;
    await input.commitCurrent(input.ref, async (tx) => {
      result = await mutate(tx);
    });
    return result;
  };
  const authorizeInTransaction: CertifiedPublishingDeletionAuthorizer = async (tx, authority, phase) => {
    if (
      authority.ref.projectId !== input.ref.projectId ||
      authority.ref.jobId !== input.ref.jobId ||
      authority.certificateId !== input.certificateId ||
      authority.generation !== input.generation
    )
      unresolved();
    await input.authorizeCertifiedDeletionInTransaction(tx, authority.operation, phase);
  };
  const lease = await acquireCertifiedPublishingDeletionSession({
    db: input.firestore,
    ref: input.ref,
    certificateId: input.certificateId,
    generation: input.generation,
    operations,
    transactionRunner,
    authorizeInTransaction,
    validateCompletePlanInTransaction: (tx, plan) => input.validateCompleteDeleteSetInTransaction(tx, plan.operations),
  });
  const executionId = await input.getRepairObservationScope();
  if (!sha(executionId)) unresolved(lease.session.id);
  let completedHandle: CertifiedPublishingDeletionHandle | undefined;
  return {
    lease,
    execute: async (operation, sendOriginalDelete) => {
      const handle = await executeCertifiedPublishingDeletion({
        db: input.firestore,
        ref: input.ref,
        certificateId: input.certificateId,
        generation: input.generation,
        operation,
        lease,
        executionId,
        transactionRunner,
        authorizeInTransaction,
        sendOriginalDelete,
      });
      completedHandle = handle;
      return handle;
    },
    prepareEffectsClosed: async (tx, validateFixedAbsence) => {
      const handle = completedHandle ?? unresolved(lease.session.id);
      return prepareCertifiedPublishingDeletionEffectsClosed(tx, handle, {
        authorizeInTransaction,
        validateFixedAbsence: (transaction) => validateFixedAbsence(transaction, lease),
      });
    },
    prepareFinalSettlement: async (tx, validateSourceCompletion) => {
      const handle = completedHandle ?? unresolved(lease.session.id);
      return prepareCertifiedPublishingDeletionFinalSettlement(tx, handle, {
        authorizeInTransaction,
        validateSourceCompletion,
      });
    },
  };
}
