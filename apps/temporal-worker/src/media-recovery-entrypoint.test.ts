const mockEvents: string[] = [];
const mockReceiptPaths: string[] = [];
let mockRegistered = true,
  mockParent = true,
  mockBundleFailure = false,
  mockCloudWitness = true;
const mockCode = 'exact-held-private-workflow-code';
const mockWorker = {
  allowPolling: jest.fn(() => mockEvents.push('allow.polling')),
  run: jest.fn(async () => {
    mockEvents.push('run');
  }),
  shutdown: jest.fn(() => {
    mockEvents.push('shutdown');
  }),
  getStatus: () => ({ runState: 'RUNNING' }),
};
const mockCreate = jest.fn(async (options: any) => {
  mockEvents.push('create');
  return mockWorker;
});
const mockAuthorize = jest.fn(async () => {
  mockEvents.push('authorize');
});
const mockActivities = { admitMediaRecoveryWork: jest.fn(), acquireMedia: jest.fn() };
const mockOwner = {
  app: { name: '[DEFAULT]', options: { projectId: 'urm-app-staging' } },
  isRegistered: () => mockRegistered,
  terminateFirestore: async () => {
    mockEvents.push('firestore.close');
  },
  deleteApp: async () => {
    mockEvents.push('firebase.close');
    mockRegistered = false;
  },
};
jest.mock('./runtime/media-recovery-config', () => ({
  loadMediaRecoveryRuntimeConfig: () => ({
    projectId: 'urm-app-staging',
    buildId: 'a'.repeat(40),
    operationId: '12345678-1234-1234-1234-123456789abc',
    namespace: 'urm-app-staging.qwejt',
    queues: ['urm-media-kernel-recovery'],
    deploymentName: 'urm-worker-media-recovery-staging',
    workflowBundle: '/fixed/private',
    address: 'controlled',
  }),
}));
jest.mock('./runtime/consumed-workflow-bundle', () => ({
  loadConsumedMediaRecoveryBundle: async () => {
    if (mockBundleFailure) throw new Error('CONTROLLED_BUNDLE_FAILURE');
    return { code: mockCode, evidence: { bundleSHA256: 'b'.repeat(64) } };
  },
}));
jest.mock('./runtime/worker-witness', () => ({
  loadWorkerWitness: async () => ({
    instanceId: '11111111-1111-4111-8111-111111111111',
    cloudRun: mockCloudWitness
      ? { pool: 'controlled-pool', revision: 'controlled-revision', revisionUid: 'controlled-revision-uid' }
      : undefined,
  }),
}));
jest.mock('./runtime/media-kernel-supervisor', () => ({
  reportMediaKernelWitness: async () =>
    mockParent ? { operationId: 'controlled', birthDigest: 'c'.repeat(64) } : undefined,
}));
jest.mock('@upperroom/shared/firebase/firebaseAdminOwnership', () => ({
  getSharedFirebaseAppOwnership: () => mockOwner,
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({}));
jest.mock('@upperroom/shared/shared/firebaseProjectConfig', () => ({
  getFirebaseStorageBucket: () => 'urm-app-staging.firebasestorage.app',
}));
jest.mock('./runtime/activities', () => ({
  createRuntimeActivities: () => ({ queues: { 'urm-media': { acquireMedia: jest.fn() } } }),
}));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    doc: (path: string) => {
      mockReceiptPaths.push(path);
      return { get: async () => ({ data: () => undefined }) };
    },
    runTransaction: async (fn: any) =>
      fn({
        get: async () => ({ exists: false }),
        create: () => {
          mockEvents.push('startup.receipt');
        },
      }),
  }),
}));
jest.mock('firebase-admin/auth', () => ({ getAuth: () => ({}) }));
jest.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket() {
      return {};
    }
  },
}));
jest.mock('./runtime/media-recovery-original-fault', () => ({ holdOriginalMediaCompletion: (o: any) => o.acquire }));
jest.mock('./runtime/media-recovery-registration', () => {
  const make = async () => ({
    cap: {
      authorize: mockAuthorize,
      context: { intentSHA256: 'd'.repeat(64) },
      plan: { expiresAt: Date.now() + 10000, createdAt: new Date().toISOString() },
    },
    activities: mockActivities,
    authorize: mockAuthorize,
  });
  return {
    createMediaRecoveryRegistration: async () => {
      mockEvents.push('original.registration');
      return make();
    },
    createMediaRecoveryReplacementRegistration: async () => {
      mockEvents.push('replacement.registration');
      return make();
    },
  };
});
jest.mock('./runtime/media-startup-capacity', () => ({
  runMediaFilesystemCanary: async () => {
    mockEvents.push('canary');
    return {};
  },
  validateMediaStartupCapacityEvidence: () => {
    mockEvents.push('capacity.validate');
  },
}));
jest.mock('./runtime/observability', () => ({
  initializeWorkerObservability: (_: any, __: any, ___: any, set: any) =>
    set({
      shutdown: async () => {
        mockEvents.push('runtime.close');
      },
    }),
  flushWorkerObservability: async () => {},
}));
jest.mock('@temporalio/worker', () => ({
  NativeConnection: {
    connect: async () => ({
      close: async () => {
        mockEvents.push('native.close');
      },
    }),
  },
}));
jest.mock('./runtime/media-recovery-polling-worker', () => ({
  MediaRecoveryPollingWorker: { create: (o: unknown) => mockCreate(o) },
}));
jest.mock('@temporalio/client', () => ({
  Connection: {
    connect: async () => ({
      withDeadline: async (_: any, fn: any) => fn(),
      close: async () => {
        mockEvents.push('client.close');
      },
    }),
  },
  Client: class {
    workflowService = { describeNamespace: async () => ({ namespaceInfo: { name: 'urm-app-staging.qwejt' } }) };
  },
}));
import { runMediaRecoveryApplication } from './media-recovery-entrypoint';
const originalSend = process.send;
beforeEach(() => {
  jest.clearAllMocks();
  mockEvents.length = 0;
  mockReceiptPaths.length = 0;
  mockRegistered = true;
  mockParent = true;
  mockBundleFailure = false;
  mockCloudWitness = true;
  process.env.TEMPORAL_MEDIA_RECOVERY_CHILD = 'original';
  process.send = (() => true) as typeof process.send;
});
afterEach(() => {
  delete process.env.TEMPORAL_MEDIA_RECOVERY_CHILD;
  process.send = originalSend;
});
test('private actual entrypoint retains same bundle bytes and only two Activities before polling', async () => {
  await runMediaRecoveryApplication();
  const options = mockCreate.mock.calls[0][0];
  expect(options.workflowBundle.code).toBe(mockCode);
  expect(options.taskQueue).toBe('urm-media-kernel-recovery');
  expect(Object.keys(options.activities).sort()).toEqual(['acquireMedia', 'admitMediaRecoveryWork']);
  expect(options.maxConcurrentActivityTaskExecutions).toBe(1);
  expect(mockEvents.indexOf('capacity.validate')).toBeLessThan(mockEvents.indexOf('create'));
  expect(mockEvents.indexOf('startup.receipt')).toBeLessThan(mockEvents.indexOf('allow.polling'));
  expect(mockEvents.indexOf('allow.polling')).toBeLessThan(mockEvents.indexOf('run'));
  expect(mockEvents).toEqual(
    expect.arrayContaining(['firestore.close', 'firebase.close', 'client.close', 'native.close', 'runtime.close'])
  );
});
test('missing Cloud Run identity cannot create an immutable startup receipt or poll', async () => {
  mockCloudWitness = false;
  await expect(runMediaRecoveryApplication()).rejects.toThrow('MEDIA_RECOVERY_CLOUD_WITNESS_REQUIRED');
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockReceiptPaths).toHaveLength(0);
  expect(mockEvents).not.toContain('original.registration');
  expect(mockEvents).toContain('firebase.close');
});
test('missing native parent cannot create a Worker or fall back', async () => {
  mockParent = false;
  await expect(runMediaRecoveryApplication()).rejects.toThrow('MEDIA_RECOVERY_PARENT_REQUIRED');
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockEvents).toContain('firebase.close');
});
test('early bundle failure still closes creator-owned Firebase and installed runtime', async () => {
  mockBundleFailure = true;
  await expect(runMediaRecoveryApplication()).rejects.toThrow('CONTROLLED_BUNDLE_FAILURE');
  expect(mockEvents).toEqual(expect.arrayContaining(['firebase.close', 'runtime.close']));
  expect(mockCreate).not.toHaveBeenCalled();
});

test('replacement uses separate lineage registration and startup receipt', async () => {
  process.env.TEMPORAL_MEDIA_RECOVERY_CHILD = 'replacement';
  await runMediaRecoveryApplication();
  expect(mockEvents).toContain('replacement.registration');
  expect(mockEvents).not.toContain('original.registration');
  expect(mockReceiptPaths.some((p) => p.includes('temporalMediaRecoveryReplacementStartup-'))).toBe(true);
  expect(mockReceiptPaths.some((p) => p.includes('temporalMediaRecoveryStartup-'))).toBe(false);
});
test('unrecognized child ordinal cannot initialize or poll', async () => {
  process.env.TEMPORAL_MEDIA_RECOVERY_CHILD = 'third';
  await expect(runMediaRecoveryApplication()).rejects.toThrow('MEDIA_RECOVERY_ORIGINAL_CHILD_REQUIRED');
  expect(mockEvents).toEqual([]);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('revoked authority after Worker creation never opens polling during lifecycle cleanup', async () => {
  mockCreate.mockImplementationOnce(async () => {
    mockAuthorize.mockRejectedValueOnce(new Error('CONTROLLED_AUTHORITY_REVOKED'));
    return mockWorker;
  });
  await expect(runMediaRecoveryApplication()).rejects.toThrow('CONTROLLED_AUTHORITY_REVOKED');
  expect(mockWorker.allowPolling).not.toHaveBeenCalled();
  expect(mockWorker.run).toHaveBeenCalledTimes(1);
  expect(mockEvents).toContain('native.close');
});
