const mockTerminate = jest.fn(async () => {});
const mockDelete = jest.fn(async () => {});
const mockWitness = jest.fn(async () => ({ buildId: 'unit' }));
const mockContext = jest.fn(async () => undefined as unknown);
const mockRestoredContext = jest.fn(async () => undefined as unknown);
const mockRestoredSupervise = jest.fn(async () => ({ code: 0 }));
jest.mock('./runtime/restored-media-startup', () => ({ restoredMediaKernelContext: () => mockRestoredContext() }));
const mockSupervise = jest.fn(async () => ({ code: 0 }));
let mockRegistered = true;
const mockStart = jest.fn(async () => {
  mockRegistered = false;
});
jest.mock('./runtime/config', () => ({ loadRuntimeConfig: () => ({ buildId: 'unit' }) }));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({}));
jest.mock('@upperroom/shared/firebase/firebaseAdminOwnership', () => ({
  getSharedFirebaseAppOwnership: () => ({
    app: {},
    isRegistered: () => mockRegistered,
    terminateFirestore: mockTerminate,
    deleteApp: mockDelete,
  }),
}));
jest.mock('firebase-admin/firestore', () => ({ getFirestore: () => ({}) }));
jest.mock('./runtime/worker-witness', () => ({ loadWorkerWitness: () => mockWitness() }));
jest.mock('./runtime/media-kernel-supervisor', () => ({
  mediaKernelContext: () => mockContext(),
  superviseMediaKernel: () => mockSupervise(),
  superviseRestoredMediaKernel: () => mockRestoredSupervise(),
}));
jest.mock('./index', () => ({ startWorkerProcess: () => mockStart() }));
import { launchApplicationWorker } from './launcher';
const saved = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  mockRegistered = true;
  process.env.FIREBASE_PROJECT_ID = 'urm-app-staging';
  process.env.TEMPORAL_WORKER_HOSTING = 'cloud-run';
  process.env.TEMPORAL_TASK_QUEUES = 'urm-media';
  process.exitCode = undefined;
});
afterEach(() => {
  process.env = { ...saved };
  process.exitCode = undefined;
});
test('failed native witness releases both creator-owned resources', async () => {
  mockWitness.mockRejectedValueOnce(new Error('CONTROLLED_WITNESS_FAILURE'));
  await expect(launchApplicationWorker()).rejects.toThrow('CONTROLLED_WITNESS_FAILURE');
  expect(mockTerminate).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledTimes(1);
  expect(mockStart).not.toHaveBeenCalled();
});
test('failed capability read preserves primary error and attempts independent cleanup', async () => {
  mockContext.mockRejectedValueOnce(new Error('CONTROLLED_CAPABILITY_FAILURE'));
  mockTerminate.mockRejectedValueOnce(new Error('CONTROLLED_CLEANUP_FAILURE'));
  await expect(launchApplicationWorker()).rejects.toThrow('CONTROLLED_CAPABILITY_FAILURE');
  expect(mockDelete).toHaveBeenCalledTimes(1);
});
test('ordinary media start transfers existing ownership to the original entrypoint', async () => {
  await launchApplicationWorker();
  expect(mockStart).toHaveBeenCalledTimes(1);
  expect(mockTerminate).not.toHaveBeenCalled();
});
test('supervised completion independently closes both parent resources', async () => {
  mockContext.mockResolvedValueOnce({ context: {} });
  await launchApplicationWorker();
  expect(mockSupervise).toHaveBeenCalledTimes(1);
  expect(mockTerminate).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledTimes(1);
  expect(mockStart).not.toHaveBeenCalled();
});

test('fallback early return without acquiring app keeps creator cleanup responsibility', async () => {
  mockStart.mockImplementationOnce(async () => {});
  await launchApplicationWorker();
  expect(mockTerminate).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledTimes(1);
});

test('restored normal capability uses only its distinct fixed supervisor', async () => {
  mockRestoredContext.mockResolvedValueOnce({ context: { protocol: 'restored-normal-media-kernel-v1' } });
  await launchApplicationWorker();
  expect(mockRestoredSupervise).toHaveBeenCalledTimes(1);
  expect(mockContext).not.toHaveBeenCalled();
  expect(mockSupervise).not.toHaveBeenCalled();
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockTerminate).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledTimes(1);
});
test('invalid restored capability never falls back to ordinary media startup', async () => {
  mockRestoredContext.mockRejectedValueOnce(new Error('CONTROLLED_RESTORED_AUTHORITY_DENIED'));
  await expect(launchApplicationWorker()).rejects.toThrow('CONTROLLED_RESTORED_AUTHORITY_DENIED');
  expect(mockContext).not.toHaveBeenCalled();
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockRestoredSupervise).not.toHaveBeenCalled();
  expect(mockTerminate).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledTimes(1);
});
