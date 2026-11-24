import { randomUUID } from 'node:crypto';
import { encodeVersioningBehavior } from '@temporalio/common';
import { Worker } from '@temporalio/worker';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';

test('a bounded legacy queue worker starts only the original run explicitly pinned to it', async () => {
  const operationId = randomUUID();
  const namespace = 'legacy-start-' + operationId;
  const environment = await createLocalTestEnvironment({
    server: {
      namespace,
      ip: '127.0.0.1',
      ...(process.env.TEMPORAL_CLI_TEST_PATH
        ? { executable: { type: 'existing-path', path: process.env.TEMPORAL_CLI_TEST_PATH } }
        : {}),
    },
  });
  const service = environment.connection.workflowService;
  const queue = 'urm-search';
  const activityDeployment = 'search-activity';
  const activityBuild = 'activity-incumbent';
  const recoveryDeployment = 'legacy-workflow';
  const recoveryBuild = 'first-task-compatibility';
  const workers: Array<{ worker: Worker; done: Promise<void> }> = [];
  const activityCalls: string[] = [];
  const awaitRegistration = async (deploymentName: string, buildId: string, type: number) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const { workerDeploymentVersionInfo } = await service.describeWorkerDeploymentVersion({
          namespace,
          deploymentVersion: { deploymentName, buildId },
        });
        if (workerDeploymentVersionInfo?.taskQueueInfos?.some((info) => info.name === queue && info.type === type)) {
          return;
        }
      } catch (error) {
        if ((error as { code?: number }).code !== 5) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The exact queue and task type did not register');
  };
  const launch = async (deploymentName: string, buildId: string, workflow: boolean) => {
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace,
      taskQueue: queue,
      identity: deploymentName,
      ...(workflow
        ? { workflowsPath: require.resolve('../test-support/independent-activity-workflow') }
        : {
            activities: {
              independentActivityMarker: async () => {
                activityCalls.push(activityBuild);
                return activityBuild;
              },
            },
          }),
      workerDeploymentOptions: {
        version: { deploymentName, buildId },
        useWorkerVersioning: true,
        defaultVersioningBehavior: 'PINNED',
      },
      shutdownGraceTime: '2 seconds',
      shutdownForceTime: '10 seconds',
    });
    const done = worker.run();
    void done.catch(() => undefined);
    workers.push({ worker, done });
    await awaitRegistration(deploymentName, buildId, workflow ? 1 : 2);
  };
  try {
    await launch(activityDeployment, activityBuild, false);
    const incumbent = await service.describeWorkerDeployment({ namespace, deploymentName: activityDeployment });
    await service.setWorkerDeploymentCurrentVersion({
      namespace,
      deploymentName: activityDeployment,
      buildId: activityBuild,
      conflictToken: incumbent.conflictToken,
      identity: 'local-first-task-test',
      ignoreMissingTaskQueues: false,
    });
    const accepted = await environment.client.workflow.start('independentActivityProbe', {
      workflowId: 'admitted-workflow',
      taskQueue: queue,
      args: [queue],
      workflowExecutionTimeout: '25 seconds',
    });
    const sentinel = await environment.client.workflow.start('independentActivityProbe', {
      workflowId: 'unlisted-workflow',
      taskQueue: queue,
      args: [queue],
      workflowExecutionTimeout: '25 seconds',
    });
    const eventTypes = async (handle: typeof accepted) =>
      (await handle.fetchHistory()).events?.map((event) => event.eventType);
    expect(await eventTypes(accepted)).toEqual([1, 5]);
    expect(await eventTypes(sentinel)).toEqual([1, 5]);

    await launch(recoveryDeployment, recoveryBuild, true);
    const recovery = await service.describeWorkerDeployment({ namespace, deploymentName: recoveryDeployment });
    expect(recovery.workerDeploymentInfo?.routingConfig?.currentDeploymentVersion).toBeFalsy();

    await service.updateWorkflowExecutionOptions({
      namespace,
      workflowExecution: { workflowId: accepted.workflowId, runId: accepted.firstExecutionRunId },
      identity: 'local-first-task-test',
      workflowExecutionOptions: {
        versioningOverride: {
          behavior: encodeVersioningBehavior('PINNED'),
          pinnedVersion: `${recoveryDeployment}.${recoveryBuild}`,
        },
      },
      updateMask: { paths: ['versioning_override'] },
    });
    expect(await accepted.result()).toBe(activityBuild);
    const execution = await service.describeWorkflowExecution({
      namespace,
      execution: { workflowId: accepted.workflowId, runId: accepted.firstExecutionRunId },
    });
    expect(execution.workflowExecutionInfo?.execution?.runId).toBe(accepted.firstExecutionRunId);
    expect(await eventTypes(sentinel)).toEqual([1, 5]);
    expect(activityCalls).toEqual([activityBuild]);
  } finally {
    for (const { worker } of workers) worker.shutdown();
    try {
      const results = await Promise.allSettled(workers.map(({ done }) => done));
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    } finally {
      await environment.teardown();
    }
  }
}, 90_000);
