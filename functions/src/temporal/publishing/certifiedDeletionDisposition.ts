import { createHash } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { FrozenProjectionRequest } from './criticalAcknowledgedRepair';
import type { CertifiedPublishingDeletionHandle, CertifiedPublishingDeletionAuthorizer } from './criticalDeletionGuard';
import {
  PROVIDER_MUTATION_SESSIONS,
  PROVIDER_MUTATION_FACTS,
  PROVIDER_MUTATION_LOCKS,
  providerMutationFingerprint,
  validateProviderMutationOriginalCompletion,
  type ProviderMutationSession,
} from './providerMutationGuard';

export const CERTIFIED_DELETION_DISPOSITIONS = 'temporalPublishingCertifiedDeletionDispositions';
const PROJECTIONS = 'temporalPublishingAcknowledgedProjections';
type OriginalDelete = FrozenProjectionRequest & {
  method: 'DELETE';
  target: NonNullable<FrozenProjectionRequest['target']>;
};
export interface CertifiedDeletionSourceHeader {
  headerPath: string;
  headerDigest: string;
  sourceProgramDigest: string;
  intentFingerprint: string;
  generation: number;
  workflowId: string;
}
export interface CertifiedDeletionFixedAbsence {
  proofPath: string;
  proofDigest: string;
  observationScope: string;
}
/** Immutable source observation, captured after an authenticated fixed-ID GET in the current
 * certificate-bound SDK attempt. It is separate from the mutable deletion phase journal. */
export interface CertifiedDeletionFixedAbsenceRecord {
  schemaVersion: 1;
  projectId: string;
  jobId: string;
  certificateId: string;
  generation: number;
  target: OriginalDelete['target'];
  state: 'absent';
  originalHttpStatus: 404 | 410;
  originalAccount: string;
  ownershipConfirmedBeforeDelete: true;
  proof: 'authenticated_fixed_id_get_404_410';
  observationScope: string;
}
export interface CertifiedDeletionDisposition {
  schemaVersion: 1;
  kind: 'certified_fixed_delete_original_nosend';
  projectId: string;
  jobId: string;
  generation: number;
  certificateId: string;
  originalSessionId: string;
  originalStep: string;
  originalRequestDigest: string;
  originalSessionSealDigest: string;
  originalPreparedRootDigest: string;
  originalPreparedPageDigest: string;
  originalPreparedReadyPageDigest: string;
  sourceHeader: CertifiedDeletionSourceHeader;
  certifiedSessionId: string;
  certifiedScopeDigest: string;
  certifiedStep: string;
  certifiedRequestFingerprint: string;
  certifiedClaim: string;
  certifiedExecutionId: string;
  certifiedFactId: string;
  certifiedFactDigest: string;
  completion: 'acknowledged' | 'rejected_no_effect';
  fixedAbsence: CertifiedDeletionFixedAbsence;
}
const fail = (): never => {
  throw Object.assign(new Error('Certified original NoSEND deletion disposition is required'), {
    code: 'PUBLISHING_CERTIFIED_DELETION_DISPOSITION_REQUIRED',
  });
};
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
// Same public timestamp normalization as immutable publishing projection fragments.
function ordered(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === 'object' && 'toMillis' in value && typeof value.toMillis === 'function')
    return value.toMillis();
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, ordered(item)])
    );
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  return fail();
}
export const certifiedDeletionDispositionDigest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex');
export const certifiedDeletionDispositionId = (ref: DurableJobRef, sessionId: string, step: string): string =>
  providerMutationFingerprint([ref.projectId, ref.jobId, sessionId, step]);

interface SourceInput {
  ref: DurableJobRef;
  originalSessionId: string;
  originalRequest: FrozenProjectionRequest;
  /** Source reads its immutable frozen deletion header, full route/ownership/program and intent generation. */
  validateSourceHeaderInTransaction(
    tx: Transaction,
    request: FrozenProjectionRequest
  ): Promise<CertifiedDeletionSourceHeader>;
}
function assertOriginalDelete(request: FrozenProjectionRequest): asserts request is OriginalDelete {
  if (request.method !== 'DELETE' || !request.target || !request.step || !sha(request.fingerprint)) fail();
}
interface OriginalProof {
  sessionSealDigest: string;
  preparedRootDigest: string;
  pageDigest: string;
  readyPageDigest: string;
  sourceHeader: CertifiedDeletionSourceHeader;
}
async function originalProof(tx: Transaction, db: Firestore, input: SourceInput): Promise<OriginalProof> {
  assertOriginalDelete(input.originalRequest);
  const request = input.originalRequest,
    target = request.target;
  if (
    !sha(input.originalSessionId) ||
    request.method !== 'DELETE' ||
    !request.step ||
    !sha(request.fingerprint) ||
    !target ||
    !['subsplash', 'soundcloud'].includes(target.provider)
  )
    fail();
  const ref = db.collection(PROVIDER_MUTATION_SESSIONS).doc(input.originalSessionId),
    snapshot = await tx.get(ref),
    session = object(snapshot.data());
  if (
    !snapshot.exists ||
    session.schemaVersion !== 1 ||
    session.state !== 'aborted' ||
    session.effectsClosed === true ||
    session.scope?.projectId !== input.ref.projectId ||
    session.scope?.jobId !== input.ref.jobId ||
    providerMutationFingerprint(session.scope) !== input.originalSessionId ||
    !Array.isArray(session.resources)
  )
    fail();
  // Initial supported case is an atomically aborted zero-request original session. Partial ACK,
  // no-effect/sending/unknown catalogues need an explicit ownership-transfer protocol instead.
  const oldRequests = await tx.get(ref.collection('requests').limit(1));
  if (!oldRequests.empty) fail();
  const root = await tx.get(db.doc(`${PROJECTIONS}/${input.originalSessionId}`)),
    data = object(root.data());
  if (
    !root.exists ||
    data.schemaVersion !== 2 ||
    data.projectId !== input.ref.projectId ||
    data.jobId !== input.ref.jobId ||
    data.sessionId !== input.originalSessionId ||
    data.operation !== session.scope.operation ||
    !sha(data.intentFingerprint)
  )
    fail();
  const index = await tx.get(root.ref.collection('requestIndex').doc(providerMutationFingerprint(request.step))),
    planned = index.get('request');
  if (
    !index.exists ||
    index.get('ready') !== true ||
    index.get('intentFingerprint') !== data.intentFingerprint ||
    certifiedDeletionDispositionDigest(planned) !== certifiedDeletionDispositionDigest(request) ||
    !sha(index.get('pageDigest')) ||
    !sha(index.get('readyPageDigest'))
  )
    fail();
  const pageDigest = index.get('pageDigest') as string,
    readyPageDigest = index.get('readyPageDigest') as string;
  const page = await tx.get(root.ref.collection('pages').doc(pageDigest)),
    ready = await tx.get(root.ref.collection('pages').doc(readyPageDigest));
  for (const [snapshot, digest] of [
    [page, pageDigest],
    [ready, readyPageDigest],
  ] as const) {
    const fragment = object(snapshot.data());
    if (
      !snapshot.exists ||
      certifiedDeletionDispositionDigest(fragment) !== digest ||
      fragment.sessionId !== input.originalSessionId ||
      fragment.intentFingerprint !== data.intentFingerprint ||
      !Array.isArray(fragment.requests) ||
      !fragment.requests.some(
        (value: unknown) => certifiedDeletionDispositionDigest(value) === certifiedDeletionDispositionDigest(request)
      )
    )
      fail();
  }
  if (ready.get('finalFragment') !== true) fail();
  const sourceHeader = await input.validateSourceHeaderInTransaction(tx, request);
  if (
    !/^temporal(?:Sermon|List|Series|Speaker)DeletionMirrorPlans\/[a-f0-9]{64}$/.test(sourceHeader.headerPath) ||
    ![sourceHeader.headerDigest, sourceHeader.sourceProgramDigest, sourceHeader.intentFingerprint].every(sha) ||
    sourceHeader.intentFingerprint !== data.intentFingerprint ||
    !Number.isSafeInteger(sourceHeader.generation) ||
    sourceHeader.generation < 1 ||
    !sourceHeader.workflowId
  )
    fail();
  const header = await tx.get(db.doc(sourceHeader.headerPath));
  if (
    !header.exists ||
    header.get('projectId') !== input.ref.projectId ||
    header.get('jobId') !== input.ref.jobId ||
    header.get('generation') !== sourceHeader.generation ||
    header.get('workflowId') !== sourceHeader.workflowId ||
    header.get('intentFingerprint') !== sourceHeader.intentFingerprint
  )
    fail();
  return {
    sessionSealDigest: certifiedDeletionDispositionDigest({
      schemaVersion: 1,
      scope: session.scope,
      resources: session.resources,
      resourceKeys: session.resourceKeys,
      state: 'aborted',
      abortedAtMillis: session.abortedAtMillis,
    }),
    preparedRootDigest: certifiedDeletionDispositionDigest(data),
    pageDigest,
    readyPageDigest,
    sourceHeader,
  };
}

async function certifiedProof(
  tx: Transaction,
  db: Firestore,
  input: {
    ref: DurableJobRef;
    certificateId: string;
    generation: number;
    session: ProviderMutationSession;
    target: OriginalDelete['target'];
  }
) {
  const { session, target } = input,
    stored = await tx.get(db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id)),
    data = object(stored.data());
  const resources = session.resources;
  if (!Array.isArray(resources) || !resources.length) fail();
  const expectedScope = {
    projectId: input.ref.projectId,
    jobId: input.ref.jobId,
    operation: `critical-fixed-delete:${input.certificateId}:${providerMutationFingerprint([
      input.generation,
      resources,
    ])}`,
  };
  if (
    !stored.exists ||
    data.schemaVersion !== 1 ||
    !['active', 'committed'].includes(data.state) ||
    !sha(input.certificateId) ||
    session.id !== providerMutationFingerprint(expectedScope) ||
    providerMutationFingerprint(session.scope) !== providerMutationFingerprint(expectedScope) ||
    providerMutationFingerprint(data.scope) !== providerMutationFingerprint(expectedScope) ||
    providerMutationFingerprint(data.resources) !== providerMutationFingerprint(resources) ||
    !resources.some((resource) => providerMutationFingerprint(resource) === providerMutationFingerprint(target))
  )
    fail();
  const resourceKeys = resources.map((resource) =>
    providerMutationFingerprint([input.ref.projectId, resource.provider, resource.account, resource.resourceId])
  );
  if (providerMutationFingerprint(data.resourceKeys) !== providerMutationFingerprint(resourceKeys)) fail();
  if (data.state === 'active') {
    const locks = await tx.getAll(...resourceKeys.map((key) => db.collection(PROVIDER_MUTATION_LOCKS).doc(key)));
    if (locks.some((lock) => !lock.exists || lock.get('state') !== 'held' || lock.get('sessionId') !== session.id))
      fail();
  }
  const step = `certified-fixed-delete:${providerMutationFingerprint(target)}`;
  const fingerprint = providerMutationFingerprint([
    'DELETE',
    { certificateId: input.certificateId, generation: input.generation, resource: target },
  ]);
  const request = await tx.get(stored.ref.collection('requests').doc(providerMutationFingerprint(step)));
  if (
    !request.exists ||
    request.get('step') !== step ||
    request.get('method') !== 'DELETE' ||
    request.get('fingerprint') !== fingerprint ||
    !['acknowledged', 'rejected_no_effect'].includes(request.get('state'))
  )
    fail();
  await validateProviderMutationOriginalCompletion(tx, session, [request as FirebaseFirestore.QueryDocumentSnapshot]);
  const factId = providerMutationFingerprint([session.id, step, request.get('claim')]),
    fact = await tx.get(db.collection(PROVIDER_MUTATION_FACTS).doc(factId));
  if (request.get('state') === 'acknowledged') {
    const result = object(fact.get('result'));
    if (
      !Object.keys(result).every((key) => key === 'originalHttpStatus') ||
      ![200, 204].includes(result.originalHttpStatus)
    )
      fail();
  } else {
    const evidence = object(fact.get('evidence'));
    if (
      evidence.transport !== 'original_http_response' ||
      ![404, 410].includes(evidence.status) ||
      evidence.providerCode !== 'fixed_resource_absent'
    )
      fail();
  }
  return {
    certifiedSessionId: session.id,
    certifiedScopeDigest: providerMutationFingerprint(expectedScope),
    certifiedStep: step,
    certifiedRequestFingerprint: fingerprint,
    certifiedClaim: request.get('claim') as string,
    certifiedExecutionId: request.get('executionId') as string,
    certifiedFactId: factId,
    certifiedFactDigest: certifiedDeletionDispositionDigest(fact.data()),
    completion: request.get('state') as CertifiedDeletionDisposition['completion'],
  };
}

async function validateAbsenceRecord(
  tx: Transaction,
  db: Firestore,
  input: {
    ref: DurableJobRef;
    certificateId: string;
    generation: number;
    target: OriginalDelete['target'];
    proof: CertifiedDeletionFixedAbsence;
  }
): Promise<void> {
  const record = await tx.get(db.doc(input.proof.proofPath)),
    data = object(record.data());
  if (
    !record.exists ||
    certifiedDeletionDispositionDigest(data) !== input.proof.proofDigest ||
    data.schemaVersion !== 1 ||
    data.projectId !== input.ref.projectId ||
    data.jobId !== input.ref.jobId ||
    data.certificateId !== input.certificateId ||
    data.generation !== input.generation ||
    providerMutationFingerprint(data.target) !== providerMutationFingerprint(input.target) ||
    data.state !== 'absent' ||
    ![404, 410].includes(data.originalHttpStatus) ||
    data.originalAccount !== input.target.account ||
    data.ownershipConfirmedBeforeDelete !== true ||
    data.proof !== 'authenticated_fixed_id_get_404_410' ||
    data.observationScope !== input.proof.observationScope ||
    !sha(data.observationScope)
  )
    fail();
}

/** Immutable source-qualified NoSEND for an ORIGINAL unclaimed request, backed by a DIFFERENT
 * certified guard's real original transport fact. Never edits the old request or fabricates ACK. */
export async function prepareCertifiedDeletionDisposition(
  tx: Transaction,
  db: Firestore,
  input: SourceInput & {
    certificateId: string;
    generation: number;
    certifiedHandle: CertifiedPublishingDeletionHandle;
    authorizeInTransaction: CertifiedPublishingDeletionAuthorizer;
    validateFixedAbsenceInTransaction(
      tx: Transaction,
      handle: CertifiedPublishingDeletionHandle
    ): Promise<CertifiedDeletionFixedAbsence>;
  }
): Promise<{ dispositionId: string; digest: string; commit(): void }> {
  assertOriginalDelete(input.originalRequest);
  const handle = input.certifiedHandle,
    target = input.originalRequest.target;
  if (
    handle.ref.projectId !== input.ref.projectId ||
    handle.ref.jobId !== input.ref.jobId ||
    handle.certificateId !== input.certificateId ||
    handle.generation !== input.generation ||
    providerMutationFingerprint(target) !==
      providerMutationFingerprint({
        provider: handle.operation.provider,
        account: handle.operation.accountId,
        resourceType: handle.operation.resourceType,
        resourceId: handle.operation.resourceId,
      })
  )
    fail();
  await input.authorizeInTransaction(tx, handle, 'close');
  const heldSession = await tx.get(db.collection(PROVIDER_MUTATION_SESSIONS).doc(handle.session.id));
  if (heldSession.get('state') !== 'active') fail();
  const original = await originalProof(tx, db, input);
  if (original.sourceHeader.generation !== input.generation) fail();
  const completed = await certifiedProof(tx, db, {
    ref: input.ref,
    certificateId: input.certificateId,
    generation: input.generation,
    session: handle.session,
    target,
  });
  const fixedAbsence = await input.validateFixedAbsenceInTransaction(tx, handle);
  if (
    !/^temporal[A-Za-z]+\/[a-f0-9]{64}(?:\/[A-Za-z]+\/[a-f0-9]{64})?$/.test(fixedAbsence.proofPath) ||
    !sha(fixedAbsence.proofDigest) ||
    !sha(fixedAbsence.observationScope)
  )
    fail();
  await validateAbsenceRecord(tx, db, {
    ref: input.ref,
    certificateId: input.certificateId,
    generation: input.generation,
    target,
    proof: fixedAbsence,
  });
  const disposition: CertifiedDeletionDisposition = {
    schemaVersion: 1,
    kind: 'certified_fixed_delete_original_nosend',
    projectId: input.ref.projectId,
    jobId: input.ref.jobId,
    generation: input.generation,
    certificateId: input.certificateId,
    originalSessionId: input.originalSessionId,
    originalStep: input.originalRequest.step,
    originalRequestDigest: certifiedDeletionDispositionDigest(input.originalRequest),
    originalSessionSealDigest: original.sessionSealDigest,
    originalPreparedRootDigest: original.preparedRootDigest,
    originalPreparedPageDigest: original.pageDigest,
    originalPreparedReadyPageDigest: original.readyPageDigest,
    sourceHeader: original.sourceHeader,
    ...completed,
    fixedAbsence,
  };
  const dispositionId = certifiedDeletionDispositionId(input.ref, input.originalSessionId, input.originalRequest.step),
    digest = certifiedDeletionDispositionDigest(disposition);
  const ref = db.collection(CERTIFIED_DELETION_DISPOSITIONS).doc(dispositionId),
    existing = await tx.get(ref);
  if (existing.exists) {
    const pinned = existing.get('disposition') as CertifiedDeletionDisposition;
    const { fixedAbsence: _freshObservation, ...currentIdentity } = disposition;
    const { fixedAbsence: _pinnedObservation, ...pinnedIdentity } = pinned ?? {};
    if (certifiedDeletionDispositionDigest(currentIdentity) !== certifiedDeletionDispositionDigest(pinnedIdentity))
      fail();
    // A restarted SDK attempt must prove fresh absence again, but cannot replace the original
    // immutable observation or change a root EOF checkpoint's already-pinned disposition digest.
    const validated = (await validateCertifiedDeletionDisposition(tx, db, input)) ?? fail();
    if (validated.dispositionId !== dispositionId) fail();
    return { dispositionId, digest: validated.digest, commit: () => {} };
  }
  return {
    dispositionId,
    digest,
    commit: () => {
      tx.create(ref, { disposition, digest });
    },
  };
}

/** Read-only proof used by frozen root/list cleanup as a qualified NoSEND branch. The caller
 * retains its fresh source SDK/grant/generation fence; this never authorizes another DELETE. */
export async function validateCertifiedDeletionDisposition(
  tx: Transaction,
  db: Firestore,
  input: SourceInput
): Promise<
  | {
      kind: CertifiedDeletionDisposition['kind'];
      dispositionId: string;
      digest: string;
      disposition: CertifiedDeletionDisposition;
    }
  | undefined
> {
  assertOriginalDelete(input.originalRequest);
  const dispositionId = certifiedDeletionDispositionId(input.ref, input.originalSessionId, input.originalRequest.step),
    snapshot = await tx.get(db.collection(CERTIFIED_DELETION_DISPOSITIONS).doc(dispositionId));
  if (!snapshot.exists) return undefined;
  const disposition = snapshot.get('disposition') as CertifiedDeletionDisposition,
    digest = snapshot.get('digest');
  if (
    !disposition ||
    disposition.schemaVersion !== 1 ||
    disposition.kind !== 'certified_fixed_delete_original_nosend' ||
    !sha(digest) ||
    certifiedDeletionDispositionDigest(disposition) !== digest ||
    disposition.projectId !== input.ref.projectId ||
    disposition.jobId !== input.ref.jobId ||
    disposition.originalSessionId !== input.originalSessionId ||
    disposition.originalStep !== input.originalRequest.step ||
    disposition.originalRequestDigest !== certifiedDeletionDispositionDigest(input.originalRequest)
  )
    fail();
  const original = await originalProof(tx, db, input);
  if (
    original.sessionSealDigest !== disposition.originalSessionSealDigest ||
    original.preparedRootDigest !== disposition.originalPreparedRootDigest ||
    original.pageDigest !== disposition.originalPreparedPageDigest ||
    original.readyPageDigest !== disposition.originalPreparedReadyPageDigest ||
    certifiedDeletionDispositionDigest(original.sourceHeader) !==
      certifiedDeletionDispositionDigest(disposition.sourceHeader) ||
    disposition.generation !== original.sourceHeader.generation
  )
    fail();
  const sessionSnap = await tx.get(db.collection(PROVIDER_MUTATION_SESSIONS).doc(disposition.certifiedSessionId)),
    sessionData = object(sessionSnap.data());
  const session: ProviderMutationSession = {
    db,
    id: disposition.certifiedSessionId,
    scope: sessionData.scope,
    resources: sessionData.resources,
  };
  const completed = await certifiedProof(tx, db, {
    ref: input.ref,
    certificateId: disposition.certificateId,
    generation: disposition.generation,
    session,
    target: input.originalRequest.target,
  });
  for (const [field, value] of Object.entries(completed))
    if (disposition[field as keyof CertifiedDeletionDisposition] !== value) fail();
  await validateAbsenceRecord(tx, db, {
    ref: input.ref,
    certificateId: disposition.certificateId,
    generation: disposition.generation,
    target: input.originalRequest.target,
    proof: disposition.fixedAbsence,
  });
  return { kind: disposition.kind, dispositionId, digest, disposition };
}
