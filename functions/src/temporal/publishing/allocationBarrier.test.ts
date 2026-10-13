jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    firestore: () => {
      throw new Error('Live SDK forbidden in allocation unit tests');
    },
  },
}));
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  claimPublishingAllocation,
  preparePublishingAllocationCommit,
  settleCancelledPublishingAllocations,
  assertPublishingDeletionAllocationsSettled,
  capturePublishingAllocationSource,
  assertPublishingContentUpdateAllocationsSettled,
} from './allocationBarrier';
const first = { projectId: 'project', jobId: 'list-job' },
  second = { projectId: 'project', jobId: 'sermon-job' };
describe('persistent cross-job provider allocation ownership', () => {
  const records = new Map<string, Record<string, unknown>>();
  const target = (path: string) => ({ path });
  const snapshot = (path: string) => ({
    exists: records.has(path),
    id: path.split('/').at(-1),
    ref: target(path),
    get: (key: string) => key.split('.').reduce((value: any, part) => value?.[part], records.get(path)),
    data: () => records.get(path),
  });
  const tx = {
    get: jest.fn(async (ref: { path: string }) => snapshot(ref.path)),
    set: jest.fn((ref: { path: string }, value: Record<string, unknown>) => records.set(ref.path, { ...value })),
    update: jest.fn((ref: { path: string }, value: Record<string, unknown>) =>
      Object.assign(records.get(ref.path)!, value)
    ),
  };
  const db = {
    collection: (name: string) => {
      const filters: Array<[string, unknown]> = [];
      const query: any = {
        doc: (id: string) => target(`${name}/${id}`),
        where: (field: string, _op: string, value: unknown) => {
          filters.push([field, value]);
          return query;
        },
        orderBy: () => query,
        limit: () => query,
        get: async () => {
          const docs = [...records]
            .filter(
              ([path, data]) => path.startsWith(`${name}/`) && filters.every(([field, value]) => data[field] === value)
            )
            .map(([path]) => snapshot(path));
          return { docs, size: docs.length };
        },
      };
      return query;
    },
  } as unknown as Firestore;
  const store = {
    commitCurrent: jest.fn(async (_ref: unknown, mutate: (tx: Transaction) => Promise<void>) => mutate(tx as never)),
  };
  const input = (ref = first) => ({
    ref,
    sermonId: 'sermon',
    provider: 'subsplash' as const,
    operationKey: `durable:project:${ref.jobId}:sermon:subsplash-create`,
  });
  beforeEach(() => {
    records.clear();
    records.set('sermons/sermon', {});
    jest.clearAllMocks();
  });
  it('blocks a second entity job after lock expiry and worker crash without dispatching another POST', async () => {
    await claimPublishingAllocation(db, store, input());
    const post = jest.fn();
    await expect(
      (async () => {
        await claimPublishingAllocation(db, store, input(second));
        await post();
      })()
    ).rejects.toMatchObject({ code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING', details: { blockingJobId: 'list-job' } });
    expect(post).not.toHaveBeenCalled();
    await claimPublishingAllocation(db, store, input());
    expect(tx.set).toHaveBeenCalledTimes(1);
    const marker = [...records.values()].find((data) => data.ownerJobId === 'list-job')!;
    expect(marker.state).toBe('allocating');
    expect(marker.receiptIds).toHaveLength(3);
  });
  it('settles ownership atomically with the confirmed canonical identity', async () => {
    await claimPublishingAllocation(db, store, input());
    const settle = await preparePublishingAllocationCommit(tx as never, db, input(), 'media');
    tx.update(target('sermons/sermon'), { subsplashId: 'media' });
    settle();
    expect([...records.values()].find((data) => data.ownerJobId === 'list-job')).toMatchObject({
      state: 'bound',
      remoteId: 'media',
    });
    await expect(claimPublishingAllocation(db, store, input(second))).rejects.toMatchObject({
      code: 'PUBLISHING_TRANSIENT',
    });
  });
  it('releases an unbound owner only through completed cancellation proof and never from time passage', async () => {
    await claimPublishingAllocation(db, store, input());
    await expect(claimPublishingAllocation(db, store, input(second))).rejects.toMatchObject({
      code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
    });
    await settleCancelledPublishingAllocations(db, store, first);
    await claimPublishingAllocation(db, store, input(second));
    expect([...records.values()].find((data) => data.sermonId === 'sermon')).toMatchObject({
      ownerJobId: 'sermon-job',
      state: 'allocating',
    });
  });
  it('cannot finalize an in-flight provider allocation after another job closes sermon deletion admission', async () => {
    await claimPublishingAllocation(db, store, input());
    records.set('temporalMediaState/sermon', { deletionParentRef: { projectId: 'project', jobId: 'delete-job' } });
    await expect(preparePublishingAllocationCommit(tx as never, db, input(), 'media')).rejects.toMatchObject({
      code: 'PUBLISHING_SUPERSEDED',
    });
    expect(records.get('sermons/sermon')).toEqual({});
    expect([...records.values()].find((data) => data.ownerJobId === 'list-job')).toMatchObject({ state: 'allocating' });
    await expect(claimPublishingAllocation(db, store, input(second))).rejects.toMatchObject({
      code: 'PUBLISHING_SUPERSEDED',
    });
  });
  it('rejects owner changes before canonical provider association', async () => {
    await claimPublishingAllocation(db, store, input());
    await expect(preparePublishingAllocationCommit(tx as never, db, input(second), 'media')).rejects.toThrow(
      'PUBLISHING_ALLOCATION_OWNER_CHANGED'
    );
    expect(records.get('sermons/sermon')).toEqual({});
  });
  it('keeps local-only deletion reversible while a sibling job owns an in-flight provider POST', async () => {
    await claimPublishingAllocation(db, store, input());
    records.set('temporalMediaState/sermon', { deletionParentRef: second });
    const critical = jest.fn(),
      removeRoot = jest.fn();
    await expect(
      (async () => {
        await assertPublishingDeletionAllocationsSettled(tx as never, db, { ref: second, sermonId: 'sermon' });
        critical();
        removeRoot();
      })()
    ).rejects.toMatchObject({
      code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
      details: { blockingJobId: first.jobId },
    });
    expect(critical).not.toHaveBeenCalled();
    expect(removeRoot).not.toHaveBeenCalled();
    await settleCancelledPublishingAllocations(db, store, first);
    await expect(
      assertPublishingDeletionAllocationsSettled(tx as never, db, { ref: second, sermonId: 'sermon' })
    ).resolves.toBeUndefined();
    await expect(claimPublishingAllocation(db, store, input())).rejects.toMatchObject({
      code: 'PUBLISHING_SUPERSEDED',
    });
  });
  it('requires exact bound provider identity and matching deletion owner before critical deletion', async () => {
    await claimPublishingAllocation(db, store, input());
    const settle = await preparePublishingAllocationCommit(tx as never, db, input(), 'media');
    settle();
    records.set('temporalMediaState/sermon', { deletionParentRef: second });
    await expect(
      assertPublishingDeletionAllocationsSettled(tx as never, db, {
        ref: second,
        sermonId: 'sermon',
        subsplashId: 'media',
      })
    ).resolves.toBeUndefined();
    await expect(
      assertPublishingDeletionAllocationsSettled(tx as never, db, { ref: second, sermonId: 'sermon' })
    ).rejects.toMatchObject({ code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING' });
    await expect(
      assertPublishingDeletionAllocationsSettled(tx as never, db, {
        ref: first,
        sermonId: 'sermon',
        subsplashId: 'media',
      })
    ).rejects.toMatchObject({ code: 'PUBLISHING_PROVIDER_REPAIR_REQUIRED' });
  });

  it('does not rely only on editedAt when canonical content changes before allocation claim', async () => {
    records.set('sermons/sermon', {
      title: 'Original',
      editedAtMillis: 1,
      audioArtifacts: { finalPath: 'workflow-audio/sermon/original' },
    });
    const source = capturePublishingAllocationSource(records.get('sermons/sermon')!);
    records.set('sermons/sermon', {
      title: 'Changed without timestamp',
      editedAtMillis: 1,
      audioArtifacts: { finalPath: 'workflow-audio/sermon/original' },
    });
    await expect(claimPublishingAllocation(db, store, { ...input(), source })).rejects.toMatchObject({
      code: 'PUBLISHING_ALLOCATION_SOURCE_CHANGED',
    });
    expect([...records.values()].some((data) => data.ownerJobId === first.jobId)).toBe(false);
  });

  it('pins canonical source before claim and refuses a stale positive ACK association', async () => {
    records.set('sermons/sermon', {
      title: 'Original',
      editedAtMillis: 1,
      audioArtifacts: { finalPath: 'workflow-audio/sermon/original' },
    });
    const original = capturePublishingAllocationSource(records.get('sermons/sermon')!);
    await claimPublishingAllocation(db, store, { ...input(), source: original });
    records.set('sermons/sermon', {
      title: 'New edit',
      editedAtMillis: 2,
      audioArtifacts: { finalPath: 'workflow-audio/sermon/replacement' },
    });
    await expect(
      preparePublishingAllocationCommit(tx as never, db, { ...input(), source: original }, 'original-post-ack')
    ).rejects.toMatchObject({ code: 'PUBLISHING_ALLOCATION_SOURCE_CHANGED' });
    expect(records.get('sermons/sermon')).not.toHaveProperty('subsplashId');
    expect([...records.values()].find((data) => data.ownerJobId === first.jobId)).toMatchObject({
      state: 'allocating',
      source: original,
    });
    await expect(claimPublishingAllocation(db, store, { ...input(), source: original })).rejects.toMatchObject({
      code: 'PUBLISHING_ALLOCATION_SOURCE_CHANGED',
    });
  });
  it('blocks an edit admitted before another entity started allocation, then permits only a canonical bound owner', async () => {
    await expect(
      assertPublishingContentUpdateAllocationsSettled(tx as never, db, { ref: second, sermonId: 'sermon' })
    ).resolves.toBeUndefined();
    await claimPublishingAllocation(db, store, input());
    await expect(
      assertPublishingContentUpdateAllocationsSettled(tx as never, db, { ref: second, sermonId: 'sermon' })
    ).rejects.toMatchObject({ code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING' });
    const complete = await preparePublishingAllocationCommit(tx as never, db, input(), 'media');
    complete();
    await expect(
      assertPublishingContentUpdateAllocationsSettled(tx as never, db, { ref: second, sermonId: 'sermon' })
    ).rejects.toMatchObject({ code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING' });
    tx.update(target('sermons/sermon'), { subsplashId: 'media' });
    await expect(
      assertPublishingContentUpdateAllocationsSettled(tx as never, db, { ref: second, sermonId: 'sermon' })
    ).resolves.toBeUndefined();
  });
});
