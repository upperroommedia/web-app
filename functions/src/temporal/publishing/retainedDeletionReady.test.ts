import type { Firestore, Transaction } from 'firebase-admin/firestore';
jest.mock('./providerMutationGuard', () => ({
  ...jest.requireActual('./providerMutationGuard'),
  validateProviderMutationOriginalCompletion: jest.fn(async () => {}),
}));
import {
  validateProviderMutationOriginalCompletion,
  providerMutationFingerprint,
  type ProviderMutationSession,
} from './providerMutationGuard';
import {
  compileRetainedDeletionReady,
  refreshRetainedDeletionReadyCanonicalCompletion,
  validateRetainedDeletionReadyCompletion,
  retainedClaimSetSeed,
  retainedClaimSetFold,
  RETAINED_DELETION_READY,
  type RetainedDeletionReadySource,
  type RetainedDeletionReadyAuthority,
} from './retainedDeletionReady';
import type { FrozenProjectionRequest } from './criticalAcknowledgedRepair';
const authority: RetainedDeletionReadyAuthority = {
  projectId: 'project',
  jobId: 'job',
  certificateId: 'c'.repeat(64),
  planId: 'plan',
  sermonId: 'sermon',
  trackId: 'track',
  generation: 1,
  workflowId: 'workflow',
  intentFingerprint: 'i'.repeat(64),
};
type Data = Record<string, any>;
const field = (value: Data | undefined, path: string) =>
  path.split('.').reduce((current, key) => current?.[key], value);
function fixture(count = 65, pages = 100) {
  const data = new Map<string, Data>(),
    scope = { projectId: 'project', jobId: 'job', operation: 'delete' },
    sessionId = providerMutationFingerprint(scope),
    ref = { projectId: 'project', jobId: 'job' };
  const expected: FrozenProjectionRequest[] = Array.from({ length: count }, (_, index) => ({
    step: `step-${index}`,
    method: 'PATCH' as const,
    fingerprint: 'f'.repeat(64),
    target: {
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      resourceType: 'list' as const,
      resourceId: `list-${index}`,
    },
  }));
  expected.push({
    step: 'retained-sc',
    method: 'DELETE',
    fingerprint: 'a'.repeat(64),
    target: { provider: 'soundcloud', account: 'configured-account', resourceType: 'track', resourceId: 'track' },
  });
  expected.sort((a, b) => providerMutationFingerprint(a.step).localeCompare(providerMutationFingerprint(b.step)));
  for (const request of expected.filter((row) => row.target?.provider !== 'soundcloud'))
    data.set(`temporalProviderMutationSessions/${sessionId}/requests/${providerMutationFingerprint(request.step)}`, {
      step: request.step,
      method: request.method,
      fingerprint: request.fingerprint,
      claim: 'claim',
      executionId: 'execution',
      state: 'acknowledged',
    });
  const query = (path: string, cursor = '', limit = Infinity): any => ({
    orderBy: () => query(path, cursor, limit),
    limit: (next: number) => query(path, cursor, next),
    startAfter: (next: string) => query(path, next, limit),
    fetch: () => {
      const docs = [...data.keys()]
        .filter(
          (key) =>
            key.startsWith(path + '/') &&
            key.split('/').length === path.split('/').length + 1 &&
            key.split('/').at(-1)! > cursor
        )
        .sort()
        .slice(0, limit)
        .map(snapshot);
      return { docs, size: docs.length, empty: !docs.length };
    },
    doc: (id: string) => reference(`${path}/${id}`),
  });
  const reference = (path: string): any => ({
    path,
    id: path.split('/').at(-1),
    collection: (name: string) => query(`${path}/${name}`),
  });
  const snapshot = (path: string): any => ({
    id: path.split('/').at(-1),
    ref: reference(path),
    exists: data.has(path),
    data: () => data.get(path),
    get: (key: string) => field(data.get(path), key),
  });
  const tx: any = {
    get: async (target: any) => (target.fetch ? target.fetch() : snapshot(target.path)),
    getAll: async (...targets: any[]) => targets.map((target) => snapshot(target.path)),
    create: (target: any, value: Data) => {
      if (data.has(target.path)) throw Error('already exists');
      data.set(target.path, value);
    },
    update: (target: any, value: Data) => data.set(target.path, { ...data.get(target.path), ...value }),
  };
  const db: any = { doc: reference };
  let completed = pages,
    authorized = 0;
  const source: RetainedDeletionReadySource = {
    readExpectedRequests: async (_tx, cursor) => {
      const start = Number(cursor ?? 0),
        end = Math.min(start + 32, expected.length);
      return {
        requests: expected.slice(start, end),
        ...(end < expected.length ? { nextCursor: String(end) } : {}),
        sourceProgramDigest: 'c'.repeat(64),
        sourceRequestCount: expected.length,
      };
    },
    readCanonicalInventory: async (_tx, cursor) => {
      const start = Number(cursor ?? 0),
        end = Math.min(start + 32, pages);
      return {
        pages: Array.from({ length: end - start }, (_, index) => ({ index: start + index, digest: 'd'.repeat(64) })),
        ...(end < pages ? { nextCursor: String(end) } : {}),
        immutableCatalogDigest: 'a'.repeat(64),
        expectedCanonicalPageCount: pages,
      };
    },
    validateCanonicalPage: async (_tx, input) => ({
      complete: input.index < completed,
      completionDigest: 'd'.repeat(64),
    }),
    validateCanonicalCompletion: async () => ({
      immutableCatalogDigest: 'a'.repeat(64),
      expectedCanonicalPageCount: pages,
      completedCanonicalPageCount: completed,
      canonicalCompletionDigest: 'b'.repeat(64),
    }),
  };
  const deps = {
    firestore: db as Firestore,
    authorize: async () => {
      authorized++;
    },
    commitCurrent: async (_ref: any, fn: any) => fn(tx),
  };
  const session: ProviderMutationSession = { db: db as Firestore, id: sessionId, scope, resources: [] };
  const seal = () => {
    const root = data.get(`${RETAINED_DELETION_READY}/${sessionId}`)!;
    return {
      sessionId,
      claimSetDigestVersion: 2 as const,
      claimSetDigest: root.closedClaimSetDigest,
      actualRequestCount: root.originalRequestCount,
      sourceDispositionValidated: true as const,
      sourceProgramDigest: root.sourceProgramDigest,
      expectedRequestCount: root.expectedRequestCount,
    };
  };
  return {
    data,
    db: db as Firestore,
    tx: tx as Transaction,
    ref,
    session,
    source,
    deps,
    seal,
    expected,
    setCompleted: (value: number) => {
      completed = value;
    },
    authorized: () => authorized,
  };
}
beforeEach(() => jest.clearAllMocks());
it('compiles complete immutable request/canonical inventory in <=32-item fresh fenced pages', async () => {
  const f = fixture();
  await compileRetainedDeletionReady(authority, f.session, f.source, f.deps);
  await refreshRetainedDeletionReadyCanonicalCompletion(authority, f.session, f.source, f.deps);
  const proof = await validateRetainedDeletionReadyCompletion(f.tx, authority, f.session, f.seal(), f.source, f.db);
  expect(proof).toMatchObject({
    originalRequestCount: 65,
    expectedCanonicalPageCount: 100,
    completedCanonicalPageCount: 100,
    immutableCatalogDigest: 'a'.repeat(64),
  });
  expect(f.authorized()).toBeGreaterThan(10);
  expect(
    jest.mocked(validateProviderMutationOriginalCompletion).mock.calls.every((call) => call[2]!.length <= 32)
  ).toBe(true);
  const claims = [...f.data.entries()].filter(([path]) => path.includes('/claimPages/')).map(([, row]) => row.claims);
  expect(claims.flat()).toHaveLength(65);
  expect(claims.every((rows) => rows.length <= 32)).toBe(true);
  let checksum = retainedClaimSetSeed(f.session.id);
  for (const row of claims.flat()) checksum = retainedClaimSetFold(checksum, row);
  expect(proof.closedClaimSetDigest).toBe(checksum);
});
it('never copies a forged closure checksum and requires all actual canonical completion pages', async () => {
  const f = fixture();
  await compileRetainedDeletionReady(authority, f.session, f.source, f.deps);
  await refreshRetainedDeletionReadyCanonicalCompletion(authority, f.session, f.source, f.deps);
  await expect(
    validateRetainedDeletionReadyCompletion(
      f.tx,
      authority,
      f.session,
      { ...f.seal(), claimSetDigest: 'e'.repeat(64) },
      f.source,
      f.db
    )
  ).rejects.toThrow();
  f.setCompleted(99);
  await expect(
    validateRetainedDeletionReadyCompletion(f.tx, authority, f.session, f.seal(), f.source, f.db)
  ).rejects.toThrow();
});
it('stops compiling immediately on later-page administrator revocation and cannot attest READY', async () => {
  const f = fixture();
  let calls = 0;
  f.deps.authorize = async () => {
    if (++calls === 6) throw Error('admin revoked');
  };
  await expect(compileRetainedDeletionReady(authority, f.session, f.source, f.deps)).rejects.toThrow('admin revoked');
  expect(f.data.get(`${RETAINED_DELETION_READY}/${f.session.id}`)?.stage).not.toBe('ready');
});
it('rejects missing original claims rather than converting arbitrary source requests to NoSEND', async () => {
  const f = fixture();
  const request = f.expected.find((row) => row.target?.provider === 'subsplash')!;
  f.data.delete(
    `temporalProviderMutationSessions/${f.session.id}/requests/${providerMutationFingerprint(request.step)}`
  );
  await expect(compileRetainedDeletionReady(authority, f.session, f.source, f.deps)).rejects.toThrow();
});
it('supports an actual reviewed SC-only root inventory with zero sends and a real canonical page', async () => {
  const f = fixture(0, 1);
  await compileRetainedDeletionReady(authority, f.session, f.source, f.deps);
  await refreshRetainedDeletionReadyCanonicalCompletion(authority, f.session, f.source, f.deps);
  expect(
    await validateRetainedDeletionReadyCompletion(f.tx, authority, f.session, f.seal(), f.source, f.db)
  ).toMatchObject({ originalRequestCount: 0, expectedCanonicalPageCount: 1, completedCanonicalPageCount: 1 });
});

it('requires each real source completion page even when an aggregate summary says complete', async () => {
  const f = fixture(2, 3);
  await compileRetainedDeletionReady(authority, f.session, f.source, f.deps);
  f.source.validateCanonicalPage = async (_tx, input) => ({
    complete: input.index !== 1,
    completionDigest: 'd'.repeat(64),
  });
  await expect(
    refreshRetainedDeletionReadyCanonicalCompletion(authority, f.session, f.source, f.deps)
  ).rejects.toThrow();
  await expect(
    validateRetainedDeletionReadyCompletion(f.tx, authority, f.session, f.seal(), f.source, f.db)
  ).rejects.toThrow();
});
it('fresh administrator revocation during canonical validation prevents final proof', async () => {
  const f = fixture(2, 40);
  await compileRetainedDeletionReady(authority, f.session, f.source, f.deps);
  let calls = 0;
  f.deps.authorize = async () => {
    if (++calls === 8) throw Error('admin revoked');
  };
  await expect(refreshRetainedDeletionReadyCanonicalCompletion(authority, f.session, f.source, f.deps)).rejects.toThrow(
    'admin revoked'
  );
  expect(f.data.get(`${RETAINED_DELETION_READY}/${f.session.id}`)?.canonicalValidationComplete).toBe(false);
});
