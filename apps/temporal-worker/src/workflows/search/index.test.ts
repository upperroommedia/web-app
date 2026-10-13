import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { SearchDocument, SearchBackfill, searchResume } from './index';
const ref = { jobId: 'search-job', projectId: 'test-project' };
function mocks() {
  return {
    syncSearchDocument: jest.fn(async () => undefined),
    finishSearch: jest.fn(async () => undefined),
    searchBackfillPage: jest.fn(async (_ref: unknown, _cursor?: string) => ({
      jobs: [] as (typeof ref)[],
      cursor: undefined as string | undefined,
      complete: true,
    })),
    confirmSearchPage: jest.fn(async () => true),
    finishSearchBackfill: jest.fn(async () => undefined),
  };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Expected search state not reached');
}
describe('native search workflow', () => {
  let environment: TestWorkflowEnvironment;
  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120000);
  afterAll(async () => {
    await environment?.teardown();
  });
  test('exhausted document failure waits for recovery signal and replays', async () => {
    const activities = mocks();
    activities.syncSearchDocument.mockRejectedValueOnce(
      ApplicationFailure.nonRetryable('Unavailable', 'SearchProviderFailure')
    );
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-search',
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
        const handle = await environment.client.workflow.start(SearchDocument, {
          workflowId: 'search-recovery',
          taskQueue: 'urm-search',
          args: [ref],
        });
        await until(() => activities.finishSearch.mock.calls.length > 0);
        await environment.sleep('1 hour');
        expect(activities.syncSearchDocument).toHaveBeenCalledTimes(1);
        await handle.signal(searchResume);
        await handle.result();
        expect(activities.syncSearchDocument).toHaveBeenCalledTimes(2);
        await Worker.runReplayHistory({ workflowsPath: require.resolve('./index') }, await handle.fetchHistory());
      })
    );
  }, 120000);
  test('backfill waits for admitted jobs before advancing cursor', async () => {
    const activities = mocks(),
      trace: string[] = [];
    activities.searchBackfillPage
      .mockImplementationOnce(async () => {
        trace.push('page-one');
        return { jobs: [ref], cursor: 'one', complete: false };
      })
      .mockImplementation(async () => {
        trace.push('page-two');
        return { jobs: [], cursor: undefined, complete: true };
      });
    activities.confirmSearchPage
      .mockImplementationOnce(async () => {
        trace.push('unconfirmed');
        return false;
      })
      .mockImplementation(async () => {
        trace.push('confirmed');
        return true;
      });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-search',
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
        const handle = await environment.client.workflow.start(SearchBackfill, {
          workflowId: 'search-backfill-confirmation',
          taskQueue: 'urm-search',
          args: [{ ref }],
        });
        await handle.result();
        expect(trace).toEqual(['page-one', 'unconfirmed', 'confirmed', 'page-two']);
        expect(activities.finishSearchBackfill).toHaveBeenCalledWith(ref, 1);
        await Worker.runReplayHistory({ workflowsPath: require.resolve('./index') }, await handle.fetchHistory());
      })
    );
  }, 120000);
  test('ContinueAsNew retains cursor after one hundred pages', async () => {
    const activities = mocks();
    let page = 0;
    activities.searchBackfillPage.mockImplementation(async () => ({
      jobs: [],
      cursor: `page-${++page}`,
      complete: page === 101,
    }));
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-search',
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
        const handle = await environment.client.workflow.start(SearchBackfill, {
          workflowId: 'search-backfill-continue',
          taskQueue: 'urm-search',
          args: [{ ref }],
        });
        await handle.result();
        expect(activities.searchBackfillPage).toHaveBeenCalledTimes(101);
        expect(activities.searchBackfillPage.mock.calls[100][1]).toBe('page-100');
        expect(activities.finishSearch).not.toHaveBeenCalled();
        expect(activities.finishSearchBackfill).toHaveBeenCalledWith(ref, 0);
      })
    );
  }, 120000);
});
