import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { Context, heartbeat } from '@temporalio/activity';
import { ImageIngest, ImageReceiptReconciliation, imageResume } from './index';
const ref = { projectId: 'test-project', jobId: 'image-test' };
const queue = 'image-native-tests';
function mocks() {
  return {
    getImageDisposition: jest.fn<Promise<'continue' | 'retained' | 'additional_review'>, []>(async () => 'continue'),
    prepareImage: jest.fn(async () => undefined),
    allocateImage: jest.fn(async () => undefined),
    uploadImageBytes: jest.fn(async () => undefined),
    commitImage: jest.fn(async () => undefined),
    finishImage: jest.fn(async () => undefined),
    cancelImage: jest.fn(async () => undefined),
    supersedeImage: jest.fn(async () => undefined),
    reconcileImageReceipt: jest.fn(async () => 'complete'),
  };
}
async function until(check: () => boolean) {
  for (let count = 0; count < 200; count++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Workflow did not reach the expected phase');
}
describe('native image workflow', () => {
  let environment: TestWorkflowEnvironment;
  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120000);
  afterAll(async () => {
    await environment?.teardown();
  });
  test('unknown allocation never uploads or publishes before explicit review and history replays', async () => {
    const activities = mocks();
    activities.allocateImage.mockRejectedValueOnce(
      ApplicationFailure.nonRetryable('Unknown allocation', 'ImageAllocationAmbiguous')
    );
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('./index'),
      activities,
    });
    const controls = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-controls',
      workflowsPath: require.resolve('./index'),
      activities,
    });
    await controls.runUntil(() =>
      worker.runUntil(async () => {
        const handle = await environment.client.workflow.start(ImageIngest, {
          workflowId: 'image-unknown-allocation',
          taskQueue: queue,
          args: [ref],
        });
        await until(() => activities.finishImage.mock.calls.length > 0);
        await environment.sleep('1 hour');
        expect(activities.allocateImage).toHaveBeenCalledTimes(1);
        expect(activities.uploadImageBytes).not.toHaveBeenCalled();
        expect(activities.commitImage).not.toHaveBeenCalled();
        activities.getImageDisposition.mockResolvedValue('retained');
        await handle.signal(imageResume);
        await handle.result();
        expect(activities.allocateImage).toHaveBeenCalledTimes(1);
        expect(activities.uploadImageBytes).not.toHaveBeenCalled();
        expect(activities.commitImage).not.toHaveBeenCalled();
        expect(activities.finishImage).toHaveBeenLastCalledWith(ref, 'cancelled');
        await Worker.runReplayHistory({ workflowsPath: require.resolve('./index') }, await handle.fetchHistory());
      })
    );
  }, 120000);
  test('a separately acknowledged original allocation remains open until its child review settles', async () => {
    const activities = mocks();
    activities.getImageDisposition.mockResolvedValue('additional_review');
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('./index'),
      activities,
    });
    const controls = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-controls',
      workflowsPath: require.resolve('./index'),
      activities,
    });
    await controls.runUntil(() =>
      worker.runUntil(async () => {
        const handle = await environment.client.workflow.start(ImageIngest, {
          workflowId: 'image-original-ack-review',
          taskQueue: queue,
          args: [ref],
        });
        await until(() => activities.finishImage.mock.calls.length > 0);
        expect(activities.finishImage).toHaveBeenLastCalledWith(
          ref,
          'needs_attention',
          'ImageAdditionalAllocationReview'
        );
        expect((await handle.describe()).status.name).toBe('RUNNING');
        expect(activities.allocateImage).not.toHaveBeenCalled();
        expect(activities.uploadImageBytes).not.toHaveBeenCalled();
        activities.getImageDisposition.mockResolvedValue('retained');
        await environment.sleep('2 minutes');
        await handle.result();
        expect(activities.finishImage).toHaveBeenLastCalledWith(ref, 'cancelled');
        await Worker.runReplayHistory({ workflowsPath: require.resolve('./index') }, await handle.fetchHistory());
      })
    );
  }, 120000);
  test('cancellation waits for aborted byte transfer to drain before cleanup', async () => {
    const trace: string[] = [];
    const activities = mocks();
    activities.uploadImageBytes.mockImplementation(async () => {
      const context = Context.current();
      const timer = setInterval(() => heartbeat({ phase: 'bytes' }), 20);
      try {
        await new Promise<void>((_resolve, reject) =>
          context.cancellationSignal.addEventListener(
            'abort',
            () => {
              setTimeout(() => {
                trace.push('transfer-drained');
                reject(new CancelledFailure());
              }, 30);
            },
            { once: true }
          )
        );
      } finally {
        clearInterval(timer);
      }
    });
    activities.cancelImage.mockImplementation(async () => {
      trace.push('cleanup');
    });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('./index'),
      activities,
    });
    const controls = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-controls',
      workflowsPath: require.resolve('./index'),
      activities,
    });
    await controls.runUntil(() =>
      worker.runUntil(async () => {
        const handle = await environment.client.workflow.start(ImageIngest, {
          workflowId: 'image-cancel-drain',
          taskQueue: queue,
          args: [ref],
        });
        await until(() => activities.uploadImageBytes.mock.calls.length > 0);
        await handle.cancel();
        await expect(handle.result()).rejects.toThrow();
        expect(trace).toEqual(['transfer-drained', 'cleanup']);
        expect(activities.commitImage).not.toHaveBeenCalled();
      })
    );
  }, 120000);
  test('independent unknown orphan cleanup survives review and resumes the selected resource cleanup', async () => {
    const activities = mocks();
    activities.reconcileImageReceipt.mockResolvedValueOnce('review').mockResolvedValue('complete');
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('./index'),
      activities,
    });
    const controls = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-controls',
      workflowsPath: require.resolve('./index'),
      activities,
    });
    await controls.runUntil(() =>
      worker.runUntil(async () => {
        const handle = await environment.client.workflow.start(ImageReceiptReconciliation, {
          workflowId: 'image-orphan-review',
          taskQueue: queue,
          args: [ref],
        });
        await until(() => activities.reconcileImageReceipt.mock.calls.length > 0);
        await environment.sleep('1 hour');
        expect(activities.reconcileImageReceipt).toHaveBeenCalledTimes(1);
        await handle.signal(imageResume);
        await handle.result();
        expect(activities.reconcileImageReceipt).toHaveBeenCalledTimes(2);
      })
    );
  }, 120000);
});
