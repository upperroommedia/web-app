import type { UserRecord } from 'firebase-admin/auth';
import type { DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { DurableCommandReceipt, DurableJobCommand, DurableJobRef } from '@upperroom/contracts/temporal';
import { createDurableJobStore } from '../../../../packages/orchestration/src/job-store';
import { admissionKey } from '../bridge';
import { isStagingSandboxDatabase } from '../../providerSandbox/database';
import { prepareRetainedSandboxListPartialStop, SANDBOX_LIST_PARTIAL_STOPS } from './retainedSandboxListStop';
import type { SandboxListCommitReview } from './retainedSandboxListCommit';

const prepareDecision = 'prepare_sandbox_list_commit_review';
const stopDecision = 'stop_after_sandbox_list_commit';
const requests = 'temporalSandboxListCommitReviewRequests';
const reviews = 'temporalSandboxListCommitReviews';
export const SANDBOX_LIST_STOP_PENDING = 'temporalSandboxListPartialStopPending';
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = (value: unknown, names: string[]): boolean =>
  !!value &&
  typeof value === 'object' &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.prototype.hasOwnProperty.call(value, name));
function fail(): never {
  throw new HttpsError('failed-precondition', 'The original staging sandbox list review could not be confirmed.');
}

export type SandboxListDecision = { kind: 'prepare' } | { kind: 'stop'; approvalId: string };
export function readSandboxListDecision(input: DurableJobCommand): SandboxListDecision | undefined {
  const decision = input.resolution?.decision;
  if (decision !== prepareDecision && decision !== stopDecision) return undefined;
  if (
    input.action !== 'resolve' ||
    !fields(input, ['jobId', 'expectedRevision', 'requestId', 'action', 'resolution']) ||
    !fields(input.resolution, decision === prepareDecision ? ['decision'] : ['decision', 'approvalId'])
  )
    throw new HttpsError('invalid-argument', 'Invalid sandbox list decision.');
  if (decision === prepareDecision) return { kind: 'prepare' };
  const approvalId = input.resolution?.approvalId;
  if (!sha(approvalId)) throw new HttpsError('invalid-argument', 'Invalid sandbox list approval ID.');
  return { kind: 'stop', approvalId };
}

export function assertSandboxListReviewer(account: UserRecord, authenticatedAt: number | undefined, fresh: boolean) {
  if (account.disabled || account.customClaims?.role !== 'admin')
    throw new HttpsError('permission-denied', 'An active administrator must review this staging job.');
  const now = Math.floor(Date.now() / 1000);
  const validAfter = account.tokensValidAfterTime ? Date.parse(account.tokensValidAfterTime) / 1000 : 0;
  if (
    typeof authenticatedAt !== 'number' ||
    !Number.isSafeInteger(authenticatedAt) ||
    !Number.isFinite(validAfter) ||
    authenticatedAt < validAfter ||
    authenticatedAt > now ||
    (fresh && now - authenticatedAt > 300)
  )
    throw new HttpsError('unauthenticated', 'Sign in again to review this staging job.');
}

function reviewTarget(db: Firestore, ref: DurableJobRef, job: DocumentSnapshot, expectedRevision: number) {
  if (
    !isStagingSandboxDatabase(db, ref.projectId) ||
    job.get('projectId') !== ref.projectId ||
    job.get('jobId') !== ref.jobId ||
    job.get('kind') !== 'sermon.publish' ||
    job.get('state') !== 'needs_attention' ||
    job.get('revision') !== expectedRevision ||
    !Array.isArray(job.get('actions')) ||
    !job.get('actions').includes('resolve') ||
    job.get('providerExecution.mode') !== 'sandbox' ||
    job.get('providerExecution.profileId') !== 'urm-app-staging-publishing-v1' ||
    job.get('providerExecution.version') !== 1 ||
    job.get('providerExecution.scenario') !== 'success' ||
    job.get('attention.stepId') !== 'lists' ||
    job.get('attention.resolutionKind') !== 'critical_repair' ||
    !sha(job.get('attention.certificateId')) ||
    !Number.isSafeInteger(job.get('generation')) ||
    job.get('generation') < 1 ||
    typeof job.get('workflowId') !== 'string' ||
    !job.get('workflowId')
  )
    fail();
  return {
    ...ref,
    generation: job.get('generation') as number,
    workflowId: job.get('workflowId') as string,
    expectedRevision,
    certificateId: job.get('attention.certificateId') as string,
  };
}

export async function prepareSandboxListReviewRequest(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  input: DurableJobCommand,
  actorUid: string,
  inputHash: string
): Promise<DurableCommandReceipt> {
  const command = db.doc(`durableJobCommands/${admissionKey(actorUid, 'command:' + input.requestId)}`);
  const request = db.doc(`${requests}/${admissionKey(actorUid, 'sandbox-list-review:' + input.requestId)}`);
  const [job, prior] = await tx.getAll(db.doc(`durableJobs/${ref.jobId}`), request);
  if (prior.exists) fail();
  await createDurableJobStore({ firestore: db, projectId: ref.projectId }).assertCurrentInTransaction(tx, ref);
  const target = reviewTarget(db, ref, job, input.expectedRevision);
  const receipt: DurableCommandReceipt = {
    ...ref,
    requestId: input.requestId,
    acceptedRevision: input.expectedRevision,
    state: 'accepted',
    sandboxListReviewRequestId: request.id,
  };
  tx.create(request, { schemaVersion: 1, ...target, actorUid, requestId: input.requestId, state: 'pending' });
  // This local command requests evidence. Only the later stop has a Temporal signal.
  const now = Date.now();
  tx.create(command, {
    schemaVersion: 1,
    ...ref,
    actorUid,
    inputHash,
    receipt,
    workflowId: target.workflowId,
    action: 'resolve',
    expectedRevision: input.expectedRevision,
    createdAt: now,
    updatedAt: now,
    state: 'dispatched',
    attempt: 0,
    nextAttemptAt: 0,
    leaseExpiresAt: 0,
    sandboxListReviewRequestId: request.id,
  });
  return receipt;
}

async function readCurrentSandboxListReview(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  approvalId: string,
  actorUid: string,
  expectedRevision?: number
) {
  const [approved, request, job] = await tx.getAll(
    db.doc(`${reviews}/${approvalId}`),
    db.doc(`${requests}/${approvalId}`),
    db.doc(`durableJobs/${ref.jobId}`)
  );
  const revision = request.get('expectedRevision');
  const originalRequestId = request.get('requestId');
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    (expectedRevision !== undefined && revision !== expectedRevision) ||
    !fields(request.data(), [
      'schemaVersion',
      'projectId',
      'jobId',
      'workflowId',
      'generation',
      'expectedRevision',
      'certificateId',
      'actorUid',
      'requestId',
      'state',
    ]) ||
    request.get('schemaVersion') !== 1 ||
    request.get('actorUid') !== actorUid ||
    typeof originalRequestId !== 'string' ||
    !originalRequestId.trim() ||
    originalRequestId.length > 200 ||
    admissionKey(actorUid, 'sandbox-list-review:' + originalRequestId) !== approvalId
  )
    return fail();
  const target = reviewTarget(db, ref, job, revision);
  if (Object.entries(target).some(([key, value]) => request.get(key) !== value)) return fail();
  if (request.get('state') === 'pending' && !approved.exists) return { state: 'pending' } as const;
  const review = approved.get('review') as SandboxListCommitReview | undefined;
  const sourceDigest = approved.get('sourceDigest');
  if (
    !approved.exists ||
    !approved.createTime?.isEqual(approved.updateTime!) ||
    !fields(approved.data(), [
      'schemaVersion',
      'projectId',
      'jobId',
      'actorUid',
      'requestId',
      'review',
      'sourceDigest',
      'nativeWitnessDigest',
    ]) ||
    approved.get('schemaVersion') !== 1 ||
    approved.get('projectId') !== ref.projectId ||
    approved.get('jobId') !== ref.jobId ||
    approved.get('actorUid') !== actorUid ||
    approved.get('requestId') !== originalRequestId ||
    !sha(approved.get('nativeWitnessDigest')) ||
    !sha(sourceDigest) ||
    !review ||
    !fields(review, [
      'sessionId',
      'workflowId',
      'generation',
      'expectedRevision',
      'certificateId',
      'drainId',
      'drainDigest',
    ]) ||
    !sha(review.sessionId) ||
    !sha(review.drainId) ||
    !sha(review.drainDigest) ||
    review.workflowId !== target.workflowId ||
    review.generation !== target.generation ||
    review.expectedRevision !== revision ||
    review.certificateId !== target.certificateId ||
    request.get('state') !== 'issued'
  )
    return fail();
  return { state: 'issued', review, sourceDigest } as const;
}

export async function readSandboxListCommitReviewStatus(
  db: Firestore,
  projectId: string,
  actorUid: string,
  input: unknown
) {
  if (!isStagingSandboxDatabase(db, projectId)) return fail();
  if (!fields(input, ['jobId', 'approvalId']))
    throw new HttpsError('invalid-argument', 'Invalid sandbox list status request.');
  const { jobId, approvalId } = input as Record<string, unknown>;
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(jobId) || !sha(approvalId))
    throw new HttpsError('invalid-argument', 'Invalid sandbox list status request.');
  const ref = { jobId, projectId };
  return db.runTransaction(
    async (tx) => {
      const review = await readCurrentSandboxListReview(tx, db, ref, approvalId, actorUid);
      await createDurableJobStore({ firestore: db, projectId }).assertCurrentInTransaction(tx, ref);
      return { state: review.state };
    },
    { readOnly: true }
  );
}

export async function prepareApprovedSandboxListStop(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  approvalId: string,
  actorUid: string,
  commandId: string,
  expectedRevision: number,
  assertAdmin: () => Promise<void>
) {
  const current = await readCurrentSandboxListReview(tx, db, ref, approvalId, actorUid, expectedRevision);
  if (current.state !== 'issued') return fail();
  const { review, sourceDigest } = current;
  const [stop, pending] = await tx.getAll(
    db.doc(`${SANDBOX_LIST_PARTIAL_STOPS}/${review.sessionId}`),
    db.doc(`${SANDBOX_LIST_STOP_PENDING}/${review.sessionId}`)
  );
  if (stop.exists || pending.exists) return fail();
  const prepared = await prepareRetainedSandboxListPartialStop(tx, db, ref, async () => {
    // All Firestore sources above participate in this same transaction. Recheck the
    // external account at the indexed writer's final pre-commit boundary as well.
    await assertAdmin();
    return { review, sourceDigest, actorUid, commandId };
  });
  return {
    approvalId,
    certificateId: review.certificateId,
    sessionId: review.sessionId,
    result: prepared.result,
    commit: prepared.commit,
  };
}
