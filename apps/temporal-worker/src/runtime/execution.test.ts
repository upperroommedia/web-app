import { ActivityExecutionContext } from './execution';
const mockInfo: any = {
  workflowExecution: { workflowId: 'wf-test-job', runId: 'run-1' },
  activityId: '12',
  activityType: 'applyAccountClaims',
  scheduledTimestampMs: 1000,
  attempt: 1,
};
jest.mock('@temporalio/activity', () => ({
  Context: { current: () => ({ info: mockInfo, cancellationSignal: { aborted: false } }) },
}));
const ref = { projectId: 'test', jobId: 'job' };
function setup(workflowId = 'wf-test-job') {
  const describe = jest
    .fn()
    .mockResolvedValue({ raw: { workflowExecutionInfo: { startTime: { seconds: '1760000000', nanos: 999999999 } } } });
  const client: any = {
    workflow: { getHandle: () => ({ describe }) },
    connection: { withDeadline: (_deadline: any, run: any) => run() },
  };
  const store: any = {
    loadJob: jest.fn().mockResolvedValue({ workflowId }),
    registerActivityExecution: jest.fn(),
    recordActivityExecutionDrained: jest.fn(),
  };
  const context = new ActivityExecutionContext(client);
  context.bindStore(store);
  return { context, store, describe };
}
test('registers exact authoritative metadata before effects and scopes it privately', async () => {
  const { context, store, describe } = setup();
  await context.run('applyAccountClaims', [ref], ['claims'], async () => {
    expect(store.registerActivityExecution).toHaveBeenCalled();
    expect(context.current()?.runStartedAtNanos).toBe('1760000000999999999');
  });
  expect(context.current()).toBeUndefined();
  await context.run('applyAccountClaims', [ref], ['claims'], async () => {});
  expect(describe).toHaveBeenCalledTimes(1);
});
test('another workflow cannot claim a job epoch or execute its effects', async () => {
  const { context, store } = setup('another-workflow');
  const effect = jest.fn();
  await expect(context.run('applyAccountClaims', [ref], ['claims'], effect)).rejects.toMatchObject({
    type: 'EXECUTION_OWNER_MISMATCH',
    nonRetryable: true,
  });
  expect(effect).not.toHaveBeenCalled();
  expect(store.registerActivityExecution).not.toHaveBeenCalled();
});
test('child media observers inspect exact references without stealing coordinator epoch', async () => {
  const { context, store } = setup('audio-coordinator');
  await context.run('readMediaCompletion', [ref], ['completion'], async () => {
    expect(context.current()).toBeUndefined();
  });
  expect(store.registerActivityExecution).not.toHaveBeenCalled();
});
test('metadata lookup failure remains sanitized and does not start provider effects', async () => {
  const { context, describe } = setup();
  describe.mockRejectedValue(new Error('secret credential'));
  const effect = jest.fn();
  await expect(context.run('applyAccountClaims', [ref], ['claims'], effect)).rejects.toMatchObject({
    type: 'EXECUTION_METADATA_UNAVAILABLE',
    message: 'Execution metadata is temporarily unavailable',
  });
  expect(effect).not.toHaveBeenCalled();
});

test('drain witness follows settlement on both success and provider rejection', async () => {
  const { context, store } = setup();
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const running = context.run('applyAccountClaims', [ref], ['claims'], () => pending);
  await new Promise((resolve) => setImmediate(resolve));
  expect(store.recordActivityExecutionDrained).not.toHaveBeenCalled();
  settle();
  await running;
  expect(store.recordActivityExecutionDrained).toHaveBeenCalledTimes(1);
  await expect(
    context.run('applyAccountClaims', [ref], ['claims'], async () => {
      throw new Error('private provider error');
    })
  ).rejects.toMatchObject({ type: 'EXECUTION_METADATA_UNAVAILABLE' });
  expect(store.recordActivityExecutionDrained).toHaveBeenCalledTimes(2);
});

test('certified repair claims affected parent steps before canonical work and restores its outer scope', async () => {
  const { context, store } = setup();
  const previous = mockInfo.activityType;
  mockInfo.activityType = 'repairPublishingCritical';
  try {
    await context.run('repairPublishingCritical', [ref], ['cleanup'], async () => {
      await context.withRepairSteps(ref, ['projection', 'lists', 'projection'], async () => {
        expect(context.currentStepIds()).toEqual(['cleanup', 'projection', 'lists']);
        expect(store.registerActivityExecution).toHaveBeenLastCalledWith(
          ref,
          expect.objectContaining({ activityType: 'repairPublishingCritical' }),
          { stepIds: ['cleanup', 'projection', 'lists'], countsAttempt: false }
        );
      });
      expect(context.currentStepIds()).toEqual(['cleanup']);
    });
    expect(context.currentStepIds()).toEqual([]);
  } finally {
    mockInfo.activityType = previous;
  }
});

test('ordinary activities cannot transfer repair authority and failed epoch claims run no repair', async () => {
  const { context, store } = setup();
  const repair = jest.fn();
  await context.run('applyAccountClaims', [ref], ['claims'], async () => {
    await expect(context.withRepairSteps(ref, ['projection'], repair)).rejects.toMatchObject({
      type: 'PERMISSION_CHANGED',
    });
  });
  expect(repair).not.toHaveBeenCalled();
  const previous = mockInfo.activityType;
  mockInfo.activityType = 'repairPublishingCritical';
  try {
    await context.run('repairPublishingCritical', [ref], ['cleanup'], async () => {
      store.registerActivityExecution.mockRejectedValueOnce(
        Object.assign(new Error('old epoch'), { code: 'STALE_EXECUTION' })
      );
      await expect(context.withRepairSteps(ref, ['projection'], repair)).rejects.toMatchObject({
        code: 'STALE_EXECUTION',
      });
    });
    expect(repair).not.toHaveBeenCalled();
  } finally {
    mockInfo.activityType = previous;
  }
});

test('private review metadata does not inflate destination attempt counts', async () => {
  const { context, store } = setup();
  await context.run('savePublishingCreateReviewCheckpoint', [ref], ['review'], async () => {});
  expect(store.registerActivityExecution).toHaveBeenLastCalledWith(ref, expect.anything(), {
    stepIds: ['review'],
    countsAttempt: false,
  });
});

test('repair step union stays within the public parent job bound before claiming epochs', async () => {
  const { context, store } = setup(),
    previous = mockInfo.activityType;
  mockInfo.activityType = 'repairPublishingCritical';
  try {
    await context.run('repairPublishingCritical', [ref], ['cleanup'], async () => {
      const effect = jest.fn(),
        sourceSteps = Array.from({ length: 32 }, (_, index) => `stage-${index}`);
      await expect(context.withRepairSteps(ref, sourceSteps, effect)).rejects.toMatchObject({
        type: 'PERMISSION_CHANGED',
      });
      expect(effect).not.toHaveBeenCalled();
      expect(store.registerActivityExecution).toHaveBeenCalledTimes(1);
    });
  } finally {
    mockInfo.activityType = previous;
  }
});
