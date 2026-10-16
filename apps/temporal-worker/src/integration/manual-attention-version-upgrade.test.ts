import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@temporalio/activity';
import {
  ApplicationFailure,
  defaultPayloadConverter,
  encodeInitialVersioningBehavior,
  encodeVersioningBehavior,
} from '@temporalio/common';
import { Worker } from '@temporalio/worker';
import type { DurableJobRef } from '../../../../packages/contracts/temporal';
import { SearchBackfill, searchResume } from '../workflows/search';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';

/** Real local server, production workflow and five-minute attention timer. Only
 * provider/outbox state is synthetic; this is NOT a Firestore-generation fence proof.
 * Current promotion changes the target, not the running PINNED execution. The old
 * worker must remain alive until its real timer checks that target and checkpoints.
 * No per-execution version override, synthetic resume, reset or replacement start.
 */
test('a pinned attention wait upgrades on its real timer without resuming completed effects', async () => {
  const id = randomUUID();
  const namespace = `attention-upgrade-${id}`;
  const deploymentName = `attention-upgrade-${id}`;
  const oldBuild = 'synthetic-old-attention';
  const newBuild = 'synthetic-new-attention';
  const evidenceDirectory = await mkdtemp(join(tmpdir(), 'urm-attention-version-upgrade-'));
  console.info(JSON.stringify({ scope: 'attention-native-evidence-directory', evidenceDirectory, namespace }));
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
  const job = { ref: { projectId: 'synthetic-local-attention', jobId: `backfill-${id}` }, generation: 7 };
  const firstDocument: DurableJobRef = { projectId: job.ref.projectId, jobId: `page-one-${id}` };
  const secondDocument: DurableJobRef = { projectId: job.ref.projectId, jobId: `page-two-${id}` };
  const calls: Array<{ worker: string; runId: string; cursor?: string; attempt: number; generation: number }> = [];
  const projections: Array<{ worker: string; state: string; count?: number }> = [];
  const confirmations: Array<{ worker: string; refs: DurableJobRef[] }> = [];
  const routingWitnesses: Array<{
    buildId: string;
    queues: Array<{ name: string; type: 1 | 2; version?: string | null }>;
  }> = [];
  const workers: Array<{ worker: Worker; done: Promise<void>; stopped: boolean }> = [];
  const workerFailures: unknown[] = [];
  let firstPageEffects = 0;
  let secondPageEffects = 0;
  let originalActivitySettled = false;
  let genuineResumeSent = false;
  let workflowId = '';
  let originalRunId = '';
  let continuedRunId = '';
  const provenanceFailures: unknown[] = [];
  async function capture(stage: string, failure?: unknown) {
    const errorRecord = (error: unknown) =>
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { value: String(error) };
    // Public connection deadlines bound failed evidence reads before server teardown.
    const readRun = async (runId: string) => {
      const results = await Promise.allSettled([
        environment.connection.withDeadline(Date.now() + 5_000, () =>
          environment.client.workflow.getHandle(workflowId, runId).fetchHistory()
        ),
        environment.connection.withDeadline(Date.now() + 5_000, () =>
          service.describeWorkflowExecution({ namespace, execution: { workflowId, runId } })
        ),
      ]);
      return {
        runId,
        history: results[0].status === 'fulfilled' ? results[0].value : undefined,
        description: results[1].status === 'fulfilled' ? results[1].value : undefined,
        errors: results.flatMap((result) => (result.status === 'rejected' ? [errorRecord(result.reason)] : [])),
      };
    };
    const original = workflowId && originalRunId ? await readRun(originalRunId) : undefined;
    const oldCan = original?.history?.events?.find(
      (event) => event.workflowExecutionContinuedAsNewEventAttributes
    )?.workflowExecutionContinuedAsNewEventAttributes;
    const nextId = continuedRunId || oldCan?.newExecutionRunId;
    const next = nextId ? await readRun(nextId) : undefined;
    // Retain raw API JSON and explicit numeric defaults; protobuf toJSON can omit zero fields.
    await writeFile(
      join(evidenceDirectory, `${stage}.json`),
      JSON.stringify(
        {
          stage,
          observedAt: new Date().toISOString(),
          namespace,
          deploymentName,
          workflowId,
          originalRunId,
          continuedRunId: nextId,
          original,
          next,
          originalCanInitialVersioningBehavior: oldCan?.initialVersioningBehavior ?? null,
          calls,
          projections,
          confirmations,
          routingWitnesses,
          generation: job.generation,
          firstPageEffects,
          secondPageEffects,
          originalActivitySettled,
          genuineResumeSent,
          failure: failure === undefined ? undefined : errorRecord(failure),
        },
        null,
        2
      ),
      { flag: 'wx', mode: 0o600 }
    );
    const errors = [...(original?.errors ?? []), ...(next?.errors ?? [])];
    if (errors.length) throw new AggregateError(errors, `Native provenance reads failed at ${stage}`);
  }
  const versionOf = (
    info?: {
      deploymentVersion?: { deploymentName?: string | null; buildId?: string | null } | null;
      version?: string | null;
    } | null
  ) =>
    info?.deploymentVersion
      ? `${info.deploymentVersion.deploymentName}.${info.deploymentVersion.buildId}`
      : info?.version;
  async function until(stage: string, check: () => Promise<boolean>, limit = 30_000, pollInterval = 100) {
    const deadline = Date.now() + limit;
    do {
      if (workerFailures.length) throw new AggregateError(workerFailures, `Worker failed during ${stage}`);
      if (await check()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
    } while (Date.now() < deadline);
    throw new Error(`Real attention upgrade did not reach ${stage}`);
  }
  async function launch(buildId: string, role: 'search' | 'controls') {
    const identity = `${buildId}-${role}`;
    const activities =
      role === 'search'
        ? {
            searchBackfillPage: async (ref: DurableJobRef, cursor?: string) => {
              expect(ref).toEqual(job.ref);
              const info = Context.current().info;
              if (!info.workflowExecution)
                throw new Error('Search Activity is missing its Workflow execution identity');
              calls.push({
                worker: identity,
                runId: info.workflowExecution.runId,
                cursor,
                attempt: info.attempt,
                generation: job.generation,
              });
              if (!cursor) {
                expect(buildId).toBe(oldBuild);
                expect(firstPageEffects++).toBe(0);
                return { jobs: [firstDocument], cursor: 'confirmed-page-one', complete: false };
              }
              expect(cursor).toBe('confirmed-page-one');
              if (buildId === oldBuild) {
                try {
                  // A real nonretryable Activity failure enters the production manual-attention branch.
                  throw ApplicationFailure.nonRetryable(
                    'Synthetic page requires operator repair',
                    'SyntheticNeedsAttention'
                  );
                } finally {
                  originalActivitySettled = true;
                }
              }
              expect(genuineResumeSent).toBe(true);
              expect(originalActivitySettled).toBe(true);
              expect(firstPageEffects).toBe(1);
              expect(secondPageEffects++).toBe(0);
              return { jobs: [secondDocument], complete: true };
            },
          }
        : {
            confirmSearchPage: async (refs: DurableJobRef[]) => {
              confirmations.push({ worker: identity, refs });
              expect(refs).toEqual(buildId === oldBuild ? [firstDocument] : [secondDocument]);
              return true;
            },
            finishSearch: async (ref: DurableJobRef, state: string) => {
              expect(ref).toEqual(job.ref);
              expect(buildId).toBe(oldBuild);
              expect(state).toBe('needs_attention');
              projections.push({ worker: identity, state });
            },
            finishSearchBackfill: async (ref: DurableJobRef, count: number) => {
              expect(ref).toEqual(job.ref);
              expect(buildId).toBe(newBuild);
              expect(genuineResumeSent).toBe(true);
              expect(count).toBe(2);
              projections.push({ worker: identity, state: 'succeeded', count });
            },
          };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace,
      identity,
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
  async function current(buildId: string) {
    await until(`all three queue types registered on ${buildId}`, async () => {
      try {
        const response = await service.describeWorkerDeploymentVersion({
          namespace,
          deploymentVersion: { deploymentName, buildId },
        });
        const queues = [
          ...(response.versionTaskQueues ?? []),
          ...(response.workerDeploymentVersionInfo?.taskQueueInfos ?? []),
        ];
        const keys = new Set(queues.map((queue) => `${queue.name}:${queue.type}`));
        return ['urm-search:1', 'urm-search:2', 'urm-controls:2'].every((key) => keys.has(key));
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 5) return false;
        throw error;
      }
    });
    const before = await service.describeWorkerDeployment({ namespace, deploymentName });
    await service.setWorkerDeploymentCurrentVersion({
      namespace,
      deploymentName,
      buildId,
      conflictToken: before.conflictToken,
      identity: 'synthetic-local-attention-operator',
      ignoreMissingTaskQueues: false,
    });
    await until(`deployment and all three queues Current ${buildId}`, async () => {
      const actual = await service.describeWorkerDeployment({ namespace, deploymentName });
      const routing = actual.workerDeploymentInfo?.routingConfig;
      if (
        routing?.currentDeploymentVersion?.buildId !== buildId &&
        routing?.currentVersion !== `${deploymentName}.${buildId}`
      )
        return false;
      const queues = await Promise.all(
        (
          [
            { name: 'urm-search', type: 1 },
            { name: 'urm-search', type: 2 },
            { name: 'urm-controls', type: 2 },
          ] as const
        ).map(async (queue) => {
          const description = await service.describeTaskQueue({
            namespace,
            taskQueue: { name: queue.name },
            taskQueueType: queue.type,
          });
          return {
            ...queue,
            version: versionOf({
              deploymentVersion: description.versioningInfo?.currentDeploymentVersion,
              version: description.versioningInfo?.currentVersion,
            }),
          };
        })
      );
      if (!queues.every((queue) => queue.version === `${deploymentName}.${buildId}`)) return false;
      routingWitnesses.push({ buildId, queues });
      return true;
    });
  }
  let primaryFailure: unknown;
  let failed = false;
  try {
    const oldSearch = await launch(oldBuild, 'search');
    const oldControls = await launch(oldBuild, 'controls');
    await current(oldBuild);
    const handle = await environment.client.workflow.start(SearchBackfill, {
      workflowId: `original-attention-${id}`,
      taskQueue: 'urm-search',
      args: [{ ref: job.ref }],
    });
    workflowId = handle.workflowId;
    originalRunId = handle.firstExecutionRunId;
    expect(originalRunId).toBeTruthy();
    const original = environment.client.workflow.getHandle<typeof SearchBackfill>(handle.workflowId, originalRunId);
    const originalExecution = { namespace, execution: { workflowId: handle.workflowId, runId: originalRunId } };
    await until('real needs_attention with settled Activity and real five-minute wait', async () => {
      const history = await original.fetchHistory();
      const timer = history.events?.find((event) => event.timerStartedEventAttributes)?.timerStartedEventAttributes;
      if (!timer || projections.length !== 1) return false;
      expect(Number(timer.startToFireTimeout?.seconds)).toBe(300);
      expect(originalActivitySettled).toBe(true);
      expect(calls).toHaveLength(2);
      expect(firstPageEffects).toBe(1);
      const description = await service.describeWorkflowExecution(originalExecution);
      expect(description.pendingActivities).toHaveLength(0);
      expect(description.workflowExecutionInfo?.versioningInfo?.behavior).toBe(encodeVersioningBehavior('PINNED'));
      expect(versionOf(description.workflowExecutionInfo?.versioningInfo)).toBe(`${deploymentName}.${oldBuild}`);
      expect(description.workflowExecutionInfo?.versioningInfo?.versioningOverride).toBeFalsy();
      return true;
    });
    await launch(newBuild, 'search');
    await launch(newBuild, 'controls');
    await current(newBuild);
    const promotedAt = Date.now();
    const beforeWake = await service.describeWorkflowExecution(originalExecution);
    expect(versionOf(beforeWake.workflowExecutionInfo?.versioningInfo)).toBe(`${deploymentName}.${oldBuild}`);
    expect(beforeWake.workflowExecutionInfo?.versioningInfo?.behavior).toBe(encodeVersioningBehavior('PINNED'));
    expect(beforeWake.workflowExecutionInfo?.versioningInfo?.versioningOverride).toBeFalsy();
    // Do not signal, sleep-skip, shorten production timers, or override PINNED routing.
    // Only the real attention timer can produce the next activation and safe checkpoint.
    await until(
      'real timer-triggered AUTO_UPGRADE Continue-As-New',
      async () => {
        const history = await original.fetchHistory();
        const continued = history.events?.find(
          (event) => event.workflowExecutionContinuedAsNewEventAttributes
        )?.workflowExecutionContinuedAsNewEventAttributes;
        if (!continued) return false;
        continuedRunId = continued.newExecutionRunId!;
        await capture('continued-before-assertions');
        // Server v1.32 CreateContinuedAsNewEvent omits this command field from the
        // old event. Require the actual next-start inheritance/routing below instead.
        expect([0, encodeInitialVersioningBehavior('AUTO_UPGRADE')]).toContain(continued.initialVersioningBehavior);
        expect(history.events?.some((event) => event.timerFiredEventAttributes)).toBe(true);
        expect(
          history.events?.some(
            (event) => event.workflowTaskStartedEventAttributes?.targetWorkerDeploymentVersionChanged
          )
        ).toBe(true);
        expect(history.events?.some((event) => event.workflowExecutionSignaledEventAttributes)).toBe(false);
        expect(history.events?.some((event) => event.workflowExecutionOptionsUpdatedEventAttributes)).toBe(false);
        expect(continued.input?.payloads).toHaveLength(1);
        expect(defaultPayloadConverter.fromPayload(continued.input!.payloads![0])).toEqual({
          ref: job.ref,
          cursor: 'confirmed-page-one',
          count: 1,
          attention: { schemaVersion: 1, waiting: true, resumeRequested: false },
        });
        continuedRunId = continued.newExecutionRunId!;
        return true;
      },
      360_000,
      1_500
    );
    expect(continuedRunId).toBeTruthy();
    expect(continuedRunId).not.toBe(originalRunId);
    const continued = environment.client.workflow.getHandle<typeof SearchBackfill>(handle.workflowId, continuedRunId);
    const nextExecution = { namespace, execution: { workflowId: handle.workflowId, runId: continuedRunId } };
    await until('new worker restores attention BEFORE any provider or control effects', async () => {
      const history = await continued.fetchHistory();
      if (!history.events?.some((event) => event.timerStartedEventAttributes)) return false;
      await capture('new-wait-before-assertions');
      expect(history.events.some((event) => event.activityTaskScheduledEventAttributes)).toBe(false);
      expect(history.events.some((event) => event.workflowExecutionSignaledEventAttributes)).toBe(false);
      const started = history.events.find(
        (event) => event.workflowExecutionStartedEventAttributes
      )?.workflowExecutionStartedEventAttributes;
      expect(started?.continuedExecutionRunId).toBe(originalRunId);
      expect(started?.firstExecutionRunId).toBe(originalRunId);
      // Official deployment/v1 proto documents legacy enum0 as AutoUpgrade ONLY
      // when this inheritance object is present. Reject missing inheritance,
      // inherited PINNED, unknown behaviors, or an execution-specific override.
      const inheritance = started?.inheritedAutoUpgradeInfo;
      expect(inheritance).toBeTruthy();
      expect(inheritance?.sourceDeploymentVersion).toMatchObject({ deploymentName, buildId: oldBuild });
      expect(Number(inheritance?.sourceDeploymentRevisionNumber)).toBeGreaterThan(0);
      expect([0, encodeInitialVersioningBehavior('AUTO_UPGRADE')]).toContain(
        inheritance?.continueAsNewInitialVersioningBehavior ?? 0
      );
      expect(started?.inheritedPinnedVersion).toBeFalsy();
      expect(started?.versioningOverride).toBeFalsy();
      const description = await service.describeWorkflowExecution(nextExecution);
      expect(versionOf(description.workflowExecutionInfo?.versioningInfo)).toBe(`${deploymentName}.${newBuild}`);
      expect(description.workflowExecutionInfo?.versioningInfo?.behavior).toBe(encodeVersioningBehavior('PINNED'));
      expect(description.workflowExecutionInfo?.versioningInfo?.versioningOverride).toBeFalsy();
      expect(
        history.events.some((event) => event.workflowTaskCompletedEventAttributes?.identity === `${newBuild}-search`)
      ).toBe(true);
      return true;
    });
    expect(calls).toHaveLength(2);
    expect(confirmations).toEqual([{ worker: `${oldBuild}-controls`, refs: [firstDocument] }]);
    expect(projections).toEqual([{ worker: `${oldBuild}-controls`, state: 'needs_attention' }]);
    expect(secondPageEffects).toBe(0);
    await stop(oldSearch);
    await stop(oldControls);
    // A real user resume is sent only AFTER native history proves the migration stayed paused.
    genuineResumeSent = true;
    await continued.signal(searchResume);
    await until('original logical job finishes on new workers after genuine resume', async () => {
      const description = await service.describeWorkflowExecution(nextExecution);
      return description.workflowExecutionInfo?.status === 2;
    });
    await continued.result();
    await handle.result();
    expect(job).toEqual({ ref: { projectId: 'synthetic-local-attention', jobId: `backfill-${id}` }, generation: 7 });
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.cursor)).toEqual([undefined, 'confirmed-page-one', 'confirmed-page-one']);
    expect(calls.map((call) => call.worker)).toEqual([
      `${oldBuild}-search`,
      `${oldBuild}-search`,
      `${newBuild}-search`,
    ]);
    expect(calls.map((call) => call.runId)).toEqual([originalRunId, originalRunId, continuedRunId]);
    expect(calls.every((call) => call.attempt === 1 && call.generation === 7)).toBe(true);
    expect(firstPageEffects).toBe(1);
    expect(secondPageEffects).toBe(1);
    expect(confirmations).toEqual([
      { worker: `${oldBuild}-controls`, refs: [firstDocument] },
      { worker: `${newBuild}-controls`, refs: [secondDocument] },
    ]);
    expect(projections).toEqual([
      { worker: `${oldBuild}-controls`, state: 'needs_attention' },
      { worker: `${newBuild}-controls`, state: 'succeeded', count: 2 },
    ]);
    const oldHistory = await original.fetchHistory();
    const newHistory = await continued.fetchHistory();
    expect(newHistory.events?.filter((event) => event.workflowExecutionSignaledEventAttributes)).toHaveLength(1);
    expect(
      newHistory.events?.find((event) => event.workflowExecutionSignaledEventAttributes)
        ?.workflowExecutionSignaledEventAttributes?.signalName
    ).toBe('search.resume');
    expect(newHistory.events?.some((event) => event.workflowExecutionContinuedAsNewEventAttributes)).toBe(false);
    await capture('completed-before-replay');
    // Actual history replay of both native runs with the current production definition.
    // These histories contain the new patch; they are NOT a prepatch compatibility claim.
    await Worker.runReplayHistory({ workflowsPath: require.resolve('../workflows/search') }, oldHistory);
    await Worker.runReplayHistory({ workflowsPath: require.resolve('../workflows/search') }, newHistory);
    console.info(
      JSON.stringify({
        scope: 'synthetic-local-real-Temporal-attention-upgrade',
        evidenceDirectory,
        namespace,
        deploymentName,
        workflowId: handle.workflowId,
        originalRunId,
        continuedRunId,
        generation: job.generation,
        promotedAt,
        completedAt: Date.now(),
        routingWitnesses,
        calls,
        projections,
        firstPageEffects,
        secondPageEffects,
        originalActivitySettled,
        realProductionTimerSeconds: 300,
        versioningOverrideUsed: false,
        resumeSignals: 1,
        firestoreGenerationFenceVerified: false,
        prepatchHistoryReplayVerified: false,
      })
    );
  } catch (error) {
    failed = true;
    primaryFailure = error;
    try {
      await capture('failure-before-teardown', error);
    } catch (captureError) {
      provenanceFailures.push(captureError);
    }
    throw error;
  } finally {
    const stopped = await Promise.allSettled(workers.filter((worker) => !worker.stopped).map(stop));
    let teardownFailure: unknown;
    try {
      await environment.teardown();
    } catch (error) {
      teardownFailure = error;
    }
    const failures = [
      ...workerFailures,
      ...provenanceFailures,
      ...stopped.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
      ...(teardownFailure ? [teardownFailure] : []),
    ];
    if (failures.length)
      throw new AggregateError(
        [...(failed ? [primaryFailure] : []), ...failures],
        'Attention upgrade worker/cleanup failure',
        { cause: failed ? primaryFailure : failures[0] }
      );
  }
}, 480_000);
