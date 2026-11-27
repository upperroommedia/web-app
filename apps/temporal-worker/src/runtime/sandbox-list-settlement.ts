import type { Client } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import { FieldPath, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { durableActivityDrainKey, type DurableActivityExecution } from '@upperroom/orchestration/job-store';
import { acknowledgedProjectionDigest as digest } from '../../../../functions/src/temporal/publishing/acknowledgedProjectionDigest';
import {
  PROVIDER_MUTATION_SESSIONS,
  providerMutationFingerprint,
} from '../../../../functions/src/temporal/publishing/providerMutationGuard';
import { readRetainedSandboxListCommit } from '../../../../functions/src/temporal/publishing/retainedSandboxListCommit';
import {
  SANDBOX_LIST_PARTIAL_STOPS,
  SANDBOX_LIST_PARTIAL_STOP_STATE,
} from '../../../../functions/src/temporal/publishing/retainedSandboxListStop';
import { isStagingSandboxDatabase } from '../../../../functions/src/providerSandbox/database';
import { assertAdmissionReleaseInTransaction } from '../../../../functions/src/temporal/releaseControl';

const REVIEW_REQUESTS = 'temporalSandboxListCommitReviewRequests';
const REVIEWS = 'temporalSandboxListCommitReviews';
const TERMINAL_PENDING = 'temporalSandboxListPartialStopPending';
const TERMINALS = 'temporalSandboxListPartialStopTerminals';
const CURSORS = 'temporalSandboxListSettlementCursors';
const projectId = 'urm-app-staging';
const namespace = 'urm-app-staging.qwejt';
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const frozen = (doc: DocumentSnapshot): boolean => doc.exists && doc.createTime?.isEqual(doc.updateTime!) === true;

function fail(): never {
  throw new Error('SANDBOX_LIST_SETTLEMENT_NATIVE_PROOF_REQUIRED');
}

type NativeClient = Pick<Client, 'workflow' | 'connection'>;
type WorkflowHandle = ReturnType<Client['workflow']['getHandle']>;
type Described = Awaited<ReturnType<WorkflowHandle['describe']>>;
type NativeHistory = Awaited<ReturnType<WorkflowHandle['fetchHistory']>>;
type HistoryEvent = NonNullable<NativeHistory['events']>[number];

function payloads(values: { payloads?: Parameters<typeof defaultPayloadConverter.fromPayload>[0][] | null } | null | undefined) {
  return (values?.payloads ?? []).map((value) => defaultPayloadConverter.fromPayload(value));
}

function eventMillis(event: HistoryEvent): number | undefined {
  const time = event.eventTime;
  if (!time?.seconds) return;
  return Number(BigInt(time.seconds.toString()) * 1000n + BigInt(time.nanos ?? 0) / 1_000_000n);
}

function refMatches(value: unknown, jobId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const ref = value as { projectId?: unknown; jobId?: unknown };
  return ref.projectId === projectId && ref.jobId === jobId;
}

function describe(client: NativeClient, workflowId: string): Promise<Described> {
  return client.connection.withDeadline(Date.now() + 5000, () => client.workflow.getHandle(workflowId).describe());
}

async function readLineage(client: NativeClient, head: Described, jobId: string, targetRunId?: string) {
  const lineage: Array<{ runId: string; events: HistoryEvent[]; close: HistoryEvent }> = [];
  let runId: string | null | undefined = head.runId;
  let successor: string | undefined;
  for (let offset = 0; runId && offset < 4; offset++) {
    const handle: WorkflowHandle = client.workflow.getHandle(head.workflowId, runId, {
      firstExecutionRunId: runId, followRuns: false,
    });
    const history = await client.connection.withDeadline(Date.now() + 5000, (): Promise<NativeHistory> =>
      handle.fetchHistory()
    );
    const events = history.events ?? [];
    const start = events[0]?.workflowExecutionStartedEventAttributes;
    const close = events.at(-1);
    if (
      !start ||
      start.workflowType?.name !== 'publishingWorkflow' ||
      !refMatches(payloads(start.input)[0], jobId) ||
      !close ||
      events.length > 512 ||
      (successor && close.workflowExecutionContinuedAsNewEventAttributes?.newExecutionRunId !== successor)
    )
      return fail();
    lineage.push({ runId, events, close });
    if (runId === targetRunId || (!targetRunId && !start.continuedExecutionRunId)) return lineage;
    successor = runId;
    runId = start.continuedExecutionRunId;
  }
  return fail();
}

function requireSameHead(before: Described, after: Described, expected: 'RUNNING' | 'CANCELLED'): void {
  if (
    before.status.name !== expected || after.status.name !== expected ||
    before.type !== 'publishingWorkflow' || after.type !== before.type ||
    after.workflowId !== before.workflowId || before.runId !== after.runId ||
    (before.raw.pendingActivities ?? []).length || (after.raw.pendingActivities ?? []).length
  )
    fail();
}

async function issueReview(db: Firestore, client: NativeClient, pending: DocumentSnapshot, signal: AbortSignal): Promise<void> {
  const row = pending.data();
  if (!row || !sha(pending.id) || row.schemaVersion !== 1 || row.projectId !== projectId ||
      !key(row.jobId) || !sha(row.certificateId) || !key(row.actorUid) ||
      typeof row.workflowId !== 'string' || typeof row.requestId !== 'string' ||
      pending.id !== digest([projectId, row.actorUid, 'sandbox-list-review:' + row.requestId])) fail();
  const ref = { projectId, jobId: row.jobId };
  const sessionId = providerMutationFingerprint({ ...ref, operation: 'publishing:' + ref.jobId + ':lists:publish:all' });
  const [claims, drains] = await Promise.all([
    db.doc(PROVIDER_MUTATION_SESSIONS + '/' + sessionId).collection('requests').limit(2).get(),
    db.collection('durableActivityDrains').where('jobId', '==', ref.jobId).limit(101).get(),
  ]);
  if (claims.size !== 1 || drains.size > 100 || claims.docs[0].get('state') !== 'unknown') fail();
  const [claim] = claims.docs;
  const related = drains.docs.filter((drain) => {
    const e = drain.get('execution') as DurableActivityExecution | undefined;
    return !!e && e.temporalNamespace === namespace && e.workflowId === row.workflowId &&
      e.activityType === 'applyPublishingLists' && providerMutationFingerprint([
        e.workflowId, e.runId, e.activityId, e.scheduledAt, e.attempt, e.worker?.instanceId ?? null,
      ]) === claim.get('executionId');
  });
  if (related.length !== 1) fail();
  const [drain] = related;
  const execution = drain.get('execution') as DurableActivityExecution;
  if (durableActivityDrainKey(projectId, ref.jobId, execution) !== drain.id) fail();
  const before = await describe(client, row.workflowId);
  if (before.workflowId !== row.workflowId) fail();
  const original = (await readLineage(client, before, ref.jobId, execution.runId)).at(-1);
  if (!original) return fail();
  const schedules = original.events.filter((event) => {
    const attr = event.activityTaskScheduledEventAttributes;
    return attr?.activityType?.name === 'applyPublishingLists' && attr.activityId === execution.activityId &&
      refMatches(payloads(attr.input)[0], ref.jobId);
  });
  if (schedules.length !== 1) fail();
  const [scheduled] = schedules;
  if (!scheduled.eventId || eventMillis(scheduled) !== execution.scheduledAt) fail();
  const scheduledId = scheduled.eventId.toString();
  const started = original.events.filter((event) => {
    const attr = event.activityTaskStartedEventAttributes;
    return attr?.scheduledEventId?.toString() === scheduledId && attr.attempt === execution.attempt;
  });
  if (started.length !== 1 || !started[0].eventId) fail();
  const completions = original.events.filter((event) => {
    const attr = event.activityTaskCompletedEventAttributes;
    return attr?.scheduledEventId?.toString() === scheduledId &&
      attr.startedEventId?.toString() === started[0].eventId?.toString();
  });
  if (completions.length !== 1 || !completions[0].eventId) fail();
  const [completion] = completions;
  const blocked = payloads(completion.activityTaskCompletedEventAttributes?.result);
  if (blocked.length !== 1 || digest(blocked[0]) !== digest({
    state: 'blocked', code: 'PROVIDER_MUTATION_UNRESOLVED', mutationSessionId: sessionId,
  })) fail();
  requireSameHead(before, await describe(client, row.workflowId), 'RUNNING');
  const review = {
    sessionId, workflowId: row.workflowId, generation: row.generation,
    expectedRevision: row.expectedRevision, certificateId: row.certificateId,
    drainId: drain.id, drainDigest: digest(drain.data()),
  };
  const approval = db.doc(REVIEWS + '/' + pending.id);
  const prepCommand = db.doc('durableJobCommands/' + digest([projectId, row.actorUid, 'command:' + row.requestId]));
  if (signal.aborted) return;
  await db.runTransaction(async (tx) => {
    await assertAdmissionReleaseInTransaction(tx, db, 'sermon.publish', { continuation: true });
    const [current, saved, sourceCommand] = await tx.getAll(pending.ref, approval, prepCommand);
    if (!current.exists || current.get('state') !== 'pending' || digest(current.data()) !== digest(row) || saved.exists)
      return;
    if (
      !sourceCommand.exists || sourceCommand.get('state') !== 'dispatched' || sourceCommand.get('attempt') !== 0 ||
      sourceCommand.get('projectId') !== projectId || sourceCommand.get('jobId') !== ref.jobId ||
      sourceCommand.get('actorUid') !== row.actorUid || sourceCommand.get('workflowId') !== row.workflowId ||
      sourceCommand.get('sandboxListReviewRequestId') !== pending.id ||
      sourceCommand.get('inputHash') !== digest({
        jobId: ref.jobId, expectedRevision: row.expectedRevision, action: 'resolve', requestId: row.requestId,
        resolution: { decision: 'prepare_sandbox_list_commit_review' },
      })
    )
      fail();
    const proof = await readRetainedSandboxListCommit(tx, db, ref, review);
    if (signal.aborted) return;
    tx.create(approval, {
      schemaVersion: 1, ...ref, actorUid: row.actorUid, requestId: row.requestId, review,
      sourceDigest: digest(proof),
      nativeWitnessDigest: digest({
        runId: execution.runId, activityId: execution.activityId, completionEventId: completion.eventId!.toString(),
        currentRunId: before.runId, outcome: blocked[0],
      }),
    });
    tx.update(pending.ref, { state: 'issued' });
  }, { maxAttempts: 1 });
}

async function issueTerminal(db: Firestore, client: NativeClient, pending: DocumentSnapshot, signal: AbortSignal): Promise<void> {
  const row = pending.data();
  if (!row || row.schemaVersion !== 1 || row.projectId !== projectId || !key(row.jobId) ||
      !sha(row.sessionId) || pending.id !== row.sessionId || !sha(row.commandId) || typeof row.workflowId !== 'string')
    fail();
  const stop = db.doc(SANDBOX_LIST_PARTIAL_STOPS + '/' + row.sessionId);
  const job = db.doc('durableJobs/' + row.jobId);
  const cancellation = db.doc('durableJobCancellationIntents/' + row.jobId);
  const holder = db.doc(PROVIDER_MUTATION_SESSIONS + '/' + row.sessionId);
  const command = db.doc('durableJobCommands/' + row.commandId);
  const [saved, stoppedJob, intent, held, dispatched] = await db.getAll(stop, job, cancellation, holder, command);
  if (stoppedJob.get('state') !== 'cancelled') return;
  const certificateId = intent.get('certificateId');
  if (!frozen(saved) || !sha(certificateId) || certificateId !== row.certificateId ||
      intent.get('purpose') !== 'sandbox_list_partial_stop' ||
      intent.get('reviewCommandId') !== row.commandId || intent.get('sessionId') !== row.sessionId ||
      saved.get('commandId') !== row.commandId || saved.get('workflowId') !== row.workflowId ||
      saved.get('generation') !== row.generation || saved.get('projectId') !== projectId ||
      saved.get('jobId') !== row.jobId || saved.get('sessionId') !== row.sessionId ||
      stoppedJob.get('generation') !== row.generation || stoppedJob.get('workflowId') !== row.workflowId ||
      stoppedJob.get('result.mode') !== 'partial_stop' || stoppedJob.get('result.providerEffects') !== 'partial' ||
      stoppedJob.get('result.contentPreserved') !== true || held.get('state') !== SANDBOX_LIST_PARTIAL_STOP_STATE ||
      held.get('sandboxPartialStopDigest') !== digest(saved.data()) ||
      dispatched.get('state') !== 'dispatched' || dispatched.get('action') !== 'resolve' ||
      dispatched.get('projectId') !== projectId || dispatched.get('jobId') !== row.jobId ||
      dispatched.get('workflowId') !== row.workflowId || dispatched.get('sandboxListApprovalId') !== intent.get('approvalId') ||
      dispatched.get('signal.name') !== 'publishingCriticalRepair' ||
      digest(dispatched.get('signal.args')) !== digest([{ certificateId }])) fail();
  const approvalId = intent.get('approvalId');
  if (!sha(approvalId)) fail();
  const approvalRef = db.doc(REVIEWS + '/' + approvalId);
  const approval = await approvalRef.get();
  const review = approval.get('review');
  if (!frozen(approval) || !sha(review?.drainId) || !sha(review?.drainDigest) ||
      review.sessionId !== row.sessionId || review.certificateId !== certificateId ||
      review.workflowId !== row.workflowId || review.generation !== row.generation ||
      approval.get('sourceDigest') !== saved.get('sourceDigest') ||
      saved.get('approvalDigest') !== digest({
        review, sourceDigest: approval.get('sourceDigest'), commandId: row.commandId, actorUid: approval.get('actorUid'),
      })) fail();
  const drainRef = db.doc('durableActivityDrains/' + review.drainId);
  const drain = await drainRef.get();
  const execution = drain.get('execution') as DurableActivityExecution | undefined;
  if (!frozen(drain) || !execution || digest(drain.data()) !== review.drainDigest ||
      execution.workflowId !== row.workflowId || execution.temporalNamespace !== namespace ||
      execution.activityType !== 'applyPublishingLists' ||
      durableActivityDrainKey(projectId, row.jobId, execution) !== drain.id)
    fail();
  const head = await describe(client, row.workflowId);
  if (head.status.name !== 'CANCELLED') return;
  if (head.workflowId !== row.workflowId) fail();
  const lineage = await readLineage(client, head, row.jobId, execution.runId);
  const final = lineage[0];
  const closeEventId = Number(final.close.eventId?.toString());
  if (final.runId !== head.runId || !final.close.workflowExecutionCanceledEventAttributes ||
      !Number.isSafeInteger(closeEventId) || closeEventId < 1) fail();
  const chronology = [...lineage].reverse().flatMap(({ runId, events }) => events.map(event => ({ runId, event })));
  const signalIndex = chronology.findIndex(({ event }) => {
    const signal = event.workflowExecutionSignaledEventAttributes;
    if (signal?.signalName !== 'publishingCriticalRepair') return false;
    const args = payloads(signal.input);
    const signalAt = eventMillis(event);
    return signalAt !== undefined && signalAt >= saved.createTime!.toMillis() &&
      args.length === 1 && digest(args[0]) === digest({ certificateId });
  });
  const approvedRepairs = chronology.flatMap(({ runId, event }, index) => {
    const activity = event.activityTaskScheduledEventAttributes;
    if (signalIndex < 0 || index <= signalIndex || activity?.activityType?.name !== 'repairPublishingCritical')
      return [];
    const args = payloads(activity.input);
    return args.length === 2 && refMatches(args[0], row.jobId) && args[1] === certificateId
      ? [{ runId, eventId: event.eventId?.toString(), index }]
      : [];
  });
  const repairCompletion = chronology.findIndex(({ runId, event }, index) => {
    const done = event.activityTaskCompletedEventAttributes;
    const scheduled = done?.scheduledEventId?.toString();
    if (!done || !scheduled || !approvedRepairs.some(
      (repair) => repair.index < index && repair.runId === runId && repair.eventId === scheduled
    )) return false;
    const reported = payloads(done.result);
    return reported.length === 1 && digest(reported[0]) === digest({
      ...saved.get('result'), nativeCancellationRequired: true,
    });
  });
  if (repairCompletion < 0) fail();
  const cancelIndex = chronology.findIndex(({ runId, event }, index) => {
    if (index <= repairCompletion || runId !== head.runId) return false;
    const activity = event.activityTaskScheduledEventAttributes;
    if (activity?.activityType?.name !== 'requestSandboxListNativeCancellation' ||
      activity.taskQueue?.name !== 'urm-controls') return false;
    const args = payloads(activity.input);
    return args.length === 2 && refMatches(args[0], row.jobId) && args[1] === certificateId;
  });
  if (cancelIndex < 0 || !chronology[cancelIndex].event.eventId) fail();
  const nativeCancelIndex = chronology.findIndex(({ runId, event }, index) =>
    index > cancelIndex && runId === head.runId &&
    event.workflowExecutionCancelRequestedEventAttributes?.identity === 'urm-staging-sandbox-list-settlement'
  );
  if (nativeCancelIndex < 0) fail();
  const finishIndex = chronology.findIndex(({ runId, event }, index) => {
    if (index <= nativeCancelIndex || runId !== head.runId) return false;
    const activity = event.activityTaskScheduledEventAttributes;
    if (activity?.activityType?.name !== 'finishDurableJob') return false;
    const args = payloads(activity.input);
    return args.length === 2 && refMatches(args[0], row.jobId) && args[1] === 'cancelled';
  });
  if (finishIndex < 0 || !chronology[finishIndex].event.eventId || !chronology.some(({ runId, event }, index) =>
    index > finishIndex && runId === head.runId &&
    event.activityTaskCompletedEventAttributes?.scheduledEventId?.toString() ===
      chronology[finishIndex].event.eventId?.toString()
  )) fail();
  requireSameHead(head, await describe(client, row.workflowId), 'CANCELLED');
  const terminal = db.doc(TERMINALS + '/' + row.sessionId);
  if (signal.aborted) return;
  await db.runTransaction(async (tx) => {
    await assertAdmissionReleaseInTransaction(tx, db, 'sermon.publish', { continuation: true });
    const [current, existing, currentStop, currentJob, currentIntent, currentHolder, currentCommand,
      currentApproval, currentDrain] = await tx.getAll(
      pending.ref, terminal, stop, job, cancellation, holder, command, approvalRef, drainRef
    );
    if (!current.exists || current.get('state') !== 'pending' || digest(current.data()) !== digest(row) || existing.exists)
      return;
    for (const [now, previous] of [
      [currentStop, saved], [currentJob, stoppedJob], [currentIntent, intent], [currentHolder, held],
      [currentCommand, dispatched],
      [currentApproval, approval], [currentDrain, drain],
    ] as const)
      if (!now.updateTime?.isEqual(previous.updateTime!)) fail();
    if (signal.aborted) return;
    tx.create(terminal, {
      schemaVersion: 1, source: 'temporal_workflow_history', projectId, jobId: row.jobId,
      sessionId: row.sessionId, generation: row.generation, workflowId: row.workflowId, runId: head.runId,
      closeEventId, closeEventType: 'WorkflowExecutionCanceled', stopDigest: digest(saved.data()), commandId: row.commandId,
    });
    tx.update(pending.ref, { state: 'observed' });
  }, { maxAttempts: 1 });
}

async function observeNext(
  db: Firestore,
  queue: string,
  run: (record: DocumentSnapshot) => Promise<void>,
  signal: AbortSignal
) {
  const cursor = db.doc(CURSORS + '/' + queue);
  const previous = await cursor.get();
  const lastId = previous.get('lastId');
  if (
    previous.exists &&
    (previous.get('projectId') !== projectId || typeof lastId !== 'string' || !lastId ||
      lastId.includes('/') || Buffer.byteLength(lastId, 'utf8') > 1500)
  )
    fail();
  const pending = db.collection(queue).where('state', '==', 'pending').orderBy(FieldPath.documentId()).limit(1);
  let page = await (lastId ? pending.startAfter(lastId) : pending).get();
  if (page.empty && lastId && !signal.aborted) page = await pending.get();
  if (page.empty || signal.aborted) return;
  const [record] = page.docs;
  try {
    await run(record);
  } catch {
    process.stderr.write('Staging sandbox list settlement evidence remains pending.\n');
  }
  if (signal.aborted) return;
  await db.runTransaction(async (tx) => {
    await assertAdmissionReleaseInTransaction(tx, db, 'sermon.publish', { continuation: true });
    const current = await tx.get(cursor);
    if (current.exists !== previous.exists || (current.exists && !current.updateTime?.isEqual(previous.updateTime!)))
      return;
    if (!signal.aborted) tx.set(cursor, { projectId, lastId: record.id });
  }, { maxAttempts: 1 });
}

/** Scheduler wake only. Neither operation sends to a provider or modifies
 * Temporal. A missing or ambiguous native record leaves its Firestore request pending. */
export async function reconcileSandboxListSettlement(
  db: Firestore, client: NativeClient, runtimeNamespace: string, signal: AbortSignal
): Promise<void> {
  if (!isStagingSandboxDatabase(db, projectId) || runtimeNamespace !== namespace || signal.aborted) return;
  await Promise.allSettled([
    observeNext(db, REVIEW_REQUESTS, (row) => issueReview(db, client, row, signal), signal),
    observeNext(db, TERMINAL_PENDING, (row) => issueTerminal(db, client, row, signal), signal),
  ]);
}
