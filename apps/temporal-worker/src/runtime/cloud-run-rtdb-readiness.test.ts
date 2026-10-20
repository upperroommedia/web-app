import { verifyCloudRunRtdbReadiness } from './cloud-run-rtdb-readiness';
const mockGet = jest.fn(),
  mockOffline = jest.fn(),
  mockDelete = jest.fn(),
  mockEmail = jest.fn(),
  mockCompute = jest.fn();
const mockCredential = { isComputeEngineCredential: mockCompute, getServiceAccountEmail: mockEmail };
const mockOwned = {
  app: {
    name: '[DEFAULT]',
    options: {
      projectId: 'urm-app-staging',
      databaseURL: 'https://urm-app-staging-default-rtdb.firebaseio.com/',
      credential: mockCredential,
    },
  },
  isRegistered: () => true,
};
const mockCreated: { name: string; options: unknown }[] = [];
let mockCreatedNameOverride: string | undefined;
jest.mock('@upperroom/shared/firebase/firebaseAdminOwnership', () => ({
  getSharedFirebaseAppOwnership: () => mockOwned,
}));
jest.mock('firebase-admin/app', () => ({
  initializeApp: (options: unknown, name: string) => {
    const app = { name: mockCreatedNameOverride ?? name, options };
    mockCreated.push(app);
    return app;
  },
  deleteApp: (app: unknown) => mockDelete(app),
}));
jest.mock('firebase-admin/database', () => ({
  getDatabase: () => ({ ref: (path: string) => ({ get: () => mockGet(path) }), goOffline: mockOffline }),
}));
const witness = {
  buildId: 'a'.repeat(40),
  instanceId: 'process',
  cloudRun: {
    projectId: 'urm-app-staging',
    region: 'us-central1',
    pool: 'pool',
    revision: 'pool-00001',
    revisionUid: 'uid',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    serviceAccount: 'tw-o-aaaaaaaaaaaaaaaaaaaa@urm-app-staging.iam.gserviceaccount.com',
    instanceId: 'native',
  },
};
const emulatorNames = [
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
];
const originalEmulators = emulatorNames.map((name) => process.env[name]);
beforeEach(() => {
  // Every Firebase boundary is mocked in this suite; no SDK networking exists.
  for (const name of emulatorNames) delete process.env[name];
  jest.useRealTimers();
  jest.clearAllMocks();
  mockCreated.length = 0;
  mockCreatedNameOverride = undefined;
  mockGet.mockResolvedValue({ privateData: 'must never be returned' });
  mockDelete.mockResolvedValue(undefined);
  mockCompute.mockResolvedValue(true);
  mockEmail.mockResolvedValue(witness.cloudRun.serviceAccount);
});
afterEach(() => {
  jest.useRealTimers();
  emulatorNames.forEach((name, index) => {
    const previous = originalEmulators[index];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
});
test('fresh SDK app proves serving read with actual runner credential and cleans only its owned app', async () => {
  const proof = await verifyCloudRunRtdbReadiness(witness);
  expect(proof).toEqual({
    databaseURL: mockOwned.app.options.databaseURL,
    readPath: 'bundle-metadata',
    readSucceeded: true,
    observedAt: expect.any(String),
  });
  expect(mockGet).toHaveBeenCalledWith('bundle-metadata');
  expect(mockOffline).toHaveBeenCalledTimes(1);
  expect(mockCreated).toHaveLength(1);
  expect(mockCreated[0].name).toMatch(/^serverless-rtdb-/);
  expect(mockDelete).toHaveBeenCalledWith(mockCreated[0]);
  expect(JSON.stringify(proof)).not.toContain('privateData');
});
test('different or non-native ADC cannot start a serving read', async () => {
  mockEmail.mockResolvedValue('foreign@urm-app-staging.iam.gserviceaccount.com');
  await expect(verifyCloudRunRtdbReadiness(witness)).rejects.toThrow('CLOUD_RUN_RTDB_READINESS_UNCONFIRMED');
  expect(mockCreated).toHaveLength(0);
  expect(mockGet).not.toHaveBeenCalled();
  mockCompute.mockResolvedValue(false);
  await expect(verifyCloudRunRtdbReadiness(witness)).rejects.toThrow('CLOUD_RUN_RTDB_READINESS_UNCONFIRMED');
});
test('read and cleanup failures remain fixed safe errors', async () => {
  mockGet.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_SDK_DETAIL'));
  await expect(verifyCloudRunRtdbReadiness(witness)).rejects.toThrow(/^CLOUD_RUN_RTDB_READINESS_UNCONFIRMED$/);
  expect(mockDelete).toHaveBeenCalledTimes(1);
  mockGet.mockResolvedValue(null);
  mockDelete.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_SDK_DETAIL'));
  await expect(verifyCloudRunRtdbReadiness(witness)).rejects.toThrow(/^CLOUD_RUN_RTDB_READINESS_UNCONFIRMED$/);
});
test('stalled ADC is bounded and late authentication cannot create an app', async () => {
  jest.useFakeTimers();
  let finish: ((email: string) => void) | undefined;
  mockEmail.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      })
  );
  const result = expect(verifyCloudRunRtdbReadiness(witness)).rejects.toThrow('CLOUD_RUN_RTDB_READINESS_UNCONFIRMED');
  await jest.advanceTimersByTimeAsync(21000);
  await result;
  finish?.(witness.cloudRun.serviceAccount);
  await jest.advanceTimersByTimeAsync(0);
  expect(mockCreated).toHaveLength(0);
  expect(mockGet).not.toHaveBeenCalled();
});

test('native entry refuses emulator or credential overrides before calling ADC', async () => {
  process.env.FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:9';
  await expect(verifyCloudRunRtdbReadiness(witness)).rejects.toThrow('CLOUD_RUN_RTDB_READINESS_UNCONFIRMED');
  expect(mockCompute).not.toHaveBeenCalled();
  expect(mockCreated).toHaveLength(0);
});

test('stalled serving read is bounded and its owned app is closed', async () => {
  jest.useFakeTimers();
  mockGet.mockImplementation(() => new Promise(() => {}));
  const result = expect(verifyCloudRunRtdbReadiness(witness)).rejects.toThrow('CLOUD_RUN_RTDB_READINESS_UNCONFIRMED');
  await jest.advanceTimersByTimeAsync(21000);
  await result;
  expect(mockOffline).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledTimes(1);
});
test('cleanup must settle before success and cannot delete a foreign app', async () => {
  jest.useFakeTimers();
  mockDelete.mockImplementation(() => new Promise(() => {}));
  const result = expect(verifyCloudRunRtdbReadiness(witness)).rejects.toThrow('CLOUD_RUN_RTDB_READINESS_UNCONFIRMED');
  await jest.advanceTimersByTimeAsync(21000);
  await result;
  jest.clearAllMocks();
  mockCreatedNameOverride = 'foreign-default';
  await expect(verifyCloudRunRtdbReadiness(witness)).rejects.toThrow('CLOUD_RUN_RTDB_READINESS_UNCONFIRMED');
  expect(mockDelete).not.toHaveBeenCalled();
  expect(mockOffline).not.toHaveBeenCalled();
});
