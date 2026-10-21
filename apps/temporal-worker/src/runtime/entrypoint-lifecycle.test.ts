const mockConsumedBundle = {
  code: 'held immutable image bytes',
  evidence: { schemaVersion: 1, buildId: 'unit', bundleSHA256: 'b'.repeat(64), bundleBytes: 26 },
};
const mockLoadConsumedBundle = jest.fn(async () => mockConsumedBundle);
jest.mock('./consumed-workflow-bundle', () => ({
  loadConsumedWorkflowBundle: (...args: unknown[]) => Reflect.apply(mockLoadConsumedBundle, undefined, args),
}));
let mockRequestHandler:
  | ((
      request: { url: string },
      response: { writeHead: (status: number, headers?: unknown) => unknown; end: (body?: string) => void }
    ) => void)
  | undefined;
let mockWorkerQueue = 'urm-controls';
let mockHosting: 'cloud-run' | 'traditional' = 'traditional';
const mockEvents: string[] = [];
const mockApp = { name: '[DEFAULT]', options: { projectId: 'urm-app-staging' } };
let mockOwnedApp: typeof mockApp | undefined = mockApp;
let mockRegistered = true;
const mockRuntimeClose = jest.fn(async () => {
  mockEvents.push('runtime.close');
});
const mockClientClose = jest.fn(async () => {
  mockEvents.push('client.close');
});
const mockNativeClose = jest.fn(async () => {
  mockEvents.push('native.close');
});
const mockFirestoreClose = jest.fn(async () => {
  mockEvents.push('firestore.close');
});
const mockDeleteApp = jest.fn(async (app: unknown) => {
  expect(app).toBe(mockApp);
  mockRegistered = false;
  mockEvents.push('app.delete');
});
const mockWorkers: Array<{
  run: jest.Mock;
  shutdown: jest.Mock;
  getStatus: () => { runState: string };
  stop: () => void;
}> = [];
const mockSignals = new Map<string, () => void>();
const pendingRuns: Promise<unknown>[] = [];
const fixtureCleanup: Array<() => void> = [];
function track<T>(promise: Promise<T>): Promise<T> {
  pendingRuns.push(promise);
  void promise.catch(() => undefined);
  return promise;
}
const mockSentryInit = jest.fn();
const mockSentryClose = jest.fn(async () => {
  mockEvents.push('sentry.flush');
});
jest.mock('@sentry/node', () => ({
  init: (options: unknown) => mockSentryInit(options),
  close: () => mockSentryClose(),
  captureException: jest.fn(),
}));
jest.mock('@temporalio/worker', () => ({
  Runtime: {
    install: jest.fn((options) => {
      expect(options.shutdownSignals).toEqual([]);
      expect(options.telemetryOptions.metrics.prometheus).toBeDefined();
      mockEvents.push('runtime.install');
      return { shutdown: mockRuntimeClose };
    }),
  },
  NativeConnection: {
    connect: jest.fn(async () => {
      expect(mockEvents[0]).toBe('runtime.install');
      mockEvents.push('native.connect');
      return { close: mockNativeClose };
    }),
  },
  Worker: {
    create: jest.fn(async (options) => {
      let resolve!: () => void;
      let state = 'INITIALIZED';
      const done = new Promise<void>((yes) => {
        resolve = yes;
      });
      const worker = {
        run: jest.fn(() => {
          state = 'RUNNING';
          mockEvents.push('worker.run');
          return done;
        }),
        shutdown: jest.fn(() => {
          state = 'DRAINING';
          mockEvents.push('worker.shutdown');
        }),
        getStatus: () => ({
          runState: state,
          workflowPollerState: options.workflowBundle ? 'POLLING' : 'SHUTDOWN',
          activityPollerState: 'POLLING',
        }),
        stop: () => {
          state = 'STOPPED';
          mockEvents.push('worker.stopped');
          resolve();
        },
      };
      mockWorkers.push(worker);
      return worker;
    }),
  },
}));
jest.mock('@temporalio/client', () => ({
  Connection: { connect: jest.fn(async () => ({ close: mockClientClose })) },
  Client: jest.fn(() => ({
    workflowService: { describeNamespace: async () => ({ namespaceInfo: { name: 'unit' } }) },
  })),
}));
jest.mock('firebase-admin/app', () => ({
  getApps: () => (mockRegistered ? [mockApp] : []),
  deleteApp: (app: unknown) => mockDeleteApp(app),
}));
jest.mock('firebase-admin/firestore', () => ({ getFirestore: () => ({ terminate: mockFirestoreClose }) }));
jest.mock('@upperroom/shared/firebase/firebaseAdminOwnership', () => ({
  getSharedFirebaseAppOwnership: () =>
    mockOwnedApp
      ? {
          app: mockOwnedApp,
          isRegistered: () => mockRegistered,
          terminateFirestore: mockFirestoreClose,
          deleteApp: () => mockDeleteApp(mockOwnedApp),
        }
      : undefined,
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({}));
jest.mock('./media-startup-capacity', () => ({ recordMediaStartupCapacity: jest.fn(async () => undefined) }));
jest.mock('./worker-witness', () => ({ loadWorkerWitness: async () => ({ instanceId: 'test' }) }));
jest.mock('./provider-sandbox-readiness', () => ({
  verifyProviderSandboxReadiness: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./activities', () => ({ createRuntimeActivities: () => ({ db: {}, queues: { 'urm-controls': {} } }) }));
jest.mock('./dispatcher', () => ({
  OutboxDispatcher: class {
    healthy = true;
    start() {}
    async stop() {
      mockEvents.push('dispatcher.stop');
    }
  },
}));
jest.mock('./config', () => ({
  loadRuntimeConfig: () => ({
    projectId: 'urm-app-staging',
    buildId: 'unit',
    queues: [mockWorkerQueue],
    hosting: mockHosting,
    workflowBundle: '/fixture/workflows.js',
    namespace: 'unit',
    port: 9999,
    dispatcherEnabled: false,
  }),
  runtimeCredentialFingerprint: () => undefined,
  assertRuntimeNamespace: jest.fn(),
}));
jest.mock('node:http', () => ({
  createServer: (handler: typeof mockRequestHandler) => {
    mockRequestHandler = handler;
    return {
      listening: true,
      once() {},
      removeListener() {},
      listen(_port: number, _host: string, ready: () => void) {
        ready();
      },
      close(done: () => void) {
        mockEvents.push('server.close');
        done();
      },
    };
  },
}));
import { runWorkerProcess, startWorkerProcess } from '../index';

const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
beforeEach(() => {
  mockRequestHandler = undefined;
  mockWorkerQueue = 'urm-controls';
  mockHosting = 'traditional';
  mockEvents.length = 0;
  mockWorkers.length = 0;
  mockSignals.clear();
  pendingRuns.length = 0;
  fixtureCleanup.length = 0;
  mockRegistered = true;
  mockOwnedApp = mockApp;
  jest.clearAllMocks();
  mockSentryInit.mockReset();
  mockSentryClose.mockReset().mockImplementation(async () => {
    mockEvents.push('sentry.flush');
  });
  jest.spyOn(process, 'on').mockImplementation(((signal: string, handler: () => void) => {
    mockSignals.set(signal, handler);
    return process;
  }) as typeof process.on);
});
afterEach(async () => {
  fixtureCleanup.forEach((cleanup) => cleanup());
  mockSignals.get('SIGTERM')?.();
  mockWorkers.forEach((worker) => worker.stop());
  await Promise.allSettled(pendingRuns);
  jest.restoreAllMocks();
});

test('actual entrypoint has one SDK signal owner and waits stopped workers before SDK sockets and Sentry close', async () => {
  const run = track(startWorkerProcess());
  await tick();
  expect(mockWorkers).toHaveLength(1);
  expect([...mockSignals.keys()]).toEqual(['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGUSR2']);
  mockSignals.get('SIGTERM')!();
  mockSignals.get('SIGTERM')!();
  mockSignals.get('SIGINT')!();
  await tick();
  expect(mockWorkers[0].shutdown).toHaveBeenCalledTimes(1);
  expect(mockFirestoreClose).not.toHaveBeenCalled();
  mockWorkers[0].stop();
  await run;
  expect(mockEvents.indexOf('dispatcher.stop')).toBeLessThan(mockEvents.indexOf('worker.shutdown'));
  expect(mockEvents.slice(-8)).toEqual([
    'worker.stopped',
    'server.close',
    'firestore.close',
    'app.delete',
    'client.close',
    'native.close',
    'runtime.close',
    'sentry.flush',
  ]);
  expect(mockEvents.at(-1)).toBe('sentry.flush');
});

test('foreign pre-existing Firebase app is not terminated or deleted on startup failure', async () => {
  mockOwnedApp = undefined;
  await expect(runWorkerProcess()).rejects.toBeInstanceOf(AggregateError);
  expect(mockFirestoreClose).not.toHaveBeenCalled();
  expect(mockDeleteApp).not.toHaveBeenCalled();
  expect(mockClientClose).toHaveBeenCalledTimes(1);
  expect(mockNativeClose).toHaveBeenCalledTimes(1);
});

test('a replaced creator app is never closed while every remaining owned connection still closes', async () => {
  let shutdown!: () => Promise<void>;
  const run = track(
    runWorkerProcess((owned) => {
      shutdown = owned;
    })
  );
  const observed = run.catch((error) => error);
  await tick();
  mockRegistered = false;
  void shutdown().catch(() => undefined);
  await tick();
  mockWorkers[0].stop();
  const error = await observed;
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors.map((failure: { stage: string }) => failure.stage)).toEqual([
    'firebase.firestore',
    'firebase.app',
  ]);
  expect(mockFirestoreClose).not.toHaveBeenCalled();
  expect(mockDeleteApp).not.toHaveBeenCalled();
  expect(mockClientClose).toHaveBeenCalledTimes(1);
  expect(mockNativeClose).toHaveBeenCalledTimes(1);
});

test('Sentry initialization failure still closes the already installed native Runtime', async () => {
  const actual = new Error('init failed');
  mockSentryInit.mockImplementationOnce(() => {
    throw actual;
  });
  let failure: AggregateError | undefined;
  try {
    await runWorkerProcess();
  } catch (error) {
    failure = error as AggregateError;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure!.errors[0]).toMatchObject({ stage: 'startup', cause: actual });
  expect(mockEvents).not.toContain('native.connect');
  expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
});

test('the same signal owner remains installed until deferred Sentry flush actually finishes', async () => {
  let releaseFlush!: () => void;
  const flushGate = new Promise<void>((resolve) => {
    releaseFlush = resolve;
  });
  fixtureCleanup.push(() => releaseFlush());
  mockSentryClose.mockImplementationOnce(async () => {
    mockEvents.push('sentry.flush');
    await flushGate;
  });
  const remove = jest.spyOn(process, 'removeListener');
  const run = track(startWorkerProcess());
  await tick();
  mockSignals.get('SIGTERM')!();
  await tick();
  mockWorkers[0].stop();
  await tick();
  expect(mockEvents.at(-1)).toBe('sentry.flush');
  expect(remove.mock.calls.filter(([signal]) => signal === 'SIGTERM')).toHaveLength(0);
  mockSignals.get('SIGTERM')!();
  mockSignals.get('SIGINT')!();
  await tick();
  expect(mockWorkers[0].shutdown).toHaveBeenCalledTimes(1);
  releaseFlush();
  await run;
  expect(remove.mock.calls.filter(([signal]) => signal === 'SIGTERM')).toHaveLength(1);
});

for (const queue of ['urm-search', 'urm-email', 'urm-images', 'urm-media'])
  for (const hosting of ['cloud-run', 'traditional'] as const)
    test(`actual ${queue} Worker.create preserves ${hosting} queue ownership`, async () => {
      mockWorkerQueue = queue;
      mockHosting = hosting;
      const { Worker } = await import('@temporalio/worker');
      const run = track(startWorkerProcess());
      await tick();
      expect(mockWorkers).toHaveLength(1);
      expect(jest.mocked(Worker.create).mock.calls[0][0].workflowBundle).toEqual(
        hosting === 'cloud-run' || queue === 'urm-media' ? undefined : { codePath: '/fixture/workflows.js' }
      );
      let status = 0;
      mockRequestHandler?.(
        { url: '/readyz' },
        {
          writeHead(code) {
            status = code;
            return this;
          },
          end() {},
        }
      );
      expect(status).toBe(200);
      mockSignals.get('SIGTERM')?.();
      mockWorkers[0].stop();
      await run;
    });

test('Cloud Run orchestration passes the exact held bundle string to Worker.create', async () => {
  mockWorkerQueue = 'urm-orchestration';
  mockHosting = 'cloud-run';
  const { Worker } = await import('@temporalio/worker');
  const running = track(startWorkerProcess());
  await tick();
  expect(mockLoadConsumedBundle).toHaveBeenCalledWith('/fixture/workflows.js', 'unit');
  expect(jest.mocked(Worker.create).mock.calls[0][0].workflowBundle).toEqual({ code: mockConsumedBundle.code });
  mockSignals.get('SIGTERM')?.();
  mockWorkers[0].stop();
  await running;
});
