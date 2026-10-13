import { Context } from '@temporalio/activity';
import { Worker } from '@temporalio/worker';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { safeActivities } from './safe-activities';
import { shutdownRetryWorkflow } from './control-capacity.fixture';
test('sanitized graceful worker shutdown retries the drained activity on another worker', async () => {
  const environment = await TestWorkflowEnvironment.createLocal();
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const queue = 'shutdown-retry';
  const first = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: queue,
    workflowsPath: require.resolve('./control-capacity.fixture'),
    shutdownGraceTime: '2 seconds',
    maxHeartbeatThrottleInterval: '1 second',
    activities: safeActivities({
      restartable: async () => {
        started();
        await Context.current().sleep('1 minute');
        return 'unexpected';
      },
    }),
  });
  let firstRun: Promise<void> | undefined;
  try {
    firstRun = first.run();
    const handle = await environment.client.workflow.start(shutdownRetryWorkflow, {
      workflowId: 'shutdown-retry',
      taskQueue: queue,
      args: [queue],
    });
    await firstStarted;
    first.shutdown();
    await firstRun;
    const replacement = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('./control-capacity.fixture'),
      activities: safeActivities({ restartable: async () => 'resumed' }),
    });
    await replacement.runUntil(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(
          await Promise.race([
            handle.result(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Shutdown retry did not complete')), 15000);
            }),
          ])
        ).toBe('resumed');
      } catch (error) {
        await handle.cancel();
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  } finally {
    if (first.getStatus().runState === 'RUNNING') first.shutdown();
    await firstRun;
    await environment.teardown();
  }
}, 120000);
