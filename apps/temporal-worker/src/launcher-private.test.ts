let mockRegistered = true;
const mockClose = jest.fn(async () => {}),
  mockDelete = jest.fn(async () => {
    mockRegistered = false;
  }),
  mockCap = jest.fn(async () => ({ context: { operationId: 'owned' } })),
  mockSupervise = jest.fn(async (..._args: unknown[]) => ({ code: 0 })),
  mockNormal = jest.fn();
jest.mock('./runtime/media-recovery-config', () => ({
  isMediaRecoveryConfiguration: () => true,
  loadMediaRecoveryRuntimeConfig: () => ({
    projectId: 'urm-app-staging',
    buildId: 'a'.repeat(40),
    operationId: 'owned',
  }),
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({}));
jest.mock('@upperroom/shared/firebase/firebaseAdminOwnership', () => ({
  getSharedFirebaseAppOwnership: () => ({
    app: { name: '[DEFAULT]', options: { projectId: 'urm-app-staging' } },
    isRegistered: () => mockRegistered,
    terminateFirestore: mockClose,
    deleteApp: mockDelete,
  }),
}));
jest.mock('firebase-admin/firestore', () => ({ getFirestore: () => ({}) }));
jest.mock('firebase-admin/auth', () => ({ getAuth: () => ({}) }));
jest.mock('./runtime/worker-witness', () => ({ loadWorkerWitness: async () => ({ buildId: 'a'.repeat(40) }) }));
jest.mock('./runtime/media-recovery-capability', () => ({ mediaRecoveryKernelContext: () => mockCap() }));
jest.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket() {
      return {};
    }
  },
}));
jest.mock('./runtime/media-recovery-replacement', () => ({
  superviseMediaRecoveryReplacementCycle: (...args: any[]) => mockSupervise(...args),
}));
jest.mock('@temporalio/client', () => ({
  Connection: { connect: async () => ({ close: async () => {} }) },
  Client: class {},
}));
jest.mock('./index', () => ({ startWorkerProcess: mockNormal }));
import { launchApplicationWorker } from './launcher';
import { mediaJobParentFailureLine } from './runtime/media-job-launch-failure';
beforeEach(() => {
  jest.clearAllMocks();
  mockRegistered = true;
});
afterEach(() => {
  process.exitCode = undefined;
});
test('image private branch supervises actual index.js and retains independent resource cleanup', async () => {
  await launchApplicationWorker();
  expect(mockSupervise).toHaveBeenCalledTimes(1);
  expect(mockSupervise.mock.calls[0][3]).toMatch(/index.js$/);
  expect(mockCap).toHaveBeenCalledTimes(1);
  expect(mockNormal).not.toHaveBeenCalled();
  expect(mockClose).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledTimes(1);
});
test('denied private capability has no normal fallback or child', async () => {
  mockCap.mockRejectedValueOnce(new Error('CONTROLLED_PRIVATE_CAPABILITY_DENIED'));
  await expect(launchApplicationWorker()).rejects.toThrow('CONTROLLED_PRIVATE_CAPABILITY_DENIED');
  expect(mockSupervise).not.toHaveBeenCalled();
  expect(mockNormal).not.toHaveBeenCalled();
  expect(mockDelete).toHaveBeenCalledTimes(1);
});
test('a finite Job parent retains a sanitized capability denial and cleans up before any child launch', async () => {
  const saved = process.env;
  process.env = { ...saved, FIREBASE_PROJECT_ID: 'urm-app-staging', TEMPORAL_MEDIA_RECOVERY_COMPUTE: 'cloud-run-job-v1' };
  delete process.env.TEMPORAL_MEDIA_RECOVERY_CHILD;
  try {
    const error = new Error('private document and token');
    mockCap.mockRejectedValueOnce(error);
    await expect(launchApplicationWorker()).rejects.toBe(error);
    expect(JSON.parse(mediaJobParentFailureLine(error))).toEqual({
      event: 'media_recovery_job_parent_start_failed', phase: 'capability', protocol: 'local', code: 'unknown',
    });
    expect(mockCap).toHaveBeenCalledTimes(1);
    expect(mockSupervise).not.toHaveBeenCalled();
    expect(mockNormal).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledTimes(1);
  } finally { process.env = saved; }
});
test('private parent cleanup independently attempts app deletion after Firestore cleanup rejects', async () => {
  mockClose.mockRejectedValueOnce(new Error('CONTROLLED_CLEANUP_FAILURE'));
  await launchApplicationWorker();
  expect(mockDelete).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(1);
  expect(mockNormal).not.toHaveBeenCalled();
});
