import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import {
  assertPublishingMutationTargetProofCurrent,
  assertPublishingMutationTargetProofForSession,
  verifyPublishingMutationTarget,
  type PublishingMutationTargetReader,
} from '../../temporal/publishing/mutationTargetProof';
import {
  providerMutationFingerprint as hash,
  type ProviderMutationSession,
  type ProviderMutationResource,
} from '../../temporal/publishing/providerMutationGuard';
const ref = { projectId: 'test-project', jobId: 'job', workflowId: 'workflow', generation: 1 } as DurableJobRef;
const list: ProviderMutationResource = {
  provider: 'subsplash',
  account: 'app:9XTSHD',
  resourceType: 'list',
  resourceId: 'root-remote',
};
function fixture() {
  const records = new Map<string, Record<string, unknown>>();
  const snapshot = (path: string) => ({
    id: path.split('/').pop()!,
    ref: { path },
    exists: records.has(path),
    data: () => records.get(path),
    get: (field: string) => records.get(path)?.[field],
  });
  const document = (path: string) => ({ path, get: async () => snapshot(path) });
  const query = (path: string, filters: Array<[string, unknown]> = []): unknown => ({
    where: (field: string, _op: string, value: unknown) => query(path, [...filters, [field, value]]),
    limit: () => query(path, filters),
    orderBy: () => query(path, filters),
    get: async () => {
      const docs = [...records.entries()]
        .filter(
          ([p, data]) =>
            p.startsWith(`${path}/`) &&
            p.slice(path.length + 1).split('/').length === 1 &&
            filters.every(([field, value]) => data[field] === value)
        )
        .map(([p]) => snapshot(p));
      return { docs, size: docs.length };
    },
  });
  const db = {
    doc: document,
    collection: (path: string) => ({
      doc: (id: string) => document(`${path}/${id}`),
      where: (field: string, op: string, value: unknown) =>
        (query(path) as { where: (field: string, op: string, value: unknown) => unknown }).where(field, op, value),
    }),
  } as unknown as Firestore;
  const scope = { projectId: ref.projectId, jobId: ref.jobId, operation: 'lists' };
  const session: ProviderMutationSession = { db, id: hash(scope), scope, resources: [list] };
  records.set(`temporalProviderMutationSessions/${session.id}`, {
    state: 'active',
    scope,
    resources: session.resources,
  });
  const reader: PublishingMutationTargetReader = {
    getList: jest.fn(async (id) => ({ id, app_key: '9XTSHD' })),
    getListRows: jest.fn(async () => [
      { id: 'row', type: 'media-item', app_key: '9XTSHD', _embedded: { 'source-list': { id: 'root-remote' } } },
    ]),
  };
  const tx = {
    get: async (target: { path?: string; get?: () => Promise<unknown> }) =>
      target.path ? snapshot(target.path) : target.get!(),
  } as unknown as Transaction;
  return { db, records, session, reader, tx };
}
const row: ProviderMutationResource = { ...list, resourceType: 'list-row', resourceId: 'row' };
test('exact planned target uses no provider reads and pins active immutable session', async () => {
  const f = fixture();
  const proof = await verifyPublishingMutationTarget({ ...f, ref, target: list });
  expect(proof.kind).toBe('planned');
  expect(f.reader.getList).not.toHaveBeenCalled();
  expect(Object.keys(proof)).not.toEqual(expect.arrayContaining(['db', 'sources', 'sessionFingerprint']));
  expect(JSON.parse(JSON.stringify(proof))).toEqual(expect.objectContaining({ kind: 'planned', rootResource: list }));
  await expect(assertPublishingMutationTargetProofCurrent(f.tx, proof)).resolves.toBeUndefined();
  f.records.get(`temporalProviderMutationSessions/${f.session.id}`)!.state = 'committed';
  await expect(assertPublishingMutationTargetProofCurrent(f.tx, proof)).rejects.toThrow('UNPROVEN');
});
test('authoritative held parent rows prove row target and hint avoids unrelated parents', async () => {
  const f = fixture();
  const proof = await verifyPublishingMutationTarget({ ...f, ref, target: row, parentHint: 'root-remote' });
  expect(proof.kind).toBe('list_row');
  expect(proof.rootResource).toEqual(list);
  expect(f.reader.getListRows).toHaveBeenCalledWith('root-remote');
});
test.each(['foreign-hint', 'foreign-source', 'foreign-app', 'missing-row', 'inactive', 'forged-session'])(
  'row ownership rejects %s',
  async (reason) => {
    const f = fixture();
    let parentHint: string | undefined;
    if (reason === 'foreign-hint') parentHint = 'client-claimed-parent';
    if (reason === 'foreign-source')
      f.reader.getListRows = async () => [
        { id: 'row', type: 'media-item', _embedded: { 'source-list': { id: 'foreign' } } },
      ];
    if (reason === 'foreign-app') f.reader.getList = async (id) => ({ id, app_key: 'foreign' });
    if (reason === 'missing-row') f.reader.getListRows = async () => [];
    if (reason === 'inactive') f.records.get(`temporalProviderMutationSessions/${f.session.id}`)!.state = 'aborted';
    if (reason === 'forged-session') f.session.resources = [{ ...list, resourceId: 'foreign' }];
    await expect(verifyPublishingMutationTarget({ ...f, ref, target: row, parentHint })).rejects.toThrow('UNPROVEN');
  }
);
function overflow(f: ReturnType<typeof fixture>, changes: Record<string, unknown> = {}) {
  f.records.set('lists/root', { subsplashId: 'root-remote', moreSermonsRef: 'new-remote' });
  f.records.set('lists/new', { subsplashId: 'new-remote', rootListId: 'root' });
  const operationKey = 'durable:test-project:job:overflow',
    step = 'overflow-list-create',
    payload = { app_key: '9XTSHD', title: 'More' };
  const receiptId = hash([operationKey, step]);
  f.records.set(`temporalProviderReceipts/${receiptId}`, {
    projectId: ref.projectId,
    jobId: ref.jobId,
    operationKey,
    step,
    intentPayload: payload,
    fingerprint: hash(payload),
    state: 'confirmed',
    owner: 'original',
    revision: 2,
    result: { id: 'new-remote' },
    providerAccount: { provider: 'subsplash', account: 'app:9XTSHD' },
    ...changes,
  });
  return { ...list, resourceId: 'new-remote' };
}
test('original qualified ACK plus canonical held-root chain proves created overflow and seals sources', async () => {
  const f = fixture();
  const target = overflow(f);
  const proof = await verifyPublishingMutationTarget({ ...f, ref, target });
  expect(proof.kind).toBe('created_overflow');
  expect(proof.canonicalPaths).toContain('lists/root');
  await expect(assertPublishingMutationTargetProofCurrent(f.tx, proof)).resolves.toBeUndefined();
  f.records.set('lists/root', { subsplashId: 'root-remote', moreSermonsRef: 'foreign' });
  await expect(assertPublishingMutationTargetProofCurrent(f.tx, proof)).rejects.toThrow('UNPROVEN');
});
test.each(['adopted', 'unknown', 'foreign-job', 'broken-chain', 'wrong-provider'])(
  'new child rejects %s',
  async (reason) => {
    const f = fixture();
    const target = overflow(
      f,
      reason === 'adopted'
        ? { resolvedBy: 'operator' }
        : reason === 'unknown'
        ? { state: 'needs_review' }
        : reason === 'foreign-job'
        ? { jobId: 'elsewhere' }
        : reason === 'wrong-provider'
        ? { providerAccount: { provider: 'subsplash', account: 'app:FOREIGN' } }
        : {}
    );
    if (reason === 'broken-chain') f.records.set('lists/root', { subsplashId: 'root-remote' });
    await expect(verifyPublishingMutationTarget({ ...f, ref, target })).rejects.toThrow('UNPROVEN');
  }
);
test('plain caller constructed proof is never accepted by claim fence', async () => {
  const f = fixture();
  await expect(
    assertPublishingMutationTargetProofCurrent(f.tx, {
      kind: 'planned',
      target: list,
      rootResource: list,
      proofHash: 'fake',
      canonicalPaths: [],
    })
  ).rejects.toThrow('UNPROVEN');
});
test('a new canonical alias cannot evade final transaction ownership proof', async () => {
  const f = fixture();
  const target = overflow(f);
  const proof = await verifyPublishingMutationTarget({ ...f, ref, target });
  f.records.set('lists/foreign-alias', { subsplashId: 'new-remote', rootListId: 'foreign' });
  await expect(assertPublishingMutationTargetProofCurrent(f.tx, proof)).rejects.toThrow('UNPROVEN');
});
test('row under newly created overflow requires the same original ACK and held-root proof', async () => {
  const f = fixture();
  overflow(f);
  f.reader.getListRows = async () => [
    { id: 'row', type: 'media-item', app_key: '9XTSHD', _embedded: { 'source-list': { id: 'new-remote' } } },
  ];
  const proof = await verifyPublishingMutationTarget({ ...f, ref, target: row, parentHint: 'new-remote' });
  expect(proof.kind).toBe('list_row');
  expect(proof.rootResource).toEqual(list);
  expect(proof.receiptId).toBeDefined();
  await expect(assertPublishingMutationTargetProofCurrent(f.tx, proof)).resolves.toBeUndefined();
});
test('an issued proof cannot be reused for a different mutation session', async () => {
  const f = fixture();
  const proof = await verifyPublishingMutationTarget({ ...f, ref, target: list });
  const other = { ...f.session, id: 'foreign-session' };
  await expect(assertPublishingMutationTargetProofForSession(f.tx, proof, other)).rejects.toThrow('UNPROVEN');
  await expect(assertPublishingMutationTargetProofForSession(f.tx, proof, f.session)).resolves.toBeUndefined();
});
