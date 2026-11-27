import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import { withProviderIndexedTransaction } from '../../../../packages/orchestration/src/provider-transaction';
import { acknowledgedProjectionDigest as digest } from './acknowledgedProjectionDigest';
import { providerMutationFingerprint, PROVIDER_MUTATION_SESSIONS } from './providerMutationGuard';
import { isStagingSandboxDatabase } from '../../providerSandbox/database';
import { readRetainedSandboxListCommit, type SandboxListCommitReview } from './retainedSandboxListCommit';

export const SANDBOX_LIST_PARTIAL_STOPS = 'temporalSandboxListPartialStops';
export const SANDBOX_LIST_PARTIAL_STOP_STATE = 'sandbox_partial_stop';

/** Private output of the original approved stop command and its active worker
 * execution fence. The issuer, not this writer, authenticates those sources. */
export interface SandboxListPartialStopApproval {
  review: SandboxListCommitReview;
  sourceDigest: string;
  commandId: string;
  actorUid: string;
}

const result = {
  state: 'completed',
  mode: 'partial_stop',
  providerEffects: 'partial',
  contentPreserved: true,
} as const;

function fail(): never {
  throw new Error('RETAINED_SANDBOX_LIST_PARTIAL_STOP_UNCONFIRMED');
}

const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Prepare settlement in the same transaction as its provider index changes.
 * Lock rows and the historical unknown claim remain intact.
 * A partial disposition is separate from a provider acknowledgement. */
export async function prepareRetainedSandboxListPartialStop(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  assertApprovedExecution: (tx: Transaction, ref: DurableJobRef) => Promise<SandboxListPartialStopApproval>
) {
  if (!isStagingSandboxDatabase(db, ref.projectId)) return fail();
  const approval = await assertApprovedExecution(tx, ref);
  const { review } = approval;
  if (
    !sha(review.sessionId) ||
    !sha(approval.sourceDigest) ||
    !sha(approval.commandId) ||
    typeof approval.actorUid !== 'string' ||
    !approval.actorUid ||
    approval.actorUid.length > 128
  )
    return fail();
  const scope = { ...ref, operation: `publishing:${ref.jobId}:lists:publish:all` };
  if (providerMutationFingerprint(scope) !== review.sessionId) return fail();
  const approvalDigest = digest(approval);
  const stop = db.doc(`${SANDBOX_LIST_PARTIAL_STOPS}/${review.sessionId}`);
  const session = db.doc(`${PROVIDER_MUTATION_SESSIONS}/${review.sessionId}`);
  const [saved, held] = await tx.getAll(stop, session);
  if (saved.exists) {
    if (
      !saved.createTime?.isEqual(saved.updateTime!) ||
      saved.get('schemaVersion') !== 1 ||
      saved.get('projectId') !== ref.projectId ||
      saved.get('jobId') !== ref.jobId ||
      saved.get('sessionId') !== review.sessionId ||
      saved.get('approvalDigest') !== approvalDigest ||
      saved.get('sourceDigest') !== approval.sourceDigest ||
      digest(saved.get('result')) !== digest(result) ||
      held.get('state') !== SANDBOX_LIST_PARTIAL_STOP_STATE ||
      held.get('sandboxPartialStopDigest') !== digest(saved.data()) ||
      digest(held.get('scope')) !== digest(scope)
    )
      return fail();
    return { result, commit: async () => {} };
  }
  const proof = await readRetainedSandboxListCommit(tx, db, ref, review);
  if (digest(proof) !== approval.sourceDigest) return fail();
  const record = {
    schemaVersion: 1,
    ...ref,
    sessionId: review.sessionId,
    generation: review.generation,
    workflowId: review.workflowId,
    commandId: approval.commandId,
    sourceDigest: approval.sourceDigest,
    approvalDigest,
    resourceKeys: proof.resourceKeys,
    physicalListId: proof.physicalListId,
    projectionDigest: digest(proof.canonicalProjection),
    journalId: proof.journalId,
    journalDigest: proof.journalDigest,
    claimDigest: proof.claimDigest,
    result,
  };
  return {
    result,
    commit: () =>
      withProviderIndexedTransaction(
        tx,
        db,
        ref.projectId,
        async (recording) => {
          for (const write of proof.canonicalProjection) recording.update(db.doc(write.path), write.patch);
          recording.create(stop, record);
          recording.update(session, {
            state: SANDBOX_LIST_PARTIAL_STOP_STATE,
            sandboxPartialStopDigest: digest(record),
          });
        },
        {
          beforeCommit: async (transaction) => {
            if (digest(await assertApprovedExecution(transaction, ref)) !== approvalDigest) fail();
          },
        }
      ),
  };
}
