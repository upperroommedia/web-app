import { randomUUID } from 'node:crypto';
import { Worker, Runtime, DefaultLogger } from '@temporalio/worker';
import { Context, ApplicationFailure } from '@temporalio/activity';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';

/** Native LOCAL-only existing retry handoff. No Firebase, provider or cloud calls.
 * This must pass before proposing an equivalent guarded original-run migration.
 */
test('an existing backoff Activity naturally retries at the fixed independent version after an exact-run override', async () => {
  // Native failed-Activity logs include task tokens. Keep fixture diagnostics fixed.
  Runtime.install({ logger: new DefaultLogger('WARN', () => undefined) });
  const id = randomUUID();
  const namespace = `independent-${id}`;
  const environment = await createLocalTestEnvironment({
    server: {
      namespace,
      ip: '127.0.0.1',
      ...(process.env.TEMPORAL_CLI_TEST_PATH
        ? { executable: { type: 'existing-path' as const, path: process.env.TEMPORAL_CLI_TEST_PATH } }
        : { executable: { type: 'cached-download' as const, version: 'v1.9.1' } }),
    },
  });
  const service = environment.connection.workflowService;
  const workers: Array<{ worker: Worker; done: Promise<void> }> = [];
  const failures: unknown[] = [];
  const workflowQueue = `independent-workflow-${id}`;
  const activityQueue = `independent-activity-${id}`;
  const workflowDeployment = `workflow-${id}`;
  const activityDeployment = `activity-${id}`;
  const workflowBuild = 'workflow-release-one';
  const activityBuild = 'activity-release-two';
  const oldBuild = 'original-shared-release';
  const activityCalls: Array<{ deploymentName: string; buildId: string; attempt: number; runId: string }> = [];
  const until = async (read: () => Promise<boolean>) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await read()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Native independent deployment routing did not settle');
  };
  const launch = async (deploymentName: string, buildId: string, taskQueue: string, workflow: boolean) => {
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace,
      taskQueue,
      identity: `local-${deploymentName}`,
      ...(workflow ? { workflowsPath: require.resolve('../test-support/pending-activity-handoff-workflow') } : {}),
      activities: workflow
        ? {}
        : {
            retryHandoffMarker: async () => {
              const info = Context.current().info;
              if (!info.workflowExecution) throw new Error('Native fixture requires workflow execution identity');
              activityCalls.push({
                deploymentName,
                buildId,
                attempt: info.attempt,
                runId: info.workflowExecution.runId,
              });
              if (Context.current().info.attempt === 1)
                throw ApplicationFailure.retryable('Safe synthetic first attempt');
              return buildId;
            },
          },
      workerDeploymentOptions: {
        version: { deploymentName, buildId },
        useWorkerVersioning: true,
        defaultVersioningBehavior: 'PINNED',
      },
      shutdownGraceTime: '2 seconds',
      shutdownForceTime: '10 seconds',
    });
    const done = worker.run();
    void done.catch((error) => failures.push(error));
    workers.push({ worker, done });
    await until(async () => {
      try {
        const found = await service.describeWorkerDeploymentVersion({
          namespace,
          deploymentVersion: { deploymentName, buildId },
        });
        return Boolean(
          found.workerDeploymentVersionInfo?.taskQueueInfos?.some(
            (q) => q.name === taskQueue && q.type === (workflow ? 1 : 2)
          )
        );
      } catch (error) {
        if ((error as { code?: number }).code === 5) return false;
        throw error;
      }
    });
    const before = await service.describeWorkerDeployment({ namespace, deploymentName });
    await service.setWorkerDeploymentCurrentVersion({
      namespace,
      deploymentName,
      buildId,
      conflictToken: before.conflictToken,
      identity: 'local-independent-probe',
      ignoreMissingTaskQueues: false,
    });
  };
  let primaryFailure: unknown;
  try {
    await launch(workflowDeployment, oldBuild, activityQueue, false);
    await launch(workflowDeployment, oldBuild, workflowQueue, true);
    const original = await environment.client.workflow.start('pendingActivityHandoffProbe', {
      workflowId: `original-${id}`,
      taskQueue: workflowQueue,
      args: [activityQueue],
      workflowExecutionTimeout: '80 seconds',
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
    });
    await until(async () => {
      const described = await original.describe();
      return activityCalls.length === 1 && described.runId === original.firstExecutionRunId;
    });
    // The full native Describe response, not a query or signal, confirms backoff.
    await until(async () => {
      const described = await service.describeWorkflowExecution({
        namespace,
        execution: { workflowId: original.workflowId, runId: original.firstExecutionRunId },
      });
      return Boolean(described.pendingActivities?.some((activity) => activity.lastFailure && activity.state === 1));
    });
    await launch(activityDeployment, activityBuild, activityQueue, false);
    await launch(workflowDeployment, workflowBuild, workflowQueue, true);
    const before = await service.describeWorkflowExecution({
      namespace,
      execution: { workflowId: original.workflowId, runId: original.firstExecutionRunId },
    });
    const pending = before.pendingActivities?.[0];
    expect(pending?.state).toBe(1); // SCHEDULED, not an already-started attempt.
    expect(pending?.lastDeploymentVersion).toMatchObject({ deploymentName: workflowDeployment, buildId: oldBuild });
    expect(Number(pending?.currentRetryInterval?.seconds)).toBe(25);
    const retryAt =
      Number(pending?.nextAttemptScheduleTime?.seconds) * 1000 +
      Number(pending?.nextAttemptScheduleTime?.nanos ?? 0) / 1000000;
    expect(retryAt).toBeGreaterThan(Date.now());
    expect(activityCalls).toHaveLength(1);
    const target = await service.describeWorkerDeploymentVersion({
      namespace,
      deploymentVersion: { deploymentName: workflowDeployment, buildId: workflowBuild },
    });
    expect(target.workerDeploymentVersionInfo?.taskQueueInfos?.some((queue) => queue.name === activityQueue)).toBe(
      false
    );
    await Worker.runReplayHistory(
      { workflowsPath: require.resolve('../test-support/pending-activity-handoff-workflow') },
      await original.fetchHistory()
    );
    await environment.connection.withDeadline(Date.now() + 10000, () =>
      service.updateWorkflowExecutionOptions({
        namespace,
        workflowExecution: { workflowId: original.workflowId, runId: original.firstExecutionRunId },
        workflowExecutionOptions: {
          versioningOverride: {
            pinned: { behavior: 1, version: { deploymentName: workflowDeployment, buildId: workflowBuild } },
          },
        },
        updateMask: { paths: ['versioning_override'] },
        identity: 'local-only-pending-handoff-probe',
      })
    );
    // No signal or manual Activity retry is sent after this native options update.
    expect(await original.result()).toBe(activityBuild);
    const history = await original.fetchHistory();
    expect(history.events?.filter((event) => event.activityTaskScheduledEventAttributes)).toHaveLength(1);
    expect(history.events?.filter((event) => event.workflowExecutionStartedEventAttributes)).toHaveLength(1);
    expect(history.events?.some((event) => event.workflowExecutionContinuedAsNewEventAttributes)).toBe(false);
    expect((await original.describe()).runId).toBe(original.firstExecutionRunId);
    const after = await service.describeWorkflowExecution({
      namespace,
      execution: { workflowId: original.workflowId, runId: original.firstExecutionRunId },
    });
    expect(after.workflowExecutionInfo?.versioningInfo?.deploymentVersion).toMatchObject({
      deploymentName: workflowDeployment,
      buildId: workflowBuild,
    });
    await Worker.runReplayHistory(
      { workflowsPath: require.resolve('../test-support/pending-activity-handoff-workflow') },
      history
    );
    expect(activityCalls).toEqual([
      { deploymentName: workflowDeployment, buildId: oldBuild, attempt: 1, runId: original.firstExecutionRunId },
      { deploymentName: activityDeployment, buildId: activityBuild, attempt: 2, runId: original.firstExecutionRunId },
    ]);
    expect(failures).toEqual([]);
  } catch (error) {
    primaryFailure = error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try {
      for (const running of workers) {
        try {
          if (running.worker.getStatus().runState === 'RUNNING') running.worker.shutdown();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      const results = await Promise.allSettled(workers.map((running) => running.done));
      for (const result of results) if (result.status === 'rejected') cleanupFailures.push(result.reason);
    } catch (error) {
      cleanupFailures.push(error);
    } finally {
      try {
        await environment.teardown();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (primaryFailure) cleanupFailures.unshift(primaryFailure);
    if (cleanupFailures.length)
      throw new AggregateError(cleanupFailures, 'Native handoff fixture or owned cleanup failed');
  }
}, 90000);
