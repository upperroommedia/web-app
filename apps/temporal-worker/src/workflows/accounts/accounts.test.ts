import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { accountsWorkflow, accountResume, accountStatus } from './index';
jest.setTimeout(120000);
const ref = { projectId: 'test-project', jobId: 'speaker-accept-job' };
const complete = () => ({ state: 'completed' as const });
it('holds an ambiguous account speaker create for audited resolution and replays its native history', async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const receiptId = 'a'.repeat(64);
  const activities = {
    beginDurableJob: jest.fn(),
    finishDurableJob: jest.fn(),
    validateAccountOperation: jest.fn().mockResolvedValue(complete()),
    applyAccountClaims: jest.fn().mockResolvedValue(complete()),
    revokeAccountSessions: jest.fn().mockResolvedValue(complete()),
    createAccountSpeaker: jest
      .fn()
      .mockResolvedValueOnce({ state: 'needs_review', code: 'PROVIDER_CREATE_AMBIGUOUS', receiptId })
      .mockResolvedValue(complete()),
    resolveAccountDocument: jest.fn().mockResolvedValue(complete()),
    notifyAccountOutcome: jest.fn().mockResolvedValue(complete()),
    reportAccountAttention: jest.fn(),
  };
  try {
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
    });
    const controls = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-controls',
      activities,
    });
    await controls.runUntil(() =>
      worker.runUntil(async () => {
        const handle = await environment.client.workflow.start(accountsWorkflow, {
          workflowId: 'account-speaker-review',
          taskQueue: 'urm-orchestration',
          args: [ref],
        });
        let status;
        for (let count = 0; count < 100; count++) {
          status = await handle.query(accountStatus);
          if (status.state === 'needs_review') break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(status).toEqual({
          step: 'speaker',
          state: 'needs_review',
          code: 'PROVIDER_CREATE_AMBIGUOUS',
          receiptId,
        });
        expect(activities.createAccountSpeaker).toHaveBeenCalledTimes(1);
        expect(activities.resolveAccountDocument).not.toHaveBeenCalled();
        await handle.signal(accountResume);
        expect(await handle.result()).toEqual(complete());
        expect(activities.createAccountSpeaker).toHaveBeenCalledTimes(2);
        expect(activities.resolveAccountDocument).toHaveBeenCalledTimes(1);
        await Worker.runReplayHistory({ workflowsPath: require.resolve('./index') }, await handle.fetchHistory());
      })
    );
  } finally {
    await environment.teardown();
  }
});
