import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, type WorkerOptions } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import type { WorkflowHandle } from '@temporalio/client';
import { AwaitSermonAudio, MediaArtifactCleanup, SermonAudioCoordinator } from './index';
import type { MediaActivities, MediaJobRef } from '../../../../process-audio/src/temporal/types';

const ref = (revision: number): MediaJobRef => ({
  jobId: `job-${revision}`,
  projectId: 'test-project',
  sermonId: 'sermon',
  revision,
  requestVersion: '0123456789abcdef',
});
const workflowPath = require.resolve('./index');
let queue = 'media-workflow-test';
let sequence = 0;
const workers = new Set<Worker>();
const runningWorkers = new Map<Worker, Promise<void>>();
async function createWorker(options: WorkerOptions) {
  const worker = await Worker.create({ ...options, shutdownGraceTime: '1 second', shutdownForceTime: '10 seconds' });
  workers.add(worker);
  return worker;
}
async function runWorker(worker: Worker, operation: () => Promise<void>) {
  const running = worker.run();
  runningWorkers.set(worker, running);
  try {
    await operation();
  } finally {
    if (worker.getState() === 'RUNNING') worker.shutdown();
    await running;
    runningWorkers.delete(worker);
  }
}
const waitFor = async (handle: WorkflowHandle, predicate: (state: any) => boolean) => {
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = await handle.query('media.state');
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Workflow did not reach expected state');
};
const activities = (overrides: Partial<MediaActivities> = {}): MediaActivities => ({
  prepareMedia: async () => ({ kind: 'ready' }),
  acquireMedia: async () => ({ kind: 'ready' }),
  mergeMedia: async () => ({ kind: 'ready' }),
  publishMedia: async () => ({ kind: 'ready' }),
  recoverMediaAuthentication: async () => ({ ready: true, generation: 'recovery-1' }),
  projectMediaWaiting: async () => {},
  projectMediaFailure: async () => {},
  cleanupMedia: async () => {},
  registerMediaObserver: async () => {},
  readMediaObservers: async () => [],
  readMediaCompletion: async () => ({ kind: 'pending' }),
  requestMediaCancellation: async () => {},
  ...overrides,
});

describe('durable media coordinator', () => {
  let environment: TestWorkflowEnvironment;
  beforeEach(async () => {
    queue = `media-workflow-test-${++sequence}`;
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);
  afterEach(async () => {
    try {
      for (const worker of workers) if (worker.getState() === 'RUNNING') worker.shutdown();
      await Promise.allSettled([...runningWorkers.values()]);
    } finally {
      workers.clear();
      runningWorkers.clear();
      await environment?.teardown();
    }
  }, 30_000);

  test('explicit retention runs bounded indexed pages and replays without media paths', async () => {
    const cursors: Array<string | undefined> = [];
    const finished: string[] = [];
    const controls = await createWorker({
      connection: environment.nativeConnection,
      taskQueue: 'urm-controls',
      activities: {
        beginDurableJob: async () => {},
        finishDurableJob: async (_ref: unknown, state: string) => {
          finished.push(state);
        },
        loadMediaCleanupPlan: async () => ({ maxPages: 2 }),
      },
    });
    const worker = await createWorker({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: workflowPath,
      activities: {
        cleanupMediaArtifactPage: async (_ref: unknown, cursor?: string) => {
          cursors.push(cursor);
          return { scanned: 25, eligible: 1, deleted: 0, protected: 24, dryRun: true, nextCursor: 'a'.repeat(64) };
        },
      },
    });
    await runWorker(controls, () =>
      runWorker(worker, async () => {
        const handle = await environment.client.workflow.start(MediaArtifactCleanup, {
          workflowId: 'media-retention',
          taskQueue: queue,
          args: [{ ref: { jobId: 'cleanup', projectId: 'test-project' } }],
        });
        await handle.result();
        expect(cursors).toEqual([undefined, 'a'.repeat(64)]);
        expect(finished).toEqual(['succeeded']);
        await Worker.runReplayHistory({ workflowsPath: workflowPath }, await handle.fetchHistory());
      })
    );
  }, 120_000);

  test('coalesces edits while processing and replays recorded history', async () => {
    const acquired: number[] = [];
    const published: number[] = [];
    const settled: Array<[number, string]> = [];
    const worker = await createWorker({
      connection: environment.nativeConnection,
      taskQueue: queue,
      maxHeartbeatThrottleInterval: 100,
      defaultHeartbeatThrottleInterval: 100,
      workflowsPath: workflowPath,
      activities: activities({
        acquireMedia: async (request) => {
          acquired.push(request.revision);
          if (request.revision === 1) {
            const context = Context.current();
            context.heartbeat();
            const timer = setInterval(() => context.heartbeat(), 20);
            try {
              await context.cancelled;
            } finally {
              clearInterval(timer);
            }
          }
          return { kind: 'ready' };
        },
        publishMedia: async (request) => {
          published.push(request.revision);
          return { kind: 'ready' };
        },
        projectMediaFailure: async (request, code) => {
          settled.push([request.revision, code]);
        },
      }),
    });
    await runWorker(worker, async () => {
      const handle = await environment.client.workflow.start(SermonAudioCoordinator, {
        workflowId: 'media-coalesce',
        taskQueue: queue,
        args: [{ initial: ref(1), mediaTaskQueue: queue, controlTaskQueue: queue }],
      });
      await waitFor(handle, (state) => state.phase === 'acquiring');
      while (!acquired.length) await new Promise((resolve) => setTimeout(resolve, 20));
      await handle.signal('media.request', ref(2));
      await handle.signal('media.request', ref(3));
      await handle.signal('media.request', ref(2));
      await waitFor(handle, (state) => state.phase === 'idle' && state.desired.revision === 3);
      expect(acquired).toEqual([1, 3]);
      expect(published).toEqual([3]);
      expect(settled).toContainEqual([1, 'SUPERSEDED']);
      const history = await handle.fetchHistory();
      await Worker.runReplayHistory({ workflowsPath: workflowPath }, history);
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
    });
  }, 120_000);

  test('post-live archive retry uses a durable timer instead of worker sleep', async () => {
    let attempts = 0;
    const worker = await createWorker({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: workflowPath,
      activities: activities({
        acquireMedia: async () => ({ kind: ++attempts === 1 ? 'waiting_archive' : 'ready' }),
      }),
    });
    await runWorker(worker, async () => {
      const handle = await environment.client.workflow.start(SermonAudioCoordinator, {
        workflowId: 'media-archive',
        taskQueue: queue,
        args: [{ initial: ref(1), mediaTaskQueue: queue, controlTaskQueue: queue }],
      });
      await waitFor(handle, (state) => state.phase === 'waiting_archive');
      await environment.sleep('31 minutes');
      await waitFor(handle, (state) => state.phase === 'idle');
      expect(attempts).toBe(2);
      const history = await handle.fetchHistory();
      expect(history.events?.some((event) => event.timerStartedEventAttributes)).toBe(true);
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
    });
  }, 120_000);

  test('human auth recovery survives waiting and requires a successful canary', async () => {
    let acquireAttempts = 0;
    let canaries = 0;
    const worker = await createWorker({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: workflowPath,
      activities: activities({
        acquireMedia: async () => ({
          kind: ++acquireAttempts === 1 ? 'waiting_auth' : 'ready',
          recoveryGeneration: null,
        }),
        recoverMediaAuthentication: async () => ({
          ready: ++canaries > 1,
          generation: canaries > 1 ? 'verified-generation' : null,
        }),
      }),
    });
    await runWorker(worker, async () => {
      const handle = await environment.client.workflow.start(SermonAudioCoordinator, {
        workflowId: 'media-auth',
        taskQueue: queue,
        args: [{ initial: ref(1), mediaTaskQueue: queue, controlTaskQueue: queue }],
      });
      await waitFor(handle, (state) => state.phase === 'waiting_auth');
      await handle.signal('media.authRecovered', 'cookies-saved');
      await environment.sleep('1 minute');
      expect(acquireAttempts).toBe(1);
      await handle.signal('media.authRecovered', 'canary-ready');
      await waitFor(handle, (state) => state.phase === 'idle');
      expect(acquireAttempts).toBe(2);
      expect(canaries).toBe(2);
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
    });
  }, 120_000);

  test('explicit cancellation waits for activity cleanup before settling', async () => {
    const effects: string[] = [];
    const worker = await createWorker({
      connection: environment.nativeConnection,
      taskQueue: queue,
      maxHeartbeatThrottleInterval: 100,
      defaultHeartbeatThrottleInterval: 100,
      workflowsPath: workflowPath,
      activities: activities({
        acquireMedia: async () => {
          const context = Context.current();
          context.heartbeat();
          const interval = setInterval(() => context.heartbeat(), 20);
          try {
            await context.cancelled;
            return { kind: 'ready' };
          } finally {
            clearInterval(interval);
            effects.push('native-cleaned');
          }
        },
        publishMedia: async () => {
          effects.push('published');
          return { kind: 'ready' };
        },
        projectMediaFailure: async (_request, code) => {
          effects.push(code);
        },
        cleanupMedia: async () => {
          effects.push('projection-cleaned');
        },
      }),
    });
    await runWorker(worker, async () => {
      const handle = await environment.client.workflow.start(SermonAudioCoordinator, {
        workflowId: 'media-cancel',
        taskQueue: queue,
        args: [{ initial: ref(1), mediaTaskQueue: queue, controlTaskQueue: queue }],
      });
      await waitFor(handle, (state) => state.phase === 'acquiring');
      await handle.signal('media.cancel', 'job-1');
      await waitFor(handle, (state) => state.phase === 'idle');
      expect(effects).toEqual(['native-cleaned', 'CANCELLED', 'projection-cleaned']);
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
    });
  }, 120_000);

  test('bounded parent dependency receives completion signal and returns only state', async () => {
    let complete = false;
    let registered = false;
    const worker = await createWorker({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: workflowPath,
      activities: activities({
        registerMediaObserver: async (_ref, workflowId) => {
          expect(workflowId).toBe('media-observer');
          registered = true;
        },
        readMediaCompletion: async () => ({ kind: complete ? 'succeeded' : 'pending' }),
      }),
    });
    await runWorker(worker, async () => {
      const handle = await environment.client.workflow.start(AwaitSermonAudio, {
        workflowId: 'media-observer',
        taskQueue: queue,
        args: [{ ref: ref(1), mediaTaskQueue: queue, controlTaskQueue: queue }],
      });
      while (!registered) await new Promise((resolve) => setTimeout(resolve, 20));
      complete = true;
      await handle.signal('media.completed', { jobId: 'job-1', projectId: 'test-project' });
      expect(await handle.result()).toEqual({ kind: 'succeeded' });
      const history = await handle.fetchHistory();
      await Worker.runReplayHistory({ workflowsPath: workflowPath }, history);
    });
  }, 120_000);

  test('dependency cancellation waits for persisted media cleanup acknowledgement', async () => {
    let state: 'pending' | 'cancelled' = 'pending';
    let registered = false;
    const effects: string[] = [];
    const worker = await createWorker({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: workflowPath,
      activities: activities({
        registerMediaObserver: async () => {
          registered = true;
        },
        requestMediaCancellation: async () => {
          effects.push('cancellation-persisted');
        },
        readMediaCompletion: async () => ({ kind: state }),
      }),
    });
    await runWorker(worker, async () => {
      const handle = await environment.client.workflow.start(AwaitSermonAudio, {
        workflowId: 'media-observer-cancel',
        taskQueue: queue,
        args: [{ ref: ref(1), mediaTaskQueue: queue, controlTaskQueue: queue }],
      });
      while (!registered) await new Promise((resolve) => setTimeout(resolve, 20));
      while ((await handle.query('media.dependencyState')) !== 'waiting')
        await new Promise((resolve) => setTimeout(resolve, 20));
      await handle.cancel();
      while (!effects.length) await new Promise((resolve) => setTimeout(resolve, 20));
      effects.push('native-cleaned');
      state = 'cancelled';
      await handle.signal('media.completed', { jobId: 'job-1', projectId: 'test-project' });
      await expect(handle.result()).rejects.toThrow();
      expect(effects).toEqual(['cancellation-persisted', 'native-cleaned']);
    });
  }, 120_000);

  test('idle coordinator retires and signalWithStart accepts a fresh revision', async () => {
    const published: number[] = [];
    const worker = await createWorker({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: workflowPath,
      activities: activities({
        publishMedia: async (request) => {
          published.push(request.revision);
          return { kind: 'ready' };
        },
      }),
    });
    await runWorker(worker, async () => {
      const first = await environment.client.workflow.start(SermonAudioCoordinator, {
        workflowId: 'media-idle',
        taskQueue: queue,
        args: [{ initial: ref(1), mediaTaskQueue: queue, controlTaskQueue: queue }],
      });
      await waitFor(first, (state) => state.phase === 'idle');
      await environment.sleep('11 minutes');
      expect(await first.result()).toBeUndefined();
      const second = await environment.client.workflow.signalWithStart(SermonAudioCoordinator, {
        workflowId: 'media-idle',
        taskQueue: queue,
        args: [{ initial: ref(2), mediaTaskQueue: queue, controlTaskQueue: queue }],
        signal: 'media.request',
        signalArgs: [ref(2)],
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      });
      await waitFor(second, (state) => state.phase === 'idle' && state.desired.revision === 2);
      expect(published).toEqual([1, 2]);
      await second.cancel();
      await expect(second.result()).rejects.toThrow();
    });
  }, 120_000);
});
