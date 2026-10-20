import { randomUUID } from 'node:crypto';
import { Worker, Runtime, DefaultLogger } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';

/** Native LOCAL-only application-style continue-as-new handoff. No Firebase, provider or cloud calls.
 * This must pass before proposing an equivalent guarded original-run migration.
 */
test('a timer-waiting pinned workflow naturally continues onto the current orchestration version without an override', async () => {
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
      ...(workflow ? { workflowsPath: require.resolve('../test-support/natural-continuation-handoff-workflow') } : {}),
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
    const original = await environment.client.workflow.start('naturalContinuationHandoffProbe', {
      workflowId: `original-${id}`,
      taskQueue: workflowQueue,
      args: [activityQueue],
      workflowExecutionTimeout: '80 seconds',
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
    });
    await until(async () => {
      const history = await original.fetchHistory();
      return Boolean(history.events?.some((event) => event.timerStartedEventAttributes));
    });
    const pinned = await service.describeWorkflowExecution({
      namespace,
      execution: { workflowId: original.workflowId, runId: original.firstExecutionRunId },
    });
    expect(pinned.workflowExecutionInfo?.versioningInfo?.behavior).toBe(1);
    expect(pinned.workflowExecutionInfo?.versioningInfo?.deploymentVersion).toMatchObject({
      deploymentName: workflowDeployment,
      buildId: oldBuild,
    });
    expect(pinned.workflowExecutionInfo?.versioningInfo?.versioningOverride).toBeFalsy();
    expect(activityCalls).toHaveLength(0);
    await launch(activityDeployment, activityBuild, activityQueue, false);
    await launch(workflowDeployment, workflowBuild, workflowQueue, true);
    const target = await service.describeWorkerDeploymentVersion({
      namespace,
      deploymentVersion: { deploymentName: workflowDeployment, buildId: workflowBuild },
    });
    expect(target.workerDeploymentVersionInfo?.taskQueueInfos?.some((queue) => queue.name === activityQueue)).toBe(
      false
    );
    // The old pinned workflow's existing timer supplies the next Workflow Task.
    // Its existing application pattern observes target change and rotates itself.
    expect(await original.result()).toBe(activityBuild);
    const originalHistory = await environment.client.workflow
      .getHandle(original.workflowId, original.firstExecutionRunId)
      .fetchHistory();
    const continued = originalHistory.events?.find((event) => event.workflowExecutionContinuedAsNewEventAttributes);
    const nextRunId = continued?.workflowExecutionContinuedAsNewEventAttributes?.newExecutionRunId;
    expect(nextRunId).toBeTruthy();
    expect(
      originalHistory.events?.filter((event) => event.workflowExecutionContinuedAsNewEventAttributes)
    ).toHaveLength(1);
    const latest = await service.describeWorkflowExecution({
      namespace,
      execution: { workflowId: original.workflowId },
    });
    expect(latest.workflowExecutionInfo?.execution?.runId).toBe(nextRunId);
    expect(latest.workflowExecutionInfo?.versioningInfo?.deploymentVersion).toMatchObject({
      deploymentName: workflowDeployment,
      buildId: workflowBuild,
    });
    expect(latest.workflowExecutionInfo?.versioningInfo?.versioningOverride).toBeFalsy();
    const nextHistory = await environment.client.workflow
      .getHandle(original.workflowId, nextRunId ?? undefined)
      .fetchHistory();
    expect(nextHistory.events?.[0]?.workflowExecutionStartedEventAttributes?.continuedExecutionRunId).toBe(
      original.firstExecutionRunId
    );
    expect(nextHistory.events?.some((event) => event.workflowExecutionContinuedAsNewEventAttributes)).toBe(false);
    expect(originalHistory.events?.some((event) => event.activityTaskScheduledEventAttributes)).toBe(false);
    expect(nextHistory.events?.filter((event) => event.activityTaskScheduledEventAttributes)).toHaveLength(1);
    for (const history of [originalHistory, nextHistory]) {
      expect(history.events?.filter((event) => event.workflowExecutionStartedEventAttributes)).toHaveLength(1);
      expect(history.events?.some((event) => event.workflowExecutionSignaledEventAttributes)).toBe(false);
      expect(history.events?.some((event) => event.workflowExecutionOptionsUpdatedEventAttributes)).toBe(false);
      await Worker.runReplayHistory(
        { workflowsPath: require.resolve('../test-support/natural-continuation-handoff-workflow') },
        history
      );
    }
    expect(activityCalls).toEqual([
      { deploymentName: activityDeployment, buildId: activityBuild, attempt: 1, runId: nextRunId },
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
