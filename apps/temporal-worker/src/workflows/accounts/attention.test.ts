class mockContinueAsNew extends Error {}
const mockCancellation = new Error('cancelled');
const mockActivities = {
  beginDurableJob: jest.fn(),
  finishDurableJob: jest.fn(),
  validateAccountOperation: jest.fn(),
  applyAccountClaims: jest.fn(),
  revokeAccountSessions: jest.fn(),
  createAccountSpeaker: jest.fn(),
  resolveAccountDocument: jest.fn(),
  notifyAccountOutcome: jest.fn(),
  reportAccountAttention: jest.fn(),
};
const mockWait = jest.fn();
const mockContinue = jest.fn();
const mockHandlers = new Map<unknown, () => unknown>();
jest.mock('@temporalio/workflow', () => ({
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: 1 },
  CancellationScope: { nonCancellable: (run: () => unknown) => run() },
  ContinueAsNew: mockContinueAsNew,
  defineSignal: (name: string) => name,
  defineQuery: (name: string) => name,
  setHandler: (name: unknown, handler: () => unknown) => mockHandlers.set(name, handler),
  proxyActivities: () => mockActivities,
  makeContinueAsNewFunc: () => mockContinue,
  isCancellation: (error: unknown) => error === mockCancellation,
}));
jest.mock('../attention', () => ({
  ...jest.requireActual('../attention'),
  waitForAttentionResume: (...args: unknown[]) => mockWait(...args),
}));
import { accountsWorkflow, accountResume, accountStatus } from './index';
const ref = { projectId: 'unit-project', jobId: 'account' };
const attention = {
  schemaVersion: 1 as const,
  waiting: true as const,
  resumeRequested: false,
  step: 'speaker' as const,
  status: { step: 'speaker', state: 'needs_review', receiptId: 'receipt-original' },
};
const migrated = new mockContinueAsNew();
beforeEach(() => {
  jest.clearAllMocks();
  mockHandlers.clear();
  for (const activity of Object.values(mockActivities)) activity.mockResolvedValue({ state: 'completed' });
  mockContinue.mockRejectedValue(migrated);
});

test('paused account rotates without changing attention or rerunning completed effects', async () => {
  mockWait.mockImplementation(async (resumed: () => boolean, rotate: () => Promise<never>) => {
    expect(resumed()).toBe(false);
    expect(mockHandlers.get(accountStatus)!()).toEqual(attention.status);
    return rotate();
  });
  await expect(accountsWorkflow(ref, attention)).rejects.toBe(migrated);
  expect(mockContinue).toHaveBeenCalledWith(ref, attention);
  for (const activity of Object.values(mockActivities)) expect(activity).not.toHaveBeenCalled();
});

test('pending genuine account resume survives rotation with original stage and receipt', async () => {
  mockWait.mockImplementation(async (_resumed: unknown, rotate: () => Promise<never>) => {
    mockHandlers.get(accountResume)!();
    return rotate();
  });
  await expect(accountsWorkflow(ref, attention)).rejects.toBe(migrated);
  expect(mockContinue).toHaveBeenCalledWith(ref, { ...attention, resumeRequested: true });
});

test('genuine resume retries only the current stage and then subsequent stages', async () => {
  mockWait.mockImplementation(async (resumed: () => boolean) => {
    expect(resumed()).toBe(true);
  });
  await expect(accountsWorkflow(ref, { ...attention, resumeRequested: true })).resolves.toEqual({ state: 'completed' });
  expect(mockActivities.beginDurableJob).not.toHaveBeenCalled();
  expect(mockActivities.validateAccountOperation).not.toHaveBeenCalled();
  expect(mockActivities.applyAccountClaims).not.toHaveBeenCalled();
  expect(mockActivities.revokeAccountSessions).not.toHaveBeenCalled();
  expect(mockActivities.createAccountSpeaker).toHaveBeenCalledTimes(1);
  expect(mockActivities.resolveAccountDocument).toHaveBeenCalledTimes(1);
  expect(mockActivities.notifyAccountOutcome).toHaveBeenCalledTimes(1);
  expect(mockActivities.finishDurableJob).toHaveBeenCalledWith(ref, 'succeeded');
});

test('account attention cancellation uses existing lifecycle finalization', async () => {
  mockWait.mockRejectedValue(mockCancellation);
  await expect(accountsWorkflow(ref, attention)).rejects.toBe(mockCancellation);
  expect(mockActivities.finishDurableJob).toHaveBeenCalledWith(ref, 'cancelled');
  expect(mockActivities.createAccountSpeaker).not.toHaveBeenCalled();
});

test.each([
  { ...attention, schemaVersion: 2 },
  { ...attention, resumeRequested: 'yes' },
  { ...attention, step: 'invented' },
  { ...attention, status: { step: 'speaker', state: 'completed' } },
  { ...attention, status: { step: 'claims', state: 'needs_review' } },
])('malformed account checkpoint cannot skip lifecycle or completed stages: %p', async (checkpoint) => {
  await expect(accountsWorkflow(ref, checkpoint as never)).rejects.toThrow('Invalid');
  for (const activity of Object.values(mockActivities)) expect(activity).not.toHaveBeenCalled();
  expect(mockWait).not.toHaveBeenCalled();
});
