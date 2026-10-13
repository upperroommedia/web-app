import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import type { WorkflowHandle } from '@temporalio/client';
import { emailDeliveryWorkflow, emailResume, emailStatus } from './index';
const ref = { jobId: 'email-test', projectId: 'test-project' };
const queue = 'urm-email';
function activities() {
  return {
    deliverEmail: jest.fn().mockResolvedValue('confirmed'),
    exhaustEmailRetries: jest.fn().mockResolvedValue(undefined),
    getEmailReceiptState: jest.fn().mockResolvedValue('confirmed'),
  };
}
async function waitFor(handle: WorkflowHandle, expected: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const state = await handle.query(emailStatus);
    if (state.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Email workflow did not reach ${expected}`);
}
describe('native email workflow', () => {
  let environment: TestWorkflowEnvironment;
  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120000);
  afterAll(async () => {
    await environment?.teardown();
  });
  test('safe pre-submission failure retries on durable timers and history replays', async () => {
    const mocks = activities();
    mocks.deliverEmail.mockResolvedValueOnce('safe_retry').mockResolvedValue('confirmed');
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('./index'),
      activities: mocks,
    });
    const controlsWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-controls',
      activities: { getEmailReceiptState: mocks.getEmailReceiptState, exhaustEmailRetries: mocks.exhaustEmailRetries },
    });
    await worker.runUntil(() =>
      controlsWorker.runUntil(async () => {
        const handle = await environment.client.workflow.start(emailDeliveryWorkflow, {
          workflowId: 'email-safe-retry',
          taskQueue: queue,
          args: [ref],
        });
        await handle.result();
        expect(mocks.deliverEmail).toHaveBeenCalledTimes(2);
        const history = await handle.fetchHistory();
        expect(history.events?.some((event) => event.timerStartedEventAttributes)).toBe(true);
        await Worker.runReplayHistory({ workflowsPath: require.resolve('./index') }, history);
      })
    );
  }, 120000);
  test('uncertain acceptance waits for operator reconciliation without automatic resend', async () => {
    const mocks = activities();
    mocks.deliverEmail.mockResolvedValueOnce('unknown').mockResolvedValue('confirmed');
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('./index'),
      activities: mocks,
    });
    const controlsWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-controls',
      activities: { getEmailReceiptState: mocks.getEmailReceiptState, exhaustEmailRetries: mocks.exhaustEmailRetries },
    });
    await worker.runUntil(() =>
      controlsWorker.runUntil(async () => {
        const handle = await environment.client.workflow.start(emailDeliveryWorkflow, {
          workflowId: 'email-unknown',
          taskQueue: queue,
          args: [ref],
        });
        await waitFor(handle, 'unknown');
        await environment.sleep('1 hour');
        expect(mocks.deliverEmail).toHaveBeenCalledTimes(1);
        const history = await handle.fetchHistory();
        await Worker.runReplayHistory({ workflowsPath: require.resolve('./index') }, history);
        await handle.signal(emailResume);
        await handle.result();
        expect(mocks.getEmailReceiptState).toHaveBeenCalledWith(ref);
      })
    );
  }, 120000);
  test('reviewed failure closes the old job through its delivery projection', async () => {
    const mocks = activities();
    mocks.deliverEmail.mockResolvedValueOnce('partial').mockResolvedValue('rejected');
    mocks.getEmailReceiptState.mockResolvedValue('rejected');
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('./index'),
      activities: mocks,
    });
    const controlsWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-controls',
      activities: { getEmailReceiptState: mocks.getEmailReceiptState, exhaustEmailRetries: mocks.exhaustEmailRetries },
    });
    await worker.runUntil(() =>
      controlsWorker.runUntil(async () => {
        const handle = await environment.client.workflow.start(emailDeliveryWorkflow, {
          workflowId: 'email-reviewed-close',
          taskQueue: queue,
          args: [ref],
        });
        await waitFor(handle, 'partial');
        await handle.signal(emailResume);
        await handle.result();
        expect(mocks.deliverEmail).toHaveBeenCalledTimes(1);
      })
    );
  }, 120000);
  test('retry budget exhaustion exposes recoverable attention then resumes after provider repair', async () => {
    const mocks = activities();
    mocks.deliverEmail.mockResolvedValue('safe_retry');
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('./index'),
      activities: mocks,
    });
    const controlsWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-controls',
      activities: { getEmailReceiptState: mocks.getEmailReceiptState, exhaustEmailRetries: mocks.exhaustEmailRetries },
    });
    await worker.runUntil(() =>
      controlsWorker.runUntil(async () => {
        const handle = await environment.client.workflow.start(emailDeliveryWorkflow, {
          workflowId: 'email-budget',
          taskQueue: queue,
          args: [ref],
        });
        await environment.sleep('2 hours');
        await waitFor(handle, 'needs_attention');
        expect(mocks.deliverEmail).toHaveBeenCalledTimes(12);
        expect(mocks.exhaustEmailRetries).toHaveBeenCalledWith(ref);
        mocks.deliverEmail.mockResolvedValue('confirmed');
        mocks.getEmailReceiptState.mockResolvedValue('prepared');
        await handle.signal(emailResume);
        await handle.result();
      })
    );
  }, 120000);
  test('sanitized storage infrastructure failures remain durable until storage recovers', async () => {
    const mocks = activities();
    mocks.deliverEmail.mockRejectedValueOnce(
      ApplicationFailure.retryable('Email storage is temporarily unavailable', 'EMAIL_STORAGE')
    );
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('./index'),
      activities: mocks,
    });
    const controlsWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-controls',
      activities: { getEmailReceiptState: mocks.getEmailReceiptState, exhaustEmailRetries: mocks.exhaustEmailRetries },
    });
    await worker.runUntil(() =>
      controlsWorker.runUntil(async () => {
        await environment.client.workflow.execute(emailDeliveryWorkflow, {
          workflowId: 'email-storage-recovery',
          taskQueue: queue,
          args: [ref],
        });
        expect(mocks.deliverEmail).toHaveBeenCalledTimes(2);
      })
    );
  }, 120000);
  test('review finalization stays responsive while the only SMTP activity slot is occupied', async () => {
    const mocks = activities();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.deliverEmail.mockImplementation(async (input: any) => {
      if (input.jobId === 'blocked-email') {
        entered();
        await gate;
        return 'confirmed';
      }
      return 'unknown';
    });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('./index'),
      activities: { deliverEmail: mocks.deliverEmail },
      maxConcurrentActivityTaskExecutions: 1,
    });
    const controlsWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-controls',
      activities: { getEmailReceiptState: mocks.getEmailReceiptState, exhaustEmailRetries: mocks.exhaustEmailRetries },
    });
    await worker.runUntil(() =>
      controlsWorker.runUntil(async () => {
        const review = await environment.client.workflow.start(emailDeliveryWorkflow, {
          workflowId: 'email-controls-review',
          taskQueue: queue,
          args: [ref],
        });
        await waitFor(review, 'unknown');
        const blocked = await environment.client.workflow.start(emailDeliveryWorkflow, {
          workflowId: 'email-controls-blocked',
          taskQueue: queue,
          args: [{ ...ref, jobId: 'blocked-email' }],
        });
        try {
          await started;
          await review.signal(emailResume);
          await review.result();
          expect(mocks.getEmailReceiptState).toHaveBeenCalledWith(ref);
          expect(mocks.deliverEmail).toHaveBeenCalledTimes(2);
        } finally {
          release();
        }
        await blocked.result();
      })
    );
  }, 120000);
  test('validated cancellation wakes a provider retry timer immediately', async () => {
    const mocks = activities();
    mocks.deliverEmail.mockResolvedValueOnce('safe_retry').mockResolvedValue('cancelled');
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('./index'),
      activities: { deliverEmail: mocks.deliverEmail },
    });
    const controlsWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-controls',
      activities: { getEmailReceiptState: mocks.getEmailReceiptState, exhaustEmailRetries: mocks.exhaustEmailRetries },
    });
    await worker.runUntil(() =>
      controlsWorker.runUntil(async () => {
        const handle = await environment.client.workflow.start(emailDeliveryWorkflow, {
          workflowId: 'email-cancel-timer',
          taskQueue: queue,
          args: [ref],
        });
        await waitFor(handle, 'safe_retry');
        await handle.signal(emailResume);
        await handle.result();
        const history = await handle.fetchHistory();
        expect(history.events?.some((event) => event.timerCanceledEventAttributes)).toBe(true);
        expect(mocks.deliverEmail).toHaveBeenCalledTimes(2);
      })
    );
  }, 120000);
});
