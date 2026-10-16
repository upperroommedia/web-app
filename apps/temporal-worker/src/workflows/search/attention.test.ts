const mockActivities = {
  syncSearchDocument: jest.fn(),
  searchBackfillPage: jest.fn(),
  confirmSearchPage: jest.fn(),
  finishSearch: jest.fn(),
  finishSearchBackfill: jest.fn(),
};
const mockCancellation = new Error('cancelled during attention');
const mockWait = jest.fn();
const mockContinue = jest.fn();
const mockMakeContinue = jest.fn((_options: unknown) => mockContinue);
const mockHandlers = new Map<unknown, () => void>();
jest.mock('@temporalio/workflow', () => ({
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: 1 },
  CancellationScope: { nonCancellable: (run: () => unknown) => run() },
  defineSignal: (name: string) => name,
  setHandler: (name: unknown, handler: () => void) => mockHandlers.set(name, handler),
  proxyActivities: () => mockActivities,
  makeContinueAsNewFunc: (options: unknown) => mockMakeContinue(options),
  workflowInfo: () => ({ continueAsNewSuggested: false }),
  isCancellation: (error: unknown) => error === mockCancellation,
}));
jest.mock('../attention', () => ({
  ...jest.requireActual('../attention'),
  waitForAttentionResume: (...args: unknown[]) => mockWait(...args),
}));
import { SearchDocument, SearchBackfill, searchResume } from './index';
const ref = { projectId: 'unit-project', jobId: 'unit-job' };
const paused = new Error('still awaiting user');
const migrated = new Error('continue-as-new');
beforeEach(() => {
  jest.clearAllMocks();
  mockHandlers.clear();
  mockContinue.mockRejectedValue(migrated);
  mockWait.mockRejectedValue(paused);
});

test('restored document attention does not retry indexing before a genuine resume', async () => {
  await expect(SearchDocument(ref, { schemaVersion: 1, waiting: true, resumeRequested: false })).rejects.toBe(paused);
  expect(mockActivities.syncSearchDocument).not.toHaveBeenCalled();
  expect(mockActivities.finishSearch).not.toHaveBeenCalled();
});

test('document rotation carries a concurrently received genuine resume', async () => {
  mockWait.mockImplementation(async (resumed: () => boolean, rotate: () => Promise<never>) => {
    expect(resumed()).toBe(false);
    mockHandlers.get(searchResume)!();
    expect(resumed()).toBe(true);
    return rotate();
  });
  await expect(SearchDocument(ref, { schemaVersion: 1, waiting: true, resumeRequested: false })).rejects.toBe(migrated);
  expect(mockMakeContinue).toHaveBeenCalledWith({ initialVersioningBehavior: 'AUTO_UPGRADE' });
  expect(mockContinue).toHaveBeenCalledWith(ref, { schemaVersion: 1, waiting: true, resumeRequested: true });
  expect(mockActivities.syncSearchDocument).not.toHaveBeenCalled();
});

test('backfill rotates with the confirmed cursor/count while staying paused', async () => {
  mockWait.mockImplementation(async (_resumed: unknown, rotate: () => Promise<never>) => rotate());
  await expect(
    SearchBackfill({
      ref,
      cursor: 'confirmed-page',
      count: 17,
      attention: { schemaVersion: 1, waiting: true, resumeRequested: false },
    })
  ).rejects.toBe(migrated);
  expect(mockContinue).toHaveBeenCalledWith({
    ref,
    cursor: 'confirmed-page',
    count: 17,
    attention: { schemaVersion: 1, waiting: true, resumeRequested: false },
  });
  expect(mockActivities.searchBackfillPage).not.toHaveBeenCalled();
  expect(mockActivities.finishSearchBackfill).not.toHaveBeenCalled();
});

test('resumed backfill uses its saved cursor and accumulates the existing count', async () => {
  mockWait.mockResolvedValue(undefined);
  mockActivities.searchBackfillPage.mockResolvedValue({ jobs: [ref], complete: true });
  mockActivities.confirmSearchPage.mockResolvedValue(true);
  await SearchBackfill({
    ref,
    cursor: 'confirmed-page',
    count: 17,
    attention: { schemaVersion: 1, waiting: true, resumeRequested: true },
  });
  expect(mockActivities.searchBackfillPage).toHaveBeenCalledWith(ref, 'confirmed-page');
  expect(mockActivities.finishSearchBackfill).toHaveBeenCalledWith(ref, 18);
});

test.each([false, true])('document attention cancellation finalizes cancelled (restored=%s)', async (restored) => {
  mockWait.mockRejectedValue(mockCancellation);
  mockActivities.syncSearchDocument.mockRejectedValue(new Error('provider exhausted'));
  await expect(
    SearchDocument(ref, restored ? { schemaVersion: 1, waiting: true, resumeRequested: false } : undefined)
  ).rejects.toBe(mockCancellation);
  expect(mockActivities.finishSearch).toHaveBeenLastCalledWith(ref, 'cancelled');
  expect(mockActivities.syncSearchDocument).toHaveBeenCalledTimes(restored ? 0 : 1);
});

test('backfill attention cancellation retains cursor and finalizes cancelled without another page', async () => {
  mockWait.mockRejectedValue(mockCancellation);
  await expect(
    SearchBackfill({
      ref,
      cursor: 'confirmed',
      count: 17,
      attention: { schemaVersion: 1, waiting: true, resumeRequested: false },
    })
  ).rejects.toBe(mockCancellation);
  expect(mockActivities.finishSearch).toHaveBeenCalledWith(ref, 'cancelled');
  expect(mockActivities.searchBackfillPage).not.toHaveBeenCalled();
});

test.each([
  { schemaVersion: 2, waiting: true, resumeRequested: false },
  { schemaVersion: 1, waiting: false, resumeRequested: false },
  { schemaVersion: 1, waiting: true, resumeRequested: 'true' },
])('malformed search attention never skips into effects: %p', async (attention) => {
  await expect(SearchDocument(ref, attention as never)).rejects.toThrow('Invalid attention continuation');
  expect(mockActivities.syncSearchDocument).not.toHaveBeenCalled();
  expect(mockWait).not.toHaveBeenCalled();
});
