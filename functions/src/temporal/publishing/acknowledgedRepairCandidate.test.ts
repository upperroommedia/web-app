let mockCountRead: ((input: any) => Promise<void>) | undefined;
let mockRootTargetReader: ((input: any) => Promise<any>) | undefined;
jest.mock('../../helpers/sermonDeletionMirrors', () => ({
  ...jest.requireActual('../../helpers/sermonDeletionMirrors'),
  assertSermonDeletionCountReadInTransaction: async (_tx: unknown, _db: unknown, input: any) => {
    if (!mockCountRead) throw new Error('COUNT_READ_NOT_AUTHORIZED');
    return mockCountRead(input);
  },
  readSermonDeletionRootMutationTargetsPage: async (_tx: unknown, _db: unknown, input: any) => {
    if (!mockRootTargetReader) throw new Error('Unexpected root source read');
    return mockRootTargetReader(input);
  },
}));
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  compileAcknowledgedRepairCandidatePage,
  ACKNOWLEDGED_REPAIR_CANDIDATES,
  type AcknowledgedRepairCandidateResult,
} from './acknowledgedRepairCandidate';
import {
  acknowledgedProjectionDigest as digest,
  ACKNOWLEDGED_PROJECTION_PLANS,
  type FrozenProjectionRequest,
  type FrozenProjectionWrite,
  type FrozenProviderVerification,
  prepareAcknowledgedRepair,
  commitAcknowledgedRepair,
  readAcknowledgedRepairRequiredVerifications,
  validateAcknowledgedRepairProviderRead,
} from './criticalAcknowledgedRepair';
import {
  providerMutationFingerprint,
  PROVIDER_MUTATION_SESSIONS,
  PROVIDER_MUTATION_FACTS,
  prepareProviderMutationEffectsClosed,
} from './providerMutationGuard';
const ref = { projectId: 'urm-app', jobId: 'job' };
const target = { provider: 'subsplash' as const, account: 'app:9XTSHD', resourceType: 'media', resourceId: 'media' };
const scope = { ...ref, operation: 'metadata' };
const sessionId = providerMutationFingerprint(scope);
type Data = Record<string, any>;
function fakeFirestore() {
  const store = new Map<string, Data>();
  const deletions: string[][] = [];
  const requestLimits: number[] = [];
  const writePaths: string[] = [];
  let missingIndex = false;
  const doc = (path: string): any => ({
    path,
    id: path.split('/').pop(),
    get: async () => snapshot(path),
    collection: (name: string) => query(`${path}/${name}`, false),
    listCollections: async () =>
      [
        ...new Set(
          [...store.keys()]
            .filter((key) => key.startsWith(`${path}/`))
            .map((key) => key.slice(path.length + 1).split('/')[0])
        ),
      ].map((id) => ({ id })),
  });
  const snapshot = (path: string): any => ({
    id: path.split('/').pop(),
    ref: doc(path),
    exists: store.has(path),
    data: () => (store.has(path) ? JSON.parse(JSON.stringify(store.get(path))) : undefined),
    get: (key: string) => {
      const value = key.split('.').reduce((current, part) => current?.[part], store.get(path));
      return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
    },
  });
  const query = (
    path: string,
    group: boolean,
    predicates: Array<[string, string, unknown]> = [],
    cursor = '',
    limit = Infinity
  ): any => ({
    _query: true,
    doc: (id: string) => doc(`${path}/${id}`),
    where: (field: string, operator: string, value: unknown) =>
      query(path, group, [...predicates, [field, operator, value]], cursor, limit),
    orderBy: () => query(path, group, predicates, cursor, limit),
    limit: (value: number) => query(path, group, predicates, cursor, value),
    startAfter: (value: any) =>
      query(path, group, predicates, typeof value === 'string' ? `${path}/${value}` : value.ref.path, limit),
    count: () => ({
      _aggregate: true,
      pathPrefix: path + '/',
      countValue: () =>
        [...store.keys()].filter(
          (key) => key.startsWith(path + '/') && key.split('/').length === path.split('/').length + 1
        ).length,
    }),
    get: async () => {
      if (path.endsWith('/requests') && limit !== Infinity) requestLimits.push(limit);
      if (missingIndex && group && predicates.length) throw Object.assign(new Error('missing index'), { code: 9 });
      const paths = [...store.keys()]
        .filter((key) => {
          const parts = key.split('/');
          const member = group
            ? parts[parts.length - 2] === path
            : key.startsWith(`${path}/`) && parts.length === path.split('/').length + 1;
          return (
            member &&
            key > cursor &&
            predicates.every(([field, operator, value]) =>
              operator === 'in' && Array.isArray(value)
                ? value.includes(snapshot(key).get(field))
                : snapshot(key).get(field) === value
            )
          );
        })
        .sort()
        .slice(0, limit);
      return { docs: paths.map(snapshot), size: paths.length, empty: paths.length === 0 };
    },
  });
  const db: any = {
    doc,
    collection: (name: string) => query(name, false),
    collectionGroup: (name: string) => query(name, true),
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      const writes: Array<() => void> = [];
      const deleted: string[] = [];
      let writing = false;
      const tx = {
        get: async (ref: any) => {
          if (writing) throw new Error('Read after write');
          return ref._aggregate
            ? { data: () => ({ count: ref.countValue() }) }
            : ref._query
            ? ref.get()
            : snapshot(ref.path);
        },
        getAll: async (...refs: any[]) => {
          if (writing) throw new Error('Read after write');
          return refs.map((ref) => snapshot(ref.path));
        },
        create: (ref: any, data: Data) => {
          writePaths.push(ref.path);
          writing = true;
          writes.push(() => {
            if (store.has(ref.path)) throw new Error('Already exists');
            store.set(ref.path, structuredClone(data));
          });
        },
        set: (ref: any, data: Data) => {
          writePaths.push(ref.path);
          writing = true;
          writes.push(() => store.set(ref.path, JSON.parse(JSON.stringify(data))));
        },
        update: (ref: any, data: Data) => {
          writePaths.push(ref.path);
          writing = true;
          writes.push(() => store.set(ref.path, { ...store.get(ref.path), ...structuredClone(data) }));
        },
        delete: (ref: any) => {
          writePaths.push(ref.path);
          writing = true;
          deleted.push(ref.path);
          writes.push(() => store.delete(ref.path));
        },
      };
      const result = await fn(tx);
      writes.forEach((write) => write());
      if (deleted.length) deletions.push(deleted);
      return result;
    },
  };
  return {
    db: db as Firestore,
    store,
    deletions,
    requestLimits,
    writePaths,
    setMissingIndex: () => {
      missingIndex = true;
    },
  };
}

const request = (step: string): FrozenProjectionRequest => {
  const payload = { title: step };
  return {
    step,
    method: 'PATCH',
    target,
    payload,
    fingerprint: providerMutationFingerprint(['PATCH', { target, body: payload }]),
  };
};
type Fragment = {
  requests: FrozenProjectionRequest[];
  writes: FrozenProjectionWrite[];
  verifications: FrozenProviderVerification[];
};
function fixture(fragments: Fragment[], states: Record<string, string> = {}, kind = 'sermon.publish') {
  const h = fakeFirestore();
  const entity = { type: 'sermon', id: 'sermon' };
  const intent = { ...ref, kind, generation: 1, entity, payload: { immutable: true } };
  h.store.set(`durableJobIntents/${ref.jobId}`, intent);
  h.store.set(`durableJobs/${ref.jobId}`, { ...intent, state: 'needs_attention' });
  const resourceKey = providerMutationFingerprint([ref.projectId, target.provider, target.account, target.resourceId]);
  h.store.set(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`, {
    schemaVersion: 1,
    scope,
    resources: [target],
    resourceKeys: [resourceKey],
    state: 'active',
  });
  h.store.set(`temporalProviderMutationLocks/${resourceKey}`, {
    state: 'held',
    sessionId,
    projectId: ref.projectId,
    jobId: ref.jobId,
  });
  let chain = digest([]);
  const unique = new Map<string, FrozenProjectionRequest>();
  fragments.forEach((fragment, index) => {
    const plan = {
      schemaVersion: 1,
      ...ref,
      sessionId,
      operation: scope.operation,
      intentFingerprint: digest(intent),
      ...fragment,
      finalFragment: true,
      completesActivity: false,
    };
    const pageDigest = digest(plan);
    h.store.set(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}/pages/${pageDigest}`, plan);
    h.store.set(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}/fragments/${String(index).padStart(16, '0')}`, {
      index,
      digest: pageDigest,
    });
    chain = digest([chain, index, pageDigest]);
    fragment.requests.forEach((planned) => {
      unique.set(planned.step, planned);
      const path = `${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}/requestIndex/${providerMutationFingerprint(
        planned.step
      )}`;
      h.store.set(path, {
        request: planned,
        intentFingerprint: digest(intent),
        pageDigest: h.store.get(path)?.pageDigest ?? pageDigest,
        ready: true,
        readyPageDigest: pageDigest,
      });
    });
  });
  for (const planned of unique.values()) {
    const state = states[planned.step] ?? 'acknowledged';
    if (state === 'unclaimed') continue;
    const claim = `claim:${planned.step}`,
      executionId = `execution:${planned.step}`;
    h.store.set(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}/requests/${providerMutationFingerprint(planned.step)}`, {
      step: planned.step,
      method: planned.method,
      fingerprint: planned.fingerprint,
      claim,
      executionId,
      state,
      result: null,
    });
    h.store.set(`${PROVIDER_MUTATION_FACTS}/${providerMutationFingerprint([sessionId, planned.step, claim])}`, {
      sessionId,
      step: planned.step,
      claim,
      executionId,
      fingerprint: planned.fingerprint,
      completion: state,
      ...(state === 'rejected_no_effect'
        ? { evidence: { transport: 'original_http_response', status: 400, providerCode: 'rejected' } }
        : { result: null }),
    });
  }
  h.store.set(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`, {
    schemaVersion: 2,
    ...ref,
    sessionId,
    operation: scope.operation,
    intentFingerprint: digest(intent),
    pageCount: fragments.length,
    requestCount: unique.size,
    chainDigest: chain,
    completesActivity: false,
    uiStepIds: [],
  });
  let commits = 0;
  const store = {
    commitCurrent: async <T>(_ref: typeof ref, mutate: (tx: Transaction) => Promise<T>): Promise<T> => {
      expect(_ref).toEqual(ref);
      commits++;
      return (h.db as any).runTransaction(mutate);
    },
  };
  const compile = () => compileAcknowledgedRepairCandidatePage(h.db, ref, sessionId, store);
  const ready = async (): Promise<AcknowledgedRepairCandidateResult> => {
    for (let count = 0; count < 10000; count++) {
      const result = await compile();
      if (result.state === 'ready') return result;
    }
    throw new Error('Compiler did not converge');
  };
  return { ...h, compile, ready, commits: () => commits };
}
const write = (path: string, step: string, patch: Record<string, unknown>): FrozenProjectionWrite => ({
  path,
  patch,
  expectedFields: {},
  requiredSteps: [step],
});
const verify = (step: string, expectedProviderFields: Record<string, unknown>): FrozenProviderVerification => ({
  ...target,
  resourceType: 'media',
  requiredSteps: [step],
  expectedProviderFields,
});

describe('bounded original acknowledged repair candidate compiler', () => {
  it('scans original claims in at most 32-request pages and writes only private candidate records', async () => {
    const requests = Array.from({ length: 75 }, (_, index) => request(`step-${index}`));
    const h = fixture([
      {
        requests,
        writes: requests.map((value, index) => write(`sermons/s${index}`, value.step, { title: value.step })),
        verifications: [verify(requests[0].step, { title: 'final' })],
      },
    ]);
    const first = await h.compile();
    expect(first).toMatchObject({ state: 'pending', phase: 'requests' });
    const result = await h.ready();
    const root = h.store.get(`${ACKNOWLEDGED_REPAIR_CANDIDATES}/${result.candidateId}`)!;
    expect(root).toMatchObject({
      originalRequestCount: 75,
      acknowledgedRequestCount: 75,
      programCount: 75,
      baselineCount: 75,
      partialStop: true,
    });
    expect(h.requestLimits.every((limit) => limit <= 32)).toBe(true);
    expect(h.writePaths.every((path) => path.startsWith(`${ACKNOWLEDGED_REPAIR_CANDIDATES}/`))).toBe(true);
    expect(h.commits()).toBeGreaterThan(7);
  });
  it('streams more than 2,000 programs without a source fleet manifest', async () => {
    const planned = request('metadata');
    const fragments = Array.from(
      { length: 35 },
      (_, index): Fragment => ({
        requests: [planned],
        writes: Array.from({ length: 64 }, (_, offset) =>
          write(`sermons/s${index * 64 + offset}`, planned.step, { title: 'new' })
        ),
        verifications: [verify(planned.step, { title: 'new' })],
      })
    );
    const h = fixture(fragments),
      result = await h.ready();
    const root = h.store.get(`${ACKNOWLEDGED_REPAIR_CANDIDATES}/${result.candidateId}`)!;
    expect(root.programCount).toBe(2240);
    expect(root.baselineCount).toBe(2240);
    expect(JSON.stringify(root).length).toBeLessThan(4000);
    expect(root).not.toHaveProperty('writes');
    expect(root).not.toHaveProperty('fragments');
  });
  it('composes final fields and stores original baselines in a subcollection instead of an array', async () => {
    const planned = request('metadata');
    const h = fixture([
      {
        requests: [planned],
        writes: [write('sermons/sermon', planned.step, { title: 'first', details: { keep: true } })],
        verifications: [verify(planned.step, { title: 'first', summary: 'keep' })],
      },
      {
        requests: [planned],
        writes: [write('sermons/sermon', planned.step, { title: 'last', 'details.last': 2 })],
        verifications: [verify(planned.step, { title: 'last' })],
      },
    ]);
    const result = await h.ready(),
      base = `${ACKNOWLEDGED_REPAIR_CANDIDATES}/${result.candidateId}`;
    const program = h.store.get(`${base}/programs/${providerMutationFingerprint('sermons/sermon')}`)!;
    expect(program.write.patch).toEqual({ title: 'last', details: { keep: true, last: 2 } });
    expect(program.baselineCount).toBe(2);
    expect(program).not.toHaveProperty('baselines');
    const baselinePaths = [...h.store.keys()].filter(
      (path) => path.startsWith(`${base}/programs/`) && path.includes('/baselines/')
    );
    expect(baselinePaths).toHaveLength(2);
    expect(baselinePaths.map((path) => h.store.get(path)!.writeIndex)).toEqual([0, 0]);
    const verification = h.store.get(
      `${base}/verifications/${providerMutationFingerprint(['subsplash', 'app:9XTSHD', 'media', 'media'])}`
    )!;
    expect(verification.verification.expectedProviderFields).toEqual({ title: 'last', summary: 'keep' });
    expect(await h.compile()).toEqual(result);
  });
  it('keeps no-effect and unclaimed prerequisites ineligible while allowing original positive any-step evidence', async () => {
    const a = request('positive'),
      b = request('no-effect'),
      c = request('unclaimed');
    const any = {
      path: 'sermons/any',
      expectedFields: {},
      patch: { title: 'positive' },
      requiredAnySteps: [a.step, b.step],
    };
    const h = fixture(
      [
        {
          requests: [a, b, c],
          writes: [
            write('sermons/positive', a.step, { title: 'yes' }),
            write('sermons/no-effect', b.step, { title: 'no' }),
            write('sermons/unclaimed', c.step, { title: 'no' }),
            any,
          ],
          verifications: [verify(a.step, { title: 'yes' }), verify(b.step, { summary: 'never' })],
        },
      ],
      { [b.step]: 'rejected_no_effect', [c.step]: 'unclaimed' }
    );
    const result = await h.ready(),
      base = `${ACKNOWLEDGED_REPAIR_CANDIDATES}/${result.candidateId}`;
    expect(h.store.get(base)).toMatchObject({
      originalRequestCount: 2,
      acknowledgedRequestCount: 1,
      rejectedRequestCount: 1,
      programCount: 2,
      partialStop: true,
    });
    expect(h.store.has(`${base}/programs/${providerMutationFingerprint('sermons/no-effect')}`)).toBe(false);
    expect(h.store.has(`${base}/programs/${providerMutationFingerprint('sermons/unclaimed')}`)).toBe(false);
  });
  it('blocks unknown original RPCs without producing compiled programs', async () => {
    const planned = request('unknown');
    const h = fixture(
      [
        {
          requests: [planned],
          writes: [write('sermons/sermon', planned.step, { title: 'cannot repair' })],
          verifications: [verify(planned.step, { title: 'cannot prove' })],
        },
      ],
      { unknown: 'unknown' }
    );
    await expect(h.compile()).rejects.toThrow();
    expect(h.writePaths).toEqual([]);
  });
  it('rejects a changed original immutable fact or direct planned request index', async () => {
    const planned = request('metadata'),
      fragments = [
        {
          requests: [planned],
          writes: [write('sermons/sermon', planned.step, { title: 'new' })],
          verifications: [verify(planned.step, { title: 'new' })],
        },
      ];
    const h = fixture(fragments);
    h.store.get(
      `${PROVIDER_MUTATION_FACTS}/${providerMutationFingerprint([sessionId, planned.step, 'claim:metadata'])}`
    )!.executionId = 'forged';
    await expect(h.compile()).rejects.toThrow();
    const second = fixture(fragments);
    second.store.get(
      `${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}/requestIndex/${providerMutationFingerprint(planned.step)}`
    )!.request.method = 'DELETE';
    await expect(second.compile()).rejects.toThrow();
  });
  it('starts a distinct candidate when the source root digest changes instead of reusing prior progress', async () => {
    const planned = request('metadata');
    const h = fixture([
      {
        requests: [planned],
        writes: [write('sermons/sermon', planned.step, { title: 'new' })],
        verifications: [verify(planned.step, { title: 'new' })],
      },
    ]);
    const first = await h.compile();
    h.store.get(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`)!.completesActivity = true;
    const next = await h.compile();
    expect(next.candidateId).not.toBe(first.candidateId);
    expect(next.sourceRootDigest).not.toBe(first.sourceRootDigest);
    expect(h.store.get(`${ACKNOWLEDGED_REPAIR_CANDIDATES}/${first.candidateId}`)).toBeDefined();
  });
  it('cannot compile under a revoked SDK fence or a replaced immutable job generation', async () => {
    const planned = request('metadata');
    const h = fixture([
      {
        requests: [planned],
        writes: [write('sermons/sermon', planned.step, { title: 'new' })],
        verifications: [verify(planned.step, { title: 'new' })],
      },
    ]);
    await expect(
      compileAcknowledgedRepairCandidatePage(h.db, ref, sessionId, {
        commitCurrent: async () => {
          throw new Error('SDK revoked');
        },
      })
    ).rejects.toThrow('SDK revoked');
    expect(h.writePaths).toEqual([]);
    h.store.get(`durableJobs/${ref.jobId}`)!.generation = 2;
    await expect(h.compile()).rejects.toThrow('evidence');
    expect(h.writePaths).toEqual([]);
  });
  it('does not certify only no-effect responses as a positive repair candidate', async () => {
    const planned = request('metadata');
    const h = fixture(
      [
        {
          requests: [planned],
          writes: [write('sermons/sermon', planned.step, { title: 'must stay' })],
          verifications: [{ ...verify(planned.step, { title: 'unproven' }), requiredSteps: [] }],
        },
      ],
      { metadata: 'rejected_no_effect' }
    );
    const ready = await h.ready(),
      base = `${ACKNOWLEDGED_REPAIR_CANDIDATES}/${ready.candidateId}`;
    expect(h.store.get(base)).toMatchObject({
      phase: 'ready',
      terminalNoEffectOnly: true,
      originalRequestCount: 1,
      acknowledgedRequestCount: 0,
      rejectedRequestCount: 1,
      programCount: 0,
      verificationCount: 0,
      partialStop: true,
    });
    expect(h.store.has(`${base}/programs/${providerMutationFingerprint('sermons/sermon')}`)).toBe(false);
    await expect(
      (h.db as any).runTransaction((tx: Transaction) => prepareAcknowledgedRepair(tx, h.db, ref, sessionId))
    ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' });
  });
  it('rejects verifications outside original planned resource authority', async () => {
    const planned = request('metadata');
    const h = fixture([
      {
        requests: [planned],
        writes: [write('sermons/sermon', planned.step, { title: 'new' })],
        verifications: [{ ...verify(planned.step, { title: 'new' }), resourceId: 'unrelated' }],
      },
    ]);
    await expect(h.ready()).rejects.toThrow('evidence');
    expect(h.writePaths.every((path) => path.startsWith(`${ACKNOWLEDGED_REPAIR_CANDIDATES}/`))).toBe(true);
  });
  it('preserves the first eligible appearance order even when path hashes sort differently', async () => {
    const planned = request('metadata');
    const h = fixture([
      {
        requests: [planned],
        writes: [
          write('sermons/root', planned.step, { title: 'root' }),
          write('sermons/z/sermonLists/list', planned.step, { id: 'list' }),
        ],
        verifications: [verify(planned.step, { title: 'root' })],
      },
      { requests: [planned], writes: [write('sermons/root', planned.step, { subtitle: 'later' })], verifications: [] },
    ]);
    const ready = await h.ready(),
      base = `${ACKNOWLEDGED_REPAIR_CANDIDATES}/${ready.candidateId}`;
    const order = [...h.store.keys()]
      .filter((path) => path.startsWith(`${base}/programOrder/`))
      .sort()
      .map((path) => h.store.get(path)!.canonicalPath);
    expect(order).toEqual(['sermons/root', 'sermons/z/sermonLists/list']);
    expect(h.store.get(`${base}/programs/${providerMutationFingerprint('sermons/root')}`)!.orderKey).toBe(
      '0000000000000000-0000000000000000'
    );
  });
  it('requires READY evidence and projects the first program without materializing the source fleet', async () => {
    const planned = request('metadata'),
      h = fixture([
        {
          requests: [planned],
          writes: [
            write('sermons/root', planned.step, { title: 'new' }),
            write('sermons/root/sermonLists/list', planned.step, { title: 'new' }),
          ],
          verifications: [verify(planned.step, { title: 'new' })],
        },
      ]);
    h.store.set('sermons/root', { title: 'old' });
    h.store.set('sermons/root/sermonLists/list', { title: 'old' });
    await expect(
      (h.db as any).runTransaction((tx: Transaction) => prepareAcknowledgedRepair(tx, h.db, ref, sessionId))
    ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_CANDIDATE_PENDING' });
    await h.ready();
    const prepared = await (h.db as any).runTransaction((tx: Transaction) =>
      prepareAcknowledgedRepair(tx, h.db, ref, sessionId)
    );
    expect(prepared.sourceEvidence).toHaveLength(2);
    const observations = [
      { ...target, resourceType: 'media' as const, state: 'present' as const, body: { title: 'new' } },
    ];
    const projected = await (h.db as any).runTransaction((tx: Transaction) =>
      commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, observations)
    );
    expect(projected).toMatchObject({ writesCompleted: 1, needsContinuation: true });
    expect(h.store.get('sermons/root')?.title).toBe('new');
    expect(h.store.get('sermons/root/sermonLists/list')?.title).toBe('old');
    await expect(
      (h.db as any).runTransaction((tx: Transaction) =>
        validateAcknowledgedRepairProviderRead(tx, h.db, ref, prepared.operation, {
          provider: 'subsplash',
          accountId: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: 'unrelated',
          method: 'GET',
        })
      )
    ).rejects.toThrow();
  });
  it('pages verifier observations and requires a source injected execution scope before canonical projection', async () => {
    const requests = Array.from({ length: 35 }, (_, index) => {
      const base = request(`metadata-${index}`),
        actual = { ...target, resourceId: `media-${index}` };
      return {
        ...base,
        target: actual,
        fingerprint: providerMutationFingerprint(['PATCH', { target: actual, body: base.payload }]),
      };
    });
    const verifications = requests.map((planned) => ({
      ...verify(planned.step, { title: 'new' }),
      resourceId: planned.target!.resourceId,
    }));
    const h = fixture([
      {
        requests,
        writes: [
          {
            ...write('sermons/root', requests[0].step, { title: 'new' }),
            requiredSteps: requests.map((value) => value.step),
          },
        ],
        verifications,
      },
    ]);
    h.store.get(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)!.resources = [
      target,
      ...verifications.map((v) => ({
        provider: v.provider,
        account: v.account,
        resourceType: v.resourceType,
        resourceId: v.resourceId,
      })),
    ];
    h.store.set('sermons/root', { title: 'old' });
    await h.ready();
    const prepared = await (h.db as any).runTransaction((tx: Transaction) =>
      prepareAcknowledgedRepair(tx, h.db, ref, sessionId)
    );
    expect(prepared.verifications).toHaveLength(32);
    const observe = (values: FrozenProviderVerification[]) =>
      values.map((v) => ({
        provider: v.provider,
        account: v.account,
        resourceType: v.resourceType,
        resourceId: v.resourceId,
        state: 'present' as const,
        body: { title: 'new' },
      }));
    await expect(
      (h.db as any).runTransaction((tx: Transaction) =>
        commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, observe(prepared.verifications))
      )
    ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_EXECUTION_SCOPE_REQUIRED' });
    const options = { observationScope: 'certificate/execution-1' };
    await (h.db as any).runTransaction((tx: Transaction) =>
      commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, observe(prepared.verifications), options)
    );
    expect(h.store.get('sermons/root')?.title).toBe('old');
    const oldReceiptPath = [...h.store.keys()].find((path) =>
      path.startsWith(`temporalPublishingAcknowledgedProjectionProgress/${sessionId}/observations/`)
    )!;
    const savedReceipt = JSON.parse(JSON.stringify(h.store.get(oldReceiptPath)));
    h.store.get(oldReceiptPath)!.observationDigest = digest('tampered earlier provider response');
    const next = await (h.db as any).runTransaction((tx: Transaction) =>
      readAcknowledgedRepairRequiredVerifications(tx, h.db, ref, prepared.operation, options)
    );
    expect(next.verifications).toHaveLength(3);
    // Consume remaining fixed-read and claim pages, then the earlier receipt's
    // immutable page proof must reject alteration before a canonical CAS.
    let rejected = false;
    for (let index = 0; index < 10 && !rejected; index++) {
      const current = await (h.db as any).runTransaction((tx: Transaction) =>
        readAcknowledgedRepairRequiredVerifications(tx, h.db, ref, prepared.operation, options)
      );
      try {
        await (h.db as any).runTransaction((tx: Transaction) =>
          commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, observe(current.verifications), options)
        );
      } catch {
        rejected = true;
      }
    }
    expect(rejected).toBe(true);
    expect(h.store.get('sermons/root')?.title).toBe('old');
    h.store.set(oldReceiptPath, savedReceipt);
    for (let index = 0; index < 10 && h.store.get('sermons/root')?.title === 'old'; index++) {
      const current = await (h.db as any).runTransaction((tx: Transaction) =>
        readAcknowledgedRepairRequiredVerifications(tx, h.db, ref, prepared.operation, options)
      );
      await (h.db as any).runTransaction((tx: Transaction) =>
        commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, observe(current.verifications), options)
      );
    }
    expect(h.store.get('sermons/root')?.title).toBe('new');
  });
  it('streams every baseline CAS and resets its observation and baseline cursor for a new SDK execution', async () => {
    const planned = request('metadata'),
      fragments = Array.from({ length: 130 }, (_, index) => ({
        requests: [planned],
        writes: [
          { ...write('sermons/root', planned.step, { title: `v${index}` }), expectedFields: { identity: 'fixed' } },
        ],
        verifications: [verify(planned.step, { title: 'v129' })],
      }));
    const h = fixture(fragments);
    h.store.set('sermons/root', { identity: 'fixed', title: 'old' });
    await h.ready();
    const prepared = await (h.db as any).runTransaction((tx: Transaction) =>
      prepareAcknowledgedRepair(tx, h.db, ref, sessionId)
    );
    const observations = [
      { ...target, resourceType: 'media' as const, state: 'present' as const, body: { title: 'v129' } },
    ];
    const commit = (scope: string) =>
      (h.db as any).runTransaction((tx: Transaction) =>
        commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, observations, { observationScope: scope })
      );
    await commit('execution-1');
    expect(h.store.get(`temporalPublishingAcknowledgedProjectionProgress/${sessionId}`)?.baselineSeen).toBe(64);
    await commit('execution-2');
    expect(h.store.get(`temporalPublishingAcknowledgedProjectionProgress/${sessionId}`)?.baselineSeen).toBe(64);
    await commit('execution-2');
    expect(h.store.get('sermons/root')?.title).toBe('old');
    await commit('execution-2');
    expect(h.store.get('sermons/root')?.title).toBe('v129');
  });

  it('streams the authoritative complete deletion graph into root-only dependencies beyond 501 targets', async () => {
    const requests = Array.from({ length: 601 }, (_, index) => {
      const target = {
        provider: 'subsplash' as const,
        account: 'app:9XTSHD',
        resourceType: index ? 'list-row' : 'media',
        resourceId: `resource-${index}`,
      };
      const payload = { id: target.resourceId };
      return {
        step: `delete-${index}`,
        method: 'DELETE' as const,
        target,
        payload,
        fingerprint: providerMutationFingerprint(['DELETE', { target, body: payload }]),
      };
    });
    const rootWrite: FrozenProjectionWrite = {
      path: 'sermons/sermon',
      mode: 'delete',
      expectedExists: true,
      expectedDocumentDigest: digest({ title: 'old' }),
      expectedFields: {},
      patch: {},
      requiredSteps: [requests[0].step],
    };
    const verifications = requests.map((value) => ({
      provider: value.target.provider,
      account: value.target.account,
      resourceType: value.target.resourceType as 'media' | 'list-row',
      resourceId: value.target.resourceId,
      expectedState: 'absent' as const,
      expectedProviderFields: {},
      requiredSteps: [value.step],
    }));
    const fragments = Array.from({ length: Math.ceil(requests.length / 32) }, (_, index) => ({
      requests: requests.slice(index * 32, index * 32 + 32),
      writes:
        index === 0
          ? [rootWrite, write('sermons/sermon/sermonLists/list', requests[0].step, { title: 'removed' })]
          : [],
      verifications: verifications.slice(index * 32, index * 32 + 32),
    }));
    const h = fixture(fragments, {}, 'sermon.delete');
    h.store.get(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)!.resources = requests.map((value) => value.target);
    const ordered = requests
      .map((value) => ({ key: providerMutationFingerprint(value.step), value }))
      .sort((a, b) => a.key.localeCompare(b.key));
    let calls = 0;
    mockRootTargetReader = async (input) => {
      calls++;
      expect(input.limit).toBe(32);
      const selected = ordered.filter((value) => !input.cursor || value.key > input.cursor).slice(0, 32);
      return {
        targets: selected.map(({ value }) => ({ target: value.target, requestStep: value.step })),
        ...(selected.length === 32 ? { nextCursor: selected[selected.length - 1].key } : {}),
        sourceProgramDigest: digest('authoritative full deletion graph'),
        sourceRequestCount: 601,
      };
    };
    try {
      const ready = await h.ready(),
        base = `${ACKNOWLEDGED_REPAIR_CANDIDATES}/${ready.candidateId}`;
      expect(calls).toBe(19);
      expect(h.store.get(base)).toMatchObject({
        rootTargetComplete: true,
        rootTargetReadCount: 601,
        rootDependencyCatalogueCount: 601,
      });
      const root = h.store.get(`${base}/programs/${providerMutationFingerprint('sermons/sermon')}`)!;
      expect(root.dependencyCount).toBe(601);
      expect(root.dependencyCatalogueDigest).toBe(h.store.get(base)?.rootDependencyCatalogueDigest);
      expect(
        h.store.get(`${base}/programs/${providerMutationFingerprint('sermons/sermon/sermonLists/list')}`)
          ?.dependencyCount
      ).toBe(1);
    } finally {
      mockRootTargetReader = undefined;
    }
  });

  it('matches an actual post-READY v2 closure against independently compiled claims before bounded final commit', async () => {
    const planned = request('metadata'),
      h = fixture([
        {
          requests: [planned],
          writes: [write('sermons/root', planned.step, { title: 'new' })],
          verifications: [verify(planned.step, { title: 'new' })],
        },
      ]);
    h.store.set('sermons/root', { title: 'old' });
    const ready = await h.ready();
    const prepared = await (h.db as any).runTransaction((tx: Transaction) =>
      prepareAcknowledgedRepair(tx, h.db, ref, sessionId)
    );
    const observations = [
        { ...target, resourceType: 'media' as const, state: 'present' as const, body: { title: 'new' } },
      ],
      options = { observationScope: 'cert/current-sdk' };
    await (h.db as any).runTransaction((tx: Transaction) =>
      commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, observations, options)
    );
    await (h.db as any).runTransaction(async (tx: Transaction) => {
      const close = await prepareProviderMutationEffectsClosed(
        tx,
        { db: h.db, id: sessionId, scope, resources: [target] },
        async (transaction) => {
          const current = await transaction.get(h.db.doc('sermons/root'));
          expect(current.get('title')).toBe('new');
          const progress = await transaction.get(
            h.db.doc(`temporalPublishingAcknowledgedProjectionProgress/${sessionId}`)
          );
          expect(progress.get('programIndex')).toBe(1);
        }
      );
      close.commit();
    });
    const root = h.store.get(`${ACKNOWLEDGED_REPAIR_CANDIDATES}/${ready.candidateId}`)!;
    expect(h.store.get(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)?.effectsClosedClaimSetDigest).toBe(
      root.terminalClaimSetDigest
    );
    expect(root.closedClaimSetDigest).toBeUndefined(); // Closure happened after READY, with no reviewed-header mutation.
    const finalized = await (h.db as any).runTransaction((tx: Transaction) =>
      commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, [], options)
    );
    expect(finalized).toMatchObject({ alreadyCommitted: false, writesCompleted: 0 });
    expect(h.store.get(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)?.state).toBe('committed');
  });

  it('closes a fully claimed metadata program from READY evidence in one bounded transaction before final settlement', async () => {
    const planned = request('metadata'),
      h = fixture([
        {
          requests: [planned],
          writes: [write('sermons/root', planned.step, { title: 'new' })],
          verifications: [verify(planned.step, { title: 'new' })],
        },
      ]);
    h.store.set('sermons/root', { title: 'old' });
    await h.ready();
    const prepared = await (h.db as any).runTransaction((tx: Transaction) =>
      prepareAcknowledgedRepair(tx, h.db, ref, sessionId)
    );
    const options = { observationScope: 'cert/current-sdk' },
      observations = [{ ...target, resourceType: 'media' as const, state: 'present' as const, body: { title: 'new' } }];
    await (h.db as any).runTransaction((tx: Transaction) =>
      commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, observations, options)
    );
    const closed = await (h.db as any).runTransaction((tx: Transaction) =>
      commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, [], options)
    );
    expect(closed).toMatchObject({ needsContinuation: true, writesCompleted: 0 });
    expect(h.store.get(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)).toMatchObject({
      state: 'active',
      effectsClosed: true,
      effectsClosedClaimSetDigestVersion: 2,
      effectsClosedActualRequestCount: 1,
    });
    const settled = await (h.db as any).runTransaction((tx: Transaction) =>
      commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, [], options)
    );
    expect(settled.needsContinuation).toBeUndefined();
    expect(h.store.get(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)?.state).toBe('committed');
    expect(h.requestLimits.every((limit) => Number.isFinite(limit) && limit <= 32)).toBe(true);
  });

  it('permanently stops an immutable non-destructive metadata prefix without replaying its unclaimed request', async () => {
    const applied = request('applied'),
      unsent = request('unsent'),
      h = fixture(
        [
          {
            requests: [applied, unsent],
            writes: [write('sermons/root', applied.step, { title: 'new' })],
            verifications: [verify(applied.step, { title: 'new' })],
          },
        ],
        { unsent: 'unclaimed' }
      );
    h.store.set('sermons/root', { title: 'old' });
    await h.ready();
    const prepared = await (h.db as any).runTransaction((tx: Transaction) =>
      prepareAcknowledgedRepair(tx, h.db, ref, sessionId)
    );
    const options = { observationScope: 'cert/current-sdk' },
      observations = [{ ...target, resourceType: 'media' as const, state: 'present' as const, body: { title: 'new' } }];
    await (h.db as any).runTransaction((tx: Transaction) =>
      commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, observations, options)
    );
    await expect(
      (h.db as any).runTransaction((tx: Transaction) =>
        commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, [], options)
      )
    ).resolves.toMatchObject({ needsContinuation: true, partialStop: true });
    expect(h.store.get(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)).toMatchObject({
      effectsClosed: true,
      effectsClosedActualRequestCount: 1,
      effectsClosedExpectedRequestCount: 2,
      state: 'active',
    });
    const result = await (h.db as any).runTransaction((tx: Transaction) =>
      commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, [], options)
    );
    expect(result).toMatchObject({ partialStop: true, factualNonDestructiveStop: true });
    expect(h.store.get(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)?.state).toBe('committed');
    expect(
      h.store.has(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}/requests/${providerMutationFingerprint(unsent.step)}`)
    ).toBe(false);
  });

  it('certifies a fixed acknowledged list-row unlink prefix while preserving its content root', async () => {
    const rowTarget = { ...target, resourceType: 'list-row', resourceId: 'row' },
      payload = { id: 'row', listId: 'list' };
    const unlink: FrozenProjectionRequest = {
      step: 'unlink',
      method: 'DELETE',
      target: rowTarget,
      payload,
      fingerprint: providerMutationFingerprint(['DELETE', { target: rowTarget, body: payload }]),
    };
    const unsent = request('unsent'),
      row = { sermonId: 'root', listItemId: 'row' };
    const h = fixture(
      [
        {
          requests: [unlink, unsent],
          writes: [
            {
              path: 'lists/list/listItems/row',
              mode: 'delete',
              expectedDocumentDigest: digest(row),
              expectedFields: {},
              patch: {},
              requiredSteps: ['unlink'],
            },
          ],
          verifications: [
            {
              ...rowTarget,
              resourceType: 'list-row',
              requiredSteps: ['unlink'],
              expectedState: 'absent',
              expectedProviderFields: {},
            },
          ],
        },
      ],
      { unsent: 'unclaimed' }
    );
    h.store.get(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)!.resources = [target, rowTarget];
    const rowKey = providerMutationFingerprint([
      ref.projectId,
      rowTarget.provider,
      rowTarget.account,
      rowTarget.resourceId,
    ]);
    h.store.get(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)!.resourceKeys.push(rowKey);
    h.store.set(`temporalProviderMutationLocks/${rowKey}`, {
      state: 'held',
      sessionId,
      projectId: ref.projectId,
      jobId: ref.jobId,
    });
    h.store.set('lists/list/listItems/row', row);
    h.store.set('sermons/root', { title: 'retained', audioArtifacts: { finalPath: 'kept' } });
    const ready = await h.ready();
    expect(h.store.get(`${ACKNOWLEDGED_REPAIR_CANDIDATES}/${ready.candidateId}`)).toMatchObject({
      destructiveRequestCount: 0,
      hasDestructiveCanonicalWrites: false,
    });
    const prepared = await (h.db as any).runTransaction((tx: Transaction) =>
        prepareAcknowledgedRepair(tx, h.db, ref, sessionId)
      ),
      options = { observationScope: 'cert/current-sdk' };
    await (h.db as any).runTransaction((tx: Transaction) =>
      commitAcknowledgedRepair(
        tx,
        h.db,
        ref,
        prepared.operation,
        [{ ...rowTarget, resourceType: 'list-row', state: 'absent' }],
        options
      )
    );
    await (h.db as any).runTransaction((tx: Transaction) =>
      commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, [], options)
    );
    await expect(
      (h.db as any).runTransaction((tx: Transaction) =>
        commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, [], options)
      )
    ).resolves.toMatchObject({ partialStop: true, factualNonDestructiveStop: true });
    expect(h.store.has('lists/list/listItems/row')).toBe(false);
    expect(h.store.get('sermons/root')).toEqual({ title: 'retained', audioArtifacts: { finalPath: 'kept' } });
  });

  it.each(['audioArtifacts.finalPath', 'audioStoragePath'])(
    'does not certify artifact-reference replacement as content preservation (%s)',
    async (field) => {
      const applied = request('applied'),
        unsent = request('unsent');
      const h = fixture(
        [
          {
            requests: [applied, unsent],
            writes: [write('sermons/root', applied.step, { [field]: 'replacement' })],
            verifications: [verify(applied.step, { title: 'new' })],
          },
        ],
        { unsent: 'unclaimed' }
      );
      const ready = await h.ready();
      expect(h.store.get(`${ACKNOWLEDGED_REPAIR_CANDIDATES}/${ready.candidateId}`)).toMatchObject({
        hasDestructiveCanonicalWrites: true,
      });
    }
  );

  it('blocks a generic prefix stop when the unclaimed original program deletes content', async () => {
    const applied = request('applied'),
      payload = { id: target.resourceId };
    const destructive: FrozenProjectionRequest = {
      step: 'delete-content',
      method: 'DELETE',
      target,
      payload,
      fingerprint: providerMutationFingerprint(['DELETE', { target, body: payload }]),
    };
    const h = fixture(
      [
        {
          requests: [applied, destructive],
          writes: [write('sermons/root', applied.step, { title: 'new' })],
          verifications: [verify(applied.step, { title: 'new' })],
        },
      ],
      { 'delete-content': 'unclaimed' }
    );
    h.store.set('sermons/root', { title: 'old' });
    const ready = await h.ready();
    expect(h.store.get(`${ACKNOWLEDGED_REPAIR_CANDIDATES}/${ready.candidateId}`)).toMatchObject({
      destructiveRequestCount: 1,
    });
    const prepared = await (h.db as any).runTransaction((tx: Transaction) =>
      prepareAcknowledgedRepair(tx, h.db, ref, sessionId)
    );
    const options = { observationScope: 'cert/current-sdk' };
    await (h.db as any).runTransaction((tx: Transaction) =>
      commitAcknowledgedRepair(
        tx,
        h.db,
        ref,
        prepared.operation,
        [{ ...target, resourceType: 'media' as const, state: 'present' as const, body: { title: 'new' } }],
        options
      )
    );
    await expect(
      (h.db as any).runTransaction((tx: Transaction) =>
        commitAcknowledgedRepair(tx, h.db, ref, prepared.operation, [], options)
      )
    ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' });
    expect(h.store.get(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)?.state).toBe('active');
    expect(
      h.store.has(
        `${PROVIDER_MUTATION_SESSIONS}/${sessionId}/requests/${providerMutationFingerprint(destructive.step)}`
      )
    ).toBe(false);
  });

  it('allows derivative count reads only through exact original full deletion source membership', async () => {
    const target = {
        provider: 'subsplash' as const,
        account: 'app:9XTSHD',
        resourceType: 'media',
        resourceId: 'resource',
      },
      payload = { id: 'resource' },
      planned = {
        step: 'delete-media',
        method: 'DELETE' as const,
        target,
        payload,
        fingerprint: providerMutationFingerprint(['DELETE', { target, body: payload }]),
      };
    const h = fixture(
      [
        {
          requests: [planned],
          writes: [
            {
              path: 'sermons/sermon',
              mode: 'delete',
              expectedExists: true,
              expectedDocumentDigest: digest({ title: 'old' }),
              patch: {},
              expectedFields: {},
              requiredSteps: [planned.step],
            },
          ],
          verifications: [
            {
              ...target,
              resourceType: 'media' as const,
              expectedState: 'absent' as const,
              expectedProviderFields: {},
              requiredSteps: [planned.step],
            },
          ],
        },
      ],
      {},
      'sermon.delete'
    );
    h.store.get(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)!.resources = [target];
    mockRootTargetReader = async () => ({
      targets: [{ target, requestStep: planned.step }],
      sourceProgramDigest: digest('source full graph'),
      sourceRequestCount: 1,
    });
    const requests: any[] = [];
    mockCountRead = async (input) => {
      requests.push(input);
      if (input.resourceId !== 'original-list') throw new Error('COUNT_READ_NOT_AUTHORIZED');
    };
    try {
      await h.ready();
      const prepared = await (h.db as any).runTransaction((tx: Transaction) =>
        prepareAcknowledgedRepair(tx, h.db, ref, sessionId)
      );
      const fixed = {
        provider: 'subsplash' as const,
        accountId: 'app:9XTSHD',
        resourceType: 'list',
        resourceId: 'original-list',
        method: 'GET' as const,
      };
      await (h.db as any).runTransaction((tx: Transaction) =>
        validateAcknowledgedRepairProviderRead(tx, h.db, ref, prepared.operation, fixed)
      );
      expect(requests).toEqual([
        {
          ref,
          sermonId: 'sermon',
          sessionId,
          sourceRootDigest: prepared.operation.projectionDigest,
          resourceType: 'list',
          resourceId: 'original-list',
          account: 'app:9XTSHD',
        },
      ]);
      await expect(
        (h.db as any).runTransaction((tx: Transaction) =>
          validateAcknowledgedRepairProviderRead(tx, h.db, ref, prepared.operation, {
            ...fixed,
            resourceId: 'unrelated',
          })
        )
      ).rejects.toThrow('COUNT_READ_NOT_AUTHORIZED');
      const before = requests.length;
      await expect(
        (h.db as any).runTransaction((tx: Transaction) =>
          validateAcknowledgedRepairProviderRead(tx, h.db, ref, prepared.operation, {
            ...fixed,
            accountId: 'app:OTHER',
          })
        )
      ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' });
      expect(requests).toHaveLength(before);
    } finally {
      mockRootTargetReader = undefined;
      mockCountRead = undefined;
    }
  });

  it('never delegates a missing ordinary metadata verifier to deletion count authority', async () => {
    const planned = request('metadata'),
      h = fixture([
        {
          requests: [planned],
          writes: [write('sermons/root', planned.step, { title: 'new' })],
          verifications: [verify(planned.step, { title: 'new' })],
        },
      ]);
    await h.ready();
    const prepared = await (h.db as any).runTransaction((tx: Transaction) =>
      prepareAcknowledgedRepair(tx, h.db, ref, sessionId)
    );
    let calls = 0;
    mockCountRead = async () => {
      calls++;
    };
    try {
      await expect(
        (h.db as any).runTransaction((tx: Transaction) =>
          validateAcknowledgedRepairProviderRead(tx, h.db, ref, prepared.operation, {
            provider: 'subsplash',
            accountId: 'app:9XTSHD',
            resourceType: 'list',
            resourceId: 'other',
            method: 'GET',
          })
        )
      ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' });
      expect(calls).toBe(0);
    } finally {
      mockCountRead = undefined;
    }
  });

  it('compiles owned DELETE404 original no-effect facts without granting canonical projection or inventing an ACK', async () => {
    const payload = { id: target.resourceId },
      planned = {
        step: 'owned-delete',
        method: 'DELETE' as const,
        target,
        payload,
        fingerprint: providerMutationFingerprint(['DELETE', { target, body: payload }]),
      },
      h = fixture(
        [
          {
            requests: [planned],
            writes: [write('sermons/sermon', planned.step, { title: 'must remain' })],
            verifications: [{ ...verify(planned.step, {}), expectedState: 'absent' as const }],
          },
        ],
        { 'owned-delete': 'rejected_no_effect' }
      );
    const requestData = h.store.get(
      `${PROVIDER_MUTATION_SESSIONS}/${sessionId}/requests/${providerMutationFingerprint(planned.step)}`
    )!;
    h.store.get(
      `${PROVIDER_MUTATION_FACTS}/${providerMutationFingerprint([sessionId, planned.step, requestData.claim])}`
    )!.evidence = { transport: 'original_http_response', status: 404, providerCode: 'resource_not_found' };
    const ready = await h.ready(),
      root = h.store.get(`${ACKNOWLEDGED_REPAIR_CANDIDATES}/${ready.candidateId}`)!;
    expect(root).toMatchObject({
      terminalNoEffectOnly: true,
      originalRequestCount: 1,
      acknowledgedRequestCount: 0,
      rejectedRequestCount: 1,
      programCount: 0,
      verificationCount: 0,
    });
    expect(
      h.store.get(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}/requests/${providerMutationFingerprint(planned.step)}`)
        ?.state
    ).toBe('rejected_no_effect');
    expect(h.writePaths.every((path) => path.startsWith(ACKNOWLEDGED_REPAIR_CANDIDATES + '/'))).toBe(true);
    await expect(
      (h.db as any).runTransaction((tx: Transaction) =>
        commitAcknowledgedRepair(
          tx,
          h.db,
          ref,
          { kind: 'acknowledged_projection', sessionId, projectionDigest: ready.sourceRootDigest },
          [],
          { observationScope: 'cert/sdk' }
        )
      )
    ).rejects.toMatchObject({ code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED' });
  });

  it('blocks unknown evidence even when every other original result had no effect', async () => {
    const a = request('noeffect'),
      b = request('unknown'),
      h = fixture([{ requests: [a, b], writes: [], verifications: [] }], {
        noeffect: 'rejected_no_effect',
        unknown: 'unknown',
      });
    await expect(h.ready()).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
    expect(
      [...h.store]
        .filter(([path]) => path.startsWith(ACKNOWLEDGED_REPAIR_CANDIDATES + '/') && path.split('/').length === 2)
        .some(([, value]) => value.phase === 'ready')
    ).toBe(false);
  });
});
