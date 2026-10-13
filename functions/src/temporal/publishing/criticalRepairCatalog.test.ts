import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { FixedRepairOperation } from './criticalRepair';
import {
  CRITICAL_REPAIR_SOURCE_CATALOGS,
  CRITICAL_REPAIR_CATALOGS,
  criticalRepairCatalogDigest,
  assertCriticalRepairCatalogClaimAllowed,
  assertV1PublishingSourceProducerBarrier,
  prepareCriticalRepairCatalogSourceAppend,
  prepareCriticalRepairCatalogSourceSeal,
  compileCriticalRepairCatalogPage,
  prepareCriticalRepairCatalog,
  readCertifiedCriticalRepairOperations,
  validateCertifiedCriticalRepairOperation,
  readCertifiedCriticalRepairDeleteSet,
  validateCertifiedCriticalRepairDeleteSet,
  validateCertifiedCriticalRepairDeletionPhase,
  readCriticalRepairCatalogStepAuthority,
  type CriticalRepairCatalogRoot,
} from './criticalRepairCatalog';

const ref = { projectId: 'urm-app', jobId: 'job-1' };
const effectPath = (id: number) =>
  `temporalPublishingEffectPlans/${ref.jobId}/operations/${criticalRepairCatalogDigest({ effect: id })}`;
const journalPath = (id: number) =>
  `temporalPublishingDeletionReceipts/${criticalRepairCatalogDigest({ journal: id })}`;
const effect = (id: number) => ({
  schemaVersion: 1,
  ...ref,
  reasonCode: 'UPDATE',
  provider: 'subsplash',
  resourceType: 'list-row',
  resourceId: `row-${id}`,
  accountId: 'app:9XTSHD',
  method: 'PATCH',
  requestFingerprint: criticalRepairCatalogDigest(id),
  plannedAtMillis: 123,
  sourceStepIds: ['delete'],
  sourceParentRef: { ...ref },
});
const journal = () => ({
  ...ref,
  sermonId: 'sermon-1',
  provider: 'subsplash',
  remoteId: 'media-1',
  originalAccount: 'app:9XTSHD',
  authorizedAtMillis: 123,
  ownershipConfirmedBeforeDelete: true,
  state: 'authorized',
  sourceStepIds: ['delete'],
  sourceParentRef: { ...ref },
});
const barrier = async () => ({ allSourceWritersEnrolled: true as const, originalSourceProgramsFrozen: true as const });

/** Models atomic rollback and Firestore's read-before-write rule; no Firebase/vendor access. */
function memoryFirestore() {
  const records = new Map<string, unknown>(),
    versions = new Map<string, number>(),
    metrics = { maxGetAll: 0, maxWrites: 0, transactions: 0, totalReads: 0 },
    failure = { beforeCommit: false };
  const doc = (path: string): any => ({
    path,
    collection: (name: string) => ({ doc: (id: string) => doc(`${path}/${name}/${id}`) }),
  });
  const db = {
    doc,
    collection: (name: string) => ({ doc: (id: string) => doc(`${name}/${id}`) }),
  } as unknown as Firestore;
  const transact = async <T>(run: (tx: Transaction) => Promise<T>): Promise<T> => {
    const writes: Array<{ path: string; value: unknown; create: boolean }> = [];
    const readVersions = new Map<string, number>();
    let wrote = false;
    const snapshot = (path: string): any => {
      readVersions.set(path, versions.get(path) ?? 0);
      const value = records.get(path);
      return {
        exists: records.has(path),
        ref: doc(path),
        data: () => value,
      };
    };
    const tx = {
      get: async (target: { path: string }) => {
        if (wrote) throw new Error('READ_AFTER_WRITE');
        metrics.totalReads++;
        return snapshot(target.path);
      },
      getAll: async (...targets: Array<{ path: string }>) => {
        if (wrote) throw new Error('READ_AFTER_WRITE');
        metrics.totalReads += targets.length;
        metrics.maxGetAll = Math.max(metrics.maxGetAll, targets.length);
        return targets.map((target) => snapshot(target.path));
      },
      create: (target: { path: string }, value: unknown) => {
        wrote = true;
        writes.push({ path: target.path, value, create: true });
      },
      set: (target: { path: string }, value: unknown) => {
        wrote = true;
        writes.push({ path: target.path, value, create: false });
      },
    } as unknown as Transaction;
    const result = await run(tx);
    if (failure.beforeCommit) {
      failure.beforeCommit = false;
      throw new Error('INTERRUPTED');
    }
    for (const [path, version] of readVersions)
      if ((versions.get(path) ?? 0) !== version) throw new Error('TX_CONFLICT');
    for (const write of writes)
      if (write.create && (records.has(write.path) || writes.filter((other) => other.path === write.path).length > 1))
        throw new Error('ALREADY_EXISTS');
    for (const write of writes) {
      records.set(write.path, write.value);
      versions.set(write.path, (versions.get(write.path) ?? 0) + 1);
    }
    metrics.maxWrites = Math.max(metrics.maxWrites, writes.length);
    metrics.transactions++;
    return result;
  };
  (db as unknown as { runTransaction: typeof transact }).runTransaction = transact;
  const fence = {
    commitCurrent: async (_ref: typeof ref, mutate: (tx: Transaction) => Promise<void>) => transact(mutate),
  };
  records.set(`durableJobs/${ref.jobId}`, {
    ...ref,
    generation: 1,
    workflowId: 'workflow-1',
    state: 'needs_attention',
    steps: [{ id: 'delete' }],
  });
  records.set(`durableJobIntents/${ref.jobId}`, {
    ...ref,
    generation: 1,
    kind: 'sermon.delete',
    publishingSourceProtocol: 'publishing-source-catalog-v1',
    entity: { type: 'sermon', id: 'sermon-1' },
    payload: { payload: { sermon: { subsplashId: 'media-1' } } },
  });
  records.set(`durableJobCriticalSections/${ref.jobId}`, {
    ...ref,
    generation: 1,
    workflowId: 'workflow-1',
    reasonCode: 'DELETE',
  });
  const append = async (path: string, value: unknown) =>
    transact(async (tx) => {
      const plan = await prepareCriticalRepairCatalogSourceAppend(tx, db, ref, { sourcePath: path, source: value });
      plan.commit();
      if (!records.has(path)) tx.create(db.doc(path), value);
    });
  const seal = async () =>
    transact(async (tx) => {
      const plan = await prepareCriticalRepairCatalogSourceSeal(tx, db, ref, barrier);
      plan.commit();
      return plan.sealDigest;
    });
  const finish = async () => {
    for (;;) {
      const result = await compileCriticalRepairCatalogPage(db, ref, fence);
      if (result.state === 'ready') return result.root;
    }
  };
  return { records, db, transact, fence, failure, metrics, append, seal, finish };
}

describe('bounded critical repair catalogs', () => {
  it('keeps the original catalog and first-claim freeze through approved administrator cleanup without treating it as user cancellation', async () => {
    const m = memoryFirestore();
    await m.append(effectPath(1), effect(1));
    await m.seal();
    const original = await m.finish();
    const jobPath = `durableJobs/${ref.jobId}`,
      job = m.records.get(jobPath) as Record<string, unknown>;
    m.records.set(jobPath, {
      ...job,
      state: 'cancel_requested',
      revision: 12,
      result: { resolutionPurpose: 'cleanup' },
    });
    m.records.set(`durableJobCancellationIntents/${ref.jobId}`, {
      schemaVersion: 1,
      ...ref,
      generation: 1,
      workflowId: 'workflow-1',
      purpose: 'critical_repair_cleanup',
      acceptedUserCancellation: false,
      certificateId: 'a'.repeat(64),
      actorUid: 'fresh-admin',
      authorizedAt: 123,
      reviewCommandId: 'review-1',
    });
    expect(await m.transact((tx) => prepareCriticalRepairCatalog(tx, m.db, ref))).toEqual(original);
    await expect(m.transact((tx) => assertCriticalRepairCatalogClaimAllowed(tx, m.db, ref))).rejects.toThrow();
    await expect(m.append(effectPath(2), effect(2))).rejects.toThrow();
    const cancellation = m.records.get(`durableJobCancellationIntents/${ref.jobId}`) as Record<string, unknown>;
    m.records.set(`durableJobCancellationIntents/${ref.jobId}`, { ...cancellation, purpose: 'user_cancellation' });
    await expect(m.transact((tx) => prepareCriticalRepairCatalog(tx, m.db, ref))).rejects.toThrow(
      'accepted user cancellation changed'
    );
  });
  it('pins original step metadata, excludes foreign or inferred IDs, and summarizes actual source steps without a fleet scan', async () => {
    const m = memoryFirestore();
    await expect(m.append(effectPath(1), { ...effect(1), sourceStepIds: undefined })).rejects.toThrow();
    await expect(m.append(effectPath(1), { ...effect(1), sourceStepIds: ['inferred'] })).rejects.toThrow();
    await expect(
      m.append(effectPath(1), { ...effect(1), sourceParentRef: { ...ref, jobId: 'foreign' } })
    ).rejects.toThrow();
    await m.append(effectPath(1), effect(1));
    await m.seal();
    const root = await m.finish();
    expect(await m.transact((tx) => readCriticalRepairCatalogStepAuthority(tx, m.db, ref, root))).toEqual({
      sourceParentRef: ref,
      sourceStepIds: ['delete'],
      sourceCount: 1,
    });
    m.records.set(effectPath(1), { ...effect(1), sourceStepIds: ['other'] });
    const read = {
      kind: 'provider_read' as const,
      provider: 'subsplash' as const,
      resourceType: 'list-row' as const,
      resourceId: 'row-1',
      accountId: 'app:9XTSHD',
      method: 'GET' as const,
    };
    await expect(
      m.transact((tx) => validateCertifiedCriticalRepairOperation(tx, m.db, ref, root, read))
    ).rejects.toThrow();
  });
  it('validates the complete DELETE set with scalar count/digest and rejects a omitted, substituted, or repeated target', async () => {
    const m = memoryFirestore(),
      intentPath = `durableJobIntents/${ref.jobId}`,
      intent = m.records.get(intentPath) as Record<string, unknown>;
    m.records.set(intentPath, {
      ...intent,
      payload: { payload: { sermon: { subsplashId: 'media-1', soundCloudTrackId: 'track-1' } } },
    });
    await m.append(journalPath(1), journal());
    await m.append(journalPath(2), {
      ...journal(),
      provider: 'soundcloud',
      remoteId: 'track-1',
      originalAccount: 'soundcloud:users:12',
    });
    await m.seal();
    const root = await m.finish(),
      set = await readCertifiedCriticalRepairDeleteSet(m.db, ref, root);
    expect(set.count).toBe(2);
    await m.transact((tx) => validateCertifiedCriticalRepairDeleteSet(tx, m.db, ref, root, set));
    await expect(
      m.transact((tx) => validateCertifiedCriticalRepairDeleteSet(tx, m.db, ref, root, set.operations.slice(0, 1)))
    ).rejects.toThrow();
    await expect(
      m.transact((tx) =>
        validateCertifiedCriticalRepairDeleteSet(tx, m.db, ref, root, [set.operations[0], set.operations[0]])
      )
    ).rejects.toThrow();
    await expect(
      m.transact((tx) =>
        validateCertifiedCriticalRepairDeleteSet(tx, m.db, ref, root, [
          set.operations[0],
          { ...set.operations[1], resourceId: 'foreign' },
        ])
      )
    ).rejects.toThrow();
    await expect(
      m.transact((tx) =>
        validateCertifiedCriticalRepairDeleteSet(tx, m.db, ref, root, { ...set, digest: '0'.repeat(64) })
      )
    ).rejects.toThrow();
  });
  it('separates NEW DELETE authority from original immutable DELETE replay/closure after confirmed absence', async () => {
    const m = memoryFirestore();
    await m.append(journalPath(1), journal());
    await m.seal();
    const root = await m.finish(),
      set = await readCertifiedCriticalRepairDeleteSet(m.db, ref, root),
      op = set.operations[0];
    await m.transact((tx) => validateCertifiedCriticalRepairDeletionPhase(tx, m.db, ref, root, op, 'claim'));
    m.records.set(journalPath(1), { ...journal(), state: 'absence_confirmed' });
    for (const phase of ['claim'] as const)
      await expect(
        m.transact((tx) => validateCertifiedCriticalRepairDeletionPhase(tx, m.db, ref, root, op, phase))
      ).rejects.toThrow();
    for (const phase of ['acquire', 'replay', 'close', 'settle'] as const)
      await m.transact((tx) => validateCertifiedCriticalRepairDeletionPhase(tx, m.db, ref, root, op, phase));
    await expect(
      m.transact((tx) =>
        validateCertifiedCriticalRepairDeletionPhase(tx, m.db, ref, root, { ...op, resourceId: 'different' }, 'replay')
      )
    ).rejects.toThrow();
    m.records.set(journalPath(1), { ...journal(), state: 'absence_confirmed', originalAccount: 'app:foreign' });
    await expect(
      m.transact((tx) => validateCertifiedCriticalRepairDeletionPhase(tx, m.db, ref, root, op, 'close'))
    ).rejects.toThrow();
  });
  it('refuses incomplete original fixed programs before registering their readiness', async () => {
    const m = memoryFirestore();
    await expect(m.append(effectPath(1), { ...effect(1), plannedAtMillis: undefined })).rejects.toThrow();
    await expect(m.append(journalPath(1), { ...journal(), authorizedAtMillis: undefined })).rejects.toThrow();
    expect(m.records.has(`${CRITICAL_REPAIR_SOURCE_CATALOGS}/${ref.jobId}`)).toBe(false);
  });
  it('derives actual producer barrier and rejects old, forged protocol, unregistered roots, or corrupt chain', async () => {
    const m = memoryFirestore();
    await m.append(effectPath(1), effect(1));
    expect(await m.transact((tx) => assertV1PublishingSourceProducerBarrier(tx, m.db, ref))).toEqual({
      allSourceWritersEnrolled: true,
      originalSourceProgramsFrozen: true,
    });
    const intentPath = `durableJobIntents/${ref.jobId}`,
      intent = m.records.get(intentPath) as Record<string, unknown>;
    m.records.set(intentPath, { ...intent, publishingSourceProtocol: undefined });
    await expect(m.seal()).rejects.toThrow();
    await expect(m.transact((tx) => assertCriticalRepairCatalogClaimAllowed(tx, m.db, ref))).rejects.toThrow();
    m.records.set(intentPath, intent);
    const rootPath = `${CRITICAL_REPAIR_SOURCE_CATALOGS}/${ref.jobId}`,
      root = m.records.get(rootPath) as Record<string, unknown>;
    m.records.set(rootPath, { ...root, sourceProgramChainDigest: '0'.repeat(64) });
    await expect(m.seal()).rejects.toThrow();
  });
  it('serializes an already-enrolled first claim against the seal and prevents its retry from sending', async () => {
    const m = memoryFirestore();
    await m.append(effectPath(1), effect(1));
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const claim = m.transact(async (tx) => {
      await assertCriticalRepairCatalogClaimAllowed(tx, m.db, ref);
      entered();
      await blocked;
      tx.create(m.db.doc('syntheticClaims/first'), { sending: true });
    });
    await ready;
    await m.seal();
    release();
    await expect(claim).rejects.toThrow('TX_CONFLICT');
    expect(m.records.has('syntheticClaims/first')).toBe(false);
    await expect(m.transact((tx) => assertCriticalRepairCatalogClaimAllowed(tx, m.db, ref))).rejects.toThrow();
    const root = await m.finish();
    expect(root.sourceCount).toBe(1);
    expect(root.operationCount).toBe(1);
  });
  it('retains a first claim serialized before seal without declaring it completed; cached original ACK lookup can precede the gate', async () => {
    const m = memoryFirestore();
    await m.append(effectPath(1), effect(1));
    await m.transact(async (tx) => {
      await assertCriticalRepairCatalogClaimAllowed(tx, m.db, ref);
      tx.create(m.db.doc('syntheticClaims/first'), { state: 'unknown' });
    });
    await m.seal();
    const root = await m.finish();
    expect(root.sourceCount).toBe(1);
    expect(m.records.get('syntheticClaims/first')).toEqual({ state: 'unknown' });
    m.records.set('syntheticFacts/exactOriginalAck', { state: 'acknowledged', originalResult: 'fixed' });
    const replay = await m.transact(async (tx) => {
      const exact = await tx.get(m.db.doc('syntheticFacts/exactOriginalAck'));
      if (exact.exists) return exact.data();
      await assertCriticalRepairCatalogClaimAllowed(tx, m.db, ref);
      throw new Error('NO_ORIGINAL_ACK');
    });
    expect(replay).toEqual({ state: 'acknowledged', originalResult: 'fixed' });
  });
  it('uses identical public Date/Timestamp millisecond digests across Firestore serialization', () => {
    expect(criticalRepairCatalogDigest({ b: undefined, a: new Date(123) })).toBe(
      criticalRepairCatalogDigest({ a: { toMillis: () => 123, _seconds: 999 } })
    );
    expect(() => criticalRepairCatalogDigest(new Date(NaN))).toThrow();
    expect(() => criticalRepairCatalogDigest({ toMillis: () => Infinity })).toThrow();
    expect(criticalRepairCatalogDigest([1, 2])).not.toBe(criticalRepairCatalogDigest([2, 1]));
  });
  it('compiles >1001 effects and >1001 journals, with >2000 unique operations and only bounded pages', async () => {
    const m = memoryFirestore();
    for (let id = 0; id < 2002; id++) await m.append(effectPath(id), effect(id));
    for (let id = 0; id < 1002; id++) await m.append(journalPath(id), journal());
    await m.seal();
    const root = await m.finish();
    expect(root.sourceCount).toBe(3004);
    expect(root.operationCount).toBe(2005);
    expect(root.ready).toBe(true);
    const all: FixedRepairOperation[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = await m.transact((tx) => readCertifiedCriticalRepairOperations(tx, m.db, ref, root, cursor!));
      expect(page.entries.length).toBeLessThanOrEqual(32);
      all.push(...page.entries.map((entry) => entry.operation));
      cursor = page.nextCursor;
    }
    expect(all).toHaveLength(2005);
    expect(new Set(all.map(criticalRepairCatalogDigest)).size).toBe(2005);
    expect(m.metrics.maxGetAll).toBeLessThanOrEqual(34);
    expect(m.metrics.maxWrites).toBeLessThanOrEqual(40);
    const before = m.metrics.totalReads;
    const deletes = await readCertifiedCriticalRepairDeleteSet(m.db, ref, root);
    expect(deletes.count).toBe(1);
    expect(m.metrics.totalReads - before).toBeLessThan(20);
    await m.transact((tx) => validateCertifiedCriticalRepairDeleteSet(tx, m.db, ref, root, deletes));
    expect(await m.transact((tx) => readCriticalRepairCatalogStepAuthority(tx, m.db, ref, root))).toEqual({
      sourceParentRef: ref,
      sourceStepIds: ['delete'],
      sourceCount: 3004,
    });
    await m.transact((tx) => validateCertifiedCriticalRepairOperation(tx, m.db, ref, root, all[2001]));
    expect(await m.finish()).toEqual(root);
  });
  it('rolls back an interrupted page, then resumes with identical immutable pages and checkpoint', async () => {
    const m = memoryFirestore();
    for (let id = 0; id < 65; id++) await m.append(effectPath(id), effect(id));
    await m.seal();
    m.failure.beforeCommit = true;
    await expect(compileCriticalRepairCatalogPage(m.db, ref, m.fence)).rejects.toThrow('INTERRUPTED');
    expect([...m.records.keys()].some((path) => path.startsWith(`${CRITICAL_REPAIR_CATALOGS}/`))).toBe(false);
    const first = await compileCriticalRepairCatalogPage(m.db, ref, m.fence);
    expect(first.state).toBe('pending');
    expect(first.root.sourceCursor).toBe(32);
    const savedPage = m.records.get(`${CRITICAL_REPAIR_CATALOGS}/${first.root.catalogId}/pages/0000000000000000`);
    const complete = await m.finish();
    expect(complete.operationCount).toBe(65);
    expect(m.records.get(`${CRITICAL_REPAIR_CATALOGS}/${first.root.catalogId}/pages/0000000000000000`)).toBe(savedPage);
    expect(await m.transact((tx) => prepareCriticalRepairCatalog(tx, m.db, ref))).toEqual(complete);
  });
  it('requires a real source insertion barrier, rejects post-seal insertion, and permits only identical registration replay', async () => {
    const m = memoryFirestore();
    await m.append(effectPath(1), effect(1));
    await expect(
      m.transact((tx) =>
        prepareCriticalRepairCatalogSourceSeal(tx, m.db, ref, async () => {
          throw new Error('PROGRAM_NOT_FROZEN');
        })
      )
    ).rejects.toThrow('PROGRAM_NOT_FROZEN');
    await expect(compileCriticalRepairCatalogPage(m.db, ref, m.fence)).rejects.toThrow();
    const id = await m.seal();
    expect(await m.seal()).toBe(id);
    await m.append(effectPath(1), effect(1));
    await expect(m.append(effectPath(2), effect(2))).rejects.toThrow();
    await expect(m.append(effectPath(1), { ...effect(1), resourceId: 'foreign' })).rejects.toThrow();
    expect((m.records.get(`${CRITICAL_REPAIR_SOURCE_CATALOGS}/${ref.jobId}`) as { count: number }).count).toBe(1);
  });
  it('does not infer completion from a missing ordinal or a changed original source', async () => {
    const m = memoryFirestore();
    await m.append(effectPath(1), effect(1));
    await m.seal();
    m.records.delete(`${CRITICAL_REPAIR_SOURCE_CATALOGS}/${ref.jobId}/entries/0000000000000000`);
    await expect(m.finish()).rejects.toThrow();
    const n = memoryFirestore();
    await n.append(effectPath(1), effect(1));
    await n.seal();
    n.records.set(effectPath(1), { ...effect(1), resourceId: 'foreign' });
    await expect(n.finish()).rejects.toThrow();
  });
  it('validates exact operation membership and original source rather than granting the entire page', async () => {
    const m = memoryFirestore();
    await m.append(effectPath(1), effect(1));
    await m.seal();
    const root = await m.finish(),
      op = {
        kind: 'provider_read' as const,
        provider: 'subsplash' as const,
        resourceType: 'list-row' as const,
        resourceId: 'row-1',
        accountId: 'app:9XTSHD',
        method: 'GET' as const,
      };
    await m.transact((tx) => validateCertifiedCriticalRepairOperation(tx, m.db, ref, root, op));
    await expect(
      m.transact((tx) => validateCertifiedCriticalRepairOperation(tx, m.db, ref, root, { ...op, resourceId: 'row-2' }))
    ).rejects.toThrow();
    m.records.set(effectPath(1), { ...effect(1), accountId: 'app:foreign' });
    await expect(
      m.transact((tx) => validateCertifiedCriticalRepairOperation(tx, m.db, ref, root, op))
    ).rejects.toThrow();
  });
  it.each(['generation', 'project', 'intent', 'critical', 'terminal'])(
    'rejects %s drift before compilation or certified dispatch',
    async (drift) => {
      const m = memoryFirestore();
      await m.append(effectPath(1), effect(1));
      await m.seal();
      const root = await m.finish();
      const path =
          drift === 'critical'
            ? `durableJobCriticalSections/${ref.jobId}`
            : drift === 'intent'
            ? `durableJobIntents/${ref.jobId}`
            : `durableJobs/${ref.jobId}`,
        old = m.records.get(path) as Record<string, unknown>;
      m.records.set(path, {
        ...old,
        ...(drift === 'generation'
          ? { generation: 2 }
          : drift === 'project'
          ? { projectId: 'foreign' }
          : drift === 'intent'
          ? { kind: 'sermon.update' }
          : drift === 'critical'
          ? { reasonCode: 'DIFFERENT' }
          : { state: 'succeeded' }),
      });
      await expect(compileCriticalRepairCatalogPage(m.db, ref, m.fence)).rejects.toThrow();
      await expect(m.transact((tx) => readCertifiedCriticalRepairOperations(tx, m.db, ref, root, 0))).rejects.toThrow();
    }
  );
  it('invalidates a pre-cancellation DELETE catalog and allows only a new read/canonical catalog after accepted cancellation', async () => {
    const m = memoryFirestore();
    await m.append(journalPath(1), journal());
    await m.seal();
    const previous = await m.finish();
    expect(previous.operationCount).toBe(3);
    const deleteOp = {
      kind: 'provider_delete' as const,
      provider: 'subsplash' as const,
      resourceType: 'media' as const,
      resourceId: 'media-1',
      accountId: 'app:9XTSHD',
      method: 'DELETE' as const,
    };
    await m.transact((tx) => validateCertifiedCriticalRepairOperation(tx, m.db, ref, previous, deleteOp));
    m.records.set(`durableJobCancellationIntents/${ref.jobId}`, { purpose: 'user_cancel' });
    await expect(
      m.transact((tx) => validateCertifiedCriticalRepairOperation(tx, m.db, ref, previous, deleteOp))
    ).rejects.toThrow();
    await m.seal();
    const current = await m.finish();
    expect(current.catalogId).not.toBe(previous.catalogId);
    expect(current.acceptedUserCancellation).toBe(true);
    expect(current.operationCount).toBe(2);
    await expect(
      m.transact((tx) => validateCertifiedCriticalRepairOperation(tx, m.db, ref, current, deleteOp))
    ).rejects.toThrow();
    m.records.delete(`durableJobCancellationIntents/${ref.jobId}`);
    await expect(m.seal()).rejects.toThrow();
  });
  it('never reauthorizes DELETE when the original journal has progressed to confirmed absence', async () => {
    const m = memoryFirestore();
    await m.append(journalPath(1), journal());
    await m.seal();
    const root = await m.finish();
    m.records.set(journalPath(1), { ...journal(), state: 'absence_confirmed' });
    const deleteOp = {
      kind: 'provider_delete' as const,
      provider: 'subsplash' as const,
      resourceType: 'media' as const,
      resourceId: 'media-1',
      accountId: 'app:9XTSHD',
      method: 'DELETE' as const,
    };
    await expect(
      m.transact((tx) => validateCertifiedCriticalRepairOperation(tx, m.db, ref, root, deleteOp))
    ).rejects.toThrow();
    await m.transact((tx) =>
      validateCertifiedCriticalRepairOperation(tx, m.db, ref, root, {
        ...deleteOp,
        kind: 'provider_read',
        method: 'GET',
      })
    );
  });
  it('rejects corrupted page body, membership digest, cursor, and pinned root', async () => {
    const m = memoryFirestore();
    await m.append(effectPath(1), effect(1));
    await m.seal();
    const root = await m.finish();
    await expect(
      m.transact((tx) =>
        readCertifiedCriticalRepairOperations(
          tx,
          m.db,
          ref,
          { ...root, operationCount: 2 } as CriticalRepairCatalogRoot,
          0
        )
      )
    ).rejects.toThrow();
    await expect(m.transact((tx) => readCertifiedCriticalRepairOperations(tx, m.db, ref, root, -1))).rejects.toThrow();
    const pagePath = `${CRITICAL_REPAIR_CATALOGS}/${root.catalogId}/pages/0000000000000000`,
      page = m.records.get(pagePath) as Record<string, unknown>;
    m.records.set(pagePath, { ...page, entries: [] });
    await expect(m.transact((tx) => readCertifiedCriticalRepairOperations(tx, m.db, ref, root, 0))).rejects.toThrow();
  });
  it('supports an explicitly frozen zero-source catalog without granting a provider effect', async () => {
    const m = memoryFirestore();
    await m.seal();
    const root = await m.finish();
    expect(root.operationCount).toBe(0);
    expect(root.pageCount).toBe(0);
    expect(await m.transact((tx) => readCertifiedCriticalRepairOperations(tx, m.db, ref, root, 0))).toEqual({
      entries: [],
      nextCursor: null,
    });
  });
  it('rejects a source that would exceed the 32-document transaction byte allowance before any producer write', async () => {
    const m = memoryFirestore();
    await expect(
      m.append(effectPath(1), { ...effect(1), canonicalPaths: ['sermons/' + 'x'.repeat(50_000)] })
    ).rejects.toThrow();
    expect(m.records.has(effectPath(1))).toBe(false);
    expect(m.records.has(`${CRITICAL_REPAIR_SOURCE_CATALOGS}/${ref.jobId}`)).toBe(false);
  });
  it('propagates fresh actor/SDK fence rejection before any candidate write', async () => {
    const m = memoryFirestore();
    await m.append(effectPath(1), effect(1));
    await m.seal();
    await expect(
      compileCriticalRepairCatalogPage(m.db, ref, {
        commitCurrent: async () => {
          throw new Error('SDK_DRAINED');
        },
      })
    ).rejects.toThrow('SDK_DRAINED');
    expect([...m.records.keys()].some((path) => path.startsWith(`${CRITICAL_REPAIR_CATALOGS}/`))).toBe(false);
  });
});
