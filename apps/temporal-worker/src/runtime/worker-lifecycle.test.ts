import { WorkerLifecycle, WorkerLifecycleFailure } from './worker-lifecycle';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function worker(events: string[], name: string) {
  const stopped = deferred();
  let state = 'INITIALIZED';
  return {
    run: jest.fn(() => {
      events.push(`${name}.run`);
      state = 'RUNNING';
      return stopped.promise;
    }),
    getStatus: () => ({ runState: state }),
    shutdown: jest.fn(() => {
      events.push(`${name}.shutdown`);
      state = 'DRAINING';
    }),
    stop: () => {
      state = 'STOPPED';
      stopped.resolve();
    },
    fail: (error: unknown) => {
      state = 'FAILED';
      stopped.reject(error);
    },
  };
}
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test('one shared shutdown promise stops dispatch first, waits actual run completion, then closes every SDK handle', async () => {
  const events: string[] = [];
  const dispatcher = deferred();
  const lifecycle = new WorkerLifecycle({
    onDraining: () => {
      events.push('probes.stop');
    },
    stopDispatcher: async () => {
      events.push('dispatcher.stop');
      await dispatcher.promise;
    },
    resources: ['firestore', 'app', 'client', 'native', 'runtime'].map((name) => ({
      name,
      close: () => {
        events.push(name);
      },
    })),
  });
  const first = worker(events, 'a'),
    second = worker(events, 'b');
  lifecycle.workers.push(first, second);
  lifecycle.completeStartup();
  const running = lifecycle.run();
  const shutdown = lifecycle.shutdown();
  expect(lifecycle.shutdown()).toBe(shutdown);
  await tick();
  expect(first.shutdown).not.toHaveBeenCalled();
  dispatcher.resolve();
  await tick();
  expect(first.shutdown).toHaveBeenCalledTimes(1);
  expect(second.shutdown).toHaveBeenCalledTimes(1);
  first.stop();
  await tick();
  expect(events).not.toContain('firestore');
  second.stop();
  await shutdown;
  await running;
  expect(events).toEqual([
    'a.run',
    'b.run',
    'probes.stop',
    'dispatcher.stop',
    'a.shutdown',
    'b.shutdown',
    'firestore',
    'app',
    'client',
    'native',
    'runtime',
  ]);
});

test('a signal during startup waits the gate, then drains even partially created initialized workers', async () => {
  const events: string[] = [];
  const lifecycle = new WorkerLifecycle({
    onDraining: () => {},
    stopDispatcher: async () => {
      events.push('dispatch');
    },
    resources: [],
  });
  const shutdown = lifecycle.shutdown();
  await tick();
  expect(events).toEqual([]);
  const partial = worker(events, 'partial');
  lifecycle.workers.push(partial);
  lifecycle.completeStartup();
  await tick();
  expect(events).toEqual(['dispatch', 'partial.run', 'partial.shutdown']);
  partial.stop();
  await shutdown;
});

test('fatal run initiates sibling drain and retains the original cause without a duplicate shutdown on FAILED', async () => {
  const events: string[] = [];
  const lifecycle = new WorkerLifecycle({ onDraining: () => {}, stopDispatcher: async () => {}, resources: [] });
  const first = worker(events, 'a'),
    second = worker(events, 'b');
  lifecycle.workers.push(first, second);
  lifecycle.completeStartup();
  const run = lifecycle.run();
  const observed = run.catch((error) => error);
  const fatal = new Error('actual run failure');
  first.fail(fatal);
  await tick();
  expect(first.shutdown).not.toHaveBeenCalled();
  expect(second.shutdown).toHaveBeenCalledTimes(1);
  second.stop();
  const error = await observed;
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([expect.objectContaining({ stage: 'worker.run', cause: fatal })]);
});

test('dispatcher, shutdown and cleanup failures all remain visible while other cleanup still runs', async () => {
  const events: string[] = [];
  const failures = [new Error('dispatch'), new Error('shutdown'), new Error('close')];
  const lifecycle = new WorkerLifecycle({
    onDraining: () => {},
    stopDispatcher: async () => {
      throw failures[0];
    },
    resources: [
      {
        name: 'bad.close',
        close: () => {
          throw failures[2];
        },
      },
      {
        name: 'final.close',
        close: () => {
          events.push('final');
        },
      },
    ],
  });
  const w = worker(events, 'a');
  w.shutdown.mockImplementation(() => {
    w.stop();
    throw failures[1];
  });
  lifecycle.workers.push(w);
  lifecycle.completeStartup();
  const run = lifecycle.run();
  const observed = run.catch((error) => error);
  const result = lifecycle.shutdown().catch((error) => error);
  const error = await result;
  await observed;
  expect(error.errors.every((item: unknown) => item instanceof WorkerLifecycleFailure)).toBe(true);
  expect(error.errors.map((item: WorkerLifecycleFailure) => item.cause)).toEqual(failures);
  expect(events).toContain('final');
});
