import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { DurableActivityExecution } from '@upperroom/orchestration/job-store';
import type { Client } from '@temporalio/client';
import { acknowledgedProjectionDigest as digest } from '../../../../functions/src/temporal/publishing/acknowledgedProjectionDigest';
import {
  PROVIDER_MUTATION_SESSIONS,
  providerMutationFingerprint,
} from '../../../../functions/src/temporal/publishing/providerMutationGuard';
import {
  SANDBOX_LIST_PARTIAL_STOPS,
  SANDBOX_LIST_PARTIAL_STOP_STATE,
} from '../../../../functions/src/temporal/publishing/retainedSandboxListStop';
import { isStagingSandboxDatabase } from '../../../../functions/src/providerSandbox/database';

const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const result = {
  state: 'completed',
  mode: 'partial_stop',
  providerEffects: 'partial',
  contentPreserved: true,
} as const;

function fail(): never {
  throw new Error('SANDBOX_LIST_PARTIAL_STOP_HANDOFF_UNCONFIRMED');
}

/** Recognizes an already committed simulator stop. The original workflow
 * remains the sole owner of cancellation and this reads no provider. */
export async function readSandboxListStopHandoff(
  db: Firestore,
  ref: DurableJobRef,
  certificateId: string,
  assertCurrent: (tx: Transaction, ref: DurableJobRef) => Promise<unknown>
): Promise<(typeof result & { nativeCancellationRequired: true }) | undefined> {
  if (!isStagingSandboxDatabase(db, ref.projectId)) return;
  const scope = { ...ref, operation: 'publishing:' + ref.jobId + ':lists:publish:all' };
  const sessionId = providerMutationFingerprint(scope);
  return db.runTransaction(async (tx) => {
    const [stop, intent] = await tx.getAll(
      db.doc(SANDBOX_LIST_PARTIAL_STOPS + '/' + sessionId),
      db.doc('durableJobCancellationIntents/' + ref.jobId)
    );
    if (intent.get('purpose') !== 'sandbox_list_partial_stop' && !stop.exists) return;
    const commandId = intent.get('reviewCommandId'), approvalId = intent.get('approvalId');
    if (!stop.exists || !stop.createTime?.isEqual(stop.updateTime!) ||
        !sha(certificateId) || intent.get('certificateId') !== certificateId ||
        intent.get('purpose') !== 'sandbox_list_partial_stop' || !sha(commandId) || !sha(approvalId)) fail();

    await assertCurrent(tx, ref);
    const [job, holder, approved, command] = await tx.getAll(
      db.doc('durableJobs/' + ref.jobId),
      db.doc(PROVIDER_MUTATION_SESSIONS + '/' + sessionId),
      db.doc('temporalSandboxListCommitReviews/' + approvalId),
      db.doc('durableJobCommands/' + commandId)
    );
    const actorUid = intent.get('actorUid');
    const generation = intent.get('generation');
    const workflowId = intent.get('workflowId');
    const review = approved.get('review');
    const sourceDigest = approved.get('sourceDigest');
    const expected = { projectId: ref.projectId, jobId: ref.jobId, workflowId, generation };
    if (
      !approved.exists || !approved.createTime?.isEqual(approved.updateTime!) ||
      approved.get('actorUid') !== actorUid || approved.get('projectId') !== ref.projectId ||
      approved.get('jobId') !== ref.jobId || !sha(sourceDigest) || !sha(approved.get('nativeWitnessDigest')) ||
      review?.certificateId !== certificateId || review?.sessionId !== sessionId ||
      review?.workflowId !== workflowId || review?.generation !== generation ||
      [intent, job, stop].some((doc) => Object.entries(expected).some(([field, value]) => doc.get(field) !== value)) ||
      job.get('state') !== 'cancel_requested' || job.get('kind') !== 'sermon.publish' ||
      job.get('result.resolutionPurpose') !== 'cleanup' ||
      job.get('result.mode') !== 'partial_stop' || job.get('result.providerEffects') !== 'partial' ||
      job.get('result.contentPreserved') !== true ||
      intent.get('sessionId') !== sessionId || intent.get('acceptedUserCancellation') !== false ||
      stop.get('sessionId') !== sessionId || stop.get('commandId') !== commandId ||
      stop.get('sourceDigest') !== sourceDigest ||
      stop.get('approvalDigest') !== digest({ review, sourceDigest, actorUid, commandId }) ||
      digest(stop.get('result')) !== digest(result) ||
      holder.get('state') !== SANDBOX_LIST_PARTIAL_STOP_STATE ||
      digest(holder.get('scope')) !== digest(scope) ||
      holder.get('sandboxPartialStopDigest') !== digest(stop.data()) ||
      !holder.updateTime?.isEqual(stop.createTime!) ||
      command.get('projectId') !== ref.projectId || command.get('jobId') !== ref.jobId ||
      command.get('actorUid') !== actorUid || command.get('workflowId') !== workflowId ||
      command.get('action') !== 'resolve' || command.get('sandboxListApprovalId') !== approvalId ||
      !['dispatching', 'dispatched'].includes(command.get('state')) ||
      command.get('signal.name') !== 'publishingCriticalRepair' ||
      digest(command.get('signal.args')) !== digest([{ certificateId }])
    )
      fail();
    return { ...result, nativeCancellationRequired: true };
  }, { readOnly: true });
}

/** The workflow signal ends desired work. This activity uses authenticated
 * Temporal control plane authority to cancel that same run, with one stable
 * native request identity across retries. */
export async function requestSandboxListNativeCancellation(
  db: Firestore,
  client: Pick<Client, 'connection'>,
  ref: DurableJobRef,
  certificateId: string,
  execution: DurableActivityExecution | undefined,
  assertCurrent: (tx: Transaction, ref: DurableJobRef) => Promise<unknown>
): Promise<void> {
  if (
    !execution ||
    execution.temporalNamespace !== 'urm-app-staging.qwejt' ||
    execution.activityType !== 'requestSandboxListNativeCancellation' ||
    !execution.workflowId ||
    !execution.runId
  )
    return fail();
  const verified = await readSandboxListStopHandoff(db, ref, certificateId, async (tx, target) => {
    await assertCurrent(tx, target);
    const job = await tx.get(db.doc('durableJobs/' + ref.jobId));
    if (job.get('workflowId') !== execution.workflowId) fail();
  });
  if (!verified) return fail();
  const requestId = digest([
    'sandbox_list_partial_stop', ref.projectId, ref.jobId, certificateId, execution.workflowId, execution.runId,
  ]);
  await client.connection.withDeadline(Date.now() + 5000, () =>
    client.connection.workflowService.requestCancelWorkflowExecution({
      namespace: execution.temporalNamespace,
      workflowExecution: { workflowId: execution.workflowId, runId: execution.runId },
      identity: 'urm-staging-sandbox-list-settlement',
      requestId,
    })
  );
}
