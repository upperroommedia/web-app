import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { createSearchActivities, type SearchDependencies } from './index';
import { createSearchProviderSession, SearchProviderError } from './provider-session';
import { createHash } from 'node:crypto';
jest.mock('@temporalio/activity', () => ({ Context: { current: jest.fn() }, heartbeat: jest.fn() }));
jest.mock('./provider-session', () => ({
  ...jest.requireActual('./provider-session'),
  createSearchProviderSession: jest.fn(),
}));
const ref = { projectId: 'test-project', jobId: 'search-job-one' };
const configuration = {
  projectId: ref.projectId,
  appId: 'test-app',
  indexName: 'records',
  collectionPath: 'sermons',
  fields: 'title',
  altObjectId: '',
  transformFunction: '',
  location: 'us-central1',
  writeKey: 'synthetic-write-key',
};
function fixture() {
  let source: { title: string } | undefined = { title: 'First' };
  let version = 1;
  let nextTask = 0;
  const locks = new Map<string, Record<string, unknown>>();
  const provider = new Map<string, Record<string, unknown>>();
  const cancellation = new AbortController();
  const context = { info: { attempt: 1 }, cancellationSignal: cancellation.signal };
  (Context.current as jest.Mock).mockReturnValue(context);
  const snapshot = () => ({
    exists: source !== undefined,
    id: 'a',
    ref: { path: 'sermons/a' },
    data: () => source,
    get: (key: string) => (key === 'title' ? source?.title : undefined),
    updateTime: source ? Timestamp.fromMillis(version) : undefined,
  });
  const reference = (path: string) => ({
    path,
    get: async () => (path === 'sermons/a' ? snapshot() : { data: () => locks.get(path) }),
  });
  const getPage = jest.fn(async () => ({ docs: [], size: 0 }));
  const firestore = {
    doc: reference,
    collection: (path: string) =>
      path === '_algoliaSyncLocks'
        ? { doc: (id: string) => reference(`${path}/${id}`) }
        : {
            orderBy() {
              return this;
            },
            limit() {
              return this;
            },
            get: getPage,
          },
    runTransaction: async (run: (tx: unknown) => Promise<unknown>) => {
      const writes: Array<{ path: string; patch: Record<string, unknown> }> = [];
      const result = await run({
        get: (doc: ReturnType<typeof reference>) => doc.get(),
        set: (doc: ReturnType<typeof reference>, patch: Record<string, unknown>) =>
          writes.push({ path: doc.path, patch }),
      });
      for (const { path, patch } of writes) locks.set(path, { ...locks.get(path), ...patch });
      return result;
    },
  } as unknown as Firestore;
  const client = {
    saveObjects: jest.fn(
      async ({ objects, waitForTasks }: { objects: Array<{ objectID: string }>; waitForTasks: boolean }) => {
        expect(waitForTasks).toBe(false);
        for (const record of objects) provider.set(record.objectID, record);
        return [{ taskID: ++nextTask }];
      }
    ),
    deleteObjects: jest.fn(async ({ objectIDs, waitForTasks }: { objectIDs: string[]; waitForTasks: boolean }) => {
      expect(waitForTasks).toBe(false);
      for (const id of objectIDs) provider.delete(id);
      return [{ taskID: ++nextTask }];
    }),
  };
  const session = {
    client,
    waitPublished: jest.fn(async (_index: string, _task: number) => {}),
    close: jest.fn(),
    check: jest.fn(() => cancellation.signal.throwIfAborted()),
  };
  (createSearchProviderSession as jest.Mock).mockReturnValue(session);
  const deps: SearchDependencies = {
    firestore,
    assertCurrent: jest.fn(async () => {}),
    assertCurrentInTransaction: jest.fn(async () => {}),
    loadIntent: jest.fn(async () => ({ payload: { instanceId: 'sermons-index', documentPath: 'sermons/a' } })),
    configurations: { 'sermons-index': configuration },
    project: jest.fn(async () => {}),
    enqueueDocument: jest.fn(),
  };
  const lockPath = `_algoliaSyncLocks/${createHash('sha256').update('sermons-index:sermons/a').digest('hex')}`;
  return {
    deps,
    session,
    locks,
    provider,
    cancellation,
    context,
    lockPath,
    activity: () => createSearchActivities(deps),
    change: (next: typeof source) => {
      source = next;
      version++;
    },
    saved: () => locks.get(lockPath)!,
  };
}
beforeEach(() => jest.clearAllMocks());

test('pending task survives retry and is confirmed before any further POST for unchanged canonical content', async () => {
  const f = fixture();
  f.session.waitPublished.mockRejectedValueOnce(new SearchProviderError('SearchCompletionPending'));
  await expect(f.activity().syncSearchDocument(ref)).rejects.toMatchObject({
    type: 'SearchCompletionPending',
    nonRetryable: false,
  });
  expect(f.saved()).toMatchObject({ leaseUntil: 0, pendingObjectId: 'a', pendingAlgoliaTask: { taskID: 1 } });
  expect(f.deps.project).not.toHaveBeenCalledWith(ref, { state: 'succeeded' });
  f.context.info.attempt = 2;
  await f.activity().syncSearchDocument(ref);
  expect(f.session.client.saveObjects).toHaveBeenCalledTimes(1);
  expect(f.session.waitPublished.mock.calls.map(([, task]) => task)).toEqual([1, 1]);
  expect(f.saved()).toMatchObject({
    pendingAlgoliaTask: null,
    pendingObjectId: null,
    confirmedSearchSave: { confirmedForJobId: ref.jobId },
  });
  expect(f.deps.project).toHaveBeenLastCalledWith(ref, { state: 'succeeded' });
});
test('changed canonical content resumes the old known task, then creates and confirms a new task', async () => {
  const f = fixture();
  f.session.waitPublished.mockRejectedValueOnce(new SearchProviderError('SearchCompletionPending'));
  await expect(f.activity().syncSearchDocument(ref)).rejects.toBeInstanceOf(ApplicationFailure);
  f.change({ title: 'Changed' });
  await f.activity().syncSearchDocument(ref);
  expect(f.session.waitPublished.mock.calls.map(([, task]) => task)).toEqual([1, 1, 2]);
  expect(f.session.client.saveObjects).toHaveBeenCalledTimes(2);
  expect(f.provider.get('a')).toMatchObject({ title: 'Changed' });
});
test('deleted canonical source confirms the prior save before deleting the orphan', async () => {
  const f = fixture();
  f.session.waitPublished.mockRejectedValueOnce(new SearchProviderError('SearchCompletionPending'));
  await expect(f.activity().syncSearchDocument(ref)).rejects.toBeInstanceOf(ApplicationFailure);
  f.change(undefined);
  await f.activity().syncSearchDocument(ref);
  expect(f.session.waitPublished.mock.calls.map(([, task]) => task)).toEqual([1, 1, 2]);
  expect(f.session.client.saveObjects).toHaveBeenCalledTimes(1);
  expect(f.session.client.deleteObjects).toHaveBeenCalledWith({
    indexName: 'records',
    objectIDs: ['a'],
    waitForTasks: false,
  });
  expect(f.provider.size).toBe(0);
});
test('ACK lost before a task receipt is saved retains object identity and retries idempotently without claiming exactly once', async () => {
  const f = fixture();
  f.session.client.saveObjects.mockImplementationOnce(async ({ objects }) => {
    for (const record of objects) f.provider.set(record.objectID, record);
    throw new SearchProviderError('SearchProviderUnavailable');
  });
  await expect(f.activity().syncSearchDocument(ref)).rejects.toBeInstanceOf(ApplicationFailure);
  expect(f.saved().pendingObjectId).toBe('a');
  expect(f.saved().pendingAlgoliaTask).toBeUndefined();
  await f.activity().syncSearchDocument(ref);
  expect(f.session.client.saveObjects).toHaveBeenCalledTimes(2);
  expect(f.provider.size).toBe(1);
  expect(f.deps.project).toHaveBeenLastCalledWith(ref, { state: 'succeeded' });
});
test('replacement lock owner prevents receipt publication and survives old activity cleanup', async () => {
  const f = fixture();
  f.session.client.saveObjects.mockImplementationOnce(async () => {
    f.locks.set(f.lockPath, { ...f.saved(), owner: 'replacement', leaseUntil: Date.now() + 600000 });
    return [{ taskID: 1 }];
  });
  await expect(f.activity().syncSearchDocument(ref)).rejects.toMatchObject({
    type: 'SearchLeaseLost',
    nonRetryable: true,
  });
  expect(f.saved().owner).toBe('replacement');
  expect(f.saved().pendingAlgoliaTask).toBeUndefined();
  expect(f.session.waitPublished).not.toHaveBeenCalled();
});
test('wrong target or replaced task receipts require attention and are never followed or cleared', async () => {
  const f = fixture();
  const retained = {
    schemaVersion: 1,
    targetDigest: '0'.repeat(64),
    action: 'addObject',
    objectId: 'a',
    taskID: 713,
    sourceVersion: '0:1000000',
    recordDigest: '1'.repeat(64),
    requestedByJobId: ref.jobId,
  };
  f.locks.set(f.lockPath, { owner: null, leaseUntil: 0, pendingAlgoliaTask: retained });
  await expect(f.activity().syncSearchDocument(ref)).rejects.toMatchObject({
    type: 'SearchTaskReceiptInvalid',
    nonRetryable: true,
  });
  expect(f.saved().pendingAlgoliaTask).toEqual(retained);
  expect(f.session.waitPublished).not.toHaveBeenCalled();
  expect(f.session.client.saveObjects).not.toHaveBeenCalled();
});
test('a replaced pending receipt is not cleared by completion of the older task', async () => {
  const f = fixture();
  f.session.waitPublished.mockImplementationOnce(async () => {
    f.locks.set(f.lockPath, {
      ...f.saved(),
      pendingAlgoliaTask: {
        ...(f.saved().pendingAlgoliaTask as Record<string, unknown>),
        taskID: 999,
      },
    });
  });
  await expect(f.activity().syncSearchDocument(ref)).rejects.toMatchObject({
    type: 'SearchTaskReceiptChanged',
    nonRetryable: true,
  });
  expect(f.saved().pendingAlgoliaTask).toMatchObject({ taskID: 999 });
  expect(f.deps.project).not.toHaveBeenCalledWith(ref, { state: 'succeeded' });
});
test('a later new backfill job does not trust an earlier job cache as evidence the index still contains its record', async () => {
  const f = fixture();
  await f.activity().syncSearchDocument(ref);
  f.provider.clear();
  await f.activity().syncSearchDocument({ ...ref, jobId: 'new-backfill-job' });
  expect(f.session.client.saveObjects).toHaveBeenCalledTimes(2);
  expect(f.provider.get('a')).toMatchObject({ title: 'First' });
});
test('cancellation does not release the lease or close the session before a held provider promise settles', async () => {
  const f = fixture();
  let entered!: () => void;
  let release: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.session.waitPublished.mockImplementationOnce(async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const done = f
    .activity()
    .syncSearchDocument(ref)
    .then(
      () => false,
      () => true
    );
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<never>((_resolve, reject) => {
    watchdog = setTimeout(() => reject(new Error('Provider entry timed out')), 5000);
  });
  try {
    await Promise.race([
      started,
      bounded,
      done.then(() => {
        throw new Error('Activity stopped before provider entry');
      }),
    ]);
    f.cancellation.abort();
    expect(f.session.close).not.toHaveBeenCalled();
    expect(f.saved().owner).not.toBeNull();
    release();
    expect(await done).toBe(true);
    expect(f.session.close).toHaveBeenCalledTimes(1);
    expect(f.saved()).toMatchObject({ owner: null, leaseUntil: 0, pendingAlgoliaTask: { taskID: 1 } });
    expect(f.deps.project).not.toHaveBeenCalledWith(ref, { state: 'succeeded' });
  } finally {
    clearTimeout(watchdog);
    f.cancellation.abort();
    release();
    await done;
  }
});
test('empty-private users never initialize or call the provider', async () => {
  const f = fixture();
  f.deps.configurations['sermons-index'] = { ...configuration, recordPolicy: 'empty-private' };
  await f.activity().syncSearchDocument(ref);
  expect(createSearchProviderSession).not.toHaveBeenCalled();
  expect(f.locks.size).toBe(0);
  expect(f.deps.project).toHaveBeenLastCalledWith(ref, { state: 'succeeded' });
});

test('backfill parent reports running and real retry attempts without adding workflow commands or provider work', async () => {
  const f = fixture();
  expect(await f.activity().searchBackfillPage(ref)).toEqual({ jobs: [], complete: true });
  expect(f.deps.project).toHaveBeenLastCalledWith(ref, { state: 'running' });
  f.context.info.attempt = 2;
  await f.activity().searchBackfillPage(ref);
  expect(f.deps.project).toHaveBeenLastCalledWith(ref, { state: 'retrying' });
  expect(createSearchProviderSession).not.toHaveBeenCalled();
});
