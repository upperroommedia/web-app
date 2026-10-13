import { createLifecycleActivities } from '../activities/lifecycle';
import { CancelledFailure } from '@temporalio/common';
const ref = { projectId: 'test', jobId: 'job' };
function harness(kind = 'role.assign', state = 'queued') {
  const store = {
    loadJob: jest.fn().mockResolvedValue({ kind, state, revision: 2, startedAt: 100 }),
    assertCurrent: jest.fn(),
    project: jest.fn(),
  };
  return { store, activities: createLifecycleActivities(store as any) };
}
test('account effects atomically remove cancellation before starting', async () => {
  const { store, activities } = harness();
  await activities.beginDurableJob(ref);
  expect(store.project).toHaveBeenCalledWith(
    ref,
    expect.objectContaining({ expectedRevision: 2, state: 'running', actions: [], startedAt: 100 })
  );
});
test('a cancellation accepted before starting prevents irreversible effects', async () => {
  const { store, activities } = harness('role.assign', 'cancel_requested');
  await expect(activities.beginDurableJob(ref)).rejects.toBeInstanceOf(CancelledFailure);
  expect(store.assertCurrent).not.toHaveBeenCalled();
  expect(store.project).not.toHaveBeenCalled();
});
test('superseded jobs never restart or overwrite a terminal projection', async () => {
  const { store, activities } = harness('bundle.regenerate', 'superseded');
  await activities.beginDurableJob(ref);
  await activities.finishDurableJob(ref, 'succeeded');
  expect(store.project).not.toHaveBeenCalled();
});
test('reversible publishing retains confirmed cancellation controls', async () => {
  const { store, activities } = harness('sermon.publish');
  await activities.beginDurableJob(ref);
  expect(store.project).toHaveBeenCalledWith(ref, expect.objectContaining({ actions: ['cancel'] }));
});
test('continued cancellation cleanup stays in cancel phase without reopening actor effects', async () => {
  const { store, activities } = harness('sermon.publish', 'cancel_requested');
  store.loadJob.mockResolvedValue({
    kind: 'sermon.publish',
    state: 'cancel_requested',
    revision: 7,
    result: { resolutionPurpose: 'cleanup' },
    actions: ['resolve'],
  });
  await activities.beginDurableCleanup(ref);
  expect(store.assertCurrent).not.toHaveBeenCalled();
  expect(store.project).toHaveBeenCalledWith(ref, {
    expectedRevision: 7,
    state: 'cancel_requested',
    actions: ['resolve'],
  });
  store.loadJob.mockResolvedValue({ kind: 'sermon.publish', state: 'running', revision: 8 });
  await expect(activities.beginDurableCleanup(ref)).rejects.toMatchObject({ type: 'CLEANUP_INTENT_MISSING' });
});
test('critical repair begin requires fresh certificate authority and never offers ordinary cancellation', async () => {
  const { store } = harness('sermon.publish', 'cancel_requested');
  const authorize = jest.fn();
  const activities = createLifecycleActivities(store as any, { authorizeCriticalRepair: authorize });
  await activities.beginDurableCriticalRepair(ref, 'a'.repeat(64));
  expect(authorize).toHaveBeenCalledWith(ref, 'a'.repeat(64));
  expect(store.project).toHaveBeenCalledWith(ref, expect.objectContaining({ state: 'cancel_requested', actions: [] }));
  store.project.mockClear();
  authorize.mockRejectedValue(new Error('Admin revoked'));
  await expect(activities.beginDurableCriticalRepair(ref, 'a'.repeat(64))).rejects.toThrow('Admin revoked');
  expect(store.project).not.toHaveBeenCalled();
  await activities.reportDurableCriticalRepairFailure(ref);
  expect(store.project).toHaveBeenCalledWith(
    ref,
    expect.objectContaining({
      state: 'cancel_requested',
      actions: [],
      error: {
        code: 'CRITICAL_REPAIR_REVIEW_REQUIRED',
        message: 'Repair needs a current administrator approval.',
        retryable: false,
      },
    })
  );
});
