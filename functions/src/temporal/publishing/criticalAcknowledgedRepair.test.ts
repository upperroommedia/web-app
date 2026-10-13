import { FieldValue, Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import {
  acknowledgedProjectionDigest,
  validateVerification,
  validateWrite,
  reduceVerificationPrograms,
  verifyAcknowledgedProviderObservations,
  prepareAcknowledgedProjectionPlan,
  prepareAcknowledgedProjectionSeal,
  prepareAcknowledgedRepair as prepareSourceRepair,
  commitAcknowledgedRepair as commitSourceRepair,
  readAcknowledgedRepairRequiredVerifications,
  validateAcknowledgedProjectionEvidence,
  assertAcknowledgedProjectionRequestPrepared,
  readAcknowledgedProjectionFragments,
} from './criticalAcknowledgedRepair';
import { providerMutationFingerprint, type ProviderMutationSession } from './providerMutationGuard';
import { compileAcknowledgedRepairCandidatePage } from './acknowledgedRepairCandidate';
import { runCriticalPublishingRepair } from './durableOperationContext';

const fixtures = new WeakMap<object, { tx: Transaction; flush: () => void; writes: Array<() => void> }>();
const executionScope = 'certificate:original-source/admin:fresh/sdk:current';
async function prepareAcknowledgedRepair(tx: Transaction, db: Firestore, ref: any, id: string) {
  const f = fixtures.get(db)!;
  for (let page = 0; page < 10000; page++) {
    const result = await compileAcknowledgedRepairCandidatePage(db, ref, id, {
      commitCurrent: async (_ref, mutate) => {
        const value = await mutate(tx);
        f.flush();
        return value;
      },
    });
    if (result.state === 'ready') return prepareSourceRepair(tx, db, ref, id);
  }
  throw Error('Bounded compiler failed to converge');
}
async function commitAcknowledgedRepair(tx: Transaction, db: Firestore, ref: any, operation: any, observations: any[]) {
  const f = fixtures.get(db)!;
  let total = 0;
  for (let page = 0; page < 10000; page++) {
    await readAcknowledgedRepairRequiredVerifications(tx, db, ref, operation, { observationScope: executionScope });
    const result = await commitSourceRepair(tx, db, ref, operation, observations, { observationScope: executionScope });
    total += result.writesCompleted;
    if (!result.needsContinuation) return { ...result, writesCompleted: total };
    f.flush();
  }
  throw Error('Paged projection failed to converge');
}
function fixture(resourceType = 'media', resourceId = 'media') {
  const rows = new Map<string, Record<string, unknown>>();
  const get = (data: Record<string, unknown> | undefined, key: string): unknown =>
    key
      .split('.')
      .reduce<unknown>(
        (value, part) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined),
        data
      );
  const clone = (value: any): any => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const document = (path: string): any => ({
    path,
    id: path.split('/').pop(),
    get: async () => snapshot(path),
    collection: (name: string) => collection(`${path}/${name}`),
  });
  const snapshot = (path: string): any => ({
    exists: rows.has(path),
    id: path.split('/').pop(),
    ref: document(path),
    data: () => clone(rows.get(path)),
    get: (key: string) => clone(get(rows.get(path), key)),
  });
  const collection = (
    path: string,
    predicates: Array<[string, string, unknown]> = [],
    cap = Infinity,
    cursor = ''
  ): any => ({
    path,
    query: true,
    count: () => ({
      aggregate: true,
      get: async () => ({
        data: () => ({
          count: [...rows.keys()].filter(
            (key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')
          ).length,
        }),
      }),
    }),
    doc: (id: string) => document(`${path}/${id}`),
    select: () => collection(path, predicates, cap, cursor),
    where: (field: string, op: string, value: unknown) =>
      collection(path, [...predicates, [field, op, value]], cap, cursor),
    orderBy: () => collection(path, predicates, cap, cursor),
    startAfter: (value: any) =>
      collection(path, predicates, cap, typeof value === 'string' ? `${path}/${value}` : value.ref.path),
    limit: (value: number) => collection(path, predicates, value, cursor),
    get: async () => {
      const docs = [...rows.keys()]
        .filter(
          (key) =>
            key.startsWith(`${path}/`) &&
            !key.slice(path.length + 1).includes('/') &&
            key > cursor &&
            predicates.every(([field, op, value]) =>
              op === 'in'
                ? (value as unknown[]).includes(get(rows.get(key), field))
                : get(rows.get(key), field) === value
            )
        )
        .sort()
        .slice(0, cap)
        .map(snapshot);
      return { docs, size: docs.length, empty: !docs.length };
    },
  });
  const writes: Array<() => void> = [];
  let writing = false;
  const assertRead = () => {
    if (writing) throw Error('Read after write');
  };
  const tx: any = {
    get: async (ref: any) => {
      assertRead();
      return ref.query || ref.aggregate ? ref.get() : snapshot(ref.path);
    },
    getAll: async (...refs: any[]) => {
      assertRead();
      return refs.map((ref) => snapshot(ref.path));
    },
    create: (ref: any, value: any) => {
      writing = true;
      writes.push(() => {
        if (rows.has(ref.path)) throw Error('existing');
        rows.set(ref.path, value);
      });
    },
    update: (ref: any, value: any) => {
      writing = true;
      writes.push(() => {
        const next = { ...rows.get(ref.path) };
        for (const [key, item] of Object.entries(value))
          if (item instanceof FieldValue && item.isEqual(FieldValue.delete())) delete next[key];
          else next[key] = item;
        rows.set(ref.path, next);
      });
    },
    set: (ref: any, value: any) => {
      writing = true;
      writes.push(() => rows.set(ref.path, value));
    },
    delete: (ref: any) => {
      writing = true;
      writes.push(() => rows.delete(ref.path));
    },
  };
  const db: any = { doc: document, collection };
  const ref = { projectId: 'project', jobId: 'job' };
  const scope = { ...ref, operation: 'metadata' },
    resource = { provider: 'subsplash' as const, account: 'app:9XTSHD', resourceType, resourceId };
  const session: ProviderMutationSession = {
    db: db as Firestore,
    id: providerMutationFingerprint(scope),
    scope,
    resources: [resource],
  };
  const resourceKey = providerMutationFingerprint([
    ref.projectId,
    resource.provider,
    resource.account,
    resource.resourceId,
  ]);
  const intent = {
    ...ref,
    kind: 'sermon.publish',
    entity: { type: 'sermon', id: 'sermon' },
    generation: 1,
    payload: { patch: { title: 'New title' } },
  };
  rows.set('durableJobIntents/job', intent);
  rows.set('durableJobs/job', { ...intent, state: 'needs_attention' });
  rows.set(`temporalProviderMutationSessions/${session.id}`, {
    schemaVersion: 1,
    scope,
    resources: session.resources,
    resourceKeys: [resourceKey],
    state: 'active',
  });
  rows.set(`temporalProviderMutationLocks/${resourceKey}`, { sessionId: session.id, state: 'held' });
  rows.set('sermons/sermon', { title: 'Old title', subsplashId: 'media', editedAtMillis: 100 });
  const request = {
    step: 'metadata',
    method: 'PATCH' as const,
    fingerprint: providerMutationFingerprint(['PATCH', { title: 'New title' }]),
  };
  const flush = () => {
    writes.splice(0).forEach((write) => write());
    writing = false;
  };
  fixtures.set(db, { tx, flush, writes });
  const complete = (state = 'acknowledged', overrides: Record<string, unknown> = {}) => {
    const claim = 'original-claim',
      executionId = 'original-sdk-execution',
      result = { updated: true };
    rows.set(`temporalProviderMutationSessions/${session.id}/requests/${providerMutationFingerprint(request.step)}`, {
      ...request,
      state,
      claim,
      executionId,
      result,
      ...overrides,
    });
    rows.set(`temporalProviderMutationFacts/${providerMutationFingerprint([session.id, request.step, claim])}`, {
      sessionId: session.id,
      step: request.step,
      claim,
      fingerprint: request.fingerprint,
      executionId,
      completion: state,
      result,
    });
  };
  const observations = [
    {
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      resourceType: 'media' as const,
      resourceId: 'media',
      state: 'present' as const,
      body: { title: 'New title' },
    },
  ];
  const freeze = async () => {
    const plan = await prepareAcknowledgedProjectionPlan(tx as Transaction, session, {
      requests: [request],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'media',
          expectedProviderFields: { title: 'New title' },
        },
      ],
      writes: [
        {
          path: 'sermons/sermon',
          expectedFields: { subsplashId: 'media', editedAtMillis: 100 },
          patch: { title: 'New title', editedAtMillis: 101 },
        },
      ],
    });
    plan.commit();
    flush();
    return plan;
  };
  return {
    rows,
    tx: tx as Transaction,
    db: db as Firestore,
    ref,
    session,
    request,
    resourceKey,
    flush,
    complete,
    freeze,
    writes,
    observations,
  };
}
describe('original acknowledgement backed critical projection', () => {
  test('large catalogs stream immutable fragments and cannot send until their source is sealed', async () => {
    const f = fixture();
    const verification = {
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      resourceType: 'media' as const,
      resourceId: 'media',
      expectedProviderFields: { title: 'New title' },
    };
    for (let offset = 0; offset < 2112; offset += 64) {
      const writes = Array.from({ length: 64 }, (_, index) => ({
        path: `sermons/catalog-${offset + index}`,
        expectedFields: { title: 'Old' },
        patch: { title: 'New' },
      }));
      const prepared = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
        requests: [f.request],
        writes,
        verifications: [verification],
        finalFragment: false,
        completesActivity: false,
      });
      prepared.commit();
      f.flush();
    }
    await expect(assertAcknowledgedProjectionRequestPrepared(f.tx, f.session, f.request)).rejects.toMatchObject({
      code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED',
    });
    const ready = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [f.request],
      writes: [],
      verifications: [],
      finalFragment: true,
      completesActivity: false,
    });
    ready.commit();
    f.flush();
    await assertAcknowledgedProjectionRequestPrepared(f.tx, f.session, f.request);
    const root = f.rows.get(`temporalPublishingAcknowledgedProjections/${f.session.id}`)!;
    expect(root.schemaVersion).toBe(2);
    expect(root.pageCount).toBe(34);
    expect(root.requestCount).toBe(1);
    expect(root.writes).toBeUndefined();
    expect(JSON.stringify(root).length).toBeLessThan(1000);
    const window = await readAcknowledgedProjectionFragments(f.tx, f.db, f.ref, f.session.id, 0, 2);
    expect(window.fragments).toHaveLength(2);
    expect(window.nextOffset).toBe(2);
  });
  test('a mutable readiness assertion without its immutable original final fragment cannot authorize the RPC', async () => {
    const f = fixture();
    const prepared = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [f.request],
      writes: [{ path: 'sermons/sermon', expectedFields: { title: 'Old title' }, patch: { title: 'New title' } }],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'media',
          expectedProviderFields: { title: 'New title' },
        },
      ],
      finalFragment: false,
    });
    prepared.commit();
    f.flush();
    const indexPath = `temporalPublishingAcknowledgedProjections/${
        f.session.id
      }/requestIndex/${providerMutationFingerprint(f.request.step)}`,
      index = f.rows.get(indexPath)!;
    f.rows.set(indexPath, { ...index, ready: true, readyPageDigest: index.pageDigest });
    await expect(assertAcknowledgedProjectionRequestPrepared(f.tx, f.session, f.request)).rejects.toMatchObject({
      code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED',
    });
  });
  test('601 original source requests use direct immutable request indices without a catalog-sized root', async () => {
    const f = fixture();
    for (let index = 0; index < 601; index++) {
      const request = { ...f.request, step: `metadata-${index}` };
      const prepared = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
        requests: [request],
        writes: [{ path: `sermons/fleet-${index}`, expectedFields: { title: 'Old' }, patch: { title: 'New' } }],
        verifications: [
          {
            provider: 'subsplash',
            account: 'app:9XTSHD',
            resourceType: 'media',
            resourceId: 'media',
            expectedProviderFields: { title: 'New title' },
          },
        ],
        completesActivity: false,
      });
      prepared.commit();
      f.flush();
    }
    const root = f.rows.get(`temporalPublishingAcknowledgedProjections/${f.session.id}`)!;
    expect(root.requestCount).toBe(601);
    expect(root.pageCount).toBe(601);
    expect(root.requests).toBeUndefined();
    await assertAcknowledgedProjectionRequestPrepared(f.tx, f.session, { ...f.request, step: 'metadata-600' });
  });
  test('closed effects reject new frozen programs while exact original ACK replay remains read-only', async () => {
    const f = fixture();
    await f.freeze();
    f.complete();
    const sessionPath = `temporalProviderMutationSessions/${f.session.id}`,
      manifestPath = `temporalPublishingAcknowledgedProjections/${f.session.id}`;
    f.rows.set(sessionPath, { ...f.rows.get(sessionPath), effectsClosed: true });
    const before = acknowledgedProjectionDigest(f.rows.get(manifestPath)),
      pageCount = f.rows.get(manifestPath)?.pageCount,
      privatePaths = [...f.rows.keys()].filter((path) => path.startsWith(`${manifestPath}/`));
    await expect(
      prepareAcknowledgedProjectionPlan(f.tx, f.session, {
        requests: [{ ...f.request, step: 'new-step' }],
        writes: [
          { path: 'sermons/sermon', expectedFields: { title: 'Old title' }, patch: { title: 'Forbidden new effect' } },
        ],
        verifications: [
          {
            provider: 'subsplash',
            account: 'app:9XTSHD',
            resourceType: 'media',
            resourceId: 'media',
            expectedProviderFields: { title: 'Forbidden new effect' },
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' });
    expect(f.writes).toHaveLength(0);
    expect(acknowledgedProjectionDigest(f.rows.get(manifestPath))).toBe(before);
    expect(f.rows.get(manifestPath)?.pageCount).toBe(pageCount);
    expect([...f.rows.keys()].filter((path) => path.startsWith(`${manifestPath}/`))).toEqual(privatePaths);
    const replay = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [f.request],
      writes: [{ path: 'sermons/sermon', expectedFields: { title: 'Speculative' }, patch: { title: 'Never apply' } }],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'media',
          expectedProviderFields: { title: 'Speculative' },
        },
      ],
    });
    expect(replay.projectionDigest).toBe(before);
    replay.commit();
    expect(f.writes).toHaveLength(0);
    expect(f.rows.get(manifestPath)?.pageCount).toBe(pageCount);
  });
  test('Date and public SDK Timestamp hash identically after Firestore serialization', () => {
    const date = new Date('2026-10-12T10:30:00.123Z');
    expect(acknowledgedProjectionDigest({ date })).toBe(
      acknowledgedProjectionDigest({ date: Timestamp.fromDate(date) })
    );
  });
  test('original ACK survives actor revocation; fresh admin projects and releases the exclusive lock atomically', async () => {
    const f = fixture();
    await f.freeze();
    f.complete();
    const revokedActor = jest.fn(() => {
      throw Error('actor revoked');
    });
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    await validateAcknowledgedProjectionEvidence(f.tx, f.db, f.ref, prepared.sourceEvidence[0]);
    const freshAdmin = jest.fn(async () => undefined);
    await freshAdmin();
    expect(await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, f.observations)).toEqual({
      alreadyCommitted: false,
      writesCompleted: 1,
      settledUiStepIds: [],
    });
    expect(f.rows.get('sermons/sermon')?.title).toBe('New title');
    expect(f.rows.get(`temporalProviderMutationSessions/${f.session.id}`)?.state).toBe('active');
    expect(f.rows.get(`temporalProviderMutationLocks/${f.resourceKey}`)?.state).toBe('held');
    f.flush();
    expect(f.rows.get('sermons/sermon')?.title).toBe('New title');
    expect(f.rows.get(`temporalProviderMutationSessions/${f.session.id}`)?.state).toBe('committed');
    // A committed owner makes its persistent lock reusable without hundreds of release writes.
    expect(f.rows.get(`temporalProviderMutationSessions/${f.session.id}`)?.state).toBe('committed');
    expect(revokedActor).not.toHaveBeenCalled();
    expect(await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, f.observations)).toEqual({
      alreadyCommitted: true,
      writesCompleted: 0,
      settledUiStepIds: [],
    });
  });
  test.each(['sending', 'unknown', 'acknowledged_unprojectable'])(
    '%s stays blocked even if current GET would match desired metadata',
    async (state) => {
      const f = fixture();
      await f.freeze();
      f.complete(state);
      const getMatchingProvider = jest.fn(async () => ({ title: 'New title' }));
      await expect(prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id)).rejects.toMatchObject({
        code: 'PROVIDER_MUTATION_UNRESOLVED',
      });
      expect(getMatchingProvider).not.toHaveBeenCalled();
      expect(f.writes).toHaveLength(0);
      expect(f.rows.get(`temporalProviderMutationLocks/${f.resourceKey}`)?.state).toBe('held');
    }
  );
  test('operator acknowledgement without matching original fact is rejected', async () => {
    const f = fixture();
    await f.freeze();
    f.complete();
    const fact = [...f.rows.keys()].find((path) => path.startsWith('temporalProviderMutationFacts/'))!;
    f.rows.set(fact, { ...f.rows.get(fact), executionId: 'different-execution' });
    await expect(prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id)).rejects.toMatchObject({
      code: 'PROVIDER_MUTATION_UNRESOLVED',
    });
    expect(f.writes).toHaveLength(0);
  });
  test('a newer canonical resource or revision cannot be overwritten', async () => {
    const f = fixture();
    await f.freeze();
    f.complete();
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    f.rows.set('sermons/sermon', { title: 'Newer title', subsplashId: 'new-media', editedAtMillis: 102 });
    await expect(commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, f.observations)).rejects.toMatchObject(
      { code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' }
    );
    expect(f.writes).toHaveLength(0);
  });
  test('freezing after an HTTP request has started is forbidden', async () => {
    const f = fixture();
    f.complete('sending');
    await expect(f.freeze()).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' });
    expect(f.writes).toHaveLength(0);
  });
  test('a frozen request set cannot omit an additional mutation', async () => {
    const f = fixture();
    await f.freeze();
    f.complete();
    f.rows.set(`temporalProviderMutationSessions/${f.session.id}/requests/extra`, {
      step: 'extra',
      state: 'acknowledged',
    });
    await expect(prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id)).rejects.toMatchObject({
      code: 'PROVIDER_MUTATION_UNRESOLVED',
    });
  });
  test('a fresh provider observation that drifted after the original ACK blocks projection', async () => {
    const f = fixture();
    await f.freeze();
    f.complete();
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    await expect(
      commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, [
        { ...f.observations[0], body: { title: 'External edit' } },
      ])
    ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' });
    expect(f.writes).toHaveLength(0);
  });
  test('a known acknowledged prefix projects only its frozen prerequisites and stops unsent work', async () => {
    const f = fixture(),
      second = {
        step: 'second',
        method: 'PATCH' as const,
        fingerprint: providerMutationFingerprint(['PATCH', { title: 'Never sent' }]),
      };
    f.rows.set('sermons/second', { title: 'Original second' });
    const frozen = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [f.request, second],
      uiStepIds: ['metadata'],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'media',
          requiredSteps: ['metadata'],
          expectedProviderFields: { title: 'New title' },
        },
      ],
      writes: [
        {
          path: 'sermons/sermon',
          requiredSteps: ['metadata'],
          expectedFields: { subsplashId: 'media' },
          patch: { title: 'New title' },
        },
        {
          path: 'sermons/second',
          requiredSteps: ['second'],
          expectedFields: { title: 'Original second' },
          patch: { title: 'Never sent' },
        },
      ],
    });
    frozen.commit();
    f.flush();
    f.complete();
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    expect(prepared.partialStop).toBe(true);
    expect(await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, f.observations)).toMatchObject({
      alreadyCommitted: false,
      writesCompleted: 1,
      partialStop: true,
      factualNonDestructiveStop: true,
    });
    f.flush();
    expect(f.rows.get('sermons/sermon')?.title).toBe('New title');
    expect(f.rows.get('sermons/second')?.title).toBe('Original second');
    expect(f.rows.get(`temporalProviderMutationSessions/${f.session.id}`)?.state).toBe('committed');
  });
  test('a missing canonical membership can be created only from its frozen absent expectation', async () => {
    const f = fixture();
    const frozen = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [f.request],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'media',
          expectedProviderFields: { title: 'New title' },
        },
      ],
      writes: [
        {
          path: 'sermons/sermon/sermonLists/list',
          mode: 'set',
          expectedExists: false,
          expectedFields: {},
          patch: { id: 'list', subsplashId: 'media' },
        },
      ],
    });
    frozen.commit();
    f.flush();
    f.complete();
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    // Support set in the in-memory transaction without bypassing the real source proof.
    (f.tx as any).set = (ref: any, value: any) => f.writes.push(() => f.rows.set(ref.path, value));
    expect(
      (await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, f.observations)).writesCompleted
    ).toBe(1);
    f.flush();
    expect(f.rows.get('sermons/sermon/sermonLists/list')).toEqual({ id: 'list', subsplashId: 'media' });
  });
  test.each([false, true])(
    'a new repair execution revalidates original claims after its last canonical page (fact changed: %s)',
    async (factChanged) => {
      const f = fixture();
      await f.freeze();
      f.complete();
      const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
      let canonicalCommitted = false;
      for (let page = 0; page < 100; page++) {
        const result = await commitSourceRepair(f.tx, f.db, f.ref, prepared.operation, f.observations, {
          observationScope: executionScope,
        });
        f.flush();
        if (result.writesCompleted) {
          canonicalCommitted = true;
          break;
        }
      }
      expect(canonicalCommitted).toBe(true);
      expect(f.rows.get(`temporalProviderMutationSessions/${f.session.id}`)?.state).toBe('active');
      const nextScope = `${executionScope}:next-activity`;
      if (factChanged) {
        const factPath = [...f.rows.keys()].find((path) => path.startsWith('temporalProviderMutationFacts/'))!;
        f.rows.set(factPath, { ...f.rows.get(factPath), result: { title: 'Different original result' } });
        await expect(
          commitSourceRepair(f.tx, f.db, f.ref, prepared.operation, [], {
            observationScope: nextScope,
          })
        ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' });
        expect(f.rows.get(`temporalProviderMutationSessions/${f.session.id}`)?.state).toBe('active');
        expect(f.writes).toHaveLength(0);
        return;
      }
      let settled = false;
      for (let page = 0; page < 100; page++) {
        const result = await commitSourceRepair(f.tx, f.db, f.ref, prepared.operation, [], {
          observationScope: nextScope,
        });
        expect(result.writesCompleted).toBe(0);
        f.flush();
        if (!result.needsContinuation) {
          settled = true;
          break;
        }
      }
      expect(settled).toBe(true);
      expect(f.rows.get(`temporalProviderMutationSessions/${f.session.id}`)?.state).toBe('committed');
    }
  );
  test('canonical pages keep the exclusive session held until the final projection page', async () => {
    const f = fixture(),
      writes = Array.from({ length: 130 }, (_, index) => {
        const path = `sermons/paged-${index}`;
        f.rows.set(path, { title: 'Old' });
        return { path, expectedFields: { title: 'Old' }, patch: { title: 'New' } };
      });
    const frozen = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [f.request],
      uiStepIds: ['metadata'],
      writes,
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'media',
          expectedProviderFields: { title: 'New title' },
        },
      ],
    });
    frozen.commit();
    f.flush();
    f.complete();
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    let projected = 0;
    let pages = 0;
    let final: any;
    for (; pages < 1000; pages++) {
      await readAcknowledgedRepairRequiredVerifications(f.tx, f.db, f.ref, prepared.operation, {
        observationScope: executionScope,
      });
      const result = await commitSourceRepair(f.tx, f.db, f.ref, prepared.operation, f.observations, {
        observationScope: executionScope,
      });
      projected += result.writesCompleted;
      expect(result.writesCompleted).toBeLessThanOrEqual(1);
      if (result.needsContinuation) {
        f.flush();
        expect(f.rows.get(`temporalProviderMutationSessions/${f.session.id}`)?.state).toBe('active');
        continue;
      }
      final = result;
      expect(f.rows.get(`temporalProviderMutationSessions/${f.session.id}`)?.state).toBe('active');
      f.flush();
      break;
    }
    expect(pages).toBeGreaterThanOrEqual(130);
    expect(projected).toBe(130);
    expect(final.settledUiStepIds).toEqual(['metadata']);
    expect(f.rows.get(`temporalProviderMutationSessions/${f.session.id}`)?.state).toBe('committed');
  });
  test('a next immutable page can be frozen after an earlier ACK and before its own send', async () => {
    const f = fixture();
    await f.freeze();
    f.complete();
    f.rows.set('sermons/second', { title: 'Old' });
    const second = {
      step: 'second',
      method: 'PATCH' as const,
      fingerprint: providerMutationFingerprint(['PATCH', { title: 'Second' }]),
    };
    const next = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [second],
      completesActivity: false,
      writes: [{ path: 'sermons/second', expectedFields: { title: 'Old' }, patch: { title: 'Second' } }],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'media',
          expectedProviderFields: { title: 'Second' },
        },
      ],
    });
    next.commit();
    f.flush();
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    expect(prepared.sourceEvidence).toHaveLength(2);
    for (const evidence of prepared.sourceEvidence)
      await validateAcknowledgedProjectionEvidence(f.tx, f.db, f.ref, evidence);
    expect(prepared.partialStop).toBe(true);
    expect(prepared.verifications[0].expectedProviderFields).toEqual({ title: 'New title' });
    expect((await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, f.observations)).partialStop).toBe(
      true
    );
    f.flush();
    expect(f.rows.get('sermons/second')?.title).toBe('Old');
  });
  test('shared canonical metadata can depend on any original provider acknowledgement without claiming every destination succeeded', async () => {
    const f = fixture(),
      sc = {
        step: 'soundcloud',
        method: 'PUT' as const,
        fingerprint: providerMutationFingerprint(['PUT', { title: 'New title' }]),
      };
    const frozen = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [f.request, sc],
      writes: [
        {
          path: 'sermons/sermon',
          requiredAnySteps: ['metadata', 'soundcloud'],
          expectedFields: { subsplashId: 'media' },
          patch: { title: 'New title' },
        },
      ],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'media',
          requiredSteps: ['metadata'],
          expectedProviderFields: { title: 'New title' },
        },
      ],
    });
    frozen.commit();
    f.flush();
    f.complete();
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    expect(await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, f.observations)).toMatchObject({
      writesCompleted: 1,
      partialStop: true,
    });
    f.flush();
    expect(f.rows.get('sermons/sermon')?.title).toBe('New title');
  });
  test('a new list row ID must come from both its original ACK and the fresh fixed list observation', async () => {
    const f = fixture('list', 'list'),
      row = {
        id: 'original-row-id',
        type: 'media-item',
        app_key: '9XTSHD',
        _embedded: { 'media-item': { id: 'media' }, 'source-list': { id: 'list' } },
      };
    const payload = {
      id: 'list',
      _embedded: { 'list-rows': [{ type: row.type, app_key: row.app_key, _embedded: row._embedded }] },
    };
    const target = f.session.resources[0];
    f.request.fingerprint = providerMutationFingerprint(['PATCH', { target, body: payload }]);
    const frozen = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [{ ...f.request, target, payload }],
      writes: [
        {
          path: 'sermons/sermon/sermonLists/list',
          mode: 'set',
          expectedExists: false,
          expectedFields: {},
          patch: { id: 'list', subsplashId: 'list', uploadStatus: { status: 'UPLOADED' } },
          listRowBindings: [
            { field: 'uploadStatus.listItemId', requestStep: 'metadata', listId: 'list', mediaId: 'media' },
          ],
        },
      ],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'list',
          resourceId: 'list',
          expectedProviderFields: { id: 'list' },
        },
      ],
    });
    frozen.commit();
    f.flush();
    f.complete();
    const result = { _embedded: { 'list-rows': [row] } };
    for (const [key, value] of f.rows)
      if (key.startsWith('temporalProviderMutationFacts/') || key.includes('/requests/'))
        f.rows.set(key, { ...value, result });
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id),
      observation = {
        provider: 'subsplash' as const,
        account: 'app:9XTSHD',
        resourceType: 'list' as const,
        resourceId: 'list',
        state: 'present' as const,
        body: { id: 'list', _embedded: { 'list-rows': [row] } },
      };
    await expect(
      commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, [
        {
          ...observation,
          body: { ...observation.body, _embedded: { 'list-rows': [{ ...row, id: 'different-row-id' }] } },
        },
      ])
    ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' });
    expect(f.writes).toHaveLength(0);
    await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, [observation]);
    f.flush();
    expect((f.rows.get('sermons/sermon/sermonLists/list')?.uploadStatus as any).listItemId).toBe('original-row-id');
  });
  test('an original affirmative null SDK ACK permits unique current row identity lookup but never unknown completion', async () => {
    const f = fixture('list', 'list'),
      row = {
        id: 'provider-assigned-row',
        type: 'media-item',
        app_key: '9XTSHD',
        _embedded: { 'media-item': { id: 'media' }, 'source-list': { id: 'list' } },
      },
      payload = {
        id: 'list',
        _embedded: { 'list-rows': [{ type: row.type, app_key: row.app_key, _embedded: row._embedded }] },
      };
    const target = f.session.resources[0];
    f.request.fingerprint = providerMutationFingerprint(['PATCH', { target, body: payload }]);
    const frozen = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [{ ...f.request, target, payload }],
      writes: [
        {
          path: 'sermons/sermon/sermonLists/list',
          mode: 'set',
          expectedExists: false,
          expectedFields: {},
          patch: { id: 'list', uploadStatus: { status: 'UPLOADED' } },
          listRowBindings: [
            { field: 'uploadStatus.listItemId', requestStep: 'metadata', listId: 'list', mediaId: 'media' },
          ],
        },
      ],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'list',
          resourceId: 'list',
          expectedProviderFields: { id: 'list' },
        },
      ],
    });
    frozen.commit();
    f.flush();
    f.complete();
    for (const [key, value] of f.rows)
      if (key.startsWith('temporalProviderMutationFacts/') || key.includes('/requests/'))
        f.rows.set(key, { ...value, result: null });
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id),
      observation = {
        provider: 'subsplash' as const,
        account: 'app:9XTSHD',
        resourceType: 'list' as const,
        resourceId: 'list',
        state: 'present' as const,
        body: { id: 'list', _embedded: { 'list-rows': [row] } },
      };
    await expect(
      commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, [
        {
          ...observation,
          body: { ...observation.body, _embedded: { 'list-rows': [row, { ...row, id: 'duplicate' }] } },
        },
      ])
    ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' });
    expect(f.writes).toHaveLength(0);
    await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, [observation]);
    f.flush();
    expect((f.rows.get('sermons/sermon/sermonLists/list')?.uploadStatus as any).listItemId).toBe(
      'provider-assigned-row'
    );
  });
  test('only the original desired final adapter can seal a dynamic activity; critical authority cannot', async () => {
    const f = fixture();
    const frozen = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [f.request],
      completesActivity: false,
      writes: [{ path: 'sermons/sermon', expectedFields: { subsplashId: 'media' }, patch: { title: 'New title' } }],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'media',
          expectedProviderFields: { title: 'New title' },
        },
      ],
    });
    frozen.commit();
    f.flush();
    f.complete();
    expect((await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id)).partialStop).toBe(true);
    await expect(
      runCriticalPublishingRepair(f.ref.jobId, () => prepareAcknowledgedProjectionSeal(f.tx, f.session))
    ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' });
    expect(f.writes).toHaveLength(0);
    const seal = await prepareAcknowledgedProjectionSeal(f.tx, f.session);
    seal.commit();
    f.flush();
    expect((await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id)).partialStop).toBe(false);
  });
  test('idempotent public settlement still requires immutable original HTTP facts', async () => {
    const f = fixture();
    await f.freeze();
    f.complete();
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, f.observations);
    f.flush();
    const fact = [...f.rows.keys()].find((path) => path.startsWith('temporalProviderMutationFacts/'))!;
    f.rows.delete(fact);
    await expect(commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, f.observations)).rejects.toMatchObject(
      { code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' }
    );
  });
  test('idempotent settlement revalidates a multi-page original fact catalog on every retry', async () => {
    const f = fixture(),
      target = f.session.resources[0],
      requests = Array.from({ length: 33 }, (_, index) => {
        const payload = { title: 'New title', index };
        return {
          step: `bulk-${String(index).padStart(3, '0')}`,
          method: 'PATCH' as const,
          target,
          payload,
          fingerprint: providerMutationFingerprint(['PATCH', { target, body: payload }]),
        };
      });
    const frozen = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests,
      writes: [
        {
          path: 'sermons/sermon',
          expectedFields: { subsplashId: 'media', editedAtMillis: 100 },
          patch: { title: 'New title' },
        },
      ],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'media',
          expectedProviderFields: { title: 'New title' },
        },
      ],
    });
    frozen.commit();
    f.flush();
    const facts: string[] = [];
    for (const request of requests) {
      const claim = `original-${request.step}`,
        executionId = 'original-sdk-execution',
        result = { updated: true };
      f.rows.set(
        `temporalProviderMutationSessions/${f.session.id}/requests/${providerMutationFingerprint(request.step)}`,
        { ...request, state: 'acknowledged', claim, executionId, result }
      );
      const factPath = `temporalProviderMutationFacts/${providerMutationFingerprint([
        f.session.id,
        request.step,
        claim,
      ])}`;
      facts.push(factPath);
      f.rows.set(factPath, {
        sessionId: f.session.id,
        step: request.step,
        claim,
        fingerprint: request.fingerprint,
        executionId,
        completion: 'acknowledged',
        result,
      });
    }
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, f.observations);
    f.flush();
    expect(await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, f.observations)).toMatchObject({
      alreadyCommitted: true,
      writesCompleted: 0,
    });
    f.flush();
    f.rows.delete(facts.at(-1)!);
    await expect(commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, f.observations)).rejects.toMatchObject(
      { code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' }
    );
    expect(f.rows.get('sermons/sermon')?.title).toBe('New title');
  });
  test('a mixed original positive ACK and documented rejection repairs only the acknowledged prefix', async () => {
    const f = fixture(),
      rejected = {
        step: 'rejected',
        method: 'PATCH' as const,
        fingerprint: providerMutationFingerprint(['PATCH', { title: 'Rejected' }]),
      };
    f.rows.set('sermons/rejected', { title: 'Untouched' });
    const freeze = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [f.request, rejected],
      writes: [
        {
          path: 'sermons/sermon',
          requiredSteps: ['metadata'],
          expectedFields: { subsplashId: 'media' },
          patch: { title: 'New title' },
        },
        {
          path: 'sermons/rejected',
          requiredSteps: ['rejected'],
          expectedFields: { title: 'Untouched' },
          patch: { title: 'Rejected' },
        },
      ],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'media',
          requiredSteps: ['metadata'],
          expectedProviderFields: { title: 'New title' },
        },
      ],
    });
    freeze.commit();
    f.flush();
    f.complete();
    const claim = 'rejected-claim',
      executionId = 'original-execution';
    f.rows.set(
      `temporalProviderMutationSessions/${f.session.id}/requests/${providerMutationFingerprint(rejected.step)}`,
      { ...rejected, state: 'rejected_no_effect', claim, executionId }
    );
    f.rows.set(`temporalProviderMutationFacts/${providerMutationFingerprint([f.session.id, rejected.step, claim])}`, {
      sessionId: f.session.id,
      step: rejected.step,
      claim,
      executionId,
      fingerprint: rejected.fingerprint,
      completion: 'rejected_no_effect',
      evidence: { transport: 'original_http_response', status: 400, providerCode: 'documented-no-effect' },
    });
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    expect(prepared.partialStop).toBe(true);
    expect(await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, f.observations)).toMatchObject({
      writesCompleted: 1,
      partialStop: true,
    });
    f.flush();
    expect(f.rows.get('sermons/rejected')?.title).toBe('Untouched');
    expect(f.rows.get(`temporalProviderMutationSessions/${f.session.id}`)?.state).toBe('committed');
  });
  test('original DELETE acknowledgement clears only its frozen ID and retires the allocation marker atomically', async () => {
    const f = fixture(),
      target = f.session.resources[0],
      payload = { id: 'media' },
      request = {
        step: 'metadata',
        method: 'DELETE' as const,
        target,
        payload,
        fingerprint: providerMutationFingerprint(['DELETE', { target, body: payload }]),
      };
    f.request.fingerprint = request.fingerprint;
    const marker = `temporalPublishingAllocations/${createHash('sha256')
      .update(JSON.stringify([f.ref.projectId, 'sermon', 'subsplash']))
      .digest('hex')}`;
    f.rows.set(marker, {
      projectId: f.ref.projectId,
      sermonId: 'sermon',
      provider: 'subsplash',
      state: 'bound',
      remoteId: 'media',
      ownerJobId: 'previous-allocation-job',
    });
    const frozen = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [request],
      writes: [
        {
          path: 'sermons/sermon',
          expectedFields: { subsplashId: 'media' },
          patch: { title: 'Old title' },
          deleteFields: ['subsplashId'],
        },
      ],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'media',
          expectedState: 'absent',
          expectedProviderFields: {},
        },
      ],
    });
    frozen.commit();
    f.flush();
    f.complete();
    for (const [key, value] of f.rows) if (key.includes('/requests/')) f.rows.set(key, { ...value, method: 'DELETE' });
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, [
      { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: 'media', state: 'absent' },
    ]);
    expect(f.rows.get('sermons/sermon')?.subsplashId).toBeUndefined();
    expect(f.rows.get(marker)?.state).toBe('cancelled');
    expect(f.rows.get(`temporalProviderMutationSessions/${f.session.id}`)?.state).toBe('active');
    f.flush();
    expect(f.rows.get('sermons/sermon')?.subsplashId).toBeUndefined();
    expect(f.rows.get(marker)?.state).toBe('cancelled');
    expect(f.rows.get(marker)?.retiredByJobId).toBe(f.ref.jobId);
  });
  test('a committed original ACK reuses the original program while ignoring fresh canonical projection inputs', async () => {
    const f = fixture();
    await f.freeze();
    f.complete();
    const original = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    await commitAcknowledgedRepair(f.tx, f.db, f.ref, original.operation, f.observations);
    f.flush();
    const replay = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [f.request],
      writes: [{ path: 'sermons/sermon', expectedFields: { title: 'Newer input' }, patch: { title: 'Never rewrite' } }],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'media',
          expectedProviderFields: { title: 'Different speculative value' },
        },
      ],
    });
    expect(replay.projectionDigest).toBe(original.operation.projectionDigest);
    replay.commit();
    expect(f.writes).toHaveLength(0);
    expect(f.rows.get('sermons/sermon')?.title).toBe('New title');
    await expect(
      prepareAcknowledgedProjectionPlan(f.tx, f.session, {
        requests: [{ ...f.request, fingerprint: providerMutationFingerprint(['PATCH', { title: 'Changed body' }]) }],
        writes: [{ path: 'sermons/sermon', expectedFields: { title: 'New title' }, patch: { title: 'Changed body' } }],
        verifications: [
          {
            provider: 'subsplash',
            account: 'app:9XTSHD',
            resourceType: 'media',
            resourceId: 'media',
            expectedProviderFields: { title: 'Changed body' },
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' });
  });
  test('sequential fragments preserve earlier untouched provider and canonical fields instead of demanding intermediate truth', async () => {
    const f = fixture();
    f.rows.set('sermons/sermon', {
      title: 'Old title',
      subtitle: 'Old subtitle',
      subsplashId: 'media',
      editedAtMillis: 100,
    });
    await f.freeze();
    f.complete();
    const second = {
      step: 'subtitle',
      method: 'PATCH' as const,
      fingerprint: providerMutationFingerprint(['PATCH', { subtitle: 'New subtitle' }]),
    };
    const appended = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [second],
      writes: [
        {
          path: 'sermons/sermon',
          requiredSteps: ['metadata', 'subtitle'],
          expectedFields: { title: 'Old title', subtitle: 'Old subtitle', subsplashId: 'media' },
          patch: { subtitle: 'New subtitle' },
        },
      ],
      verifications: [
        {
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'media',
          expectedProviderFields: { subtitle: 'New subtitle' },
        },
      ],
    });
    appended.commit();
    f.flush();
    const claim = 'subtitle-original',
      executionId = 'original-sdk';
    f.rows.set(
      `temporalProviderMutationSessions/${f.session.id}/requests/${providerMutationFingerprint(second.step)}`,
      { ...second, state: 'acknowledged', claim, executionId, result: { updated: true } }
    );
    f.rows.set(`temporalProviderMutationFacts/${providerMutationFingerprint([f.session.id, second.step, claim])}`, {
      sessionId: f.session.id,
      step: second.step,
      claim,
      executionId,
      fingerprint: second.fingerprint,
      completion: 'acknowledged',
      result: { updated: true },
    });
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    expect(prepared.verifications[0].expectedProviderFields).toEqual({ title: 'New title', subtitle: 'New subtitle' });
    await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, [
      { ...f.observations[0], body: { title: 'New title', subtitle: 'New subtitle' } },
    ]);
    f.flush();
    expect(f.rows.get('sermons/sermon')?.title).toBe('New title');
    expect(f.rows.get('sermons/sermon')?.subtitle).toBe('New subtitle');
  });
});

describe('external provider JSON field paths', () => {
  const base = {
    provider: 'subsplash' as const,
    account: 'app:9XTSHD',
    resourceType: 'media' as const,
    resourceId: 'media',
  };
  test('freezes and repairs the original acknowledged series unlink through the real bounded candidate path', async () => {
    const f = fixture(),
      payload = { app_key: '9XTSHD', _embedded: { 'media-series': null } };
    Object.assign(f.request, {
      target: base,
      payload,
      fingerprint: providerMutationFingerprint(['PATCH', { target: base, body: payload }]),
    });
    const program = await prepareAcknowledgedProjectionPlan(f.tx, f.session, {
      requests: [f.request],
      writes: [{ path: 'sermons/sermon', expectedFields: { subsplashId: 'media' }, patch: { seriesId: null } }],
      verifications: [{ ...base, expectedProviderFields: { '_embedded.media-series': null } }],
    });
    program.commit();
    f.flush();
    f.complete();
    const prepared = await prepareAcknowledgedRepair(f.tx, f.db, f.ref, f.session.id);
    await expect(
      commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, [
        { ...base, state: 'present', body: { _embedded: { 'media-series': { id: 'drift' } } } },
      ])
    ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' });
    await commitAcknowledgedRepair(f.tx, f.db, f.ref, prepared.operation, [
      { ...base, state: 'present', body: { _embedded: { 'media-series': null } } },
    ]);
    f.flush();
    expect(f.rows.get('sermons/sermon')).toMatchObject({ seriesId: null, subsplashId: 'media' });
  });

  test('validates the frozen series-unlink HAL path and requires its exact fresh value', () => {
    const verification = { ...base, expectedProviderFields: { '_embedded.media-series': null } };
    expect(() => validateVerification(verification)).not.toThrow();
    const [reduced] = reduceVerificationPrograms([verification]);
    expect(() => validateVerification(reduced)).not.toThrow();
    expect(() =>
      verifyAcknowledgedProviderObservations(
        [reduced],
        [{ ...base, state: 'present', body: { _embedded: { 'media-series': null } } }]
      )
    ).not.toThrow();
    for (const body of [{ _embedded: { 'media-series': { id: 'still-linked' } } }, { _embedded: {} }]) {
      expect(() => verifyAcknowledgedProviderObservations([reduced], [{ ...base, state: 'present', body }])).toThrow();
    }
  });
  test.each([
    '_embedded..media-series',
    '_embedded.media-series/other',
    '_embedded.__proto__',
    'constructor.id',
    '_embedded.media-series[0]',
  ])('rejects unsafe external field path %s', (key) => {
    expect(() => validateVerification({ ...base, expectedProviderFields: { [key]: null } })).toThrow();
  });
  test('keeps the canonical Firestore write path grammar unchanged', () => {
    expect(() =>
      validateWrite({ path: 'sermons/sermon', expectedFields: {}, patch: { '_embedded.media-series': null } })
    ).toThrow();
  });
});
