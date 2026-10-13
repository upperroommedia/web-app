import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { bundlesWorkflow, requestBundleRegeneration } from './index';

test('bundle coordinator routes authoritative metadata to controls and closes after idle', async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const initial = { projectId: 'test-project', jobId: 'initial' },
    latest = { projectId: 'test-project', jobId: 'latest' };
  const regenerateBundle = jest.fn().mockResolvedValue({ state: 'completed' });
  const resolveLatestBundleJob = jest.fn().mockImplementation(async (ref) => ref);
  try {
    const provider = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities: { regenerateBundle },
    });
    const controls = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-controls',
      activities: { resolveLatestBundleJob, beginDurableJob: async () => {}, finishDurableJob: async () => {} },
    });
    await provider.runUntil(() =>
      controls.runUntil(async () => {
        const handle = await environment.client.workflow.start(bundlesWorkflow, {
          workflowId: 'bundle-controls-test',
          taskQueue: 'urm-orchestration',
          args: [initial],
        });
        await handle.signal(requestBundleRegeneration, latest);
        await handle.signal(requestBundleRegeneration, latest);
        await handle.signal(requestBundleRegeneration, { projectId: 'another-project', jobId: 'foreign' });
        await handle.result();
        expect(regenerateBundle.mock.calls.filter(([ref]) => ref.jobId === 'latest')).toHaveLength(1);
        expect(regenerateBundle.mock.calls.every(([ref]) => ref.projectId === 'test-project')).toBe(true);
        expect(resolveLatestBundleJob).toHaveBeenCalled();
        await Worker.runReplayHistory({ workflowsPath: require.resolve('./index') }, await handle.fetchHistory());
      })
    );
  } finally {
    await environment.teardown();
  }
}, 120000);
