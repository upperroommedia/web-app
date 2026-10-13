import { beginClaimedPublishingStep } from './activity-step-start';
const ref = { projectId: 'test', jobId: 'job' },
  execution: any = {
    workflowId: 'workflow',
    runId: 'run',
    activityId: '1',
    activityType: 'updatePublishingMetadata',
    attempt: 1,
  };
function setup(steps: any[] = []) {
  const store: any = {
    assertCurrent: jest.fn(),
    loadJob: jest.fn().mockResolvedValue({ workflowId: 'workflow', steps }),
    recordStep: jest.fn(),
  };
  return store;
}
test('an initial empty job publishes its actual SDK-bound step before any source effect', async () => {
  const store = setup(),
    events: string[] = [];
  store.assertCurrent.mockImplementation(async () => {
    events.push('actor-and-epoch');
  });
  store.recordStep.mockImplementation(async (_ref: any, step: any) => {
    events.push('public-step');
    expect(step).toEqual({
      id: 'projection',
      label: 'Update details',
      state: 'running',
      attempt: 1,
      startedAt: 100,
      finishedAt: undefined,
      error: undefined,
      nextRetryAt: undefined,
    });
  });
  await beginClaimedPublishingStep(
    store,
    ref,
    { id: 'projection', label: 'Update details' },
    execution,
    ['projection'],
    100
  );
  events.push('source-registration');
  expect(events).toEqual(['actor-and-epoch', 'public-step', 'source-registration']);
});
test('a client-selected or foreign-workflow step never acquires observable source authority', async () => {
  const store = setup();
  await expect(
    beginClaimedPublishingStep(store, ref, { id: 'cleanup', label: 'Injected' }, execution, ['projection'])
  ).rejects.toMatchObject({ type: 'EXECUTION_IDENTITY_MISSING' });
  expect(store.recordStep).not.toHaveBeenCalled();
  store.loadJob.mockResolvedValue({ workflowId: 'other', steps: [] });
  await expect(
    beginClaimedPublishingStep(store, ref, { id: 'projection', label: 'Update' }, execution, ['projection'])
  ).rejects.toMatchObject({ type: 'EXECUTION_OWNER_MISMATCH' });
  expect(store.recordStep).not.toHaveBeenCalled();
});
test('revoked actor or stale epoch rejects the step before source registration', async () => {
  const store = setup();
  store.assertCurrent.mockRejectedValue(Object.assign(new Error('Revoked'), { code: 'PERMISSION_CHANGED' }));
  await expect(
    beginClaimedPublishingStep(store, ref, { id: 'projection', label: 'Update' }, execution, ['projection'])
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  expect(store.loadJob).not.toHaveBeenCalled();
  expect(store.recordStep).not.toHaveBeenCalled();
});
test('retries start truthfully while previously proved completion stays intact', async () => {
  const store = setup([
    { id: 'projection', label: 'Update', state: 'retrying', startedAt: 50, error: { code: 'OLD' }, nextRetryAt: 100 },
  ]);
  await beginClaimedPublishingStep(store, ref, { id: 'projection', label: 'Update' }, execution, ['projection'], 200);
  expect(store.recordStep).toHaveBeenCalledWith(
    ref,
    expect.objectContaining({ state: 'running', startedAt: 50, error: undefined, nextRetryAt: undefined })
  );
  store.recordStep.mockClear();
  store.loadJob.mockResolvedValue({ workflowId: 'workflow', steps: [{ id: 'projection', state: 'succeeded' }] });
  await beginClaimedPublishingStep(store, ref, { id: 'projection', label: 'Update' }, execution, ['projection'], 300);
  expect(store.recordStep).not.toHaveBeenCalled();
});
