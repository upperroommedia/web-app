import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ProviderOrphanReview, providerOrphanReviewResume } from './index';
const ref = { projectId: 'test-project', jobId: 'independent-orphan-case' };
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Review workflow did not reach expected phase');
}
describe('native independent provider orphan review', () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120000);
  afterAll(async () => {
    await env?.teardown();
  });
  test('manual review resumes only the read-only case and history replays', async () => {
    const review = jest.fn<Promise<'pending' | 'complete'>, []>(async () => 'pending');
    const controls = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'urm-controls',
      activities: { reviewProviderOrphanAcknowledgement: review },
    });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'orphan-review-test',
      workflowsPath: require.resolve('./index'),
    });
    await controls.runUntil(() =>
      worker.runUntil(async () => {
        const handle = await env.client.workflow.start(ProviderOrphanReview, {
          workflowId: 'independent-review-case',
          taskQueue: 'orphan-review-test',
          args: [ref],
        });
        await until(() => review.mock.calls.length === 1);
        expect((await handle.describe()).status.name).toBe('RUNNING');
        review.mockResolvedValue('complete');
        await handle.signal(providerOrphanReviewResume);
        await handle.result();
        expect(review).toHaveBeenCalledTimes(2);
        const history = await handle.fetchHistory();
        const names =
          history.events?.flatMap((event) =>
            event.activityTaskScheduledEventAttributes?.activityType?.name
              ? [event.activityTaskScheduledEventAttributes.activityType.name]
              : []
          ) ?? [];
        expect(new Set(names)).toEqual(new Set(['reviewProviderOrphanAcknowledgement']));
        await Worker.runReplayHistory({ workflowsPath: require.resolve('./index') }, history);
      })
    );
  }, 120000);
  test('an unexpected Temporal cancellation cannot discard a pending acknowledged asset', async () => {
    const review = jest.fn<Promise<'pending' | 'complete'>, []>(async () => 'pending');
    const controls = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'urm-controls',
      activities: { reviewProviderOrphanAcknowledgement: review },
    });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'orphan-review-cancel-test',
      workflowsPath: require.resolve('./index'),
    });
    await controls.runUntil(() =>
      worker.runUntil(async () => {
        const handle = await env.client.workflow.start(ProviderOrphanReview, {
          workflowId: 'independent-review-cancel',
          taskQueue: 'orphan-review-cancel-test',
          args: [ref],
        });
        await until(() => review.mock.calls.length === 1);
        await handle.cancel();
        expect((await handle.describe()).status.name).toBe('RUNNING');
        review.mockResolvedValue('complete');
        await handle.signal(providerOrphanReviewResume);
        await handle.result();
        await Worker.runReplayHistory({ workflowsPath: require.resolve('./index') }, await handle.fetchHistory());
      })
    );
  }, 120000);
});
