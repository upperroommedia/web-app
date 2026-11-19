import { Worker } from '@temporalio/worker';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';

test('the orchestration candidate supersedes the shared build while independent controls stay current', async () => {
  const namespace = 'urm-app-staging.qwejt';
  const local = await createLocalTestEnvironment({
    server: {
      namespace,
      ip: '127.0.0.1',
      ...(process.env.TEMPORAL_CLI_TEST_PATH
        ? { executable: { type: 'existing-path' as const, path: process.env.TEMPORAL_CLI_TEST_PATH } }
        : {}),
    },
  });
  const service = local.connection.workflowService;
  const queue = 'urm-controls';
  const oldDeployment = { deploymentName: 'urm-worker-staging', buildId: 'a'.repeat(40) };
  const candidate = { deploymentName: 'urm-worker-controls-staging', buildId: 'b'.repeat(40) };
  const orchestration = { deploymentName: oldDeployment.deploymentName, buildId: candidate.buildId };
  const workers: { worker: Worker; done: Promise<void> }[] = [];
  const until = async (callback: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await callback()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Native routing did not settle');
  };
  const launch = async (version: typeof candidate, taskQueue: string) => {
    const worker = await Worker.create({
      connection: local.nativeConnection,
      namespace,
      taskQueue,
      activities: { marker: async () => 'fixture' },
      workerDeploymentOptions: { useWorkerVersioning: true, defaultVersioningBehavior: 'PINNED', version },
      shutdownGraceTime: '2 seconds',
    });
    const done = worker.run();
    void done.catch(() => undefined);
    workers.push({ worker, done });
    await until(async () => {
      try {
        const report = await service.describeWorkerDeploymentVersion({ namespace, deploymentVersion: version });
        return Boolean(
          report.workerDeploymentVersionInfo?.taskQueueInfos?.some((q) => q.name === taskQueue && q.type === 2)
        );
      } catch (error) {
        if ((error as { code?: number }).code !== 5) throw error;
        return false;
      }
    });
  };
  const change = async (deploymentName: string, buildId: string) => {
    const described = await service.describeWorkerDeployment({ namespace, deploymentName });
    await service.setWorkerDeploymentCurrentVersion({
      namespace,
      deploymentName,
      buildId,
      conflictToken: described.conflictToken,
      identity: 'local-traditional-handoff',
      ignoreMissingTaskQueues: false,
    });
  };
  const routing = () =>
    service.describeTaskQueue({
      namespace,
      taskQueue: { name: queue, kind: 1 },
      taskQueueType: 2,
      includeTaskQueueStatus: true,
    });

  try {
    await launch(oldDeployment, 'urm-orchestration');
    await launch(oldDeployment, queue);
    await change(oldDeployment.deploymentName, oldDeployment.buildId);
    await launch(candidate, queue);
    await change(candidate.deploymentName, candidate.buildId);
    await until(async () => (await routing()).versioningInfo?.currentDeploymentVersion?.buildId === candidate.buildId);
    await launch(orchestration, 'urm-orchestration');
    await change(orchestration.deploymentName, orchestration.buildId);
    const shared = await service.describeWorkerDeployment({ namespace, deploymentName: oldDeployment.deploymentName });
    expect(shared.workerDeploymentInfo?.routingConfig?.currentDeploymentVersion).toMatchObject(orchestration);
    const former = await service.describeWorkerDeploymentVersion({ namespace, deploymentVersion: oldDeployment });
    expect(former.workerDeploymentVersionInfo?.currentSinceTime).toBeFalsy();
    await until(async () => (await routing()).versioningInfo?.currentDeploymentVersion?.buildId === candidate.buildId);
    expect((await routing()).versioningInfo?.currentDeploymentVersion).toMatchObject(candidate);
  } finally {
    for (const { worker } of workers) if (worker.getStatus().runState === 'RUNNING') worker.shutdown();
    await Promise.allSettled(workers.map(({ done }) => done));
    await local.teardown();
  }
}, 60000);
