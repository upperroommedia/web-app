import { randomUUID } from 'node:crypto';
import { Context } from '@temporalio/activity';
import { ApplicationFailure, encodeVersioningBehavior } from '@temporalio/common';
import { Worker } from '@temporalio/worker';
import type { DurableJobRef } from '../../../../../packages/contracts/temporal';
import { SearchBackfill, SearchDocument } from '../workflows/search';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';

/** Actual local Temporal routing/history; only provider effects and the outbox are synthetic.
 * No Firebase credentials, workflow reset, replacement run, or private SDK patch is used.
 */
test('migrates a pending pinned search Activity in the original run; independent outbox starts use Current', async () => {
  const id = randomUUID();
  const namespace = `search-version-recovery-${id}`;
  const deploymentName = `search-recovery-${id}`;
  const oldBuild = 'synthetic-old-search';
  const newBuild = 'synthetic-new-search';
  const identity = 'local-search-version-recovery-operator';
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
  const backfillRef: DurableJobRef = { projectId: 'synthetic-local-search', jobId: `backfill-${id}` };
  const documentRef: DurableJobRef = { projectId: backfillRef.projectId, jobId: `document-${id}` };
  const job = { ref: backfillRef, generation: 1 };
  const attempts: Array<{ worker: string; runId: string; activityId: string; attempt: number; generation: number }> =
    [];
  const controls: string[] = [];
  const events: string[] = [];
  const routingWitnesses: Array<{
    buildId: string;
    queues: Array<{ name: string; type: 1 | 2; version: string | null | undefined }>;
  }> = [];
  let providerReceipt: string | undefined;
  let providerAcceptances = 0;
  let oldPromiseSettled = false;
  let documentEffect = false;
  let backfillFinished = false;
  let outboxHandle: Awaited<ReturnType<typeof environment.client.workflow.start<typeof SearchDocument>>> | undefined;
  const workers: Array<{ worker: Worker; done: Promise<void>; stopped: boolean }> = [];
  const workerFailures: unknown[] = [];
  async function until(stage: string, check: () => Promise<boolean>, limit = 30_000) {
    const deadline = Date.now() + limit;
    do {
      if (workerFailures.length) throw new AggregateError(workerFailures, `Worker failed during ${stage}`);
      if (await check()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(`Local version migration did not reach ${stage}`);
  }
  async function launch(buildId: string, role: 'search' | 'controls') {
    const workerIdentity = `${buildId}-${role}`;
    const activities =
      role === 'search'
        ? {
            searchBackfillPage: async (ref: DurableJobRef) => {
              const info = Context.current().info;
              expect(ref).toEqual(job.ref);
              expect(job.generation).toBe(1);
              attempts.push({
                worker: workerIdentity,
                runId: info.workflowExecution.runId,
                activityId: info.activityId,
                attempt: info.attempt,
                generation: job.generation,
              });
              if (buildId === oldBuild) {
                try {
                  // Simulated provider accepted once; its promise settles before a retryable acknowledgement loss.
                  expect(providerReceipt).toBeUndefined();
                  await Promise.resolve();
                  providerReceipt = `synthetic-accepted-${id}`;
                  providerAcceptances++;
                  events.push('old-provider-accepted');
                  throw ApplicationFailure.retryable(
                    'Synthetic acknowledgement loss after acceptance',
                    'SyntheticSearchAckLost'
                  );
                } finally {
                  oldPromiseSettled = true;
                  events.push('old-activity-settled');
                }
              }
              expect(oldPromiseSettled).toBe(true);
              expect(providerReceipt).toBe(`synthetic-accepted-${id}`);
              expect(providerAcceptances).toBe(1);
              events.push('new-activity-reused-accepted-receipt');
              return { jobs: [documentRef], complete: true };
            },
            syncSearchDocument: async (ref: DurableJobRef) => {
              expect(buildId).toBe(newBuild);
              expect(ref).toEqual(documentRef);
              expect(oldPromiseSettled).toBe(true);
              events.push('independent-document-new-activity');
              documentEffect = true;
            },
          }
        : {
            confirmSearchPage: async (refs: DurableJobRef[]) => {
              expect(buildId).toBe(newBuild);
              expect(refs).toEqual([documentRef]);
              controls.push(workerIdentity);
              if (!outboxHandle) {
                // Independent client start models the outbox dispatcher. It is deliberately NOT a Child Workflow
                // and has no versioning override; it must get the newly Current deployment on its own.
                outboxHandle = await environment.client.workflow.start(SearchDocument, {
                  taskQueue: 'urm-search',
                  workflowId: `independent-document-${id}`,
                  args: [documentRef],
                });
              }
              return documentEffect;
            },
            finishSearchBackfill: async (ref: DurableJobRef, count: number) => {
              expect(buildId).toBe(newBuild);
              expect(ref).toEqual(job.ref);
              expect(count).toBe(1);
              controls.push(workerIdentity);
              backfillFinished = true;
            },
            finishSearch: async () => {
              throw new Error('Migration must not cancel, supersede, or exhaust the original job');
            },
          };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace,
      identity: workerIdentity,
      taskQueue: role === 'search' ? 'urm-search' : 'urm-controls',
      ...(role === 'search' ? { workflowsPath: require.resolve('../workflows/search') } : {}),
      activities,
      workerDeploymentOptions: {
        version: { deploymentName, buildId },
        useWorkerVersioning: true,
        defaultVersioningBehavior: 'PINNED',
      },
      shutdownGraceTime: '2 seconds',
      shutdownForceTime: '10 seconds',
    });
    const done = worker.run();
    // Attach immediately, but preserve and rethrow the actual failure in the main path/cleanup.
    void done.catch((error: unknown) => {
      workerFailures.push(error);
    });
    const running = { worker, done, stopped: false };
    workers.push(running);
    return running;
  }
  async function stop(running: (typeof workers)[number]) {
    if (running.stopped) return;
    running.worker.shutdown();
    await running.done;
    running.stopped = true;
  }
  async function registered(buildId: string) {
    await until(`all search/control queue pollers registered on ${buildId}`, async () => {
      try {
        const response = await service.describeWorkerDeploymentVersion({
          namespace,
          deploymentVersion: { deploymentName, buildId },
        });
        const queues = [
          ...(response.versionTaskQueues ?? []),
          ...(response.workerDeploymentVersionInfo?.taskQueueInfos ?? []),
        ];
        const observed = new Set(queues.map((q) => `${q.name}:${q.type}`));
        return ['urm-search:1', 'urm-search:2', 'urm-controls:2'].every((q) => observed.has(q));
      } catch (error) {
        // A newly starting version can be absent until its first poller arrives. Unsupported APIs fail.
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 5) return false;
        throw error;
      }
    });
  }
  async function current(buildId: string) {
    const before = await service.describeWorkerDeployment({ namespace, deploymentName });
    await service.setWorkerDeploymentCurrentVersion({
      namespace,
      deploymentName,
      buildId,
      identity,
      conflictToken: before.conflictToken,
      ignoreMissingTaskQueues: false,
    });
    await until(`Current ${buildId}`, async () => {
      const actual = await service.describeWorkerDeployment({ namespace, deploymentName });
      const routing = actual.workerDeploymentInfo?.routingConfig;
      return (
        routing?.currentDeploymentVersion?.buildId === buildId ||
        routing?.currentVersion === `${deploymentName}.${buildId}`
      );
    });
    await until(`all three task queue types route Current ${buildId}`, async () => {
      const queues = await Promise.all(
        (
          [
            { name: 'urm-search', type: 1 },
            { name: 'urm-search', type: 2 },
            { name: 'urm-controls', type: 2 },
          ] as const
        ).map(async (queue) => {
          const actual = await service.describeTaskQueue({
            namespace,
            taskQueue: { name: queue.name },
            taskQueueType: queue.type,
          });
          return {
            ...queue,
            version: versionOf({
              deploymentVersion: actual.versioningInfo?.currentDeploymentVersion,
              version: actual.versioningInfo?.currentVersion,
            }),
          };
        })
      );
      if (!queues.every((q) => q.version === `${deploymentName}.${buildId}`)) return false;
      routingWitnesses.push({ buildId, queues });
      return true;
    });
  }
  const execution = (workflowId: string, runId: string) => ({ namespace, execution: { workflowId, runId } });
  const versionOf = (
    info:
      | {
          deploymentVersion?: { deploymentName?: string | null; buildId?: string | null } | null;
          version?: string | null;
        }
      | null
      | undefined
  ) =>
    info?.deploymentVersion
      ? `${info.deploymentVersion.deploymentName}.${info.deploymentVersion.buildId}`
      : info?.version;
  async function completed<T>(promise: Promise<T>, stage: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Original-run migration did not complete ${stage}`)), 60_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  try {
    const oldSearch = await launch(oldBuild, 'search');
    const oldControls = await launch(oldBuild, 'controls');
    await registered(oldBuild);
    await current(oldBuild);
    const handle = await environment.client.workflow.start(SearchBackfill, {
      taskQueue: 'urm-search',
      workflowId: `original-backfill-${id}`,
      args: [{ ref: backfillRef }],
    });
    const runId = handle.firstExecutionRunId;
    expect(runId).toBeTruthy();
    let pendingActivityId = '';
    await until('server-acknowledged retryable failure after the old Activity settled', async () => {
      const actual = await service.describeWorkflowExecution(execution(handle.workflowId, runId));
      const activity = actual.pendingActivities.find(
        (a) => a.lastFailure?.applicationFailureInfo?.type === 'SyntheticSearchAckLost'
      );
      if (!activity) return false;
      expect(oldPromiseSettled).toBe(true);
      pendingActivityId = activity.activityId!;
      expect(actual.workflowExecutionInfo?.versioningInfo?.behavior).toBe(encodeVersioningBehavior('PINNED'));
      return true;
    });
    // This is real graceful shutdown after the promise AND server failure have settled, not termination.
    await stop(oldSearch);
    await stop(oldControls);
    events.push('old-workers-naturally-stopped');
    expect(attempts).toHaveLength(1);
    await launch(newBuild, 'search');
    await launch(newBuild, 'controls');
    await registered(newBuild);
    await current(newBuild);
    const beforeOverride = await service.describeWorkflowExecution(execution(handle.workflowId, runId));
    expect(beforeOverride.workflowExecutionInfo?.execution?.runId).toBe(runId);
    expect(beforeOverride.pendingActivities.some((a) => a.activityId === pendingActivityId)).toBe(true);
    expect(versionOf(beforeOverride.workflowExecutionInfo?.versioningInfo)).toBe(`${deploymentName}.${oldBuild}`);
    // This installed proto's deprecated scalar representation is still the supported server-compatible
    // PINNED override. The exact original Run Id and FieldMask prevent a latest-run/replacement edit.
    await service.updateWorkflowExecutionOptions({
      namespace,
      workflowExecution: { workflowId: handle.workflowId, runId },
      identity,
      workflowExecutionOptions: {
        versioningOverride: {
          behavior: encodeVersioningBehavior('PINNED'),
          pinnedVersion: `${deploymentName}.${newBuild}`,
        },
      },
      updateMask: { paths: ['versioning_override'] },
    });
    await completed(handle.result(), 'same backfill run');
    expect(backfillFinished).toBe(true);
    expect(outboxHandle).toBeDefined();
    await completed(outboxHandle!.result(), 'independent outbox document');
    expect(providerAcceptances).toBe(1);
    expect(job).toEqual({ ref: backfillRef, generation: 1 });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      worker: `${oldBuild}-search`,
      runId,
      activityId: pendingActivityId,
      attempt: 1,
      generation: 1,
    });
    expect(attempts[1]).toMatchObject({
      worker: `${newBuild}-search`,
      runId,
      activityId: pendingActivityId,
      generation: 1,
    });
    expect(attempts[1].attempt).toBeGreaterThan(1);
    expect(events.indexOf('old-activity-settled')).toBeLessThan(events.indexOf('old-workers-naturally-stopped'));
    expect(events.indexOf('old-workers-naturally-stopped')).toBeLessThan(
      events.indexOf('new-activity-reused-accepted-receipt')
    );
    expect(controls.length).toBeGreaterThanOrEqual(2);
    expect(controls.every((worker) => worker === `${newBuild}-controls`)).toBe(true);
    const completedDescription = await service.describeWorkflowExecution(execution(handle.workflowId, runId));
    expect(completedDescription.workflowExecutionInfo?.execution?.runId).toBe(runId);
    const independent = await service.describeWorkflowExecution(
      execution(outboxHandle!.workflowId, outboxHandle!.firstExecutionRunId)
    );
    expect(versionOf(independent.workflowExecutionInfo?.versioningInfo)).toBe(`${deploymentName}.${newBuild}`);
    expect(independent.workflowExecutionInfo?.versioningInfo?.versioningOverride).toBeFalsy();
    const history = await handle.fetchHistory();
    const documentHistory = await outboxHandle!.fetchHistory();
    const workflowWorkers =
      history.events?.flatMap((event) => event.workflowTaskCompletedEventAttributes?.identity ?? []) ?? [];
    expect(workflowWorkers).toContain(`${oldBuild}-search`);
    expect(workflowWorkers).toContain(`${newBuild}-search`);
    const completedTasks = history.events?.flatMap((event) => event.workflowTaskCompletedEventAttributes ?? []) ?? [];
    const historyVersions = completedTasks.map((task) =>
      versionOf({
        deploymentVersion: task.deploymentVersion,
        version: task.workerDeploymentVersion,
      })
    );
    expect(historyVersions).toContain(`${deploymentName}.${oldBuild}`);
    expect(historyVersions).toContain(`${deploymentName}.${newBuild}`);
    expect(completedTasks.every((task) => task.versioningBehavior === encodeVersioningBehavior('PINNED'))).toBe(true);
    const activityWorkers =
      history.events?.flatMap((event) => event.activityTaskStartedEventAttributes?.identity ?? []) ?? [];
    expect(activityWorkers).toContain(`${newBuild}-search`);
    expect(activityWorkers).toContain(`${newBuild}-controls`);
    expect(
      documentHistory.events?.some(
        (event) => event.workflowTaskCompletedEventAttributes?.identity === `${newBuild}-search`
      )
    ).toBe(true);
    expect(history.events?.filter((event) => event.workflowExecutionStartedEventAttributes)).toHaveLength(1);
    expect(history.events?.some((event) => event.workflowExecutionOptionsUpdatedEventAttributes)).toBe(true);
    console.info(
      JSON.stringify({
        scope: 'synthetic-local-real-Temporal-version-migration',
        namespace,
        deploymentName,
        originalWorkflowId: handle.workflowId,
        originalRunId: runId,
        pendingActivityId,
        attempts,
        controls,
        newIndependentWorkflowId: outboxHandle!.workflowId,
        newIndependentRunId: outboxHandle!.firstExecutionRunId,
        historyEventCount: history.events?.length,
        documentHistoryEventCount: documentHistory.events?.length,
        historyVersions,
        providerAcceptances,
        routingWitnesses,
        sameOriginalRun: true,
        firestoreGenerationFenceVerified: false,
      })
    );
  } finally {
    const stopped = await Promise.allSettled(workers.filter((w) => !w.stopped).map(stop));
    let teardownFailure: unknown;
    try {
      await environment.teardown();
    } catch (error) {
      teardownFailure = error;
    }
    const failures = [
      ...workerFailures,
      ...stopped.flatMap((r) => (r.status === 'rejected' ? [r.reason] : [])),
      ...(teardownFailure ? [teardownFailure] : []),
    ];
    if (failures.length) throw new AggregateError(failures, 'Local search migration cleanup/worker failure');
  }
}, 180_000);
