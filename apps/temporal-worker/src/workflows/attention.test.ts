const mockCondition = jest.fn();
const mockPatched = jest.fn();
const mockInfo = { targetWorkerDeploymentVersionChanged: false, continueAsNewSuggested: false };
jest.mock('@temporalio/workflow', () => ({
  condition: (...args: unknown[]) => mockCondition(...args),
  patched: (...args: unknown[]) => mockPatched(...args),
  workflowInfo: () => mockInfo,
}));
import { waitForAttentionResume } from './attention';

beforeEach(() => {
  mockCondition.mockReset();
  mockPatched.mockReset().mockReturnValue(true);
  mockInfo.targetWorkerDeploymentVersionChanged = false;
  mockInfo.continueAsNewSuggested = false;
});

test('sparse wake never fabricates resume or returns to provider work', async () => {
  let resumed = false;
  let checks = 0;
  mockCondition.mockImplementation(async (predicate: () => boolean, timeout: string) => {
    expect(timeout).toBe('5 minutes');
    expect(predicate()).toBe(false);
    checks++;
    if (checks === 3) resumed = true;
  });
  const rotate = jest.fn();
  await waitForAttentionResume(() => resumed, rotate);
  expect(checks).toBe(3);
  expect(rotate).not.toHaveBeenCalled();
});

test('native target change rotates even when a genuine resume arrives in the same activation', async () => {
  let resumed = false;
  const migration = new Error('continue-as-new command');
  const rotate = jest.fn(async (): Promise<never> => {
    throw migration;
  });
  mockCondition.mockImplementation(async () => {
    mockInfo.targetWorkerDeploymentVersionChanged = true;
    resumed = true;
  });
  await expect(waitForAttentionResume(() => resumed, rotate)).rejects.toBe(migration);
  expect(rotate).toHaveBeenCalledTimes(1);
  expect(resumed).toBe(true);
});

test('historical unmarked wait adds no timer and can observe native migration', async () => {
  mockPatched.mockReturnValue(false);
  const migration = new Error('continue-as-new command');
  const rotate = jest.fn(async (): Promise<never> => {
    throw migration;
  });
  mockCondition.mockImplementation(async (predicate: () => boolean) => {
    expect(mockCondition.mock.calls[0]).toHaveLength(1);
    expect(predicate()).toBe(false);
    mockInfo.targetWorkerDeploymentVersionChanged = true;
    expect(predicate()).toBe(true);
  });
  await expect(waitForAttentionResume(() => false, rotate)).rejects.toBe(migration);
  expect(rotate).toHaveBeenCalledTimes(1);
});

test('historical genuine resume retains its original no-timer command sequence', async () => {
  mockPatched.mockReturnValue(false);
  mockCondition.mockResolvedValue(undefined);
  const rotate = jest.fn();
  await waitForAttentionResume(() => true, rotate);
  expect(mockCondition.mock.calls[0]).toHaveLength(1);
  expect(rotate).not.toHaveBeenCalled();
});

test('history-pressure rotation preserves the paused state without scheduling effects', async () => {
  mockInfo.continueAsNewSuggested = true;
  const migration = new Error('continue-as-new command');
  const rotate = jest.fn(async (): Promise<never> => {
    throw migration;
  });
  await expect(waitForAttentionResume(() => false, rotate)).rejects.toBe(migration);
  expect(mockCondition).not.toHaveBeenCalled();
});

test('cancellation propagates rather than rotating or treating it as resume', async () => {
  const cancellation = new Error('workflow cancelled');
  mockCondition.mockRejectedValue(cancellation);
  const rotate = jest.fn();
  await expect(waitForAttentionResume(() => false, rotate)).rejects.toBe(cancellation);
  expect(rotate).not.toHaveBeenCalled();
});
