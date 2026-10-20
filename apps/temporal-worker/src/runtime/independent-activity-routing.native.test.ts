import { randomUUID } from 'node:crypto';
import { Worker } from '@temporalio/worker';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';

/** Actual local Temporal routing; no Firebase, provider calls or Cloud Run proof.
 * Separating deployments must preserve the independent-Activity behavior without
 * deprecated versioningIntent or arbitrary per-execution overrides.
 */
test('a pinned workflow calls an independent activity on a separately versioned deployment', async () => {
  const id = randomUUID();
  const namespace = `independent-${id}`;
  const environment = await createLocalTestEnvironment({
    server: {
      namespace,
      ip: '127.0.0.1',
      ...(process.env.TEMPORAL_CLI_TEST_PATH
        ? { executable: { type: 'existing-path' as const, path: process.env.TEMPORAL_CLI_TEST_PATH } }
        : {}),
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
  const activityCalls: Array<{ deploymentName: string; buildId: string }> = [];
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
      ...(workflow ? { workflowsPath: require.resolve('../test-support/independent-activity-workflow') } : {}),
      activities: workflow
        ? {}
        : {
            independentActivityMarker: async () => {
              activityCalls.push({ deploymentName, buildId });
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
  try {
    await launch(workflowDeployment, oldBuild, activityQueue, false);
    await launch(workflowDeployment, oldBuild, workflowQueue, true);
    const original = await environment.client.workflow.start('independentActivityProbe', {
      workflowId: `original-${id}`,
      taskQueue: workflowQueue,
      args: [activityQueue, true],
      workflowExecutionTimeout: '60 seconds',
    });
    await until(async () => {
      try {
        return await original.query<boolean>('independentProbeReady');
      } catch {
        return false;
      }
    });
    await launch(activityDeployment, activityBuild, activityQueue, false);
    await launch(workflowDeployment, workflowBuild, workflowQueue, true);
    const handle = await environment.client.workflow.start('independentActivityProbe', {
      workflowId: `probe-${id}`,
      taskQueue: workflowQueue,
      args: [activityQueue],
      workflowExecutionTimeout: '45 seconds',
    });
    expect(await handle.result()).toBe(activityBuild);
    await original.signal('releaseIndependentProbe');
    expect(await original.result()).toBe(oldBuild);
    expect(activityCalls).toEqual(
      expect.arrayContaining([
        { deploymentName: activityDeployment, buildId: activityBuild },
        { deploymentName: workflowDeployment, buildId: oldBuild },
      ])
    );
    expect(activityCalls).toHaveLength(2);
    const history = await handle.fetchHistory();
    expect(history.events?.some((e) => e.activityTaskScheduledEventAttributes?.taskQueue?.name === activityQueue)).toBe(
      true
    );
    const workflowVersion = await service.describeWorkerDeploymentVersion({
      namespace,
      deploymentVersion: { deploymentName: workflowDeployment, buildId: workflowBuild },
    });
    expect(workflowVersion.workerDeploymentVersionInfo?.taskQueueInfos?.some((q) => q.name === activityQueue)).toBe(
      false
    );
    expect(failures).toEqual([]);
  } finally {
    for (const running of workers) running.worker.shutdown();
    const results = await Promise.allSettled(workers.map((running) => running.done));
    try {
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    } finally {
      await environment.teardown();
    }
  }
}, 90000);
