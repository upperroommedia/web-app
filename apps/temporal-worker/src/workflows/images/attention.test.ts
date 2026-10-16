const mockActivities = {
  getImageDisposition: jest.fn(),
  prepareImage: jest.fn(),
  allocateImage: jest.fn(),
  uploadImageBytes: jest.fn(),
  commitImage: jest.fn(),
  finishImage: jest.fn(),
  cancelImage: jest.fn(),
  deleteImageProviders: jest.fn(),
  reconcileImageReceipt: jest.fn(),
};
const mockCancellation = new Error('cancelled during attention');
const mockWait = jest.fn();
const mockContinue = jest.fn();
const mockHandlers = new Map<unknown, () => void>();
jest.mock('@temporalio/workflow', () => ({
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: 1 },
  CancellationScope: { nonCancellable: (run: () => unknown) => run() },
  defineSignal: (name: string) => name,
  setHandler: (name: unknown, handler: () => void) => mockHandlers.set(name, handler),
  proxyActivities: () => mockActivities,
  makeContinueAsNewFunc: () => mockContinue,
  workflowInfo: () => ({ continueAsNewSuggested: false, targetWorkerDeploymentVersionChanged: false }),
  patched: () => true,
  isCancellation: (error: unknown) => error === mockCancellation,
}));
jest.mock('../attention', () => ({
  ...jest.requireActual('../attention'),
  waitForAttentionResume: (...args: unknown[]) => mockWait(...args),
}));
import { ImageIngest, ImageDelete, ImageReceiptReconciliation, imageResume } from './index';
const ref = { projectId: 'unit-project', jobId: 'image' };
const attention = { schemaVersion: 1 as const, waiting: true as const, resumeRequested: false };
const paused = new Error('awaiting user');
const migrated = new Error('continue-as-new');
beforeEach(() => {
  jest.clearAllMocks();
  mockHandlers.clear();
  mockWait.mockRejectedValue(paused);
  mockContinue.mockRejectedValue(migrated);
});

test.each([ImageIngest, ImageDelete, ImageReceiptReconciliation])(
  '%p restores attention without provider calls or status rewrites',
  async (workflow) => {
    await expect(workflow(ref, attention)).rejects.toBe(paused);
    for (const activity of Object.values(mockActivities)) expect(activity).not.toHaveBeenCalled();
  }
);

test.each([ImageIngest, ImageDelete, ImageReceiptReconciliation])(
  '%p preserves the original job and an arriving genuine resume when rotating',
  async (workflow) => {
    mockWait.mockImplementation(async (resumed: () => boolean, rotate: () => Promise<never>) => {
      expect(resumed()).toBe(false);
      mockHandlers.get(imageResume)!();
      expect(resumed()).toBe(true);
      return rotate();
    });
    await expect(workflow(ref, attention)).rejects.toBe(migrated);
    expect(mockContinue).toHaveBeenCalledWith(ref, { ...attention, resumeRequested: true });
    for (const activity of Object.values(mockActivities)) expect(activity).not.toHaveBeenCalled();
  }
);

test('actual ingest resume reads durable disposition before attempting allocation', async () => {
  mockWait.mockResolvedValue(undefined);
  mockActivities.getImageDisposition.mockResolvedValue('retained');
  await ImageIngest(ref, { ...attention, resumeRequested: true });
  expect(mockActivities.getImageDisposition).toHaveBeenCalledWith(ref);
  expect(mockActivities.allocateImage).not.toHaveBeenCalled();
  expect(mockActivities.uploadImageBytes).not.toHaveBeenCalled();
  expect(mockActivities.finishImage).toHaveBeenCalledWith(ref, 'cancelled');
});

test('cancelled ingest attention cleans up before propagating cancellation', async () => {
  mockWait.mockRejectedValue(mockCancellation);
  await expect(ImageIngest(ref, attention)).rejects.toBe(mockCancellation);
  expect(mockActivities.cancelImage).toHaveBeenCalledWith(ref);
  expect(mockActivities.allocateImage).not.toHaveBeenCalled();
});

test('cancelled delete attention drains existing deletion and reports success', async () => {
  mockWait.mockRejectedValue(mockCancellation);
  await ImageDelete(ref, attention);
  expect(mockActivities.deleteImageProviders).toHaveBeenCalledWith(ref);
  expect(mockActivities.finishImage).toHaveBeenCalledWith(ref, 'succeeded');
});

test('cancelled receipt review preserves unresolved acknowledgement attention', async () => {
  mockWait.mockRejectedValue(mockCancellation);
  mockActivities.reconcileImageReceipt.mockResolvedValue('review');
  await ImageReceiptReconciliation(ref, attention);
  expect(mockActivities.reconcileImageReceipt).toHaveBeenCalledWith(ref);
  expect(mockActivities.finishImage).toHaveBeenCalledWith(ref, 'needs_attention', undefined);
  expect(mockActivities.allocateImage).not.toHaveBeenCalled();
});
