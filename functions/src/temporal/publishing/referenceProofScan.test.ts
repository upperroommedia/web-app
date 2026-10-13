import {
  containsPublishingReference,
  createPublishingReferenceProofScanner,
  PUBLISHING_REFERENCE_COLLECTIONS,
  type PublishingReferenceCollection,
  type PublishingReferenceProofDependencies,
  type PublishingReferenceProofCheckpoint,
  type PublishingReferencePage,
  type PublishingReferenceAllocation,
} from './referenceProofScan';

const ref = { jobId: 'job-1', projectId: 'urm-app-staging' };
const allocation: PublishingReferenceAllocation = {
  receiptId: 'receipt-1',
  fingerprint: 'fingerprint-1',
  revision: 0,
  remoteId: 'remote-image',
};
type Document = { id: string; data: unknown };
const documents = (count: number): Document[] =>
  Array.from({ length: count }, (_, index) => ({ id: `${index}`.padStart(6, '0'), data: { title: 'safe' } }));

function harness(initial: Partial<Record<PublishingReferenceCollection, Document[]>> = {}) {
  const current = new Map<PublishingReferenceCollection, Document[]>(
    PUBLISHING_REFERENCE_COLLECTIONS.map((name) => [name, initial[name] ?? []])
  );
  const snapshots = new Map<string, Map<PublishingReferenceCollection, Document[]>>();
  let checkpoint: PublishingReferenceProofCheckpoint | undefined;
  let epoch = 'epoch-1';
  let expired = false;
  let snapshotCount = 0;
  const initialize = jest.fn(async () => {
    const snapshotReadTime = `snapshot-${++snapshotCount}`;
    snapshots.set(snapshotReadTime, new Map(Array.from(current, ([name, docs]) => [name, structuredClone(docs)])));
    expired = false;
    return { snapshotReadTime, resourceEpoch: epoch };
  });
  const revalidate: PublishingReferenceProofDependencies['revalidate'] = async (_ref, _allocation, proof) =>
    !expired && proof.resourceEpoch === epoch;
  const readPage = jest.fn<
    Promise<PublishingReferencePage>,
    Parameters<PublishingReferenceProofDependencies['readPage']>
  >(async (proof, query) => {
    const candidates = snapshots
      .get(proof.snapshotReadTime)!
      .get(query.collection)!
      .filter((doc) => !query.cursor || doc.id > query.cursor);
    return { documents: candidates.slice(0, query.limit), hasMore: candidates.length > query.limit };
  });
  const persistCheckpoint = jest.fn(async (_ref, proof: PublishingReferenceProofCheckpoint) => {
    checkpoint = structuredClone(proof);
  });
  const deps: PublishingReferenceProofDependencies = {
    loadCheckpoint: async () => checkpoint,
    initialize,
    revalidate,
    readPage,
    persistCheckpoint,
  };
  return {
    current,
    initialize,
    readPage,
    persistCheckpoint,
    deps,
    scanner: createPublishingReferenceProofScanner(deps),
    checkpoint: () => checkpoint,
    setEpoch: (value: string) => {
      epoch = value;
    },
    expire: () => {
      expired = true;
    },
  };
}

describe('publishing reference predicate', () => {
  it('finds identifiers deeply inside maps and arrays but ignores prose', () => {
    expect(containsPublishingReference({ title: 'remote-image', url: 'remote-image' }, allocation.remoteId)).toBe(
      false
    );
    expect(
      containsPublishingReference(
        { speakers: [{ images: [{ subsplashId: allocation.remoteId }] }] },
        allocation.remoteId
      )
    ).toBe(true);
    expect(
      containsPublishingReference({ embedded: { unrelated: [{ id: allocation.remoteId }] } }, allocation.remoteId)
    ).toBe(true);
  });
  it('handles deep and cyclic values without recursion or spread limits', () => {
    let data: unknown = { id: allocation.remoteId };
    for (let i = 0; i < 10_000; i++) data = { child: data };
    expect(containsPublishingReference(data, allocation.remoteId)).toBe(true);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(containsPublishingReference(cycle, allocation.remoteId)).toBe(false);
    expect(
      containsPublishingReference([...Array(150_000).fill(null), { id: allocation.remoteId }], allocation.remoteId)
    ).toBe(true);
  });
});

describe('bounded publishing reference proof scan', () => {
  it('finds a reference beyond the former 501-document ceiling', async () => {
    const docs = documents(700);
    docs[699].data = { embedded: { images: [{ subsplashId: allocation.remoteId }] } };
    const h = harness({ sermons: docs });
    expect(await h.scanner.run(ref, allocation)).toBe('referenced');
    expect(h.readPage).toHaveBeenCalledTimes(4);
    expect(h.checkpoint()?.outcome).toBe('referenced');
  });
  it('persists the twentieth page and resumes without rereading earlier pages', async () => {
    const h = harness({ sermons: documents(4500) });
    expect(await h.scanner.run(ref, allocation)).toBe('pending');
    expect(h.readPage).toHaveBeenCalledTimes(20);
    expect(h.checkpoint()).toMatchObject({ collectionIndex: 0, cursor: '003999', outcome: 'scanning' });
    expect(await h.scanner.run(ref, allocation)).toBe('clear');
    expect(h.readPage.mock.calls[20][1]).toEqual({ collection: 'sermons', cursor: '003999', limit: 200 });
    expect(h.initialize).toHaveBeenCalledTimes(1);
    expect(h.readPage).toHaveBeenCalledTimes(27);
    expect(h.checkpoint()).toMatchObject({ collectionIndex: 5, outcome: 'clear' });
  });
  it.each(PUBLISHING_REFERENCE_COLLECTIONS)('checks %s references before clearing', async (collection) => {
    const h = harness({ [collection]: [{ id: 'doc', data: { image: { id: allocation.remoteId } } }] });
    expect(await h.scanner.run(ref, allocation)).toBe('referenced');
  });
  it('resets its entire proof after a writer changes the epoch between activities', async () => {
    const h = harness({ sermons: documents(4500) });
    expect(await h.scanner.run(ref, allocation)).toBe('pending');
    h.current.get('sermons')![0].data = { id: allocation.remoteId };
    h.setEpoch('epoch-2');
    expect(await h.scanner.run(ref, allocation)).toBe('referenced');
    expect(h.initialize).toHaveBeenCalledTimes(2);
    expect(h.readPage.mock.calls[20][1].cursor).toBeUndefined();
  });
  it('does not return clear if a late reference invalidates the completed snapshot', async () => {
    const h = harness({ sermons: documents(1) });
    const originalRead = h.deps.readPage;
    h.deps.readPage = async (proof, query) => {
      const page = await originalRead(proof, query);
      if (query.collection === 'images') {
        h.current.get('sermons')![0].data = { images: [{ subsplashId: allocation.remoteId }] };
        h.setEpoch('epoch-2');
      }
      return page;
    };
    expect(await h.scanner.run(ref, allocation)).toBe('pending');
    expect(h.checkpoint()).toMatchObject({ collectionIndex: 0, outcome: 'scanning', resourceEpoch: 'epoch-2' });
    expect(await h.scanner.run(ref, allocation)).toBe('referenced');
  });
  it('restarts when the consistent snapshot expires', async () => {
    const h = harness({ sermons: documents(4500) });
    expect(await h.scanner.run(ref, allocation)).toBe('pending');
    h.expire();
    expect(await h.scanner.run(ref, allocation)).toBe('pending');
    expect(h.initialize).toHaveBeenCalledTimes(2);
    expect(h.readPage.mock.calls[20][1].cursor).toBeUndefined();
  });
  it('never reuses a cached clear proof for a different allocation revision', async () => {
    const h = harness();
    expect(await h.scanner.run(ref, allocation)).toBe('clear');
    h.current.get('images')!.push({ id: 'record', data: { subsplashId: 'replacement-image' } });
    expect(await h.scanner.run(ref, { ...allocation, revision: 1, remoteId: 'replacement-image' })).toBe('referenced');
    expect(h.initialize).toHaveBeenCalledTimes(2);
  });
  it('revalidates cached clear proofs against new writers', async () => {
    const h = harness();
    expect(await h.scanner.run(ref, allocation)).toBe('clear');
    h.current.get('speakers')!.push({ id: 'record', data: { images: [{ id: allocation.remoteId }] } });
    h.setEpoch('epoch-2');
    expect(await h.scanner.run(ref, allocation)).toBe('referenced');
  });
  it('does not mark a failed or nonadvancing query as clear', async () => {
    const h = harness();
    h.readPage.mockRejectedValueOnce(new Error('read unavailable'));
    await expect(h.scanner.run(ref, allocation)).rejects.toThrow('read unavailable');
    expect(h.checkpoint()?.outcome).toBe('scanning');
    h.readPage.mockResolvedValueOnce({ documents: [], hasMore: true });
    await expect(h.scanner.run(ref, allocation)).rejects.toThrow('Invalid reference proof page');
    expect(h.checkpoint()?.outcome).toBe('scanning');
  });
  it('rejects unsorted documents rather than skipping unseen records', async () => {
    const h = harness();
    h.readPage.mockResolvedValueOnce({
      documents: [
        { id: 'b', data: {} },
        { id: 'a', data: {} },
      ],
      hasMore: true,
    });
    await expect(h.scanner.run(ref, allocation)).rejects.toThrow('advance in document ID order');
    expect(h.checkpoint()?.collectionIndex).toBe(0);
  });
});
