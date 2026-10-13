import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { WorkerRestartProbe, workerRestartProbeRelease, workerRestartProbeStatus } from './index';
test('a waiting deployment probe survives worker replacement in the same original run without activities', async () => {
  const environment = await TestWorkflowEnvironment.createLocal(),
    queue = 'restart-probe-' + crypto.randomUUID();
  let worker: Worker | undefined, run: Promise<void> | undefined;
  try {
    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('./index'),
      activities: {},
    });
    run = worker.run();
    const handle = await environment.client.workflow.start(WorkerRestartProbe, {
      workflowId: queue,
      taskQueue: queue,
      args: [],
    });
    const first = await handle.query(workerRestartProbeStatus);
    expect(first.state).toBe('waiting');
    expect(first.runId).toBe(handle.firstExecutionRunId);
    worker.shutdown();
    await run;
    worker = undefined;
    run = undefined;
    const replacement = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('./index'),
      activities: {},
    });
    await replacement.runUntil(async () => {
      expect(await handle.query(workerRestartProbeStatus)).toEqual(first);
      await handle.signal(workerRestartProbeRelease);
      expect(await handle.result()).toEqual({ completed: true });
      const history = await handle.fetchHistory();
      expect(history.events?.some((event) => Boolean(event.activityTaskScheduledEventAttributes))).toBe(false);
      expect(history.events?.filter((event) => Boolean(event.workflowExecutionStartedEventAttributes))).toHaveLength(1);
      await Worker.runReplayHistory({ workflowsPath: require.resolve('./index') }, history);
      // Cloud/CLI downloads contain protobuf JSON, unlike fetchHistory's decoded
      // objects. Exercise the SDK converter as well as native history replay.
      const downloadedHistory = JSON.parse(historyToJSON(history));
      await Worker.runReplayHistory({ workflowsPath: require.resolve('./index') }, downloadedHistory);
    });
  } finally {
    if (worker?.getStatus().runState === 'RUNNING') worker.shutdown();
    await run;
    await environment.teardown();
  }
}, 60000);
