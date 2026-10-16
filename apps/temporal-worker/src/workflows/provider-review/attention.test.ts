const mockReview = jest.fn();
const mockCondition = jest.fn();
const mockContinue = jest.fn();
const mockPatched = jest.fn();
const mockInfo = { targetWorkerDeploymentVersionChanged: false, continueAsNewSuggested: false };
let mockResume: () => void;
jest.mock('@temporalio/workflow', () => ({
  CancellationScope: { nonCancellable: (run: () => unknown) => run() },
  defineSignal: (name: string) => name,
  setHandler: (_name: unknown, handler: () => void) => {
    mockResume = handler;
  },
  proxyActivities: () => ({ reviewProviderOrphanAcknowledgement: (...args: unknown[]) => mockReview(...args) }),
  patched: (...args: unknown[]) => mockPatched(...args),
  workflowInfo: () => mockInfo,
  condition: (...args: unknown[]) => mockCondition(...args),
  makeContinueAsNewFunc: (options: unknown) => {
    expect(options).toEqual({ initialVersioningBehavior: 'AUTO_UPGRADE' });
    return mockContinue;
  },
}));
import { ProviderOrphanReview } from './index';
const ref = { projectId: 'unit-project', jobId: 'orphan' };
const stopped = new Error('test stops paused workflow');
const migrated = new Error('continue-as-new');
beforeEach(() => {
  jest.clearAllMocks();
  mockInfo.targetWorkerDeploymentVersionChanged = false;
  mockInfo.continueAsNewSuggested = false;
  mockPatched.mockReturnValue(true);
  mockReview.mockResolvedValue('pending');
  mockContinue.mockRejectedValue(migrated);
});

test('five-minute metadata wakes do not accelerate daily receipt reconciliation', async () => {
  let wakes = 0;
  mockCondition.mockImplementation(async (_predicate: unknown, timeout: number) => {
    expect(timeout).toBeLessThanOrEqual(5 * 60 * 1000);
    if (++wakes === 3) throw stopped;
  });
  await expect(ProviderOrphanReview(ref)).rejects.toBe(stopped);
  expect(mockReview).toHaveBeenCalledTimes(1);
  expect(mockContinue).not.toHaveBeenCalled();
});

test('rotation carries original review deadline and genuine signal without a second receipt read', async () => {
  const nextReviewAt = Date.now() + 24 * 60 * 60 * 1000;
  mockCondition.mockImplementation(async () => {
    mockInfo.targetWorkerDeploymentVersionChanged = true;
  });
  await expect(ProviderOrphanReview(ref, { schemaVersion: 1, resumeRequested: false, nextReviewAt })).rejects.toBe(
    migrated
  );
  expect(mockReview).not.toHaveBeenCalled();
  expect(mockContinue).toHaveBeenCalledWith(ref, { schemaVersion: 1, resumeRequested: false, nextReviewAt });
});

test('restored genuine signal permits the existing receipt reconciliation', async () => {
  mockReview.mockResolvedValue('complete');
  await ProviderOrphanReview(ref, { schemaVersion: 1, resumeRequested: true, nextReviewAt: Date.now() + 86_400_000 });
  expect(mockReview).toHaveBeenCalledWith(ref);
  expect(mockCondition).not.toHaveBeenCalled();
});

test('a real signal arriving during the metadata wait permits reconciliation without fake resume', async () => {
  mockReview.mockResolvedValueOnce('pending').mockResolvedValue('complete');
  mockCondition.mockImplementation(async () => {
    mockResume();
  });
  await ProviderOrphanReview(ref);
  expect(mockReview).toHaveBeenCalledTimes(2);
  expect(mockContinue).not.toHaveBeenCalled();
});

test('pre-migration history retains the original daily timer shape', async () => {
  mockPatched.mockReturnValue(false);
  mockCondition.mockImplementation(async (_predicate: unknown, timeout: string) => {
    expect(timeout).toBe('1 day');
    throw stopped;
  });
  await expect(ProviderOrphanReview(ref)).rejects.toBe(stopped);
  expect(mockReview).toHaveBeenCalledTimes(1);
  expect(mockContinue).not.toHaveBeenCalled();
});
