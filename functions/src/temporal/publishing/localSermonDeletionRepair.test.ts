import type { Firestore, Transaction } from 'firebase-admin/firestore';
let mockRunner: ((mutate: (tx: Transaction) => Promise<void>) => Promise<void>) | undefined;
const mockRemove = jest.fn();
jest.mock('../../helpers/sermonDeletionMirrors', () => ({
  ...jest.requireActual('../../helpers/sermonDeletionMirrors'),
  removeSermonDeletionMirrors: (...args: unknown[]) => mockRemove(...args),
}));
jest.mock('./durableOperationContext', () => ({
  runCriticalPublishingRepair: async (
    _job: string,
    run: () => Promise<unknown>,
    commit: (mutate: (tx: Transaction) => Promise<void>) => Promise<void>
  ) => {
    mockRunner = commit;
    try {
      return await run();
    } finally {
      mockRunner = undefined;
    }
  },
}));
import {
  prepareLocalSermonDeletionRepair,
  runLocalSermonDeletionRepair,
  localSermonDeletionHeaderProjection,
  validateLocalSermonDeletionRepairEvidence,
} from './localSermonDeletionRepair';
import { sermonDeletionMirrorPlanId, SERMON_DELETION_MIRROR_PLANS } from '../../helpers/sermonDeletionMirrors';
import { acknowledgedProjectionDigest } from './criticalAcknowledgedRepair';
import { desiredProviderDeletionDocumentFingerprint } from '../../../../packages/orchestration/src/provider-usage';
const ref = { projectId: 'project', jobId: 'job' };
type Data = Record<string, unknown>;
const field = (value: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (current, key) => (current && typeof current === 'object' ? (current as Data)[key] : undefined),
      value
    );
function fixture() {
  const data = new Map<string, Data>(),
    originalRoot = { id: 'sermon', title: 'Local', uploaderId: 'owner' },
    planId = sermonDeletionMirrorPlanId(ref, 'sermon');
  const intent = {
    schemaVersion: 1,
    ...ref,
    kind: 'sermon.delete',
    generation: 1,
    entity: { type: 'sermon', id: 'sermon' },
    payload: { sermonId: 'sermon', action: 'delete', generation: 1 },
  };
  const header = {
    schemaVersion: 1,
    ...ref,
    sermonId: 'sermon',
    planId,
    generation: 1,
    workflowId: 'workflow',
    state: 'prepared',
    intentFingerprint: desiredProviderDeletionDocumentFingerprint(intent),
    originalRoot,
    originalRootDigest: acknowledgedProjectionDigest(originalRoot),
    pointerClearRootDigest: acknowledgedProjectionDigest(originalRoot),
    requests: [],
    verifications: [],
  };
  data.set('durableJobIntents/job', intent);
  data.set('durableJobs/job', { ...intent, state: 'needs_attention', workflowId: 'workflow', revision: 4 });
  data.set('sermons/sermon', originalRoot);
  data.set(`${SERMON_DELETION_MIRROR_PLANS}/${planId}`, header);
  const reference = (path: string): any => ({ path, id: path.split('/').at(-1) });
  const snapshot = (path: string): any => ({
    id: path.split('/').at(-1),
    ref: reference(path),
    exists: data.has(path),
    data: () => data.get(path),
    get: (key: string) => field(data.get(path), key),
  });
  const query = (path: string, filters: Array<[string, unknown]> = [], limit = Infinity): any => ({
    where: (key: string, _op: string, value: unknown) => query(path, [...filters, [key, value]], limit),
    limit: (value: number) => query(path, filters, value),
    fetch: () => {
      const docs = [...data.keys()]
        .filter(
          (key) =>
            key.startsWith(path + '/') &&
            key.split('/').length === path.split('/').length + 1 &&
            filters.every(([name, value]) => field(data.get(key), name) === value)
        )
        .slice(0, limit)
        .map(snapshot);
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });
  const tx = { get: async (target: any) => (target.fetch ? target.fetch() : snapshot(target.path)) };
  const db = { doc: reference, collection: query };
  return {
    data,
    originalRoot,
    header,
    planId,
    headerPath: `${SERMON_DELETION_MIRROR_PLANS}/${planId}`,
    tx: tx as unknown as Transaction,
    db: db as unknown as Firestore,
  };
}
async function granted(f: ReturnType<typeof fixture>) {
  const source = await prepareLocalSermonDeletionRepair(f.tx, f.db, { ref, expectedRevision: 4 });
  f.data.set('durableJobCriticalRepairGrants/job', {
    schemaVersion: 1,
    ...ref,
    generation: 1,
    workflowId: 'workflow',
    actorUid: 'admin',
    commandId: 'command',
    certificateId: 'c'.repeat(64),
    intentFingerprint: acknowledgedProjectionDigest(f.data.get('durableJobIntents/job')),
    operations: [source.operation],
    sourceEvidenceDigests: [source.sourceEvidenceDigest],
  });
  return source;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockRunner = undefined;
});
it('prepares an actual source-captured local-root deletion operation, never an empty success certificate', async () => {
  const f = fixture(),
    source = await prepareLocalSermonDeletionRepair(f.tx, f.db, { ref, expectedRevision: 4 });
  expect(source.operation).toEqual({ kind: 'local_sermon_delete', planId: f.planId });
  expect(source.sourceEvidence.path).toBe(f.headerPath);
  expect(source.sourceEvidenceDigest).toMatch(/^[a-f0-9]{64}$/);
  source.commit();
  expect(f.data.get('sermons/sermon')).toEqual(f.originalRoot);
});
it.each(['subsplashId', 'soundCloudTrackId'])(
  'rejects a captured provider identity %s even with an empty request array',
  async (field) => {
    const f = fixture(),
      root = { ...f.originalRoot, [field]: 'remote' };
    f.data.set('sermons/sermon', root);
    f.data.set(f.headerPath, {
      ...f.header,
      originalRoot: root,
      originalRootDigest: acknowledgedProjectionDigest(root),
      pointerClearRootDigest: acknowledgedProjectionDigest(root),
    });
    await expect(prepareLocalSermonDeletionRepair(f.tx, f.db, { ref })).rejects.toThrow();
  }
);
it('rejects mutable requests, missing private preparation, stale root SHA and arbitrary plan IDs', async () => {
  const f = fixture();
  f.data.set(f.headerPath, { ...f.header, requests: [{ method: 'DELETE' }] });
  await expect(prepareLocalSermonDeletionRepair(f.tx, f.db, { ref })).rejects.toThrow();
  f.data.set(f.headerPath, f.header);
  f.data.set('sermons/sermon', { ...f.originalRoot, title: 'Changed' });
  await expect(prepareLocalSermonDeletionRepair(f.tx, f.db, { ref })).rejects.toThrow();
  f.data.delete(f.headerPath);
  await expect(prepareLocalSermonDeletionRepair(f.tx, f.db, { ref })).rejects.toThrow();
  await expect(
    runLocalSermonDeletionRepair(
      ref,
      { kind: 'local_sermon_delete', planId: 'arbitrary' },
      { firestore: f.db, authorizeInTransaction: async () => {}, commitCurrent: async () => {} }
    )
  ).rejects.toThrow();
});
it('does not authorize missing-root cleanup without the original private root-removal checkpoint', async () => {
  const f = fixture();
  f.data.delete('sermons/sermon');
  await expect(prepareLocalSermonDeletionRepair(f.tx, f.db, { ref })).rejects.toThrow();
  f.data.set(f.headerPath, { ...f.header, state: 'root_removed' });
  await expect(prepareLocalSermonDeletionRepair(f.tx, f.db, { ref })).rejects.toThrow();
});
it('pins immutable captured authority while allowing its validated root-removal progress', async () => {
  const f = fixture(),
    before = await prepareLocalSermonDeletionRepair(f.tx, f.db, { ref });
  f.data.delete('sermons/sermon');
  f.data.set(f.headerPath, {
    ...f.header,
    state: 'root_removed',
    rootRemoval: {
      schemaVersion: 1,
      generation: 1,
      workflowId: 'workflow',
      intentFingerprint: f.header.intentFingerprint,
      rootSourceDigest: f.header.originalRootDigest,
      originalEvidenceDigest: desiredProviderDeletionDocumentFingerprint({
        localOnly: true,
        intentFingerprint: f.header.intentFingerprint,
      }),
      removedAtMillis: 123,
    },
  });
  const after = await prepareLocalSermonDeletionRepair(f.tx, f.db, { ref });
  expect(after.sourceEvidenceDigest).toBe(before.sourceEvidenceDigest);
  expect(localSermonDeletionHeaderProjection(f.data.get(f.headerPath)!)).toEqual(before.headerProjection);
});
it('revalidates the exact fresh administrator grant inside every delegated cleanup transaction', async () => {
  const f = fixture(),
    source = await granted(f),
    authorize = jest.fn(async () => {});
  mockRemove.mockImplementation(
    async (_db, _plan, options: { assertOriginalProviderEffects: (tx: Transaction) => Promise<void> }) => {
      for (let page = 0; page < 3; page++) await mockRunner!(async (tx) => options.assertOriginalProviderEffects(tx));
    }
  );
  const result = await runLocalSermonDeletionRepair(ref, source.operation, {
    firestore: f.db,
    authorizeInTransaction: authorize,
    commitCurrent: async (_ref, run) => run(f.tx),
  });
  expect(result).toEqual({ state: 'completed', planId: f.planId });
  expect(authorize).toHaveBeenCalledTimes(4);
  expect(mockRemove).toHaveBeenCalledWith(f.db, source.plan, expect.anything());
});
it('fresh administrator revocation blocks a later cleanup page without permitting extra work', async () => {
  const f = fixture(),
    source = await granted(f),
    authorize = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Error('admin revoked'));
  let completedPages = 0;
  mockRemove.mockImplementation(
    async (_db, _plan, options: { assertOriginalProviderEffects: (tx: Transaction) => Promise<void> }) => {
      for (let page = 0; page < 3; page++) {
        await mockRunner!(async (tx) => options.assertOriginalProviderEffects(tx));
        completedPages++;
      }
    }
  );
  await expect(
    runLocalSermonDeletionRepair(ref, source.operation, {
      firestore: f.db,
      authorizeInTransaction: authorize,
      commitCurrent: async (_ref, run) => run(f.tx),
    })
  ).rejects.toThrow('admin revoked');
  expect(completedPages).toBe(1);
});
it('does not override a provider session or original create receipt', async () => {
  const f = fixture();
  f.data.set('temporalProviderMutationSessions/session', { scope: ref, state: 'active' });
  await expect(prepareLocalSermonDeletionRepair(f.tx, f.db, { ref })).rejects.toThrow();
  f.data.delete('temporalProviderMutationSessions/session');
  f.data.set('temporalProviderReceipts/create', { ...ref, state: 'executing' });
  await expect(prepareLocalSermonDeletionRepair(f.tx, f.db, { ref })).rejects.toThrow();
});
it('requires a matching reviewed critical-cleanup authority for cancel_requested projection', async () => {
  const f = fixture(),
    source = await granted(f);
  f.data.set('durableJobs/job', { ...f.data.get('durableJobs/job'), state: 'cancel_requested' });
  const deps = {
    firestore: f.db,
    authorizeInTransaction: async () => {},
    commitCurrent: async (_ref: unknown, run: (tx: Transaction) => Promise<void>) => run(f.tx),
  };
  await expect(runLocalSermonDeletionRepair(ref, source.operation, deps)).rejects.toThrow();
  f.data.set('durableJobCancellationIntents/job', {
    ...ref,
    generation: 1,
    workflowId: 'workflow',
    purpose: 'critical_repair_cleanup',
    certificateId: 'c'.repeat(64),
  });
  mockRemove.mockResolvedValue(undefined);
  await expect(runLocalSermonDeletionRepair(ref, source.operation, deps)).resolves.toEqual({
    state: 'completed',
    planId: f.planId,
  });
});

it('validates exact immutable local evidence without mutating and rejects changed path or digest', async () => {
  const f = fixture(),
    source = await prepareLocalSermonDeletionRepair(f.tx, f.db, { ref });
  await validateLocalSermonDeletionRepairEvidence(f.tx, f.db, ref, source.sourceEvidence);
  expect(f.data.get('sermons/sermon')).toEqual(f.originalRoot);
  await expect(
    validateLocalSermonDeletionRepairEvidence(f.tx, f.db, ref, { ...source.sourceEvidence, path: 'sermons/sermon' })
  ).rejects.toThrow();
  await expect(
    validateLocalSermonDeletionRepairEvidence(f.tx, f.db, ref, { ...source.sourceEvidence, digest: 'f'.repeat(64) })
  ).rejects.toThrow();
});
