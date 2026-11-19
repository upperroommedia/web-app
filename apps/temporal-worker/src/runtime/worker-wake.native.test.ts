import { randomUUID } from 'node:crypto';
import { Worker } from '@temporalio/worker';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';
import { cloudRunPollerIdentity } from './cloud-run-witness';
import { createWorkerWakeActivities } from './worker-wake';
import { startOrObserveWorkerWake, type WorkerWakeAttempt } from './worker-wake-start';
import { inspectWorkerWakeRetryWait, inspectWorkerWakeHistory } from './worker-wake-history';

test('native timer and delayed Activity retry can each wait for a new poller', async () => {
  const projectId = 'urm-app-staging';
  const namespace = `${projectId}.qwejt`;
  const environment = await createLocalTestEnvironment({
    server: {
      namespace,
      ip: '127.0.0.1',
      ...(process.env.TEMPORAL_CLI_TEST_PATH
        ? { executable: { type: 'existing-path' as const, path: process.env.TEMPORAL_CLI_TEST_PATH } }
        : {}),
    },
  });
  const buildId = 'a'.repeat(40);
  const input = {
    projectId,
    buildId,
    nonce: randomUUID().replaceAll('-', ''),
    role: 'controls' as const,
    delayMs: 2500,
  };
  const workflowId = `worker-wake-${input.nonce}`;
  const workers: { worker: Worker; done: Promise<void>; identity: string }[] = [];
  const launch = async (queue: string) => {
    // Provider instance metadata is controlled here. The local server and SDK are real.
    const identity = cloudRunPollerIdentity(`fixture-${queue}-${randomUUID()}`, randomUUID());
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace,
      taskQueue: queue,
      identity,
      workflowsPath:
        queue === 'urm-orchestration' ? require.resolve('../workflows/verification/worker-wake') : undefined,
      activities: createWorkerWakeActivities({ projectId, buildId, queue, identity }),
      shutdownGraceTime: '2 seconds',
    });
    const done = worker.run();
    void done.catch(() => undefined);
    const running = { worker, done, identity };
    workers.push(running);
    return running;
  };
  const stop = async (running: (typeof workers)[number]) => {
    if (running.worker.getStatus().runState === 'RUNNING') running.worker.shutdown();
    await running.done;
    expect(running.worker.getStatus().runState).toBe('STOPPED');
  };
  const waitFor = async (observe: () => Promise<boolean>) => {
    for (let i = 0; i < 180; i++) {
      if (await observe()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Expected native wake history state was not reached');
  };

  try {
    const timerBefore = await launch('urm-orchestration');
    const activityBefore = await launch('urm-controls');
    const client = environment.client;
    const actualStart = client.workflow.start.bind(client.workflow);
    const start = jest.spyOn(client.workflow, 'start');
    let saved: WorkerWakeAttempt | undefined;
    const saveAttempt = jest.fn(async (attempt: WorkerWakeAttempt) => {
      saved = attempt;
    });
    const assertAuthority = jest.fn(async () => undefined);
    start.mockImplementationOnce(async (...args) => {
      if (!saved) throw new Error('Attempt must be saved before start');
      await actualStart(...args);
      throw new Error('Fixture lost start acknowledgement');
    });
    await expect(startOrObserveWorkerWake({ client, input, assertAuthority, saveAttempt })).rejects.toThrow(
      'Fixture lost start acknowledgement'
    );
    expect(saveAttempt).toHaveBeenCalledTimes(1);
    expect(saved?.workflowId).toBe(workflowId);
    const changedAuthority = jest
      .fn(async () => undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Fixture lost paused release authority'));
    const withheld = { ...input, nonce: randomUUID().replaceAll('-', '') };
    const withheldSave = jest.fn(async () => undefined);
    await expect(
      startOrObserveWorkerWake({
        client,
        input: withheld,
        assertAuthority: changedAuthority,
        saveAttempt: withheldSave,
      })
    ).rejects.toThrow('Fixture lost paused release authority');
    expect(withheldSave).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    const run = await startOrObserveWorkerWake({ client, input, assertAuthority, saveAttempt, saved });
    expect(start).toHaveBeenCalledTimes(1);
    expect(saveAttempt).toHaveBeenCalledTimes(1);
    const neverStarted = { ...input, nonce: randomUUID().replaceAll('-', '') };
    await expect(
      startOrObserveWorkerWake({
        client,
        input: neverStarted,
        assertAuthority,
        saveAttempt,
        saved: { workflowId: `worker-wake-${neverStarted.nonce}`, input: neverStarted, attemptedAt: Date.now() },
      })
    ).rejects.toThrow();
    expect(start).toHaveBeenCalledTimes(1);
    expect(saveAttempt).toHaveBeenCalledTimes(1);
    const handle = client.workflow.getHandle(workflowId, run.runId, {
      firstExecutionRunId: run.runId,
      followRuns: false,
    });
    await waitFor(async () =>
      Boolean((await handle.fetchHistory()).events?.some((event) => event.timerStartedEventAttributes))
    );
    await stop(timerBefore);
    await waitFor(async () =>
      Boolean((await handle.fetchHistory()).events?.some((event) => event.timerFiredEventAttributes))
    );
    expect((await handle.fetchHistory()).events?.some((event) => event.activityTaskScheduledEventAttributes)).toBe(
      false
    );
    const timerAfter = await launch('urm-orchestration');
    let retryWindow: ReturnType<typeof inspectWorkerWakeRetryWait> | undefined;
    await waitFor(async () => {
      const observation = await environment.connection.workflowService.describeWorkflowExecution({
        namespace,
        execution: { workflowId, runId: handle.firstExecutionRunId },
      });
      if (
        !observation.pendingActivities?.some(
          (activity) =>
            activity.lastFailure?.applicationFailureInfo?.type === 'WORKER_WAKE_RETRY' && activity.state === 1
        )
      )
        return false;
      const history = await handle.fetchHistory();
      retryWindow = inspectWorkerWakeRetryWait(history, observation, run, Date.now());
      expect(() => inspectWorkerWakeRetryWait(history, observation, run, retryWindow!.eligibleAt)).toThrow(
        'WORKER_WAKE_HISTORY_UNCONFIRMED'
      );
      return true;
    });
    await stop(activityBefore);
    await new Promise((resolve) => setTimeout(resolve, input.delayMs + 250));
    expect((await handle.fetchHistory()).events?.some((event) => event.activityTaskCompletedEventAttributes)).toBe(
      false
    );
    const activityAfter = await launch('urm-controls');
    expect(await handle.result()).toBe(activityAfter.identity);

    const history = await handle.fetchHistory();
    expect(retryWindow?.worker).toBe(activityBefore.identity);
    expect(retryWindow?.eligibleAt).toBeGreaterThan(retryWindow?.observedAt ?? Infinity);
    expect(inspectWorkerWakeHistory(history, run)).toMatchObject({
      timer: { before: timerBefore.identity, after: timerAfter.identity },
      retry: { before: activityBefore.identity, after: activityAfter.identity },
    });
    expect(() => inspectWorkerWakeHistory(history, { ...run, runId: randomUUID() })).toThrow(
      'WORKER_WAKE_HISTORY_UNCONFIRMED'
    );
    const completion = history.events?.find((event) => event.activityTaskCompletedEventAttributes)!
      .activityTaskCompletedEventAttributes!;
    completion.identity = activityBefore.identity;
    expect(() => inspectWorkerWakeHistory(history, run)).toThrow('WORKER_WAKE_HISTORY_UNCONFIRMED');
  } finally {
    for (const running of workers) if (running.worker.getStatus().runState === 'RUNNING') running.worker.shutdown();
    await Promise.allSettled(workers.map(({ done }) => done));
    await environment.teardown();
  }
}, 60000);
