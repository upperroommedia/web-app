import { randomUUID } from 'node:crypto';
import { Connection } from '@temporalio/client';
import { DefaultLogger, Runtime, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';

Runtime.install({ logger: new DefaultLogger('ERROR', () => undefined) });

/** LOCAL server semantics for the guarded handoff design. No application or provider work. */
test('independent Activity queue handoff precedes shared deployment promotion and preserves the original pinned execution', async () => {
  const environment = await createLocalTestEnvironment({
    server: { executable: { type: 'cached-download', version: 'v1.9.1' } },
  });
  const namespace = environment.client.options.namespace;
  const id = randomUUID();
  const workflowQueue = `handoff-workflow-${id}`;
  const activityQueue = `handoff-controls-${id}`;
  const sharedName = `handoff-shared-${id}`;
  const old = { deploymentName: sharedName, buildId: 'old-shared' };
  const orchestration = { deploymentName: sharedName, buildId: 'new-orchestration' };
  const controls = { deploymentName: `handoff-controls-${id}`, buildId: 'new-controls' };
  const workers: Array<{ worker: Worker; done: Promise<void> }> = [];
  const failures: unknown[] = [];
  const calls: string[] = [];
  const handles: Array<ReturnType<typeof environment.client.workflow.getHandle>> = [];
  let mutation: Connection | undefined;
  const bounded = <T>(work: Promise<T>, ms = 10000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned handoff fixture deadline')), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const rpc = <T>(work: () => Promise<T>) =>
    bounded(environment.connection.withDeadline(Date.now() + 5000, work), 6000);
  const until = async (read: () => Promise<boolean>) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (await rpc(read)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Native handoff observation did not settle');
  };
  const service = environment.connection.workflowService;
  const queue = () => rpc(() => service.describeTaskQueue({
    namespace, taskQueue: { name: activityQueue }, taskQueueType: 2, reportStats: true,
  }));
  const launch = async (taskQueue: string, version: typeof old, workflow: boolean, identity: string) => {
    const worker = await Worker.create({
      connection: environment.nativeConnection, namespace, taskQueue, identity,
      ...(workflow ? { workflowsPath: require.resolve('../test-support/independent-activity-workflow') } : {}),
      activities: { independentActivityMarker: async () => { calls.push(identity); return identity; } },
      workerDeploymentOptions: { version, useWorkerVersioning: true, defaultVersioningBehavior: 'PINNED' },
      shutdownGraceTime: '2 seconds', shutdownForceTime: '5 seconds',
    });
    const done = worker.run();
    void done.catch((error) => failures.push(error));
    workers.push({ worker, done });
    await until(async () => {
      try {
        const info = (await service.describeWorkerDeploymentVersion({ namespace, deploymentVersion: version }))
          .workerDeploymentVersionInfo;
        return Boolean(info?.taskQueueInfos?.some((q) => q.name === taskQueue && q.type === (workflow ? 1 : 2)));
      } catch (error) {
        if ((error as { code?: number }).code === 5) return false;
        throw error;
      }
    });
  };
  const describe = (deploymentName: string) => rpc(() => service.describeWorkerDeployment({ namespace, deploymentName }));
  const setCurrent = async (version: typeof old) => {
    const before = await describe(version.deploymentName);
    expect(before.conflictToken?.byteLength).toBeGreaterThan(0);
    if (!mutation) throw new Error('Owned nonretrying connection absent');
    // Exact native conflict token. Server missing-queue/no-poller guards stay enabled.
    const response = await bounded(mutation.withDeadline(Date.now() + 5000, () =>
      mutation!.workflowService.setWorkerDeploymentCurrentVersion({
        namespace, deploymentName: version.deploymentName, buildId: version.buildId,
        conflictToken: before.conflictToken, identity: `owned-handoff-${id}`,
      })), 6000);
    expect(response.conflictToken?.byteLength).toBeGreaterThan(0);
    expect((await describe(version.deploymentName)).workerDeploymentInfo?.routingConfig?.currentDeploymentVersion)
      .toMatchObject(version);
    return { before, response };
  };
  try {
    // SDK client defaults include retry interceptors. Explicitly suppress both layers
    // on the connection used for every fixture CAS; reads use their normal client.
    mutation = await bounded(Connection.connect({
      address: environment.connection.options.address, interceptors: [],
      channelArgs: { 'grpc.enable_retries': 0 }, connectTimeout: '5 seconds',
    }));
    expect(mutation.options.interceptors).toEqual([]);
    expect(mutation.options.channelArgs['grpc.enable_retries']).toBe(0);
    await launch(workflowQueue, old, true, 'old-shared-workflow');
    await launch(activityQueue, old, false, 'old-shared-controls');
    await setCurrent(old);
    await until(async () => (await queue()).versioningInfo?.currentDeploymentVersion?.buildId === old.buildId);
    const original = await rpc(() => environment.client.workflow.start('independentActivityProbe', {
      workflowId: `protected-${id}`, taskQueue: workflowQueue, args: [activityQueue, true],
      versioningOverride: { pinnedTo: old }, workflowExecutionTimeout: '2 minutes',
    }));
    handles.push(original);
    expect(await rpc(() => original.query('independentProbeReady'))).toBe(true);
    const originalRunId = original.firstExecutionRunId;
    const before = await rpc(() => original.fetchHistory());
    expect(before.events?.some((e) => e.activityTaskScheduledEventAttributes)).toBe(false);
    const bundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('../test-support/independent-activity-workflow'),
      logger: new DefaultLogger('ERROR', () => undefined),
    });
    await bounded(Worker.runReplayHistory({ workflowBundle: { code: bundle.code } }, before), 15000);

    await launch(activityQueue, controls, false, 'new-independent-controls');
    await launch(workflowQueue, orchestration, true, 'new-orchestration');
    // Candidate registration does not move either the queue or shared deployment.
    expect((await queue()).versioningInfo?.currentDeploymentVersion).toMatchObject(old);
    const controlChange = await setCurrent(controls);
    await until(async () => (await queue()).versioningInfo?.currentDeploymentVersion?.buildId === controls.buildId);
    expect((await describe(sharedName)).workerDeploymentInfo?.routingConfig?.currentDeploymentVersion).toMatchObject(old);
    const nativeQueue = await queue();
    expect(nativeQueue.versioningInfo?.currentDeploymentVersion).toMatchObject(controls);
    expect(nativeQueue.versioningInfo?.rampingVersionPercentage ?? 0).toBe(0);
    // DEFAULT DescribeTaskQueue pollers carry native deployment options; do not
    // interpret the target deployment's conflict token as the queue's CAS token.
    expect(nativeQueue.pollers?.some((p) => p.identity === 'new-independent-controls' &&
      p.deploymentOptions?.deploymentName === controls.deploymentName &&
      p.deploymentOptions.buildId === controls.buildId)).toBe(true);

    // Reusing the original token is rejected rather than silently overwriting.
    await expect(bounded(mutation.withDeadline(Date.now() + 5000, () => mutation!.workflowService
      .setWorkerDeploymentCurrentVersion({ namespace, deploymentName: controls.deploymentName,
        buildId: controls.buildId, conflictToken: controlChange.before.conflictToken, identity: `owned-stale-${id}` })), 6000))
      .rejects.toMatchObject({ code: 9 }); // FAILED_PRECONDITION: native conflict token mismatch.
    await setCurrent(orchestration);
    await until(async () => (await service.describeTaskQueue({ namespace, taskQueue: { name: workflowQueue }, taskQueueType: 1 }))
      .versioningInfo?.currentDeploymentVersion?.buildId === orchestration.buildId);
    expect((await queue()).versioningInfo?.currentDeploymentVersion).toMatchObject(controls);

    // Exact old RunId still waits on old workers after both routing mutations.
    expect(original.firstExecutionRunId).toBe(originalRunId);
    expect(await rpc(() => original.query('independentProbeReady'))).toBe(true);
    await rpc(() => original.signal('releaseIndependentProbe'));
    expect(await rpc(() => original.result())).toBe('old-shared-controls');
    const history = await rpc(() => environment.client.workflow.getHandle(original.workflowId, originalRunId).fetchHistory());
    expect(history.events?.filter((e) => e.workflowExecutionStartedEventAttributes)).toHaveLength(1);
    expect(history.events?.filter((e) => e.activityTaskScheduledEventAttributes)).toHaveLength(1);
    expect(history.events?.filter((e) => e.activityTaskStartedEventAttributes)).toHaveLength(1);
    expect(history.events?.filter((e) => e.activityTaskCompletedEventAttributes)).toHaveLength(1);
    expect(history.events?.some((e) => e.workflowExecutionContinuedAsNewEventAttributes)).toBe(false);
    const completedTasks = history.events?.flatMap((e) => e.workflowTaskCompletedEventAttributes ? [e] : []) ?? [];
    expect(completedTasks.length).toBeGreaterThan(1);
    expect(completedTasks.every((e) => e.workflowTaskCompletedEventAttributes?.identity === 'old-shared-workflow')).toBe(true);
    const oldHead = BigInt(before.events!.at(-1)!.eventId!.toString());
    expect(completedTasks.some((e) => BigInt(e.eventId!.toString()) > oldHead)).toBe(true);
    const finalOriginal = await rpc(() => service.describeWorkflowExecution({
      namespace, execution: { workflowId: original.workflowId, runId: originalRunId },
    }));
    expect(finalOriginal.workflowExecutionInfo?.versioningInfo?.deploymentVersion).toMatchObject(old);
    expect(finalOriginal.workflowExecutionInfo?.execution?.runId).toBe(originalRunId);
    await bounded(Worker.runReplayHistory({ workflowBundle: { code: bundle.code } }, history), 15000);
    expect(calls).toEqual(['old-shared-controls']);
    // A new execution uses current orchestration and crosses to the independent
    // controls deployment. It must not inherit the old run's pin or worker.
    const fresh = await rpc(() => environment.client.workflow.start('independentActivityProbe', {
      workflowId: `fresh-${id}`, taskQueue: workflowQueue, args: [activityQueue, false],
      workflowExecutionTimeout: '1 minute',
    }));
    handles.push(fresh);
    expect(await rpc(() => fresh.result())).toBe('new-independent-controls');
    expect(fresh.firstExecutionRunId).not.toBe(originalRunId);
    const freshHistory = await rpc(() => fresh.fetchHistory());
    expect(freshHistory.events?.filter((e) => e.workflowExecutionStartedEventAttributes)).toHaveLength(1);
    expect(freshHistory.events?.filter((e) => e.activityTaskStartedEventAttributes)).toHaveLength(1);
    expect(freshHistory.events?.filter((e) => e.workflowTaskCompletedEventAttributes).every((e) =>
      e.workflowTaskCompletedEventAttributes?.identity === 'new-orchestration')).toBe(true);
    const freshDescription = await rpc(() => service.describeWorkflowExecution({
      namespace, execution: { workflowId: fresh.workflowId, runId: fresh.firstExecutionRunId },
    }));
    expect(freshDescription.workflowExecutionInfo?.versioningInfo?.deploymentVersion).toMatchObject(orchestration);
    await bounded(Worker.runReplayHistory({ workflowBundle: { code: bundle.code } }, freshHistory), 15000);
    expect(calls).toEqual(['old-shared-controls', 'new-independent-controls']);
    expect(failures).toEqual([]);
  } catch (error) {
    failures.unshift(error);
  } finally {
    // Cleanup is independent and bounded; it never mutates a real deployment.
    for (const handle of handles) {
      try { await rpc(() => handle.signal('releaseIndependentProbe')); } catch (error) {
        if ((error as { name?: string }).name !== 'WorkflowNotFoundError') failures.push(error);
      }
    }
    for (const { worker } of workers) {
      try { if (worker.getStatus().runState === 'RUNNING') worker.shutdown(); } catch (error) { failures.push(error); }
    }
    try {
      const settled = await bounded(Promise.allSettled(workers.map(({ done }) => done)), 15000);
      failures.push(...settled.flatMap((r) => r.status === 'rejected' ? [r.reason] : []));
    } catch (error) { failures.push(error); }
    try { await bounded(mutation?.close() ?? Promise.resolve()); } catch (error) { failures.push(error); }
    try { await environment.teardown(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Native shared deployment handoff fixture failed');
  }
});
