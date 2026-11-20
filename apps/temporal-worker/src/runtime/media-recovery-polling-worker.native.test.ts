import { randomUUID } from 'node:crypto';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';
import { MediaRecoveryPollingWorker } from './media-recovery-polling-worker';
import { WorkerLifecycle } from './worker-lifecycle';

class ObservedRecoveryWorker extends MediaRecoveryPollingWorker {
  trackActivityPolls() {
    const observed: string[] = [];
    const poll = this.nativeWorker.pollActivityTask.bind(this.nativeWorker);
    jest.spyOn(this.nativeWorker, 'pollActivityTask').mockImplementation((...args) => {
      observed.push(this.getState());
      return poll(...args);
    });
    return observed;
  }
}

test('the real SDK closes an unauthorized diagnostic Worker without any first poll', async () => {
  Runtime.install({ logger: new DefaultLogger('WARN', () => undefined) });
  const namespace = 'private-poll-gate',
    environment = await createLocalTestEnvironment({
      server: {
        namespace,
        ip: '127.0.0.1',
        ...(process.env.TEMPORAL_CLI_TEST_PATH
          ? { executable: { type: 'existing-path' as const, path: process.env.TEMPORAL_CLI_TEST_PATH } }
          : {}),
      },
    });
  const run = async (authorized: boolean) => {
    const queue = 'private-poll-gate-' + randomUUID();
    const worker = await ObservedRecoveryWorker.create({
      connection: environment.nativeConnection,
      namespace,
      taskQueue: queue,
      activities: { probe: async () => undefined },
      shutdownGraceTime: '2 seconds',
    });
    if (!(worker instanceof ObservedRecoveryWorker)) throw new Error('Expected the observed worker subclass');
    const nativePoll = worker.trackActivityPolls();
    const lifecycle = new WorkerLifecycle({ onDraining() {}, stopDispatcher: async () => {}, resources: [] });
    lifecycle.workers.push(worker);
    lifecycle.completeStartup();
    let running: Promise<void> | undefined;
    const describe = () =>
      environment.connection.workflowService.describeTaskQueue({
        namespace,
        taskQueue: { name: queue },
        taskQueueType: 2,
      });
    try {
      if (authorized) {
        worker.allowPolling(() => !lifecycle.draining);
        running = lifecycle.run();
        void running.catch(() => undefined);
        const deadline = Date.now() + 5000;
        while ((await describe()).pollers?.length === 0 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        expect(nativePoll).toContain('RUNNING');
        expect((await describe()).pollers).toHaveLength(1);
      }
    } finally {
      await lifecycle.shutdown();
      await running;
    }
    expect(worker.getState()).toBe('STOPPED');
    if (!authorized) {
      expect(nativePoll.length).toBeGreaterThan(0);
      expect(nativePoll.every((state) => state === 'DRAINING')).toBe(true);
      expect((await describe()).pollers ?? []).toHaveLength(0);
    }
  };

  try {
    await run(false);
    await run(true);
  } finally {
    await environment.teardown();
  }
}, 20000);
