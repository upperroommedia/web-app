const mockActivities = { deliverEmail: jest.fn(), getEmailReceiptState: jest.fn(), exhaustEmailRetries: jest.fn() };
const mockWait = jest.fn();
const mockContinue = jest.fn();
const mockMakeContinue = jest.fn((_options: unknown) => mockContinue);
const mockHandlers = new Map<unknown, () => unknown>();
jest.mock('@temporalio/workflow', () => ({
  defineSignal: (name: string) => name,
  defineQuery: (name: string) => name,
  setHandler: (name: unknown, handler: () => unknown) => mockHandlers.set(name, handler),
  proxyActivities: () => mockActivities,
  makeContinueAsNewFunc: (options: unknown) => mockMakeContinue(options),
  condition: jest.fn(),
}));
jest.mock('../attention', () => ({
  ...jest.requireActual('../attention'),
  waitForAttentionResume: (...args: unknown[]) => mockWait(...args),
}));
import { emailDeliveryWorkflow, emailResume, emailStatus } from './index';
const ref = { projectId: 'unit-project', jobId: 'email' };
const attention = {
  schemaVersion: 1 as const,
  waiting: true as const,
  resumeRequested: false,
  safeAttempts: 12,
  status: { state: 'needs_attention', attempt: 12 },
};
const paused = new Error('still awaiting user');
const migrated = new Error('continue-as-new');
beforeEach(() => {
  jest.clearAllMocks();
  mockHandlers.clear();
  mockContinue.mockRejectedValue(migrated);
  mockWait.mockRejectedValue(paused);
});

test('restored uncertain email neither reads the receipt nor sends before actual resume', async () => {
  await expect(emailDeliveryWorkflow(ref, attention)).rejects.toBe(paused);
  expect(mockHandlers.get(emailStatus)!()).toEqual(attention.status);
  expect(mockActivities.deliverEmail).not.toHaveBeenCalled();
  expect(mockActivities.getEmailReceiptState).not.toHaveBeenCalled();
  expect(mockActivities.exhaustEmailRetries).not.toHaveBeenCalled();
});

test('rotation preserves exhausted retry budget and genuine signal without resending', async () => {
  mockWait.mockImplementation(async (resumed: () => boolean, rotate: () => Promise<never>) => {
    expect(resumed()).toBe(false);
    mockHandlers.get(emailResume)!();
    expect(resumed()).toBe(true);
    return rotate();
  });
  await expect(emailDeliveryWorkflow(ref, attention)).rejects.toBe(migrated);
  expect(mockMakeContinue).toHaveBeenCalledWith({ initialVersioningBehavior: 'AUTO_UPGRADE' });
  expect(mockContinue).toHaveBeenCalledWith(ref, { ...attention, resumeRequested: true });
  expect(mockActivities.deliverEmail).not.toHaveBeenCalled();
});

test('a genuine resume of an already confirmed receipt closes without another send', async () => {
  mockWait.mockResolvedValue(undefined);
  mockActivities.getEmailReceiptState.mockResolvedValue('confirmed');
  await emailDeliveryWorkflow(ref, { ...attention, resumeRequested: true });
  expect(mockActivities.getEmailReceiptState).toHaveBeenCalledWith(ref);
  expect(mockActivities.deliverEmail).not.toHaveBeenCalled();
});

test('a genuine resume with prepared receipt resets the preserved budget before delivery', async () => {
  mockWait.mockResolvedValue(undefined);
  mockActivities.getEmailReceiptState.mockResolvedValue('prepared');
  mockActivities.deliverEmail.mockResolvedValue('confirmed');
  await emailDeliveryWorkflow(ref, { ...attention, resumeRequested: true });
  expect(mockActivities.getEmailReceiptState.mock.invocationCallOrder[0]).toBeLessThan(
    mockActivities.deliverEmail.mock.invocationCallOrder[0]
  );
  expect(mockActivities.deliverEmail).toHaveBeenCalledTimes(1);
  expect(mockHandlers.get(emailStatus)!()).toEqual({ state: 'confirmed', attempt: 1 });
});
