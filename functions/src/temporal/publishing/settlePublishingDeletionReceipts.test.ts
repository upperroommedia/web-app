jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: 'project' } }) },
}));
jest.mock('../../../../packages/orchestration/src/provider-usage', () => ({
  ...jest.requireActual('../../../../packages/orchestration/src/provider-usage'),
  prepareDesiredProviderDeletionSettlement: jest.fn(async (_tx, _db, input) => {
    if (mockIndexPending) throw new Error('PROVIDER_DESIRED_DELETION_SETTLEMENT_PENDING');
    return () => mockSettled.push(input);
  }),
}));
import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  settlePublishingDeletionReceipts,
  PublishingDeletionSettlementPendingError,
} from './settlePublishingDeletionReceipts';
import { providerMutationFingerprint as hash } from './providerMutationGuard';
import { acknowledgedProjectionDigest as digest } from './criticalAcknowledgedRepair';
import { publishingMutationRequestFingerprint } from './durableOperationContext';
import { desiredProviderDeletionIntentFingerprint } from '../../../../packages/orchestration/src/provider-usage';

let mockIndexPending = false;
let mockSettled: any[] = [];
const ref = { projectId: 'project', jobId: 'job' };
function fixture(count = 1, provider: 'subsplash' | 'soundcloud' = 'subsplash') {
  const data = new Map<string, any>(),
    queryLimits: number[] = [];
  let fences = 0;
  const doc = (path: string): any => ({
    path,
    id: path.split('/').pop(),
    collection: (name: string) => query(`${path}/${name}`),
  });
  const snap = (path: string): any => ({
    ref: doc(path),
    id: path.split('/').pop(),
    exists: data.has(path),
    data: () => (data.has(path) ? JSON.parse(JSON.stringify(data.get(path))) : undefined),
    get: (field: string) =>
      field
        .split('.')
        .reduce((v, k) => v?.[k], data.has(path) ? JSON.parse(JSON.stringify(data.get(path))) : undefined),
  });
  const query = (path: string, filters: any[] = [], limit = Infinity, cursor = ''): any => ({
    _query: true,
    doc: (id: string) => doc(`${path}/${id}`),
    where: (field: string, op: string, value: unknown) => query(path, [...filters, [field, op, value]], limit, cursor),
    orderBy: () => query(path, filters, limit, cursor),
    limit: (n: number) => {
      queryLimits.push(n);
      return query(path, filters, n, cursor);
    },
    startAfter: (value: any) => query(path, filters, limit, value.ref.path),
    get: async () => {
      const paths = [...data.keys()]
        .filter(
          (key) =>
            key > cursor &&
            key.startsWith(`${path}/`) &&
            key.split('/').length === path.split('/').length + 1 &&
            filters.every(([field, op, value]) =>
              op === 'in' ? value.includes(snap(key).get(field)) : snap(key).get(field) === value
            )
        )
        .sort()
        .slice(0, limit);
      return { docs: paths.map(snap), size: paths.length, empty: !paths.length };
    },
  });
  const db: any = {
    doc,
    collection: query,
    runTransaction: async (fn: any) => {
      let writing = false;
      const writes: Array<() => void> = [];
      const tx = {
        get: async (r: any) => {
          if (writing) throw new Error('read after write');
          return r._query ? r.get() : snap(r.path);
        },
        getAll: async (...rs: any[]) => {
          if (writing) throw new Error('read after write');
          return rs.map((r) => snap(r.path));
        },
        update: (r: any, value: any) => {
          writing = true;
          writes.push(() => data.set(r.path, { ...data.get(r.path), ...JSON.parse(JSON.stringify(value)) }));
        },
      };
      await fn(tx);
      for (const write of writes) write();
    },
  };
  const intent = {
    schemaVersion: 1,
    ...ref,
    kind: 'sermon.unpublish',
    entity: { type: 'sermon', id: 'sermon' },
    actorUid: 'actor',
    generation: 1,
    payload: { sermonId: 'sermon', action: 'unpublish' },
    createdAt: 1,
  };
  data.set('durableJobIntents/job', intent);
  data.set('durableJobs/job', { ...intent, state: 'running' });
  const receiptPaths: string[] = [],
    requestPaths: string[] = [],
    sessionPaths: string[] = [],
    factPaths: string[] = [];
  for (let n = 0; n < count; n++) {
    const remoteId = `${n + 1}`,
      account = provider === 'subsplash' ? 'app:9XTSHD' : 'soundcloud:users:123';
    const receiptId = createHash('sha256')
      .update(JSON.stringify([ref.projectId, ref.jobId, provider, remoteId]))
      .digest('hex');
    const receiptPath = `temporalPublishingDeletionReceipts/${receiptId}`;
    receiptPaths.push(receiptPath);
    data.set(receiptPath, {
      ...ref,
      sermonId: 'sermon',
      provider,
      remoteId,
      originalAccount: account,
      state: 'absence_confirmed',
      ownershipConfirmedBeforeDelete: true,
      absenceProof: 'authenticated_fixed_id_get_404_410',
    });
    const scope = { ...ref, operation: `delete-${remoteId}` },
      sessionId = hash(scope),
      sessionPath = `temporalProviderMutationSessions/${sessionId}`;
    const target = {
      provider,
      account,
      resourceType: provider === 'subsplash' ? 'media' : 'track',
      resourceId: remoteId,
    };
    sessionPaths.push(sessionPath);
    data.set(sessionPath, { schemaVersion: 1, scope, resources: [target], state: 'committed' });
    const step = `delete:${provider}:${remoteId}`,
      fingerprint = publishingMutationRequestFingerprint({ method: 'DELETE', target, payload: { id: remoteId } });
    const requestPath = `${sessionPath}/requests/${hash(step)}`,
      claim = `claim-${remoteId}`,
      executionId = 'original';
    requestPaths.push(requestPath);
    data.set(requestPath, {
      step,
      method: 'DELETE',
      fingerprint,
      claim,
      executionId,
      state: 'acknowledged',
      result: null,
    });
    const factPath = `temporalProviderMutationFacts/${hash([sessionId, step, claim])}`;
    factPaths.push(factPath);
    data.set(factPath, { sessionId, step, fingerprint, claim, executionId, completion: 'acknowledged', result: null });
    const request = { step, method: 'DELETE', target, fingerprint, payload: { id: remoteId } },
      page = { requests: [request], finalFragment: true },
      pageDigest = digest(page);
    const sourcePath = `temporalPublishingAcknowledgedProjections/${sessionId}`,
      intentFingerprint = desiredProviderDeletionIntentFingerprint(intent);
    data.set(sourcePath, {
      schemaVersion: 2,
      ...scope,
      sessionId,
      intentFingerprint,
      pageCount: 1,
      requestCount: 1,
      chainDigest: digest([]),
      completesActivity: false,
      uiStepIds: [],
    });
    data.set(`${sourcePath}/pages/${pageDigest}`, page);
    data.set(`${sourcePath}/requestIndex/${hash(step)}`, {
      request,
      intentFingerprint,
      ready: true,
      pageDigest,
      readyPageDigest: pageDigest,
    });
  }
  return {
    db: db as Firestore,
    data,
    receiptPaths,
    requestPaths,
    sessionPaths,
    factPaths,
    queryLimits,
    store: {
      commitCurrent: async (_ref: any, fn: any) => {
        fences++;
        await db.runTransaction(fn);
      },
    },
    getFences: () => fences,
  };
}

describe('provider deletion receipt settlement', () => {
  beforeEach(() => {
    mockIndexPending = false;
    mockSettled = [];
  });
  it('settles original acknowledged deletion only after a fresh fenced proof read', async () => {
    const f = fixture();
    await settlePublishingDeletionReceipts(f.db, ref, f.store);
    expect(mockSettled).toEqual([
      {
        resource: { projectId: 'project', provider: 'subsplash', account: 'app:9XTSHD', remoteId: '1' },
        jobId: 'job',
        resourceType: 'media',
      },
    ]);
    expect(f.data.get(f.receiptPaths[0]).indexSettlement).toBe('confirmed_absent');
    expect(f.getFences()).toBeGreaterThan(1);
  });
  it('uses the index alias while requiring the original SoundCloud account in the source fact', async () => {
    const f = fixture(1, 'soundcloud');
    await settlePublishingDeletionReceipts(f.db, ref, f.store);
    expect(mockSettled[0]).toMatchObject({
      resource: { provider: 'soundcloud', account: 'configured-account' },
      resourceType: 'track',
    });
    f.data.get(f.receiptPaths[0]).originalAccount = 'soundcloud:users:999';
    await expect(settlePublishingDeletionReceipts(f.db, ref, f.store)).rejects.toBeInstanceOf(
      PublishingDeletionSettlementPendingError
    );
    expect(mockSettled).toHaveLength(1);
  });
  it('accepts genuine original 404 no-effect and fixed GET absence, without treating it as a positive ACK', async () => {
    const f = fixture();
    f.data.get(f.requestPaths[0]).state = 'rejected_no_effect';
    Object.assign(f.data.get(f.factPaths[0]), {
      completion: 'rejected_no_effect',
      evidence: { transport: 'original_http_response', status: 404, providerCode: 'resource_not_found' },
    });
    await settlePublishingDeletionReceipts(f.db, ref, f.store);
    expect(mockSettled).toHaveLength(1);
  });
  it.each(['unknown', 'sending', 'acknowledged_unprojectable'])(
    'never settles an original %s completion via fresh GET absence',
    async (state) => {
      const f = fixture();
      f.data.get(f.requestPaths[0]).state = state;
      await expect(settlePublishingDeletionReceipts(f.db, ref, f.store)).rejects.toMatchObject({
        code: 'PUBLISHING_DELETION_SETTLEMENT_PENDING',
        reason: 'original_completion',
      });
      expect(mockSettled).toHaveLength(0);
    }
  );
  it('requires an effects-closed or committed session even when DELETE was acknowledged', async () => {
    const f = fixture();
    f.data.get(f.sessionPaths[0]).state = 'active';
    await expect(settlePublishingDeletionReceipts(f.db, ref, f.store)).rejects.toMatchObject({
      reason: 'session_not_closed',
    });
    f.data.get(f.sessionPaths[0]).effectsClosed = true;
    await settlePublishingDeletionReceipts(f.db, ref, f.store);
    expect(mockSettled).toHaveLength(1);
  });
  it('returns typed pending while canonical mirror references remain', async () => {
    const f = fixture();
    mockIndexPending = true;
    await expect(settlePublishingDeletionReceipts(f.db, ref, f.store)).rejects.toMatchObject({
      code: 'PUBLISHING_DELETION_SETTLEMENT_PENDING',
      reason: 'canonical_references',
    });
    expect(f.data.get(f.receiptPaths[0]).indexSettlement).toBeUndefined();
    expect(mockSettled).toHaveLength(0);
  });
  it('rejects reconciled receipts lacking actual fixed GET evidence and altered immutable facts', async () => {
    const f = fixture();
    Object.assign(f.data.get(f.receiptPaths[0]), { state: 'reconciled', absenceProof: undefined });
    await expect(settlePublishingDeletionReceipts(f.db, ref, f.store)).rejects.toMatchObject({
      code: 'PUBLISHING_DELETION_SETTLEMENT_PROOF_INVALID',
    });
    f.data.get(f.receiptPaths[0]).absenceProof = 'authenticated_fixed_id_get_404_410';
    f.data.get(f.factPaths[0]).claim = 'forged';
    await expect(settlePublishingDeletionReceipts(f.db, ref, f.store)).rejects.toThrow();
    expect(mockSettled).toHaveLength(0);
  });
  it('pages more than 64 own receipts and sessions without a fleet ceiling', async () => {
    const f = fixture(130);
    await settlePublishingDeletionReceipts(f.db, ref, f.store);
    expect(mockSettled).toHaveLength(130);
    expect(f.queryLimits.every((n) => n <= 64)).toBe(true);
  });
  it('rejects changed generation under the final fresh SDK fence', async () => {
    const f = fixture();
    let calls = 0;
    const store = {
      commitCurrent: async (r: any, fn: any) => {
        if (++calls === 2) f.data.get('durableJobs/job').generation = 2;
        await f.store.commitCurrent(r, fn);
      },
    };
    await expect(settlePublishingDeletionReceipts(f.db, ref, store)).rejects.toMatchObject({
      code: 'PUBLISHING_DELETION_SETTLEMENT_PROOF_INVALID',
    });
    expect(mockSettled).toHaveLength(0);
  });
});
