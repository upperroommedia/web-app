import type { Client } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import { isDeepStrictEqual } from 'node:util';
import { validWorkerWakeProbe, type WorkerWakeProbeInput } from '../workflows/verification/worker-wake-input';

export interface WorkerWakeRun {
  workflowId: string;
  runId: string;
  input: WorkerWakeProbeInput;
}
type History = Awaited<ReturnType<ReturnType<Client['workflow']['getHandle']>['fetchHistory']>>;
type Describe = Awaited<ReturnType<Client['workflowService']['describeWorkflowExecution']>>;
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const regularIdentity = new RegExp(`^cloud-run-[a-f0-9]{64}-${uuid}$`);
const restoredIdentity = new RegExp(`^media-restored-${uuid}$`);
const fail = (): never => {
  throw new Error('WORKER_WAKE_HISTORY_UNCONFIRMED');
};
const milliseconds = (duration: { seconds?: unknown; nanos?: number | null } | null | undefined) =>
  duration == null ? NaN : Number(duration.seconds ?? 0) * 1000 + (duration.nanos ?? 0) / 1e6;

const decode = (payloads: Parameters<typeof defaultPayloadConverter.fromPayload>[0][] | null | undefined) => {
  if (payloads?.length !== 1) return fail();
  return defaultPayloadConverter.fromPayload(payloads[0]);
};
const validRoleWorker = (identity: unknown, role: WorkerWakeProbeInput['role']): identity is string =>
  typeof identity === 'string' &&
  (regularIdentity.test(identity) || (role === 'media' && restoredIdentity.test(identity)));

export function inspectWorkerWakeStart(history: History, { workflowId, runId, input }: WorkerWakeRun) {
  const events = history.events ?? [];
  const first = events[0]?.workflowExecutionStartedEventAttributes;
  const startedAt = milliseconds(events[0]?.eventTime);
  if (
    !validWorkerWakeProbe(input, workflowId) ||
    first?.originalExecutionRunId !== runId ||
    first.firstExecutionRunId !== runId ||
    first.continuedExecutionRunId ||
    first.workflowType?.name !== 'WorkerWakeProbe' ||
    first.taskQueue?.name !== 'urm-orchestration' ||
    !isDeepStrictEqual(decode(first.input?.payloads), input) ||
    !Number.isFinite(startedAt) ||
    startedAt <= 0 ||
    events.some((e) => e.workflowExecutionSignaledEventAttributes || e.workflowExecutionUpdateAcceptedEventAttributes)
  )
    return fail();
  return startedAt;
}

/** Read eligibility from the native pending Activity, while the same retry is
 * still scheduled. The timestamp is not derived from the later pickup time. */
export function inspectWorkerWakeRetryWait(
  history: History,
  described: Describe,
  run: WorkerWakeRun,
  observedAt: number
) {
  inspectWorkerWakeStart(history, run);
  const { workflowId, runId, input } = run;
  const events = history.events ?? [];
  const scheduled = events.filter((e) => e.activityTaskScheduledEventAttributes);
  const [activity] = described.pendingActivities ?? [];
  const schedule = scheduled[0]?.activityTaskScheduledEventAttributes;
  const failure = activity?.lastFailure?.applicationFailureInfo;
  const eligibleAt = milliseconds(activity?.nextAttemptScheduleTime);
  const failedAt = milliseconds(activity?.lastAttemptCompleteTime);
  if (
    described.workflowExecutionInfo?.execution?.workflowId !== workflowId ||
    described.workflowExecutionInfo.execution.runId !== runId ||
    described.workflowExecutionInfo.status !== 1 ||
    described.pendingActivities?.length !== 1 ||
    scheduled.length !== 1 ||
    !activity ||
    !schedule ||
    !failure ||
    activity.activityId !== schedule.activityId ||
    activity.activityType?.name !== 'probeWorkerWake' ||
    schedule.activityType?.name !== 'probeWorkerWake' ||
    schedule.taskQueue?.name !== `urm-${input.role}` ||
    !isDeepStrictEqual(decode(schedule.input?.payloads), input) ||
    schedule.retryPolicy?.maximumAttempts !== 2 ||
    milliseconds(schedule.retryPolicy.initialInterval) !== input.delayMs ||
    Math.round(milliseconds(activity.currentRetryInterval)) !== input.delayMs ||
    activity.state !== 1 ||
    activity.attempt !== 2 ||
    activity.maximumAttempts !== 2 ||
    !Number.isFinite(failedAt) ||
    failedAt < milliseconds(scheduled[0].eventTime) ||
    failedAt > observedAt ||
    failure.type !== 'WORKER_WAKE_RETRY' ||
    failure.nonRetryable ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(eligibleAt) ||
    eligibleAt <= observedAt ||
    events.some((e) => e.activityTaskStartedEventAttributes || e.activityTaskCompletedEventAttributes)
  )
    return fail();
  const worker = decode(failure.details?.payloads);
  if (!validRoleWorker(worker, input.role) || activity.lastWorkerIdentity !== worker) return fail();
  return {
    workflowId,
    runId,
    role: input.role,
    scheduledEventId: String(scheduled[0].eventId),
    worker,
    eligibleAt,
    failedAt,
    observedAt,
  };
}

/** Native Temporal evidence only. Cloud Run pool and instance observations are separate. */
export function inspectWorkerWakeHistory(history: History, run: WorkerWakeRun) {
  inspectWorkerWakeStart(history, run);
  const { workflowId, runId, input } = run;
  const events = history.events ?? [];
  const last = events.at(-1)?.workflowExecutionCompletedEventAttributes;
  if (!last) return fail();

  const timerStarts = events.filter((e) => e.timerStartedEventAttributes);
  const timerFinishes = events.filter((e) => e.timerFiredEventAttributes);
  const schedules = events.filter((e) => e.activityTaskScheduledEventAttributes);
  const starts = events.filter((e) => e.activityTaskStartedEventAttributes);
  const completions = events.filter((e) => e.activityTaskCompletedEventAttributes);
  if ([timerStarts, timerFinishes, schedules, starts, completions].some((items) => items.length !== 1)) return fail();

  const [timer] = timerStarts;
  const [fired] = timerFinishes;
  const [scheduled] = schedules;
  const [started] = starts;
  const [completed] = completions;
  const timerCommand = timer.timerStartedEventAttributes!;
  const schedule = scheduled.activityTaskScheduledEventAttributes!;
  const retry = started.activityTaskStartedEventAttributes!;
  const complete = completed.activityTaskCompletedEventAttributes!;
  const timerStartedAt = milliseconds(timer.eventTime);
  const timerFiredAt = milliseconds(fired.eventTime);
  const activityScheduledAt = milliseconds(scheduled.eventTime);
  const retryStartedAt = milliseconds(started.eventTime);
  const retryCompletedAt = milliseconds(completed.eventTime);
  const historyEvent = (id: unknown) => events.find((event) => String(event.eventId) === String(id));
  const timerWorkerBefore = historyEvent(timerCommand.workflowTaskCompletedEventId)
    ?.workflowTaskCompletedEventAttributes?.identity;
  const timerTask = historyEvent(schedule.workflowTaskCompletedEventId);
  const timerTaskDone = timerTask?.workflowTaskCompletedEventAttributes;
  const timerTaskStart = historyEvent(timerTaskDone?.startedEventId);
  const timerWorkerAfter = timerTaskDone?.identity;
  const timerEligibleAt = timerStartedAt + input.delayMs;
  const timerTaskStartedAt = milliseconds(timerTaskStart?.eventTime);
  if (
    milliseconds(timerCommand.startToFireTimeout) !== input.delayMs ||
    String(fired.timerFiredEventAttributes?.startedEventId) !== String(timer.eventId) ||
    Number(fired.eventId) >= Number(schedule.workflowTaskCompletedEventId) ||
    ![timerStartedAt, timerFiredAt, timerTaskStartedAt, activityScheduledAt, retryStartedAt, retryCompletedAt].every(
      Number.isFinite
    ) ||
    !timerTaskStart?.workflowTaskStartedEventAttributes ||
    timerTaskStart.workflowTaskStartedEventAttributes.identity !== timerWorkerAfter ||
    timerTaskStartedAt < timerFiredAt ||
    timerTaskStartedAt > activityScheduledAt ||
    retryCompletedAt < retryStartedAt ||
    timerStartedAt <= 0 ||
    timerFiredAt <= timerStartedAt ||
    activityScheduledAt < timerFiredAt ||
    retryStartedAt <= activityScheduledAt ||
    !timerWorkerBefore ||
    !regularIdentity.test(timerWorkerBefore) ||
    !timerWorkerAfter ||
    !regularIdentity.test(timerWorkerAfter) ||
    schedule.taskQueue?.name !== `urm-${input.role}` ||
    schedule.activityType?.name !== 'probeWorkerWake' ||
    !isDeepStrictEqual(decode(schedule.input?.payloads), input) ||
    schedule.retryPolicy?.maximumAttempts !== 2 ||
    milliseconds(schedule.retryPolicy.initialInterval) !== input.delayMs ||
    retry.attempt !== 2 ||
    retry.lastFailure?.applicationFailureInfo?.type !== 'WORKER_WAKE_RETRY' ||
    retry.lastFailure.applicationFailureInfo.nonRetryable ||
    String(retry.scheduledEventId) !== String(scheduled.eventId) ||
    String(complete.scheduledEventId) !== String(scheduled.eventId) ||
    String(complete.startedEventId) !== String(started.eventId) ||
    retry.identity !== complete.identity ||
    !validRoleWorker(complete.identity, input.role) ||
    decode(complete.result?.payloads) !== complete.identity ||
    decode(last.result?.payloads) !== complete.identity
  )
    return fail();
  const activityWorkerBefore = decode(retry.lastFailure.applicationFailureInfo.details?.payloads);
  if (!validRoleWorker(activityWorkerBefore, input.role)) return fail();

  return {
    workflowId,
    runId,
    role: input.role,
    timer: {
      startedEventId: String(timer.eventId),
      firedEventId: String(fired.eventId),
      startedAt: timerStartedAt,
      firedAt: timerFiredAt,
      eligibleAt: timerEligibleAt,
      taskStartedAt: timerTaskStartedAt,
      taskCompletedAt: activityScheduledAt,
      before: timerWorkerBefore,
      after: timerWorkerAfter,
    },
    retry: {
      scheduledEventId: String(scheduled.eventId),
      startedEventId: String(started.eventId),
      scheduledAt: activityScheduledAt,
      startedAt: retryStartedAt,
      completedAt: retryCompletedAt,
      before: activityWorkerBefore,
      after: complete.identity,
    },
  };
}
