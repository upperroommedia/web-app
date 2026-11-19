import type { Client } from '@temporalio/client';
import { isDeepStrictEqual } from 'node:util';
import { validWorkerWakeProbe, type WorkerWakeProbeInput } from '../workflows/verification/worker-wake-input';
import { inspectWorkerWakeStart, type WorkerWakeRun } from './worker-wake-history';

const namespace = 'urm-app-staging.qwejt';
export interface WorkerWakeAttempt {
  workflowId: string;
  input: WorkerWakeProbeInput;
  attemptedAt: number;
}

const fail = (): never => {
  throw new Error('WORKER_WAKE_START_UNCONFIRMED');
};

/** One persisted attempt. Reconciliation never sends START again, including when
 * no original is visible. Caller owns persistence and paused-release authority. */
export async function startOrObserveWorkerWake(o: {
  client: Client;
  input: WorkerWakeProbeInput;
  saved?: WorkerWakeAttempt;
  assertAuthority: () => Promise<void>;
  saveAttempt: (attempt: WorkerWakeAttempt) => Promise<void>;
}): Promise<WorkerWakeRun> {
  const { client } = o;
  const input = { ...o.input };
  const workflowId = `worker-wake-${input.nonce}`;
  const reconciling = Object.hasOwn(o, 'saved');
  const attemptedAt = reconciling ? o.saved?.attemptedAt : Date.now();
  if (
    client.options.namespace !== namespace ||
    !validWorkerWakeProbe(input, workflowId) ||
    typeof attemptedAt !== 'number' ||
    !Number.isSafeInteger(attemptedAt) ||
    attemptedAt <= 0 ||
    attemptedAt > Date.now() ||
    (reconciling && (o.saved?.workflowId !== workflowId || !isDeepStrictEqual(o.saved.input, input)))
  )
    return fail();

  await o.assertAuthority();
  let runId: string;
  if (reconciling) {
    const original = await client.connection.withDeadline(Date.now() + 10000, () =>
      client.workflow.getHandle(workflowId).describe()
    );
    if (
      original.workflowId !== workflowId ||
      original.type !== 'WorkerWakeProbe' ||
      original.taskQueue !== 'urm-orchestration' ||
      !original.runId
    )
      return fail();
    runId = original.runId;
  } else {
    await o.saveAttempt({ workflowId, input, attemptedAt });
    await o.assertAuthority();
    if (Date.now() - attemptedAt > 15000) return fail();
    const original = await client.connection.withDeadline(attemptedAt + 15000, () =>
      client.workflow.start('WorkerWakeProbe', {
        workflowId,
        taskQueue: 'urm-orchestration',
        args: [input],
        workflowExecutionTimeout: input.delayMs * 2 + 10 * 60 * 1000,
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        workflowIdConflictPolicy: 'FAIL',
      })
    );
    runId = original.firstExecutionRunId;
  }
  if (!runId) return fail();
  const run = { workflowId, runId, input };
  const history = await client.connection.withDeadline(Date.now() + 10000, () =>
    client.workflow.getHandle(workflowId, runId, { firstExecutionRunId: runId, followRuns: false }).fetchHistory()
  );
  const nativeStartedAt = inspectWorkerWakeStart(history, run);
  await o.assertAuthority();
  if (nativeStartedAt < attemptedAt - 5000 || nativeStartedAt > attemptedAt + 20000) return fail();
  return run;
}
